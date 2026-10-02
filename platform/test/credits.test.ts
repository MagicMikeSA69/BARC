import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, transaction } from '../src/db.ts';
import { createUser } from '../src/auth.ts';
import { applyEntry, balance, chargeForTask, InsufficientCredits, refundTask } from '../src/credits.ts';
import { applyCheckoutCompleted } from '../src/payments.ts';
import { estimateCostUsd } from '../src/catalog.ts';

function fresh() {
  const db = openDb(':memory:');
  const user = createUser(db, 'ledger@example.com', 'password123');
  return { db, user };
}

test('balance is the sum of ledger deltas and refs are idempotent', () => {
  const { db, user } = fresh();
  assert.equal(balance(db, user.id), 0);
  assert.equal(applyEntry(db, { userId: user.id, delta: 100, kind: 'purchase', ref: 'buy-1' }), true);
  assert.equal(applyEntry(db, { userId: user.id, delta: 100, kind: 'purchase', ref: 'buy-1' }), false);
  assert.equal(balance(db, user.id), 100);
});

test('charging more than the balance throws and writes nothing', () => {
  const { db, user } = fresh();
  applyEntry(db, { userId: user.id, delta: 4, kind: 'purchase', ref: 'buy-1' });
  assert.throws(() => transaction(db, () => chargeForTask(db, user.id, 'task-1', 5)), InsufficientCredits);
  assert.equal(balance(db, user.id), 4);
  transaction(db, () => chargeForTask(db, user.id, 'task-2', 4));
  assert.equal(balance(db, user.id), 0);
});

test('refunding the same task twice only refunds once', () => {
  const { db, user } = fresh();
  applyEntry(db, { userId: user.id, delta: 10, kind: 'purchase', ref: 'buy-1' });
  transaction(db, () => chargeForTask(db, user.id, 'task-1', 8));
  assert.equal(refundTask(db, user.id, 'task-1', 8, 'failed'), true);
  assert.equal(refundTask(db, user.id, 'task-1', 8, 'failed again'), false);
  assert.equal(balance(db, user.id), 10);
});

test('a replayed Stripe checkout session credits the wallet once', () => {
  const { db, user } = fresh();
  const session = {
    id: 'cs_test_123',
    payment_status: 'paid',
    client_reference_id: user.id,
    metadata: { user_id: user.id, pack_id: 'starter', credits: '100' },
    amount_total: 1000,
  };
  assert.equal(applyCheckoutCompleted(db, session), 'credited');
  assert.equal(applyCheckoutCompleted(db, session), 'duplicate');
  assert.equal(applyCheckoutCompleted(db, { ...session, id: 'cs_unpaid', payment_status: 'unpaid' }), 'ignored');
  assert.equal(applyCheckoutCompleted(db, { ...session, id: 'cs_nobody', metadata: { user_id: 'ghost', credits: '100' } }), 'ignored');
  assert.equal(balance(db, user.id), 100);
});

test('cost estimate follows the provider price list', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 100_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 500_000, web_search_requests: 10 };
  // Opus 5.5: $4 in + $2 out + $0.10 cache reads + $0.10 searches
  assert.equal(estimateCostUsd('claude-opus-5-5', usage), 6.2);
  assert.equal(estimateCostUsd('unknown-model', usage), 0);
});
