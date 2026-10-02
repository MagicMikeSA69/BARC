import { buildApp } from './app.ts';
import { chooseRunner } from './claude.ts';
import { createStripeClient } from './payments.ts';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env file; environment variables are read as they are.
}

const env = process.env;
const port = Number(env.PORT ?? 4300);
const { run, mode } = chooseRunner(env);
const stripe = createStripeClient(env.STRIPE_SECRET_KEY);

const { app, runner } = await buildApp({
  dbPath: env.DB_PATH ?? 'data/platform.db',
  run,
  mode,
  model: env.CLAUDE_MODEL,
  stripe,
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
  appUrl: env.APP_URL ?? `http://localhost:${port}`,
  adminToken: env.ADMIN_TOKEN,
  concurrency: Number(env.MAX_CONCURRENT_TASKS ?? 2),
  logger: true,
});

const recovered = runner.recover();
await app.listen({ port, host: env.HOST ?? '0.0.0.0' });
app.log.info(
  `Claude: ${mode === 'live' ? 'live' : 'DEMO MODE, responses are simulated (set ANTHROPIC_API_KEY)'}; ` +
    `payments: ${stripe ? 'Stripe Checkout' : 'dev top-up, no real charges (set STRIPE_SECRET_KEY)'}; ` +
    `re-queued ${recovered} unfinished task(s)`,
);
