import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@barc/shared';
import type { Store } from './db.ts';

/**
 * Authentication on a BARC node is intentionally minimal: registering gives
 * the device a bearer token, which is the only credential. A community that
 * needs stronger identity (phone verification, in-person vetting at a taxi
 * rank, a web-of-trust) adds it at the node level; the protocol does not
 * demand a corporate identity provider.
 */

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('base64url')}`;
}

export function tokenFromRequest(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7).trim();
  const q = (req.query as Record<string, unknown> | undefined)?.token;
  return typeof q === 'string' && q ? q : null;
}

export function userFromRequest(store: Store, req: FastifyRequest): User | null {
  const token = tokenFromRequest(req);
  if (!token) return null;
  const id = store.userIdForToken(token);
  return id ? store.getUser(id) : null;
}

export function requireUser(store: Store) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = userFromRequest(store, req);
    if (!user) {
      await reply.code(401).send({ error: 'sign in first' });
      return;
    }
    (req as FastifyRequest & { user: User }).user = user;
  };
}

export function currentUser(req: FastifyRequest): User {
  return (req as FastifyRequest & { user: User }).user;
}
