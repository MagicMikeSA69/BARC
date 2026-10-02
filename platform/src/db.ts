import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * One SQLite file is the whole state of the platform: users, sessions, the
 * credit ledger, tasks and processed Stripe events. Easy to back up, easy to
 * run on a single small server, and more than enough for the first thousand
 * clients. Swap for Postgres when you outgrow it; the queries are plain SQL.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
-- Append-only. A client's balance is the SUM of their deltas. Every row has a
-- unique ref so a retried webhook, a double-clicked button or a crashed task
-- can never credit or charge twice.
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  delta INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT UNIQUE NOT NULL,
  task_id TEXT,
  usd_cents INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, id);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL,
  price_credits INTEGER NOT NULL,
  model TEXT NOT NULL,
  output_text TEXT,
  error TEXT,
  usage_json TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS tasks_user ON tasks(user_id, created_at);
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);
`;

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function now(): string {
  return new Date().toISOString();
}

/** Run fn inside BEGIN IMMEDIATE / COMMIT, rolling back on any throw. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
