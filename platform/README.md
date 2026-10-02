# Task Desk: a prepaid task platform powered by Claude

Clients buy credits up front, hand over a task, and get the finished work
back. Claude does the work through the Anthropic API; the platform meters
every task so you always know what it cost you against what the client paid.
"Task Desk" is a placeholder name.

## How the money flows

1. A client creates an account and buys a credit pack through Stripe
   Checkout. Stripe confirms the payment through a signed webhook and only
   then do the credits land in the client's wallet.
2. The client picks a task type, fills in the form and submits. The task's
   fixed price is charged **before** it runs. Not enough credits: the task is
   rejected and nothing happens.
3. The task goes onto a queue with a concurrency cap and runs on Claude.
   Tokens and web searches are recorded and priced from Anthropic's rate
   card, so each task carries its real provider cost.
4. If the task fails, or Claude declines it, the charge is refunded in full
   and automatically.

The wallet is an append-only ledger. Every row has a unique reference, so a
replayed Stripe webhook, a double-clicked button or a crashed task can never
credit or charge twice. The balance is simply the sum of the rows.

## Try it in two minutes

```bash
cd platform
npm install
npm run dev
```

Open http://localhost:4300. Without an Anthropic key the platform runs in
**demo mode**: everything works end to end, but task results are simulated
and clearly labelled, and "Buy credits" tops up the wallet without a real
payment. The banner at the top of the page tells you which mode you are in.

## Going live

Copy `.env.example` to `.env` and fill in:

| Variable | What it does |
| --- | --- |
| `ANTHROPIC_API_KEY` | Turns on real Claude calls. Get one at console.anthropic.com. |
| `CLAUDE_MODEL` | Defaults to `claude-opus-5-5`. The price list in `src/catalog.ts` also knows `claude-sonnet-5-5` and `claude-haiku-4-5`. |
| `STRIPE_SECRET_KEY` | Turns on real Stripe Checkout. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for the `checkout.session.completed` webhook. |
| `APP_URL` | Public URL of the site, used for Stripe redirects and secure cookies. |
| `ADMIN_TOKEN` | Enables `/admin.html` and `GET /api/admin/summary`. |
| `MAX_CONCURRENT_TASKS` | How many tasks run on Claude at once (default 2). |

For Stripe, point a webhook at `POST /api/stripe/webhook` for the event
`checkout.session.completed`. Locally, the Stripe CLI does this for you:

```bash
stripe listen --forward-to localhost:4300/api/stripe/webhook
```

Every Claude request opts into Anthropic's server-side fallback
(`fallbacks: "default"`). If a safety classifier declines a request, the
API re-runs it on the recommended fallback model inside the same call rather
than failing the client's task. Remove the two lines in `src/claude.ts` if
you would rather not.

## What is sold, and for how much

Everything commercial lives in `src/catalog.ts`:

- **Credit packs**: 100 credits for $10, 550 for $50, 1200 for $100.
- **Task types**, each with a fixed credit price, an effort level and the
  prompt it builds. Shipped with four examples: polish my writing (5),
  summarize a document (8), draft an email reply (5) and a research brief
  with web search (25).
- **Provider price list**, used to turn token usage into dollars.

To add a task type, append an object to `TASK_TYPES`: a name, a blurb, a
price, the form fields and a `buildPrompt` function. The UI, validation,
charging and metering pick it up automatically.

The operator page at `/admin.html` shows credits sold, cash collected,
credits consumed, provider cost and the resulting gross margin, overall and
per task type.

## Layout

```
src/index.ts     boot: env, mode selection, listen
src/app.ts       HTTP routes (auth, catalog, wallet, tasks, Stripe webhook, admin)
src/db.ts        SQLite schema; one file is the whole state
src/auth.ts      email + password accounts, cookie sessions
src/credits.ts   the ledger: balance, charge, refund, idempotency
src/catalog.ts   packs, task types, prompts, provider prices
src/claude.ts    the one place that calls Claude; also the demo-mode runner
src/runner.ts    task queue, concurrency cap, settlement, crash recovery
src/payments.ts  Stripe Checkout and webhook handling, dev top-up
public/          the client UI (plain HTML, CSS and JavaScript)
test/            ledger and end-to-end API tests
scripts/e2e.mjs  drives the real app in a browser and saves screenshots
```

## Tests

```bash
npm test          # ledger rules, task flow, refunds, isolation, queue, recovery, admin
npm run typecheck
npm run e2e       # needs Playwright; set NODE_PATH to a global node_modules that has it
```

## Not built yet

Email verification and password reset, per-client rate limits, terms of
service and an acceptable-use check on submissions, receipts and VAT
invoices, cancelling a queued task, and a queue that survives running more
than one server process. All are straightforward additions on top of what
is here.
