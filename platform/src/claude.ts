import Anthropic from '@anthropic-ai/sdk';
import type { Effort, Usage } from './catalog.ts';

/**
 * The one place that talks to Claude. The runner is a function so tests can
 * swap in a fake and so the platform can run in a labelled demo mode when no
 * API key is configured.
 */

export interface ModelRequest {
  model: string;
  system: string;
  user: string;
  effort: Effort;
  webSearch?: boolean;
  maxSearches?: number;
}

export interface Source {
  url: string;
  title: string | null;
}

export interface ModelResult {
  kind: 'ok' | 'refused';
  text: string;
  usage: Usage;
  stopReason: string | null;
  refusal?: { category: string | null; explanation: string | null };
  sources: Source[];
  truncated: boolean;
  continuations: number;
  servedBy: string;
}

export type RunModel = (req: ModelRequest) => Promise<ModelResult>;

/** Server-side tool loops pause after ten iterations; resume a few times, not forever. */
const MAX_CONTINUATIONS = 5;

export function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0 };
}

function addUsage(total: Usage, u: Anthropic.Beta.BetaUsage | null | undefined): void {
  if (!u) return;
  total.input_tokens += u.input_tokens ?? 0;
  total.output_tokens += u.output_tokens ?? 0;
  total.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
  total.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
  total.web_search_requests += u.server_tool_use?.web_search_requests ?? 0;
}

function collect(msg: Anthropic.Beta.BetaMessage, usage: Usage, continuations: number): ModelResult {
  if (msg.stop_reason === 'refusal') {
    const details = (msg as { stop_details?: { category?: string | null; explanation?: string | null } | null }).stop_details;
    return {
      kind: 'refused',
      text: '',
      usage,
      stopReason: msg.stop_reason,
      refusal: { category: details?.category ?? null, explanation: details?.explanation ?? null },
      sources: [],
      truncated: false,
      continuations,
      servedBy: msg.model,
    };
  }
  const parts: string[] = [];
  const sources = new Map<string, Source>();
  for (const block of msg.content) {
    if (block.type !== 'text') continue;
    parts.push(block.text);
    for (const c of block.citations ?? []) {
      if (c.type === 'web_search_result_location' && !sources.has(c.url)) sources.set(c.url, { url: c.url, title: c.title });
    }
  }
  return {
    kind: 'ok',
    text: parts.join('').trim(),
    usage,
    stopReason: msg.stop_reason,
    sources: [...sources.values()],
    truncated: msg.stop_reason === 'max_tokens',
    continuations,
    servedBy: msg.model,
  };
}

export function createClaudeRunner(opts: { apiKey?: string; timeoutMs?: number } = {}): RunModel {
  // Hard tasks on Opus can run for minutes; the SDK default of 10 minutes is a little tight.
  const client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 15 * 60 * 1000, maxRetries: 2 });

  return async (req) => {
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: req.user }];
    const tools: Anthropic.Beta.BetaToolUnion[] | undefined = req.webSearch
      ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: req.maxSearches ?? 8 }]
      : undefined;
    const usage = emptyUsage();
    let continuations = 0;

    for (;;) {
      const stream = client.beta.messages.stream({
        model: req.model,
        max_tokens: 64000,
        // If a safety classifier declines the request, Anthropic re-runs it on the
        // recommended fallback model inside the same call instead of failing the task.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        // The task's instructions are stable per task type, so they cache across clients.
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        output_config: { effort: req.effort },
        messages,
        ...(tools ? { tools } : {}),
      });
      const msg = await stream.finalMessage();
      addUsage(usage, msg.usage);
      if (msg.stop_reason === 'pause_turn' && continuations < MAX_CONTINUATIONS) {
        // The server-side search loop hit its iteration limit. Send the turn back
        // unchanged and the API resumes where it left off.
        messages.push({ role: 'assistant', content: msg.content });
        continuations += 1;
        continue;
      }
      return collect(msg, usage, continuations);
    }
  };
}

/** Demo mode: no key, no network, no cost. Output is clearly labelled as simulated. */
export function createMockRunner(opts: { delayMs?: number } = {}): RunModel {
  return async (req) => {
    await new Promise((r) => setTimeout(r, opts.delayMs ?? 1200));
    const words = req.user.split(/\s+/).filter(Boolean).length;
    const preview = req.user.split('\n').slice(0, 6).join('\n').slice(0, 400);
    const text = [
      '**Demo mode: this response was simulated, not written by Claude.**',
      'Set ANTHROPIC_API_KEY on the server and the same task will run on the real model.',
      '',
      `The task reached the runner with ${words} words of input and would have been sent to the model at "${req.effort}" effort${req.webSearch ? ' with web search enabled' : ''}.`,
      '',
      'First lines of what the model would receive:',
      '',
      preview,
    ].join('\n');
    return {
      kind: 'ok',
      text,
      usage: {
        input_tokens: Math.ceil((req.system.length + req.user.length) / 4),
        output_tokens: Math.ceil(text.length / 4),
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        web_search_requests: req.webSearch ? 3 : 0,
      },
      stopReason: 'end_turn',
      sources: req.webSearch ? [{ url: 'https://example.com/simulated-source', title: 'Simulated source' }] : [],
      truncated: false,
      continuations: 0,
      servedBy: 'demo',
    };
  };
}

export function chooseRunner(env: NodeJS.ProcessEnv): { run: RunModel; mode: 'live' | 'mock' } {
  const hasKey = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  if (env.MOCK_CLAUDE === '1' || !hasKey) return { run: createMockRunner(), mode: 'mock' };
  return { run: createClaudeRunner(), mode: 'live' };
}
