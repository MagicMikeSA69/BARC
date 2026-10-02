/**
 * What the platform sells. Three things live here on purpose, side by side:
 * the credit packs clients buy, the task types they can spend credits on,
 * and the provider price list used to meter what each task really cost.
 * Change the business by editing this file.
 */

export const DEFAULT_MODEL = 'claude-opus-5-5';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** USD per million tokens, Anthropic first-party rates. */
export const PRICING_USD_PER_MTOK: Record<string, ModelPrice> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

export const WEB_SEARCH_USD_PER_1000 = 10;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  web_search_requests: number;
}

export function estimateCostUsd(model: string, u: Usage): number {
  const p = PRICING_USD_PER_MTOK[model];
  if (!p) return 0;
  const tokens =
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      u.cache_creation_input_tokens * p.cacheWrite +
      u.cache_read_input_tokens * p.cacheRead) /
    1_000_000;
  const searches = (u.web_search_requests * WEB_SEARCH_USD_PER_1000) / 1000;
  return Math.round((tokens + searches) * 10_000) / 10_000;
}

export interface CreditPack {
  id: string;
  label: string;
  credits: number;
  usdCents: number;
  blurb: string;
}

export const CREDIT_PACKS: CreditPack[] = [
  { id: 'starter', label: 'Starter', credits: 100, usdCents: 1000, blurb: 'Try it out. About 20 small tasks.' },
  { id: 'pro', label: 'Pro', credits: 550, usdCents: 5000, blurb: '10% bonus credits.' },
  { id: 'team', label: 'Team', credits: 1200, usdCents: 10000, blurb: '20% bonus credits.' },
];

export function creditPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id);
}

export interface TaskField {
  key: string;
  label: string;
  kind: 'text' | 'textarea' | 'select';
  placeholder?: string;
  options?: string[];
  required?: boolean;
  maxLength?: number;
}

export interface TaskType {
  id: string;
  name: string;
  blurb: string;
  priceCredits: number;
  effort: Effort;
  fields: TaskField[];
  /** Let Claude use Anthropic's server-side web search while doing the task. */
  webSearch?: boolean;
  maxSearches?: number;
  buildPrompt(input: Record<string, string>): { system: string; user: string };
}

const TONES = ['Keep my tone', 'Professional', 'Friendly', 'Concise', 'Formal'];

export const TASK_TYPES: TaskType[] = [
  {
    id: 'polish',
    name: 'Polish my writing',
    blurb: 'Fix grammar, tighten sentences and improve flow without changing what you meant.',
    priceCredits: 5,
    effort: 'low',
    fields: [
      { key: 'text', label: 'Your text', kind: 'textarea', required: true, maxLength: 40_000, placeholder: 'Paste the text you want improved.' },
      { key: 'tone', label: 'Tone', kind: 'select', options: TONES },
    ],
    buildPrompt: (i) => ({
      system:
        "You are an editor. Improve the clarity, flow and correctness of the text you are given while keeping the author's meaning and voice. Match the requested tone. Return only the improved text, with no preamble or notes.",
      user: `Tone: ${i.tone || TONES[0]}\n\nText:\n${i.text}`,
    }),
  },
  {
    id: 'summarize',
    name: 'Summarize a document',
    blurb: 'Turn a long document into a one-paragraph summary, key points and action items.',
    priceCredits: 8,
    effort: 'medium',
    fields: [
      { key: 'text', label: 'Document', kind: 'textarea', required: true, maxLength: 120_000, placeholder: 'Paste the document, report, transcript or thread.' },
      { key: 'audience', label: 'Who is this summary for?', kind: 'text', placeholder: 'e.g. the leadership team' },
    ],
    buildPrompt: (i) => ({
      system:
        "You produce executive summaries of documents for busy readers. Respond in Markdown with three sections: 'Summary' (one short paragraph), 'Key points' (a bullet list) and 'Action items' (a bullet list, or 'None' if the document contains none). Do not add information that is not in the document.",
      user: `Audience: ${i.audience || 'a busy professional'}\n\nDocument:\n${i.text}`,
    }),
  },
  {
    id: 'email_reply',
    name: 'Draft an email reply',
    blurb: 'Paste an email you received and say what you want. Get a reply that is ready to send.',
    priceCredits: 5,
    effort: 'low',
    fields: [
      { key: 'email', label: 'The email you received', kind: 'textarea', required: true, maxLength: 40_000 },
      { key: 'goal', label: 'What do you want the reply to achieve?', kind: 'text', required: true, placeholder: 'e.g. decline politely but keep the door open' },
      { key: 'tone', label: 'Tone', kind: 'select', options: TONES.slice(1) },
      { key: 'name', label: 'Sign off as', kind: 'text', required: true, placeholder: 'Your name' },
    ],
    buildPrompt: (i) => ({
      system:
        "You draft email replies on behalf of the user. Write a reply that achieves the user's goal, matches the requested tone and is ready to send. Return only the email body, with no subject line and no commentary.",
      user: `Goal: ${i.goal}\nTone: ${i.tone || 'Professional'}\nSign off as: ${i.name}\n\nEmail received:\n${i.email}`,
    }),
  },
  {
    id: 'research',
    name: 'Research brief',
    blurb: 'Claude searches the web, reads the sources and writes a cited brief on your topic.',
    priceCredits: 25,
    effort: 'high',
    webSearch: true,
    maxSearches: 8,
    fields: [
      { key: 'topic', label: 'Topic', kind: 'text', required: true, placeholder: 'e.g. ride-hailing regulation in South Africa' },
      { key: 'questions', label: 'What do you want to know?', kind: 'textarea', required: true, maxLength: 10_000, placeholder: 'List the questions the brief should answer.' },
    ],
    buildPrompt: (i) => ({
      system:
        "You are a research analyst. Use web search to investigate the topic, then write a brief in Markdown with the sections 'Overview', 'Findings' (the specific facts and figures you found, each attributed to its source), 'Open questions' and 'Sources'. Prefer primary and recent sources. Say plainly when evidence is thin or conflicting.",
      user: `Topic: ${i.topic}\n\nWhat the client wants to know:\n${i.questions}`,
    }),
  },
];

export function taskType(id: string): TaskType | undefined {
  return TASK_TYPES.find((t) => t.id === id);
}

/** The catalog as the browser sees it: no prompt builders. */
export function publicCatalog() {
  return {
    model: DEFAULT_MODEL,
    packs: CREDIT_PACKS,
    taskTypes: TASK_TYPES.map(({ buildPrompt: _omit, ...rest }) => rest),
  };
}

export class InvalidInput extends Error {}

/** Keep only declared fields, enforce required and length limits. */
export function validateInput(type: TaskType, raw: unknown): Record<string, string> {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const clean: Record<string, string> = {};
  for (const f of type.fields) {
    const v = input[f.key];
    const s = typeof v === 'string' ? v.trim() : '';
    if (f.required && !s) throw new InvalidInput(`"${f.label}" is required.`);
    if (f.maxLength && s.length > f.maxLength) throw new InvalidInput(`"${f.label}" is too long (max ${f.maxLength} characters).`);
    if (f.kind === 'select' && s && f.options && !f.options.includes(s)) throw new InvalidInput(`"${f.label}" has an unknown option.`);
    clean[f.key] = s;
  }
  return clean;
}
