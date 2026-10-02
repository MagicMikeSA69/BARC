// Drives the real app in a real browser and saves screenshots to docs/screenshots.
// Needs Playwright: `npm i -g playwright && playwright install chromium`, or set
// NODE_PATH to a global node_modules that has it.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = join(here, '..');
const shots = join(projectDir, 'docs', 'screenshots');
mkdirSync(shots, { recursive: true });

const PORT = Number(process.env.E2E_PORT ?? 4310);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'platform-e2e-'));

const server = spawn(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', 'src/index.ts'],
  {
    cwd: projectDir,
    env: { ...process.env, PORT: String(PORT), DB_PATH: join(dataDir, 'e2e.db'), MOCK_CLAUDE: process.env.E2E_LIVE ? '' : '1', APP_URL: BASE, STRIPE_SECRET_KEY: '', ADMIN_TOKEN: 'e2e-admin' },
    stdio: ['ignore', 'pipe', 'inherit'],
  },
);
server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/catalog`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

const SAMPLE_DOC = `Minutes, product sync, 1 October

Attendees: Mike, Thandi, Sipho.

Mike reported that sign-ups grew 18% month on month, mostly from the referral programme. Support tickets about the payment page doubled after the redesign; Thandi will roll back the checkout button change by Friday and add a regression test. Sipho proposed moving the pricing experiment to next quarter because the data pipeline is not ready; everyone agreed. We will hire one more support person once the backlog passes 200 open tickets.

Decisions: roll back the checkout button, delay the pricing experiment, revisit hiring at the next sync.`;

let exitCode = 0;
try {
  await waitForServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const log = (m) => console.log(`e2e: ${m}`);

  await page.goto(BASE);
  await page.getByText('Create account').click();
  await page.fill('#email', 'demo@example.com');
  await page.fill('#password', 'demo-password-1');
  await page.screenshot({ path: join(shots, '01-create-account.png') });
  await page.click('#authForm button[type=submit]');
  await page.waitForSelector('#balance');
  log(`signed up, balance ${await page.textContent('#balance')}`);
  await page.screenshot({ path: join(shots, '02-catalog.png'), fullPage: true });

  await page.click('button[data-action=wallet]');
  await page.waitForSelector('button[data-action=buy]');
  await page.screenshot({ path: join(shots, '03-buy-credits.png'), fullPage: true });
  await page.click('button[data-action=buy][data-pack=starter]');
  await page.waitForFunction(() => document.querySelector('#balance')?.textContent === '100');
  await page.waitForSelector('table');
  log(`bought starter pack, balance ${await page.textContent('#balance')}`);
  await page.screenshot({ path: join(shots, '04-wallet-after-purchase.png'), fullPage: true });

  await page.click('button[data-action=pick][data-type=summarize]');
  await page.fill('#f_text', SAMPLE_DOC);
  await page.fill('#f_audience', 'the leadership team');
  await page.screenshot({ path: join(shots, '05-task-form.png'), fullPage: true });
  await page.click('#taskForm button[type=submit]');
  await page.waitForSelector('.chip.queued, .chip.running');
  log('task submitted');
  await page.waitForSelector('.chip.done', { timeout: process.env.E2E_LIVE ? 600_000 : 30_000 });
  const balance = await page.textContent('#balance');
  log(`task done, balance ${balance}`);
  if (balance !== '92') throw new Error(`expected balance 92 after an 8-credit task, got ${balance}`);
  await page.screenshot({ path: join(shots, '06-task-done.png'), fullPage: true });

  await page.click('button[data-action=wallet]');
  await page.waitForSelector('table');
  await page.screenshot({ path: join(shots, '07-ledger.png'), fullPage: true });

  await page.goto(`${BASE}/admin.html`);
  await page.fill('#token', 'e2e-admin');
  await page.click('#f button[type=submit]');
  await page.waitForSelector('#out table');
  await page.screenshot({ path: join(shots, '08-operator-summary.png'), fullPage: true });

  await browser.close();
  console.log(`e2e: all steps passed; screenshots in ${shots}`);
} catch (err) {
  console.error('e2e failed:', err);
  exitCode = 1;
} finally {
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(exitCode);
