import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { now, type Db } from './db.ts';

export interface User {
  id: string;
  email: string;
  created_at: string;
}

export class AuthError extends Error {}

function normalizeEmail(email: string): string {
  const e = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new AuthError('Enter a valid email address.');
  return e;
}

function checkPassword(password: string): void {
  if (typeof password !== 'string' || password.length < 8) {
    throw new AuthError('Password must be at least 8 characters.');
  }
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function createUser(db: Db, email: string, password: string): User {
  const e = normalizeEmail(email);
  checkPassword(password);
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(e);
  if (existing) throw new AuthError('An account with that email already exists.');
  const user: User = { id: randomUUID(), email: e, created_at: now() };
  db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
    user.id,
    user.email,
    hashPassword(password),
    user.created_at,
  );
  return user;
}

export function verifyUser(db: Db, email: string, password: string): User {
  const e = normalizeEmail(email);
  const row = db
    .prepare('SELECT id, email, password_hash, created_at FROM users WHERE email = ?')
    .get(e) as (User & { password_hash: string }) | undefined;
  if (!row || typeof password !== 'string' || !verifyPassword(password, row.password_hash)) {
    throw new AuthError('Email or password is incorrect.');
  }
  return { id: row.id, email: row.email, created_at: row.created_at };
}

export function createSession(db: Db, userId: string): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, now());
  return token;
}

export function userForSession(db: Db, token: string | undefined): User | null {
  if (!token) return null;
  const row = db
    .prepare(
      'SELECT u.id, u.email, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?',
    )
    .get(token) as User | undefined;
  return row ?? null;
}

export function destroySession(db: Db, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
