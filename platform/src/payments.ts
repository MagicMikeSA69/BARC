import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { now, type Db } from './db.ts';
import { applyEntry, balance } from './credits.ts';
import type { CreditPack } from './catalog.ts';

/**
 * Prepaid top-ups through Stripe Checkout. The browser never sees a card
 * number: it is sent to Stripe's hosted page and Stripe tells us, through a
 * signed webhook, when the payment settled. Only then do credits appear.
 * Without Stripe keys the platform runs a labelled dev top-up instead.
 */

export function createStripeClient(secretKey: string | undefined): Stripe | null {
  return secretKey ? new Stripe(secretKey) : null;
}

export async function createCheckoutUrl(
  stripe: Stripe,
  args: { userId: string; email: string; pack: CreditPack; appUrl: string },
): Promise<string> {
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: args.email,
    client_reference_id: args.userId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: args.pack.usdCents,
          product_data: { name: `${args.pack.credits} credits (${args.pack.label} pack)` },
        },
      },
    ],
    metadata: { user_id: args.userId, pack_id: args.pack.id, credits: String(args.pack.credits) },
    success_url: `${args.appUrl}/?checkout=success`,
    cancel_url: `${args.appUrl}/?checkout=cancelled`,
  });
  if (!session.url) throw new Error('Stripe did not return a checkout URL.');
  return session.url;
}

/** The slice of a Stripe Checkout Session the ledger cares about. */
export interface CompletedCheckout {
  id: string;
  payment_status: string | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string> | null;
  amount_total?: number | null;
}

export type CheckoutOutcome = 'credited' | 'duplicate' | 'ignored';

/** Idempotent: the session id is the ledger ref, so a retried webhook is a no-op. */
export function applyCheckoutCompleted(db: Db, session: CompletedCheckout): CheckoutOutcome {
  if (session.payment_status !== 'paid') return 'ignored';
  const userId = session.metadata?.user_id ?? session.client_reference_id ?? null;
  const credits = Number(session.metadata?.credits);
  if (!userId || !Number.isInteger(credits) || credits <= 0) return 'ignored';
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return 'ignored';
  const applied = applyEntry(db, {
    userId,
    delta: credits,
    kind: 'purchase',
    ref: `stripe:${session.id}`,
    usdCents: session.amount_total ?? 0,
    note: `Bought ${credits} credits`,
  });
  return applied ? 'credited' : 'duplicate';
}

/** Returns false when this Stripe event id was already processed. */
export function recordStripeEvent(db: Db, eventId: string): boolean {
  const r = db.prepare('INSERT OR IGNORE INTO stripe_events (id, received_at) VALUES (?, ?)').run(eventId, now());
  return r.changes === 1;
}

/** Dev-only top-up when Stripe is not configured. Returns the new balance. */
export function devTopUp(db: Db, userId: string, pack: CreditPack): number {
  applyEntry(db, {
    userId,
    delta: pack.credits,
    kind: 'purchase',
    ref: `dev:${randomUUID()}`,
    usdCents: pack.usdCents,
    note: `Dev top-up: ${pack.credits} credits (no real payment)`,
  });
  return balance(db, userId);
}
