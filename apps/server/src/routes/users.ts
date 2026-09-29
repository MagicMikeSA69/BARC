import type { FastifyInstance } from 'fastify';
import { validateRates, type Role, type User, type Vehicle } from '@barc/shared';
import { currentUser, newId, newToken, requireUser } from '../auth.ts';
import type { Store } from '../db.ts';

const ROLES: Role[] = ['rider', 'driver', 'both'];
const HANDLE_RE = /^[a-z0-9_]{3,24}$/;

function cleanVehicle(v: unknown): Vehicle | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim().slice(0, 40) : '');
  const seats = Number(o.seats);
  return {
    make: str('make'),
    model: str('model'),
    colour: str('colour'),
    plate: str('plate'),
    seats: Number.isInteger(seats) && seats > 0 && seats <= 12 ? seats : 4,
  };
}

export function userRoutes(app: FastifyInstance, store: Store): void {
  app.post('/auth/register', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const handle = String(body.handle ?? '').trim().toLowerCase();
    const displayName = String(body.displayName ?? '').trim().slice(0, 60);
    const role = body.role as Role;
    if (!HANDLE_RE.test(handle)) {
      return reply.code(400).send({ error: 'handle must be 3-24 chars: letters, numbers, underscore' });
    }
    if (!displayName) return reply.code(400).send({ error: 'display name is required' });
    if (!ROLES.includes(role)) return reply.code(400).send({ error: 'role must be rider, driver or both' });
    if (store.getUserByHandle(handle)) return reply.code(409).send({ error: 'that handle is taken' });

    const user = store.createUser({ id: newId('usr'), handle, displayName, role });
    const token = newToken();
    store.createToken(token, user.id);
    return reply.code(201).send({ token, user });
  });

  app.get('/me', { preHandler: requireUser(store) }, async (req) => {
    return { user: currentUser(req) };
  });

  app.patch('/me', { preHandler: requireUser(store) }, async (req, reply) => {
    const me = currentUser(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<Pick<User, 'displayName' | 'role' | 'paymentHandle' | 'rates' | 'vehicle'>> = {};

    if (typeof body.displayName === 'string' && body.displayName.trim()) {
      patch.displayName = body.displayName.trim().slice(0, 60);
    }
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role as Role)) return reply.code(400).send({ error: 'invalid role' });
      patch.role = body.role as Role;
    }
    if (typeof body.paymentHandle === 'string') patch.paymentHandle = body.paymentHandle.trim().slice(0, 120);
    if (body.rates !== undefined) {
      if (body.rates === null) patch.rates = null;
      else if (!validateRates(body.rates)) return reply.code(400).send({ error: 'invalid rate card' });
      else patch.rates = body.rates;
    }
    if (body.vehicle !== undefined) patch.vehicle = cleanVehicle(body.vehicle);

    return { user: store.updateUser(me.id, patch) };
  });

  /** Public profile, as riders and drivers see each other. */
  app.get('/users/:id', { preHandler: requireUser(store) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const u = store.getUser(id);
    if (!u) return reply.code(404).send({ error: 'no such member' });
    const { handle: _h, paymentHandle: _p, ...pub } = u;
    return { user: pub };
  });

  /**
   * Reputation portability: a member can take their full history with them.
   * The export is plain JSON so any other node (or the member) can read it.
   */
  app.get('/me/export', { preHandler: requireUser(store) }, async (req) => {
    const me = currentUser(req);
    return {
      exportedAt: new Date().toISOString(),
      node: store.getSetting('node_name', 'BARC node'),
      user: me,
      rides: store.ridesForUser(me.id, 10000),
    };
  });

  /** Drivers can also flip presence over HTTP, which keeps the app simple when the socket is down. */
  app.post('/me/presence', { preHandler: requireUser(store) }, async (req, reply) => {
    const me = currentUser(req);
    if (me.role === 'rider') return reply.code(403).send({ error: 'only drivers publish presence' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const online = Boolean(body.online);
    const loc = body.location as { lat?: unknown; lng?: unknown } | null | undefined;
    const lat = typeof loc?.lat === 'number' ? loc.lat : null;
    const lng = typeof loc?.lng === 'number' ? loc.lng : null;
    const heading = typeof body.heading === 'number' ? body.heading : null;
    store.setPresence(me.id, online, lat, lng, heading);
    return { ok: true };
  });
}
