import { randomUUID } from 'node:crypto';
import { now, transaction, type Db } from './db.ts';
import { estimateCostUsd, taskType, type TaskType, type Usage } from './catalog.ts';
import { chargeForTask, refundTask } from './credits.ts';
import type { RunModel, Source } from './claude.ts';

/**
 * The task queue. Charging happens when a task is created; running happens
 * in the background with a concurrency cap so one heavy client cannot eat the
 * whole rate limit. Anything that goes wrong refunds the charge.
 */

export type TaskStatus = 'queued' | 'running' | 'done' | 'refused' | 'failed';

export interface TaskRow {
  id: string;
  user_id: string;
  type: string;
  input_json: string;
  status: TaskStatus;
  price_credits: number;
  model: string;
  output_text: string | null;
  error: string | null;
  usage_json: string | null;
  cost_usd: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface TaskView {
  id: string;
  type: string;
  typeName: string;
  status: TaskStatus;
  priceCredits: number;
  refunded: boolean;
  model: string;
  input: Record<string, string>;
  output: string | null;
  error: string | null;
  usage: (Usage & { sources?: Source[]; servedBy?: string; continuations?: number }) | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export class TaskRunner {
  private queue: string[] = [];
  private active = 0;
  private idleWaiters: Array<() => void> = [];

  private readonly db: Db;
  private readonly run: RunModel;
  private readonly concurrency: number;
  private readonly log: (msg: string) => void;

  constructor(db: Db, run: RunModel, concurrency = 2, log: (msg: string) => void = () => {}) {
    this.db = db;
    this.run = run;
    this.concurrency = concurrency;
    this.log = log;
  }

  /** Charge the wallet and record the task in one transaction, then queue it. */
  createTask(userId: string, type: TaskType, input: Record<string, string>, model: string): TaskRow {
    const id = randomUUID();
    transaction(this.db, () => {
      chargeForTask(this.db, userId, id, type.priceCredits);
      this.db
        .prepare(
          `INSERT INTO tasks (id, user_id, type, input_json, status, price_credits, model, created_at)
           VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run(id, userId, type.id, JSON.stringify(input), type.priceCredits, model, now());
    });
    this.enqueue(id);
    return this.get(id)!;
  }

  /** After a restart, put unfinished tasks back on the queue. */
  recover(): number {
    const rows = this.db
      .prepare("SELECT id FROM tasks WHERE status IN ('queued', 'running') ORDER BY created_at")
      .all() as Array<{ id: string }>;
    this.db.prepare("UPDATE tasks SET status = 'queued', started_at = NULL WHERE status = 'running'").run();
    for (const r of rows) this.enqueue(r.id);
    return rows.length;
  }

  get(id: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  }

  listFor(userId: string, limit = 50): TaskRow[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, limit) as unknown as TaskRow[];
  }

  view(row: TaskRow): TaskView {
    const refunded = Boolean(
      this.db.prepare("SELECT 1 FROM ledger WHERE ref = ?").get(`task:${row.id}:refund`),
    );
    return {
      id: row.id,
      type: row.type,
      typeName: taskType(row.type)?.name ?? row.type,
      status: row.status,
      priceCredits: row.price_credits,
      refunded,
      model: row.model,
      input: JSON.parse(row.input_json),
      output: row.output_text,
      error: row.error,
      usage: row.usage_json ? JSON.parse(row.usage_json) : null,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }

  enqueue(id: string): void {
    this.queue.push(id);
    queueMicrotask(() => this.pump());
  }

  /** Resolves once the queue is empty and nothing is running. */
  drain(): Promise<void> {
    if (this.queue.length === 0 && this.active === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const claimed = this.db
        .prepare("UPDATE tasks SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
        .run(now(), id);
      if (claimed.changes !== 1) continue;
      this.active += 1;
      this.execute(id).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
    if (this.queue.length === 0 && this.active === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  private async execute(id: string): Promise<void> {
    const row = this.get(id);
    if (!row) return;
    const type = taskType(row.type);
    if (!type) {
      this.finishFailed(row, 'This task type no longer exists.');
      return;
    }
    const input = JSON.parse(row.input_json) as Record<string, string>;
    const { system, user } = type.buildPrompt(input);
    try {
      const result = await this.run({
        model: row.model,
        system,
        user,
        effort: type.effort,
        webSearch: type.webSearch,
        maxSearches: type.maxSearches,
      });
      const costUsd = estimateCostUsd(row.model, result.usage);
      const usage = { ...result.usage, sources: result.sources, servedBy: result.servedBy, continuations: result.continuations };
      if (result.kind === 'refused') {
        this.db
          .prepare("UPDATE tasks SET status = 'refused', error = ?, usage_json = ?, cost_usd = ?, finished_at = ? WHERE id = ?")
          .run(result.refusal?.explanation ?? 'Claude declined this task.', JSON.stringify(usage), costUsd, now(), id);
        refundTask(this.db, row.user_id, id, row.price_credits, 'Claude declined this task');
        this.log(`task ${id} refused (${result.refusal?.category ?? 'unknown'}); refunded ${row.price_credits} credits`);
        return;
      }
      let text = result.text;
      if (result.sources.length) {
        text += '\n\n**Sources**\n' + result.sources.map((s) => `- ${s.title ? `${s.title}: ` : ''}${s.url}`).join('\n');
      }
      if (result.truncated) text += '\n\n_(The output reached the length limit and may be incomplete.)_';
      this.db
        .prepare("UPDATE tasks SET status = 'done', output_text = ?, usage_json = ?, cost_usd = ?, finished_at = ? WHERE id = ?")
        .run(text, JSON.stringify(usage), costUsd, now(), id);
      this.log(`task ${id} done; ${result.usage.input_tokens} in / ${result.usage.output_tokens} out; $${costUsd.toFixed(4)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.finishFailed(row, message);
    }
  }

  private finishFailed(row: TaskRow, message: string): void {
    this.db
      .prepare("UPDATE tasks SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
      .run(message, now(), row.id);
    refundTask(this.db, row.user_id, row.id, row.price_credits, 'Task failed');
    this.log(`task ${row.id} failed: ${message}; refunded ${row.price_credits} credits`);
  }
}
