import { now, type Db } from './db.ts';

/**
 * The prepaid wallet. Credits are integers; the client buys them up front and
 * each task charges a fixed price. Charges happen before the task runs, so
 * the platform never does work it cannot bill for. If a task fails or Claude
 * declines it, the charge is refunded in full.
 */

export type LedgerKind = 'purchase' | 'task_charge' | 'refund' | 'adjustment';

export interface LedgerEntry {
  id: number;
  user_id: string;
  delta: number;
  kind: LedgerKind;
  ref: string;
  task_id: string | null;
  usd_cents: number;
  note: string;
  created_at: string;
}

export class InsufficientCredits extends Error {
  readonly needed: number;
  readonly available: number;
  constructor(needed: number, available: number) {
    super(`This task costs ${needed} credits but the wallet has ${available}.`);
    this.needed = needed;
    this.available = available;
  }
}

export function balance(db: Db, userId: string): number {
  const row = db.prepare('SELECT COALESCE(SUM(delta), 0) AS bal FROM ledger WHERE user_id = ?').get(userId) as {
    bal: number;
  };
  return Number(row.bal);
}

export interface EntryInput {
  userId: string;
  delta: number;
  kind: LedgerKind;
  /** Idempotency key. A second entry with the same ref is ignored. */
  ref: string;
  taskId?: string;
  usdCents?: number;
  note?: string;
}

/** Append one ledger row. Returns false when the ref was already applied. */
export function applyEntry(db: Db, e: EntryInput): boolean {
  if (!Number.isInteger(e.delta)) throw new Error('Ledger deltas must be whole credits.');
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO ledger (user_id, delta, kind, ref, task_id, usd_cents, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(e.userId, e.delta, e.kind, e.ref, e.taskId ?? null, e.usdCents ?? 0, e.note ?? '', now());
  return result.changes === 1;
}

/**
 * Charge a task's price up front. Throws InsufficientCredits without writing.
 * Call it inside transaction() so the balance check and the charge are atomic.
 */
export function chargeForTask(db: Db, userId: string, taskId: string, price: number): void {
  if (!Number.isInteger(price) || price <= 0) throw new Error('Task price must be a positive whole number.');
  const available = balance(db, userId);
  if (available < price) throw new InsufficientCredits(price, available);
  applyEntry(db, { userId, delta: -price, kind: 'task_charge', ref: `task:${taskId}:charge`, taskId });
}

/** Give the task's price back. Safe to call more than once. */
export function refundTask(db: Db, userId: string, taskId: string, price: number, note: string): boolean {
  return applyEntry(db, { userId, delta: price, kind: 'refund', ref: `task:${taskId}:refund`, taskId, note });
}

export function ledgerFor(db: Db, userId: string, limit = 50): LedgerEntry[] {
  return db
    .prepare('SELECT * FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit) as unknown as LedgerEntry[];
}
