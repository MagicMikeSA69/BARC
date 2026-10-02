// Task Desk client. Plain JavaScript on purpose: no build step, nothing to learn.

const root = document.getElementById('app');
const toastEl = document.getElementById('toast');

const state = {
  me: null, // { user, balance, mode, model, payments }
  catalog: null, // { model, packs, taskTypes }
  tasks: [],
  wallet: null, // { balance, ledger }
  view: 'catalog', // catalog | task | wallet
  typeId: null,
  task: null,
  authTab: 'signin',
  authEmail: '',
  error: null,
  busy: false,
};
const formDraft = {};
let pollTimer = null;

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (opts.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Just enough Markdown for Claude's output: headings, bullets, bold, links.
function md(text) {
  const lines = esc(text).split('\n');
  let html = '';
  let inList = false;
  for (const raw of lines) {
    const line = raw
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\s)_([^_]+)_(?=\s|$|[.,;:])/g, '$1<em>$2</em>')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${bullet[1]}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (heading) { const lvl = heading[1].length + 2; html += `<h${lvl}>${heading[2]}</h${lvl}>`; continue; }
    if (line.trim() === '') { html += '<div class="gap"></div>'; continue; }
    html += `<p>${line}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString();
}

function toast(msg, ms = 3500) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { toastEl.hidden = true; }, ms);
}

function statusLabel(s) {
  return { queued: 'Queued', running: 'Working', done: 'Done', failed: 'Failed', refused: 'Declined' }[s] || s;
}

async function refreshMe() { state.me = await api('/api/me'); }
async function refreshTasks() { state.tasks = (await api('/api/tasks')).tasks; }
async function refreshWallet() { state.wallet = await api('/api/wallet'); }

function render() {
  if (!state.me) return renderAuth();
  const demo = state.me.mode === 'mock';
  root.innerHTML = `
    <header class="topbar">
      <div class="brand">Task<span>Desk</span></div>
      <div class="right">
        <span class="pill">Balance <b id="balance">${state.me.balance}</b> credits</span>
        <button class="btn primary" data-action="wallet">Buy credits</button>
        <span class="muted small">${esc(state.me.user.email)}</span>
        <button class="btn link" data-action="logout">Sign out</button>
      </div>
    </header>
    ${demo ? `<div class="banner"><b>Demo mode.</b> No Anthropic API key is configured, so task results are simulated and labelled as such. Payments are simulated too. Add the keys to <code>.env</code> to go live.</div>` : ''}
    <div class="layout">
      <aside class="stack">
        <section class="panel">
          <h2>What do you need done?</h2>
          <div class="cards">${state.catalog.taskTypes.map((t) => `
            <button class="card ${state.view !== 'wallet' && state.typeId === t.id ? 'active' : ''}" data-action="pick" data-type="${t.id}">
              <div class="head"><span>${esc(t.name)}</span><span class="price">${t.priceCredits} credits</span></div>
              <div class="muted small">${esc(t.blurb)}</div>
            </button>`).join('')}
          </div>
        </section>
        <section class="panel">
          <h2>Your tasks</h2>
          ${state.tasks.length ? `<div class="list">${state.tasks.slice(0, 12).map((t) => `
            <button class="row" data-action="open" data-id="${t.id}">
              <span><span class="title">${esc(t.typeName)}</span><br><span class="muted small">${fmtDate(t.createdAt)}</span></span>
              <span class="chip ${t.status}">${statusLabel(t.status)}</span>
            </button>`).join('')}</div>` : `<p class="muted">Nothing yet. Pick a task type to get started.</p>`}
        </section>
      </aside>
      <main class="panel" id="main"></main>
    </div>`;
  const main = document.getElementById('main');
  if (state.view === 'wallet') renderWallet(main);
  else if (state.view === 'task' && state.task) renderTask(main);
  else renderForm(main);
}

function renderAuth() {
  const signin = state.authTab === 'signin';
  root.innerHTML = `
    <div class="auth panel stack">
      <div>
        <div class="brand" style="font-size:1.4rem">Task<span>Desk</span></div>
        <p class="muted">Buy credits, hand over a task, get the finished work back. Powered by Claude.</p>
      </div>
      <div class="tabs">
        <button type="button" class="${signin ? 'active' : ''}" data-action="tab" data-tab="signin">Sign in</button>
        <button type="button" class="${signin ? '' : 'active'}" data-action="tab" data-tab="signup">Create account</button>
      </div>
      <form id="authForm">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="email" value="${esc(state.authEmail)}" required />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="${signin ? 'current-password' : 'new-password'}" minlength="8" required />
        ${state.error ? `<div class="error">${esc(state.error)}</div>` : ''}
        <div class="actions">
          <button class="btn primary" type="submit" ${state.busy ? 'disabled' : ''}>${signin ? 'Sign in' : 'Create account'}</button>
        </div>
      </form>
    </div>`;
}

function fieldHtml(f, value = '') {
  const id = `f_${f.key}`;
  const req = f.required ? ' required' : '';
  if (f.kind === 'textarea') {
    return `<label for="${id}">${esc(f.label)}</label><textarea id="${id}" name="${f.key}" placeholder="${esc(f.placeholder || '')}"${req}>${esc(value)}</textarea>`;
  }
  if (f.kind === 'select') {
    return `<label for="${id}">${esc(f.label)}</label><select id="${id}" name="${f.key}">${(f.options || []).map((o) => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }
  return `<label for="${id}">${esc(f.label)}</label><input id="${id}" name="${f.key}" type="text" value="${esc(value)}" placeholder="${esc(f.placeholder || '')}"${req} />`;
}

function renderForm(main) {
  const t = state.catalog.taskTypes.find((x) => x.id === state.typeId) || state.catalog.taskTypes[0];
  state.typeId = t.id;
  const draft = formDraft[t.id] || {};
  const canAfford = state.me.balance >= t.priceCredits;
  main.innerHTML = `
    <div class="stack">
      <div><h1>${esc(t.name)}</h1><p class="muted">${esc(t.blurb)}</p></div>
      <form id="taskForm">
        ${t.fields.map((f) => fieldHtml(f, draft[f.key])).join('')}
        ${state.error ? `<div class="error">${esc(state.error)}</div>` : ''}
        <div class="actions">
          <button class="btn primary" type="submit" ${state.busy || !canAfford ? 'disabled' : ''}>${state.busy ? '<span class="spinner"></span> Submitting' : `Run this task for ${t.priceCredits} credits`}</button>
          ${canAfford
            ? `<span class="muted small">You have ${state.me.balance} credits. Charged now, refunded in full if the task does not complete.</span>`
            : `<span class="muted small">This needs ${t.priceCredits} credits and you have ${state.me.balance}.</span> <button class="btn" type="button" data-action="wallet">Buy credits</button>`}
        </div>
      </form>
    </div>`;
}

function renderTask(main) {
  const t = state.task;
  const live = t.status === 'queued' || t.status === 'running';
  const u = t.usage;
  main.innerHTML = `
    <div class="stack">
      <div style="display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;flex-wrap:wrap">
        <div><h1>${esc(t.typeName)}</h1><p class="muted small">Submitted ${fmtDate(t.createdAt)} · ${t.priceCredits} credits${t.refunded ? ' · <b>refunded</b>' : ''}</p></div>
        <span class="chip ${t.status}">${live ? '<span class="spinner"></span> ' : ''}${statusLabel(t.status)}</span>
      </div>
      ${live ? `<p class="muted">${t.status === 'queued' ? 'Waiting for a free slot.' : 'Claude is working on it. Longer tasks can take a few minutes; you can leave this page and come back.'}</p>` : ''}
      ${t.status === 'done' ? `<div class="output">${md(t.output || '')}</div>` : ''}
      ${t.status === 'failed' ? `<div class="error">This task failed and your ${t.priceCredits} credits were refunded.<br><span class="small">${esc(t.error || '')}</span></div>` : ''}
      ${t.status === 'refused' ? `<div class="error">Claude declined this task and your ${t.priceCredits} credits were refunded.<br><span class="small">${esc(t.error || '')}</span></div>` : ''}
      ${u ? `<div class="meta muted small">
        <span>${Number(u.input_tokens).toLocaleString()} tokens in</span>
        <span>${Number(u.output_tokens).toLocaleString()} tokens out</span>
        ${u.web_search_requests ? `<span>${u.web_search_requests} web searches</span>` : ''}
        <span>model: ${esc(u.servedBy || t.model)}</span>
      </div>` : ''}
      <details>
        <summary class="muted small">What you submitted</summary>
        <div class="output small">${Object.entries(t.input).filter(([, v]) => v).map(([k, v]) => `<p><b>${esc(k)}:</b> ${esc(v).replace(/\n/g, '<br>')}</p>`).join('')}</div>
      </details>
      <div class="actions">
        ${t.status === 'done' ? `<button class="btn" data-action="copy">Copy result</button>` : ''}
        <button class="btn" data-action="pick" data-type="${t.type}">Run another</button>
      </div>
    </div>`;
}

function ledgerLabel(e) {
  if (e.kind === 'purchase') return e.note || 'Credits purchased';
  if (e.kind === 'task_charge') return 'Task charge';
  if (e.kind === 'refund') return `Refund: ${e.note || 'task did not complete'}`;
  return e.note || e.kind;
}

function renderWallet(main) {
  const w = state.wallet;
  const dev = state.me.payments === 'dev';
  main.innerHTML = `
    <div class="stack">
      <div>
        <h1>Credits</h1>
        <p class="muted">Balance: <b>${state.me.balance}</b> credits. Buy a pack, then spend it on tasks. ${dev ? '<b>Payments are simulated</b> until Stripe keys are configured.' : 'Payments are handled by Stripe; your card never touches our servers.'}</p>
      </div>
      <div class="packs">${state.catalog.packs.map((p) => `
        <div class="pack">
          <div class="big">${p.credits} credits</div>
          <div>$${(p.usdCents / 100).toFixed(2)}</div>
          <div class="muted small">${esc(p.blurb)}</div>
          <button class="btn primary" data-action="buy" data-pack="${p.id}" ${state.busy ? 'disabled' : ''}>${dev ? 'Add (simulated)' : 'Buy'}</button>
        </div>`).join('')}
      </div>
      <h2>Ledger</h2>
      ${w && w.ledger.length
        ? `<table><thead><tr><th>When</th><th>What</th><th class="num">Credits</th></tr></thead><tbody>${w.ledger.map((e) => `
            <tr><td class="small muted">${fmtDate(e.created_at)}</td><td>${esc(ledgerLabel(e))}</td><td class="num ${e.delta >= 0 ? 'pos' : 'neg'}">${e.delta > 0 ? '+' : ''}${e.delta}</td></tr>`).join('')}</tbody></table>`
        : `<p class="muted">No activity yet.</p>`}
    </div>`;
}

async function submitAuth(fd) {
  state.authEmail = fd.get('email');
  state.busy = true;
  state.error = null;
  render();
  try {
    const path = state.authTab === 'signin' ? '/api/auth/login' : '/api/auth/signup';
    state.me = await api(path, { method: 'POST', body: { email: fd.get('email'), password: fd.get('password') } });
    await refreshTasks();
    state.view = 'catalog';
  } catch (err) {
    state.error = err.message;
  }
  state.busy = false;
  render();
}

async function submitTask(fd) {
  const input = Object.fromEntries(fd);
  formDraft[state.typeId] = input;
  state.busy = true;
  state.error = null;
  render();
  try {
    const { task, balance } = await api('/api/tasks', { method: 'POST', body: { type: state.typeId, input } });
    state.me.balance = balance;
    state.task = task;
    state.view = 'task';
    delete formDraft[state.typeId];
    await refreshTasks();
    startPolling(task.id);
  } catch (err) {
    state.error = err.status === 402 ? `${err.message} Buy more credits to run it.` : err.message;
  }
  state.busy = false;
  render();
}

async function openTask(id) {
  const { task, balance } = await api(`/api/tasks/${id}`);
  state.task = task;
  state.me.balance = balance;
  state.view = 'task';
  state.error = null;
  render();
  if (task.status === 'queued' || task.status === 'running') startPolling(id);
  else stopPolling();
}

function startPolling(id) {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const { task, balance } = await api(`/api/tasks/${id}`);
      if (!state.task || state.task.id !== id) return stopPolling();
      const changed = task.status !== state.task.status;
      state.task = task;
      state.me.balance = balance;
      if (task.status !== 'queued' && task.status !== 'running') {
        stopPolling();
        await refreshTasks();
        render();
      } else if (changed) {
        render();
      }
    } catch {
      stopPolling();
    }
  }, 1500);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function buy(packId) {
  state.busy = true;
  render();
  try {
    const r = await api('/api/wallet/checkout', { method: 'POST', body: { packId } });
    if (r.mode === 'stripe') {
      location.href = r.url;
      return;
    }
    state.me.balance = r.balance;
    toast(`Added ${r.credits} credits (simulated payment).`);
    await refreshWallet();
  } catch (err) {
    toast(err.message);
  }
  state.busy = false;
  render();
}

