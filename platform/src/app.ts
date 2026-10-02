import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type Stripe from 'stripe';
import { openDb } from './db.ts';
import { AuthError, createSession, createUser, destroySession, userForSession, verifyUser, type User } from './auth.ts';
import { balance, InsufficientCredits, ledgerFor } from './credits.ts';
import { creditPack, DEFAULT_MODEL, InvalidInput, publicCatalog, taskType, validateInput } from './catalog.ts';
import type { RunModel } from './claude.ts';
import { TaskRunner } from './runner.ts';
import { applyCheckoutCompleted, createCheckoutUrl, devTopUp, recordStripeEvent, type CompletedCheckout } from './payments.ts';

export interface AppDeps {
  dbPath: string;
  run: RunModel;
  mode: 'live' | 'mock';
  model?: string;
  stripe?: Stripe | null;
  stripeWebhookSecret?: string;
  appUrl?: string;
  adminToken?: string;
  concurrency?: number;
  logger?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

const COOKIE = 'sid';
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

export async function buildApp(deps: AppDeps) {
  const db = openDb(deps.dbPath);
  const model = deps.model ?? DEFAULT_MODEL;
  const appUrl = deps.appUrl ?? 'http://localhost:4300';
  const stripe = deps.stripe ?? null;
  const app = Fastify({ logger: deps.logger ?? false });
  const runner = new TaskRunner(db, deps.run, deps.concurrency ?? 2, (m) => app.log.info(m));

  await app.register(fastifyCookie);
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/' });

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    req.user = userForSession(db, req.cookies[COOKIE]);
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof AuthError || err instanceof InvalidInput) return reply.code(400).send({ error: err.message });
    if (err instanceof InsufficientCredits) {
      return reply.code(402).send({ error: err.message, needed: err.needed, available: err.available });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (err instanceof Error && status && status < 500) return reply.code(status).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong on our side. Please try again.' });
  });

  function requireUser(req: FastifyRequest, reply: FastifyReply): User | null {
    if (req.user) return req.user;
    reply.code(401).send({ error: 'Sign in first.' });
    return null;
  }

  function signIn(reply: FastifyReply, userId: string): void {
    const token = createSession(db, userId);
    reply.setCookie(COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: appUrl.startsWith('https://'),
      maxAge: 60 * 60 * 24 * 30,
    });
  }

  function mePayload(user: User) {
    return {
      user: { id: user.id, email: user.email },
      balance: balance(db, user.id),
      mode: deps.mode,
      model,
      payments: stripe ? 'stripe' : 'dev',
    };
  }

  type Credentials = { email?: string; password?: string };

  app.post<{ Body: Credentials }>('/api/auth/signup', async (req, reply) => {
    const user = createUser(db, req.body?.email ?? '', req.body?.password ?? '');
    signIn(reply, user.id);
    return reply.code(201).send(mePayload(user));
  });

  app.post<{ Body: Credentials }>('/api/auth/login', async (req, reply) => {
    const user = verifyUser(db, req.body?.email ?? '', req.body?.password ?? '');
    signIn(reply, user.id);
    return mePayload(user);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    destroySession(db, req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    return mePayload(user);
  });

  app.get('/api/catalog', async () => publicCatalog());

  app.get('/api/wallet', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    return { balance: balance(db, user.id), ledger: ledgerFor(db, user.id) };
  });

  app.post<{ Body: { packId?: string } }>('/api/wallet/checkout', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const pack = creditPack(String(req.body?.packId ?? ''));
    if (!pack) return reply.code(400).send({ error: 'Unknown credit pack.' });
    if (stripe) {
      const url = await createCheckoutUrl(stripe, { userId: user.id, email: user.email, pack, appUrl });
      return { mode: 'stripe', url };
    }
    // No Stripe keys: credit the wallet directly so the flow can be tried end to end.
    const newBalance = devTopUp(db, user.id, pack);
    return { mode: 'dev', credits: pack.credits, balance: newBalance };
  });

  // Stripe signs the raw body, so this route must see the bytes, not parsed JSON.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    scope.post('/api/stripe/webhook', async (req, reply) => {
      if (!stripe || !deps.stripeWebhookSecret) return reply.code(404).send({ error: 'Stripe is not configured.' });
      const sig = req.headers['stripe-signature'];
      if (typeof sig !== 'string') return reply.code(400).send({ error: 'Missing Stripe signature.' });
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(req.body as Buffer, sig, deps.stripeWebhookSecret);
      } catch {
        return reply.code(400).send({ error: 'Invalid Stripe signature.' });
      }
      if (event.type === 'checkout.session.completed') {
        const outcome = applyCheckoutCompleted(db, event.data.object as unknown as CompletedCheckout);
        app.log.info(`stripe ${event.id}: ${outcome}`);
      }
      recordStripeEvent(db, event.id);
      return { received: true };
    });
  });

  app.post<{ Body: { type?: string; input?: unknown } }>('/api/tasks', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const type = taskType(String(req.body?.type ?? ''));
    if (!type) return reply.code(400).send({ error: 'Unknown task type.' });
    const input = validateInput(type, req.body?.input);
    const row = runner.createTask(user.id, type, input, model);
    return reply.code(201).send({ task: runner.view(row), balance: balance(db, user.id) });
  });

  app.get('/api/tasks', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    return { tasks: runner.listFor(user.id).map((r) => runner.view(r)) };
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const row = runner.get(req.params.id);
    if (!row || row.user_id !== user.id) return reply.code(404).send({ error: 'Task not found.' });
    return { task: runner.view(row), balance: balance(db, user.id) };
  });

  app.get('/api/admin/summary', async (req, reply) => {
    if (!deps.adminToken || req.headers['x-admin-token'] !== deps.adminToken) {
      return reply.code(404).send({ error: 'Not found.' });
    }
    const totals = db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM users) AS users,
          (SELECT COALESCE(SUM(delta), 0) FROM ledger WHERE kind = 'purchase') AS credits_sold,
          (SELECT COALESCE(SUM(usd_cents), 0) FROM ledger WHERE kind = 'purchase') AS revenue_cents,
          (SELECT COALESCE(-SUM(delta), 0) FROM ledger WHERE kind = 'task_charge') AS credits_charged,
          (SELECT COALESCE(SUM(delta), 0) FROM ledger WHERE kind = 'refund') AS credits_refunded,
          (SELECT COALESCE(SUM(cost_usd), 0) FROM tasks) AS provider_cost_usd,
          (SELECT COUNT(*) FROM tasks) AS tasks`,
      )
      .get() as Record<string, number>;
    const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all();
    const byType = db
      .prepare(
        `SELECT type, COUNT(*) AS n, SUM(price_credits) AS credits, SUM(cost_usd) AS cost_usd
         FROM tasks WHERE status = 'done' GROUP BY type ORDER BY n DESC`,
      )
      .all();
    return { mode: deps.mode, model, totals, byStatus, byType };
  });

  return { app, db, runner };
}
