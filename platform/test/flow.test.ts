import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.ts';
import { createMockRunner, type ModelResult, type RunModel } from '../src/claude.ts';

async function makeApp(run: RunModel, extra: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const built = await buildApp({ dbPath: ':memory:', run, mode: 'mock', concurrency: 2, ...extra });
  await built.app.ready();
  return built;
}

type App = Awaited<ReturnType<typeof makeApp>>['app'];

async function signup(app: App, email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password123' } });
  assert.equal(res.statusCode, 201, res.body);
  const sid = res.cookies.find((c) => c.name === 'sid')!.value;
  return { sid };
}

async function topUp(app: App, cookies: { sid: string }, packId = 'starter') {
  const res = await app.inject({ method: 'POST', url: '/api/wallet/checkout', cookies, payload: { packId } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { mode: string; credits: number; balance: number };
}

const polish = { type: 'polish', input: { text: 'helo wrld, this is a tset', tone: 'Friendly' } };

test('a client signs up, buys credits, runs a task and is charged exactly once', async () => {
  const { app, runner } = await makeApp(createMockRunner({ delayMs: 5 }));
  const cookies = await signup(app, 'ann@example.com');

  const me = await app.inject({ method: 'GET', url: '/api/me', cookies });
  assert.equal(me.json().balance, 0);
  assert.equal(me.json().mode, 'mock');

  const broke = await app.inject({ method: 'POST', url: '/api/tasks', cookies, payload: polish });
  assert.equal(broke.statusCode, 402);
  assert.equal(broke.json().needed, 5);

  const bought = await topUp(app, cookies);
  assert.equal(bought.mode, 'dev');
  assert.equal(bought.balance, 100);

  const created = await app.inject({ method: 'POST', url: '/api/tasks', cookies, payload: polish });
  assert.equal(created.statusCode, 201, created.body);
  const { task, balance } = created.json();
  assert.equal(task.status, 'queued');
  assert.equal(balance, 95);

  await runner.drain();
  const got = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}`, cookies });
  const done = got.json();
  assert.equal(done.task.status, 'done');
  assert.match(done.task.output, /Demo mode/);
  assert.equal(done.task.refunded, false);
  assert.ok(done.task.usage.input_tokens > 0);
  assert.equal(done.balance, 95);

  const wallet = await app.inject({ method: 'GET', url: '/api/wallet', cookies });
  assert.deepEqual(
    wallet.json().ledger.map((e: { kind: string; delta: number }) => [e.kind, e.delta]),
    [['task_charge', -5], ['purchase', 100]],
  );
  await app.close();
});

test('a task that throws is marked failed and the charge is refunded', async () => {
  const failing: RunModel = async () => {
    throw new Error('upstream exploded');
  };
  const { app, runner } = await makeApp(failing);
  const cookies = await signup(app, 'bob@example.com');
  await topUp(app, cookies);
  const created = await app.inject({ method: 'POST', url: '/api/tasks', cookies, payload: polish });
  assert.equal(created.json().balance, 95);
  await runner.drain();
  const got = await app.inject({ method: 'GET', url: `/api/tasks/${created.json().task.id}`, cookies });
  assert.equal(got.json().task.status, 'failed');
  assert.equal(got.json().task.refunded, true);
  assert.match(got.json().task.error, /upstream exploded/);
  assert.equal(got.json().balance, 100);
  await app.close();
});

test('a task Claude declines is marked refused and the charge is refunded', async () => {
  const refusing: RunModel = async () => {
    const r: ModelResult = {
      kind: 'refused',
      text: '',
      usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0 },
      stopReason: 'refusal',
      refusal: { category: 'cyber', explanation: 'Declined by policy.' },
      sources: [],
      truncated: false,
      continuations: 0,
      servedBy: 'claude-opus-5-5',
    };
    return r;
  };
  const { app, runner } = await makeApp(refusing);
  const cookies = await signup(app, 'cat@example.com');
  await topUp(app, cookies);
  const created = await app.inject({ method: 'POST', url: '/api/tasks', cookies, payload: polish });
  await runner.drain();
  const got = await app.inject({ method: 'GET', url: `/api/tasks/${created.json().task.id}`, cookies });
  assert.equal(got.json().task.status, 'refused');
  assert.equal(got.json().task.refunded, true);
  assert.equal(got.json().balance, 100);
  await app.close();
});

test('bad input is rejected before anything is charged', async () => {
  const { app } = await makeApp(createMockRunner({ delayMs: 5 }));
  const cookies = await signup(app, 'dan@example.com');
  await topUp(app, cookies);
  const missing = await app.inject({ method: 'POST', url: '/api/tasks', cookies, payload: { type: 'polish', input: { tone: 'Friendly' } } });
  assert.equal(missing.statusCode, 400);
  assert.match(missing.json().error, /required/);
  const unknown = await app.inject({ method: 'POST', url: '/api/tasks', cookies, payload: { type: 'nope', input: {} } });
  assert.equal(unknown.statusCode, 400);
  const me = await app.inject({ method: 'GET', url: '/api/me', cookies });
  assert.equal(me.json().balance, 100);
  await app.close();
});

test('clients cannot see each other and anonymous calls are rejected', async () => {
  const { app, runner } = await makeApp(createMockRunner({ delayMs: 5 }));
  const ann = await signup(app, 'ann2@example.com');
  const bob = await signup(app, 'bob2@example.com');
  await topUp(app, ann);
  const created = await app.inject({ method: 'POST', url: '/api/tasks', cookies: ann, payload: polish });
  await runner.drain();
  const asBob = await app.inject({ method: 'GET', url: `/api/tasks/${created.json().task.id}`, cookies: bob });
  assert.equal(asBob.statusCode, 404);
  const bobList = await app.inject({ method: 'GET', url: '/api/tasks', cookies: bob });
  assert.equal(bobList.json().tasks.length, 0);
  const anon = await app.inject({ method: 'GET', url: '/api/me' });
  assert.equal(anon.statusCode, 401);
  const dup = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'ann2@example.com', password: 'password123' } });
  assert.equal(dup.statusCode, 400);
  const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ann2@example.com', password: 'nope-nope-nope' } });
  assert.equal(wrong.statusCode, 400);
  await app.close();
});

test('the queue honours the concurrency cap', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const mock = createMockRunner({ delayMs: 1 });
  let started = 0;
  const slow: RunModel = async (req) => {
    started += 1;
    await gate;
    return mock(req);
  };
  const { app, runner } = await makeApp(slow, { concurrency: 1 });
  const cookies = await signup(app, 'eve@example.com');
  await topUp(app, cookies);
  const a = await app.inject({ method: 'POST', url: '/api/tasks', cookies, payload: polish });
  const b = await app.inject({ method: 'POST', url: '/api/tasks', cookies, payload: polish });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(started, 1);
  const list = await app.inject({ method: 'GET', url: '/api/tasks', cookies });
  const statuses = Object.fromEntries(list.json().tasks.map((t: { id: string; status: string }) => [t.id, t.status]));
  assert.equal(statuses[a.json().task.id], 'running');
  assert.equal(statuses[b.json().task.id], 'queued');
  release();
  await runner.drain();
  assert.equal(started, 2);
  await app.close();
});

test('unfinished tasks are picked up again after a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-'));
  const dbPath = join(dir, 'p.db');
  const hang: RunModel = () => new Promise(() => {});
  const first = await makeApp(hang, { dbPath });
  const cookies = await signup(first.app, 'fay@example.com');
  await topUp(first.app, cookies);
  const created = await first.app.inject({ method: 'POST', url: '/api/tasks', cookies, payload: polish });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(first.runner.get(created.json().task.id)!.status, 'running');
  await first.app.close();
  first.db.close();

  const second = await makeApp(createMockRunner({ delayMs: 5 }), { dbPath });
  assert.equal(second.runner.recover(), 1);
  await second.runner.drain();
  const got = await second.app.inject({ method: 'GET', url: `/api/tasks/${created.json().task.id}`, cookies });
  assert.equal(got.json().task.status, 'done');
  assert.equal(got.json().balance, 95);
  await second.app.close();
  second.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the admin summary is hidden without the token and adds up with it', async () => {
  const { app, runner } = await makeApp(createMockRunner({ delayMs: 5 }), { adminToken: 'secret' });
  const cookies = await signup(app, 'gus@example.com');
  await topUp(app, cookies, 'pro');
  await app.inject({ method: 'POST', url: '/api/tasks', cookies, payload: polish });
  await runner.drain();
  const hidden = await app.inject({ method: 'GET', url: '/api/admin/summary' });
  assert.equal(hidden.statusCode, 404);
  const shown = await app.inject({ method: 'GET', url: '/api/admin/summary', headers: { 'x-admin-token': 'secret' } });
  assert.equal(shown.statusCode, 200);
  const t = shown.json().totals;
  assert.equal(t.credits_sold, 550);
  assert.equal(t.revenue_cents, 5000);
  assert.equal(t.credits_charged, 5);
  assert.equal(t.credits_refunded, 0);
  assert.ok(t.provider_cost_usd > 0);
  await app.close();
});