root.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-action]');
  if (!btn) return;
  const a = btn.dataset.action;
  try {
    if (a === 'tab') { state.authTab = btn.dataset.tab; state.error = null; render(); }
    else if (a === 'logout') {
      await api('/api/auth/logout', { method: 'POST' });
      stopPolling();
      Object.assign(state, { me: null, tasks: [], task: null, wallet: null, view: 'catalog', error: null });
      render();
    }
    else if (a === 'wallet') { state.view = 'wallet'; state.error = null; await refreshWallet(); render(); }
    else if (a === 'pick') { state.view = 'catalog'; state.typeId = btn.dataset.type; state.error = null; stopPolling(); render(); }
    else if (a === 'open') await openTask(btn.dataset.id);
    else if (a === 'buy') await buy(btn.dataset.pack);
    else if (a === 'copy') { await navigator.clipboard.writeText(state.task?.output || ''); toast('Copied.'); }
  } catch (err) {
    toast(err.message);
  }
});

root.addEventListener('submit', async (ev) => {
  if (ev.target.id === 'authForm') { ev.preventDefault(); await submitAuth(new FormData(ev.target)); }
  if (ev.target.id === 'taskForm') { ev.preventDefault(); await submitTask(new FormData(ev.target)); }
});

root.addEventListener('input', (ev) => {
  const form = ev.target.closest('#taskForm');
  if (!form || !state.typeId) return;
  formDraft[state.typeId] = Object.fromEntries(new FormData(form));
});

async function boot() {
  state.catalog = await api('/api/catalog');
  try { state.me = await api('/api/me'); } catch { state.me = null; }
  const params = new URLSearchParams(location.search);
  if (params.get('checkout') === 'success') {
    toast('Payment received. Credits appear as soon as Stripe confirms it, usually within seconds.', 6000);
    history.replaceState(null, '', '/');
    state.view = 'wallet';
    if (state.me) await refreshWallet();
  } else if (params.get('checkout') === 'cancelled') {
    toast('Checkout cancelled. Nothing was charged.');
    history.replaceState(null, '', '/');
  }
  if (state.me) await refreshTasks();
  render();
}

boot().catch((err) => {
  root.innerHTML = `<div class="auth panel"><p class="error">Could not reach the server: ${esc(err.message)}</p></div>`;
});
