// Screens and actions. Money rules live in budget.js; storage lives in store.js.
import * as B from './budget.js';
import { SupabaseStore, DemoStore } from './store.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const live = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase);
const store = live ? new SupabaseStore(SUPABASE_URL, SUPABASE_ANON_KEY) : new DemoStore();

const ui = { tab: 'home', draft: null, edit: null, confirm: null, signIn: { step: 'email', email: '' } };
let data = null;

// ---------- small helpers ----------
const $ = id => document.getElementById(id);
const today = () => B.startOfDay(new Date());
const money = n => '$' + Math.round(Number(n)).toLocaleString('en-US');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nice = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const weekday = d => d.toLocaleDateString('en-US', { weekday: 'short' });
const KIND = { food: 'Food', housing: 'Housing', other: 'Other' };
const FREQ = { weekly: 'Every week', biweekly: 'Every 2 weeks', monthly: 'Once a month' };
const LIMIT = { food: 'Food only (FoodShare)', housing: 'Housing only (housing assistance)' };
const lowerFirst = t => t[0].toLowerCase() + t.slice(1);
const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));
const P_COLS = ['id', 'name', 'needed', 'due_date', 'kind', 'sort_order', 'paid'];
const S_COLS = ['id', 'name', 'person', 'freq', 'amount', 'next_date', 'limit_kind'];

function dueText(p) {
  const n = B.daysUntilDue(p, today());
  if (n === null) return 'Used through the month';
  if (n < 0) return 'Due date passed';
  if (n === 0) return 'Due today';
  if (n === 1) return 'Due tomorrow';
  return `Due in ${n} days (${nice(B.parseDate(p.due_date))})`;
}
function ago(ts) {
  const m = Math.round((Date.now() - new Date(ts)) / 6e4);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
function friendlyError(e) {
  const msg = String(e?.message || e);
  if (/fetch|network/i.test(msg)) return "Couldn't reach the internet. Check your connection and try again.";
  return msg.length < 140 ? msg : 'Something went wrong. Please try again.';
}

let toastTimer;
function toast(msg, undoFn, cheer) {
  const el = $('toast');
  el.innerHTML = `<span class="${cheer ? 'cheer' : ''}">${esc(msg)}</span>` + (undoFn ? '<button id="undo-btn">Undo</button>' : '');
  el.hidden = false;
  el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  if (undoFn) $('undo-btn').onclick = async () => {
    el.hidden = true;
    try { await undoFn(); await refresh(); toast('Change undone.'); } catch (e) { toast(friendlyError(e)); }
  };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 7000);
}

async function act(fn) {
  try { await fn(); } catch (e) { console.error(e); toast(friendlyError(e)); }
}
async function refresh() {
  data = await store.load();
  render();
}
const sorted = () => [...data.priorities].sort((a, b) => a.sort_order - b.sort_order);
const ctx = () => ({ priorities: sorted(), sources: data.sources, deposits: data.deposits });

// ---------- sign in and household setup (real app only) ----------
function renderSignIn() {
  $('nav').hidden = true;
  const s = ui.signIn;
  $('app').innerHTML = s.step === 'email' ? `
    <div class="card center" style="border:none;background:none;padding:0">
      <h1>Steady Budget</h1>
      <p>Plan each paycheck so your important bills are covered.</p>
      <div class="card">
        <label for="email">Your email<input id="email" type="email" autocomplete="email" value="${esc(s.email)}"></label>
        <p class="small muted">We'll email you a sign-in link and code. No password needed.</p>
        <p class="error" id="err" hidden></p>
        <button class="primary" id="send">Email me a sign-in link</button>
      </div>
    </div>` : `
    <div class="card">
      <h1>Check your email</h1>
      <p>We sent a message to <strong>${esc(s.email)}</strong>. Tap the link in it, or type the code from it here.</p>
      <label for="code">Code from the email<input id="code" inputmode="numeric" autocomplete="one-time-code"></label>
      <p class="error" id="err" hidden></p>
      <div class="btns"><button class="primary" id="verify">Sign in</button><button id="restart">Use a different email</button></div>
    </div>`;
  const err = m => { $('err').textContent = m; $('err').hidden = false; };
  if (s.step === 'email') {
    $('send').onclick = async () => {
      const email = $('email').value.trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) return err('Enter an email address like name@example.com.');
      $('send').disabled = true;
      try { await store.sendSignInLink(email); ui.signIn = { step: 'code', email }; renderSignIn(); }
      catch (e) { err(friendlyError(e)); $('send').disabled = false; }
    };
  } else {
    $('restart').onclick = () => { ui.signIn = { step: 'email', email: s.email }; renderSignIn(); };
    $('verify').onclick = async () => {
      const token = $('code').value.trim();
      if (!token) return err('Type the code from the email.');
      const { error } = await store.sb.auth.verifyOtp({ email: s.email, token, type: 'email' });
      if (error) err("That code didn't work. Check it, or ask for a new email."); else route();
    };
  }
}

function renderSetup() {
  $('nav').hidden = true;
  $('app').innerHTML = `
    <h1>Welcome</h1>
    <p>Is this the first time someone in your household is using Steady Budget?</p>
    <div class="card">
      <h2>Start a new household</h2>
      <label for="my-name">Your first name<input id="my-name" autocomplete="given-name"></label>
      <label for="hh-name">Household name<input id="hh-name" placeholder="For example: The Smith home"></label>
      <button class="primary" id="create">Start household</button>
    </div>
    <div class="card">
      <h2>Join your partner's household</h2>
      <p class="small muted">Ask them for the invite code on their Plan screen.</p>
      <label for="my-name2">Your first name<input id="my-name2" autocomplete="given-name"></label>
      <label for="invite">Invite code<input id="invite" autocapitalize="characters"></label>
      <button id="join">Join household</button>
    </div>
    <p class="error" id="err" hidden></p>
    <button class="link" id="signout">Sign out</button>`;
  const err = m => { $('err').textContent = m; $('err').hidden = false; };
  $('create').onclick = async () => {
    const me = $('my-name').value.trim(), hh = $('hh-name').value.trim() || `${me}'s household`;
    if (!me) return err('Add your first name so your partner knows who changed what.');
    try { await store.createHousehold(hh, me); await store.log('started the household'); route(); } catch (e) { err(friendlyError(e)); }
  };
  $('join').onclick = async () => {
    const me = $('my-name2').value.trim(), code = $('invite').value.trim();
    if (!me || !code) return err('Add your first name and the invite code.');
    try { await store.joinHousehold(code, me); await store.log('joined the household'); route(); } catch (e) { err(friendlyError(e)); }
  };
  $('signout').onclick = async () => { await store.signOut(); route(); };
}

// ---------- main screens ----------
function priorityCard(p) {
  const st = B.statusOf(p, data.deposits, today());
  const a = B.assignedTo(p, data.deposits), r = B.remainingFor(p, data.deposits);
  const pct = Math.min(100, Math.round((a / p.needed) * 100));
  const label = { paid: 'Paid', ready: '✓ Ready', 'heads-up': 'Needs a little more', 'on-track': 'On track' }[st];
  const chip = { paid: 'paid', ready: 'ready', 'heads-up': 'heads', 'on-track': 'track' }[st];
  const plan = B.setAsidePlan(p, ctx(), today());
  let line;
  if (p.paid) line = 'Marked as paid. Nice.';
  else if (r <= 0) line = 'All set aside.';
  else if (plan && plan.count) line = `${money(r)} to go. Set aside about ${money(plan.each)} from each of your next ${plan.count === 1 ? 'paycheck' : plan.count + ' paychecks'}.`;
  else line = `${money(r)} to go.`;
  return `<div class="row ${chip}">
    <div class="row-head"><strong>${esc(p.name)}</strong><span class="chip ${chip}">${label}</span></div>
    <div class="bar" role="img" aria-label="${pct}% set aside"><span style="width:${pct}%"></span></div>
    <div class="meta"><span class="num">${money(a)} of ${money(p.needed)}</span><span>${dueText(p)}</span></div>
    <p class="small">${line}</p>
  </div>`;
}

function renderHome() {
  const t = today(), pr = sorted();
  const next = B.nextUp(ctx(), t);
  const needs = pr.filter(p => B.statusOf(p, data.deposits, t) === 'heads-up' && p !== next).slice(0, 2);
  const ready = pr.filter(p => ['ready', 'paid'].includes(B.statusOf(p, data.deposits, t))).length;
  let nextHtml;
  if (!pr.length) nextHtml = `<div class="card next"><p class="big">Let's set up your priorities.</p><p>Start with the bills that matter most, like rent and food. Then add where your money comes from.</p><div class="btns"><button class="primary" data-go="plan">Set up my plan</button></div></div>`;
  else if (next) {
    const pays = B.upcomingPaydays(data.sources, t, B.planHorizon(next, t)).slice(0, 3).map(x => `${esc(x.source.person)} (${weekday(x.date)})`).join(', ');
    nextHtml = `<div class="card next"><p class="small muted">What needs money next</p>
      <p class="big">${esc(next.name)}: ${money(B.remainingFor(next, data.deposits))} to go</p>
      <p>${dueText(next)}.${pays ? ` Paychecks coming before then: ${pays}.` : ''}</p>
      <div class="btns"><button class="primary" data-go="add">Add money</button></div></div>`;
  } else nextHtml = `<div class="card next"><p class="big">Everything is set aside.</p><p>Every priority has the money it needs this month. That's a big deal.</p></div>`;
  const heads = needs.map(p => `<div class="card headsup"><p><strong>Heads up:</strong> ${esc(p.name)} is ${lowerFirst(dueText(p))} and still needs ${money(B.remainingFor(p, data.deposits))}. You can move money from another priority or wait for the next paycheck.</p></div>`).join('');
  const lk = B.leftByKind(data.deposits, data.sources);
  const names = data.members.map(m => m.display_name).join(' & ');
  return `
    <div class="top"><div><h1>Hi ${esc(names || data.me)}</h1><p class="muted small">${t.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}${pr.length ? ` · ${ready} of ${pr.length} priorities ready` : ''}</p></div></div>
    ${store.mode === 'demo' ? '<p class="example">This is example data saved only on this device. Once your household is connected, you\'ll both see the same real numbers.</p>' : ''}
    ${nextHtml}${heads}
    ${pr.length ? `<h2>Your priorities</h2><div class="list">${pr.map(priorityCard).join('')}</div>
    <div class="card"><div class="row-head"><strong>Left over to spend</strong><span class="num">${money(lk.any)}</span></div><p class="small muted">Money from paychecks that isn't set aside for a priority.</p>${lk.food > 0 ? `<p class="small">Plus ${money(lk.food)} of FoodShare for food only.</p>` : ''}${lk.housing > 0 ? `<p class="small">Plus ${money(lk.housing)} of housing assistance for housing only.</p>` : ''}</div>` : ''}
    ${data.activity.length ? `<div class="card"><h2>Recent changes</h2><ul class="log">${data.activity.slice(0, 6).map(l => `<li><strong>${esc(l.who)}</strong> ${esc(l.what)} <span class="muted">· ${ago(l.created_at)}</span></li>`).join('')}</ul></div>` : ''}`;
}

function renderAdd() {
  const d = ui.draft;
  if (d?.step === 'split') return renderSplit();
  if (d?.step === 'confirm') return renderConfirm();
  if (!data.priorities.length) return `<h1>Add money</h1><div class="card"><p>Add a priority first, so there's somewhere for the money to go.</p><button class="primary" data-go="plan">Go to Plan</button></div>`;
  const opts = data.sources.map(s => `<option value="${s.id}">${esc(s.name)} (usually ${money(s.amount)})</option>`).join('');
  return `<h1>Add money</h1>
    <div class="card">
      <label for="src">Where is it from?<select id="src">${opts}<option value="adhoc">Something else (one-time deposit)</option></select></label>
      <label for="adhoc-name" id="adhoc-wrap" hidden>What is it?<input id="adhoc-name" placeholder="For example: tax refund, gift"></label>
      <label for="amt">How much?<input id="amt" inputmode="decimal" class="num"></label>
      <p class="small muted" id="note"></p>
      <button class="primary" id="to-split">Show me a suggested split</button>
    </div>`;
}

function renderSplit() {
  const d = ui.draft;
  const rows = sorted().filter(p => !p.paid && (!d.limit || p.kind === d.limit) && (B.remainingFor(p, data.deposits) > 0 || d.alloc[p.id] > 0));
  const used = Object.values(d.alloc).reduce((a, b) => a + b, 0), left = d.amount - used;
  const limitWord = d.limit === 'food' ? 'food' : 'housing';
  return `<h1>Split ${money(d.amount)}</h1>
    <p class="muted">${d.limit ? `${esc(d.label)} can only be used for ${limitWord}, so it can only go to ${limitWord} priorities.` : 'Here is a suggestion based on what each priority still needs and when it is due. Change any amount.'}</p>
    <div class="card">
      ${rows.length ? rows.map(p => `<div class="split-row"><label for="a-${p.id}" style="font-weight:400">${esc(p.name)}<span class="small muted">${money(B.remainingFor(p, data.deposits))} to go · ${dueText(p)}</span></label><input id="a-${p.id}" data-pid="${p.id}" inputmode="decimal" class="num" value="${d.alloc[p.id] || 0}"></div>`).join('') : `<p>No ${d.limit ? limitWord + ' ' : ''}priorities need money right now.</p>`}
      <div class="total"><span id="left-label">${left >= 0 ? (d.limit ? `Left over (${limitWord} only)` : 'Left over to spend') : 'Over by'}</span><span class="num" id="left">${money(Math.abs(left))}</span></div>
    </div>
    <div class="btns"><button class="primary" id="to-confirm" ${left < 0 ? 'disabled' : ''}>Next</button><button id="back">Go back</button></div>`;
}

function renderConfirm() {
  const d = ui.draft;
  const parts = Object.entries(d.alloc).filter(([, v]) => v > 0).map(([id, v]) => `<li>${money(v)} to ${esc(data.priorities.find(p => p.id === id)?.name)}</li>`).join('');
  const used = Object.values(d.alloc).reduce((a, b) => a + b, 0);
  return `<h1>Does this look right?</h1>
    <div class="card"><p>This adds <strong>${money(d.amount)}</strong> from ${esc(d.label)} and sets aside:</p><ul>${parts || '<li>Nothing yet</li>'}</ul><p>${money(d.amount - used)} is left over${d.limit ? ` (${d.limit} only)` : ' to spend'}.</p><p class="small muted">You can undo this right after.</p></div>
    <div class="btns"><button class="primary" id="save-split">Yes, save it</button><button id="back">Change amounts</button></div>`;
}

function renderPlan() {
  if (ui.edit) return renderEdit();
  if (ui.confirm) return renderConfirmBox();
  const pr = sorted();
  return `<h1>Plan</h1>
    <div class="section-title"><h2>Priorities</h2><button data-edit="priority">Add</button></div>
    <p class="small muted">In order of importance. Money goes to the top ones first.</p>
    <div class="list">${pr.map((p, i) => `<div class="row">
      <div class="row-head"><strong>${i + 1}. ${esc(p.name)}</strong><span class="num">${money(p.needed)}</span></div>
      <div class="meta"><span>${dueText(p)}</span><span>${KIND[p.kind]}</span></div>
      <div class="btns">
        <button data-up="${p.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(p.name)} up">Move up</button>
        <button data-paid="${p.id}">${p.paid ? 'Not paid yet' : 'Mark as paid'}</button>
        <button data-edit="priority" data-id="${p.id}">Edit</button>
      </div></div>`).join('') || '<p>No priorities yet.</p>'}</div>
    <div class="section-title"><h2>Money coming in</h2><button data-edit="source">Add</button></div>
    <div class="list">${data.sources.map(s => `<div class="row">
      <div class="row-head"><strong>${esc(s.name)}</strong><span class="num">${money(s.amount)}</span></div>
      <div class="meta"><span>${FREQ[s.freq]} · next ${nice(B.nextPayDate(s, today()))}</span><span>${s.limit_kind ? LIMIT[s.limit_kind] : esc(s.person)}</span></div>
      <div class="btns"><button data-edit="source" data-id="${s.id}">Edit</button></div></div>`).join('') || '<p>No income added yet.</p>'}</div>
    <div class="card"><h2>Household</h2>
      <p>${data.members.map(m => esc(m.display_name)).join(' and ')}</p>
      ${data.members.length < 2 ? `<p class="small">To add your partner, have them open the app, sign in with their email, choose "Join", and enter this code:</p><p class="code">${esc(data.household.invite_code)}</p>` : ''}
      <p class="small muted">You're using the app as ${esc(data.me)}.</p>
    </div>
    <div class="card"><h2>Reminders</h2><p class="small">Calm reminders a few days before a due date, when a priority still needs money, are coming in the next update.</p></div>
    <div class="btns"><button id="new-month">Start next month</button>${store.mode === 'demo' ? '<button id="reset">Reset example data</button>' : '<button id="signout">Sign out</button>'}</div>`;
}

function renderEdit() {
  const e = ui.edit;
  if (e.type === 'priority') {
    const p = data.priorities.find(x => x.id === e.id) || { name: '', needed: '', due_date: '', kind: 'other' };
    return `<h1>${e.id ? 'Edit priority' : 'Add a priority'}</h1><div class="card">
      <label for="f-name">Name<input id="f-name" value="${esc(p.name)}" placeholder="For example: Internet"></label>
      <label for="f-needed">Amount needed this month<input id="f-needed" inputmode="decimal" class="num" value="${esc(p.needed)}"></label>
      <label for="f-due">Due date (leave empty if it's used all month, like groceries)<input id="f-due" type="date" value="${esc(p.due_date || '')}"></label>
      <label for="f-kind">Kind<select id="f-kind">${Object.entries(KIND).map(([k, v]) => `<option value="${k}" ${p.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <p class="small muted">Food and Housing matter for FoodShare and housing assistance money, which can only go to matching priorities.</p>
      <p class="error" id="err" hidden></p>
      <div class="btns"><button class="primary" id="f-save">Save</button><button id="f-cancel">Cancel</button>${e.id ? '<button class="danger" id="f-delete">Delete</button>' : ''}</div></div>`;
  }
  const s = data.sources.find(x => x.id === e.id) || { name: '', person: data.me, freq: 'biweekly', amount: '', next_date: '', limit_kind: null };
  return `<h1>${e.id ? 'Edit income' : 'Add income'}</h1><div class="card">
    <label for="f-name">Name<input id="f-name" value="${esc(s.name)}" placeholder="For example: Pat's paycheck, FoodShare"></label>
    <label for="f-person">Whose is it?<select id="f-person">${data.members.map(m => `<option ${m.display_name === s.person ? 'selected' : ''}>${esc(m.display_name)}</option>`).join('')}</select></label>
    <label for="f-freq">How often?<select id="f-freq">${Object.entries(FREQ).map(([k, v]) => `<option value="${k}" ${s.freq === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label for="f-amount">Usual amount<input id="f-amount" inputmode="decimal" class="num" value="${esc(s.amount)}"></label>
    <label for="f-next">Next pay date<input id="f-next" type="date" value="${esc(s.next_date)}"></label>
    <label for="f-limit">Can it be used for anything?<select id="f-limit"><option value="">Yes, anything</option>${Object.entries(LIMIT).map(([k, v]) => `<option value="${k}" ${s.limit_kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <p class="error" id="err" hidden></p>
    <div class="btns"><button class="primary" id="f-save">Save</button><button id="f-cancel">Cancel</button>${e.id ? '<button class="danger" id="f-delete">Delete</button>' : ''}</div></div>`;
}

function renderConfirmBox() {
  const c = ui.confirm;
  return `<h1>${esc(c.title)}</h1><div class="card"><p>${esc(c.body)}</p>
    <div class="btns"><button class="primary" id="c-yes">${esc(c.yes)}</button><button id="c-no">Cancel</button></div></div>`;
}

// ---------- render + wiring ----------
function render() {
  $('nav').hidden = false;
  $('app').innerHTML = ui.tab === 'home' ? renderHome() : ui.tab === 'add' ? renderAdd() : renderPlan();
  document.querySelectorAll('#nav button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === ui.tab ? 'page' : 'false'));
  wire();
}
function go(tab) {
  ui.tab = tab; ui.draft = null; ui.edit = null; ui.confirm = null;
  render(); window.scrollTo(0, 0);
}

function wire() {
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));

  // Add money: step 1
  if ($('src')) {
    const upd = () => {
      const s = data.sources.find(x => x.id === $('src').value);
      $('adhoc-wrap').hidden = !!s;
      $('amt').value = s ? s.amount : '';
      $('note').textContent = s?.limit_kind ? `${s.name} can only be used for ${s.limit_kind}.` : '';
    };
    $('src').onchange = upd; upd();
    $('to-split').onclick = () => {
      const s = data.sources.find(x => x.id === $('src').value), amount = parseFloat($('amt').value);
      if (!(amount > 0)) { $('note').textContent = 'Enter an amount above $0 to continue.'; return; }
      const label = s ? s.name : ($('adhoc-name').value.trim() || 'a one-time deposit');
      ui.draft = { step: 'split', source: s || null, label, amount, limit: s?.limit_kind || null, alloc: B.suggestSplit(amount, s?.limit_kind || null, ctx(), today()) };
      render();
    };
  }
  // Add money: step 2
  document.querySelectorAll('[data-pid]').forEach(inp => inp.oninput = () => {
    ui.draft.alloc[inp.dataset.pid] = Math.max(0, parseFloat(inp.value) || 0);
    const left = ui.draft.amount - Object.values(ui.draft.alloc).reduce((a, b) => a + b, 0);
    $('left').textContent = money(Math.abs(left));
    $('left-label').textContent = left >= 0 ? (ui.draft.limit ? `Left over (${ui.draft.limit} only)` : 'Left over to spend') : 'Over by';
    $('to-confirm').disabled = left < 0;
  });
  if ($('to-confirm')) $('to-confirm').onclick = () => { ui.draft.step = 'confirm'; render(); };
  if ($('back')) $('back').onclick = () => { ui.draft.step = ui.draft.step === 'confirm' ? 'split' : null; if (!ui.draft.step) ui.draft = null; render(); };
  // Add money: step 3
  if ($('save-split')) $('save-split').onclick = () => act(async () => {
    $('save-split').disabled = true;
    const d = ui.draft, t = today();
    const before = new Set(data.priorities.filter(p => B.remainingFor(p, data.deposits) <= 0).map(p => p.id));
    const alloc = Object.fromEntries(Object.entries(d.alloc).filter(([, v]) => v > 0));
    const depId = await store.addDeposit({ source_id: d.source?.id || null, label: d.label, amount: d.amount, deposit_date: B.iso(t) }, alloc);
    // Move the source's next pay date past today.
    let oldSource = null;
    if (d.source) {
      const nextDate = B.iso(B.nextPayDate(d.source, B.addDays(t, 1)));
      if (nextDate !== d.source.next_date) {
        oldSource = pick(d.source, S_COLS);
        await store.save('income_sources', { ...oldSource, next_date: nextDate });
      }
    }
    await store.log(`added ${d.label} (${money(d.amount)}) and split it`);
    ui.draft = null; ui.tab = 'home';
    await refresh(); window.scrollTo(0, 0);
    const done = data.priorities.filter(p => !p.paid && B.remainingFor(p, data.deposits) <= 0 && !before.has(p.id));
    const undo = async () => {
      await store.deleteDeposit(depId);
      if (oldSource) await store.save('income_sources', oldSource);
      await store.log(`undid adding ${d.label}`);
    };
    if (done.length) toast(done.length > 2 ? `✓ ${done.length} priorities are now fully set aside. Nice work.` : `✓ ${done.map(p => p.name).join(' and ')} ${done.length > 1 ? 'are' : 'is'} fully set aside. Nice work.`, undo, true);
    else toast('Saved. Your priorities are updated.', undo);
  });

  // Plan: priorities
  document.querySelectorAll('[data-up]').forEach(b => b.onclick = () => act(async () => {
    const pr = sorted(), i = pr.findIndex(p => p.id === b.dataset.up);
    const a = pick(pr[i - 1], P_COLS), c = pick(pr[i], P_COLS);
    // Renumber so the swap is clean even if two priorities share a number.
    const swap = async (x, y) => { await store.save('priorities', { ...x, sort_order: i }); await store.save('priorities', { ...y, sort_order: i - 1 }); };
    await swap(a, c);
    await store.log(`moved ${c.name} up`);
    await refresh();
    toast('Order changed.', async () => { await store.save('priorities', a); await store.save('priorities', c); });
  }));
  document.querySelectorAll('[data-paid]').forEach(b => b.onclick = () => act(async () => {
    const p = pick(data.priorities.find(x => x.id === b.dataset.paid), P_COLS);
    await store.save('priorities', { ...p, paid: !p.paid });
    await store.log(p.paid ? `marked ${p.name} as not paid` : `marked ${p.name} as paid`);
    await refresh();
    toast(p.paid ? `${p.name} is back on the list.` : `✓ ${p.name} is paid. One less thing to think about.`, () => store.save('priorities', p), !p.paid);
  }));
  document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { ui.edit = { type: b.dataset.edit, id: b.dataset.id || null }; render(); window.scrollTo(0, 0); });

  // Plan: edit forms
  if ($('f-save')) {
    const err = m => { $('err').textContent = m; $('err').hidden = false; };
    $('f-cancel').onclick = () => { ui.edit = null; render(); };
    $('f-save').onclick = () => act(async () => {
      const e = ui.edit, name = $('f-name').value.trim();
      if (e.type === 'priority') {
        const needed = parseFloat($('f-needed').value);
        if (!name || !(needed > 0)) return err('Add a name and an amount above $0.');
        const old = data.priorities.find(x => x.id === e.id);
        const row = { ...(old ? pick(old, P_COLS) : { paid: false, sort_order: data.priorities.length }), name, needed, due_date: $('f-due').value || null, kind: $('f-kind').value };
        const id = await store.save('priorities', row);
        await store.log(old ? `changed the priority ${name}` : `added the priority ${name}`);
        ui.edit = null; await refresh();
        toast(old ? `${name} saved.` : `${name} added.`, old ? () => store.save('priorities', pick(old, P_COLS)) : () => store.remove('priorities', id));
      } else {
        const amount = parseFloat($('f-amount').value), next_date = $('f-next').value;
        if (!name || !(amount >= 0) || !next_date) return err('Add a name, the usual amount, and the next pay date.');
        const old = data.sources.find(x => x.id === e.id);
        const row = { ...(old ? pick(old, S_COLS) : {}), name, person: $('f-person').value, freq: $('f-freq').value, amount, next_date, limit_kind: $('f-limit').value || null };
        const id = await store.save('income_sources', row);
        await store.log(old ? `changed the income ${name}` : `added the income ${name}`);
        ui.edit = null; await refresh();
        toast(`${name} saved.`, old ? () => store.save('income_sources', pick(old, S_COLS)) : () => store.remove('income_sources', id));
      }
    });
    if ($('f-delete')) $('f-delete').onclick = () => {
      const e = ui.edit, item = (e.type === 'priority' ? data.priorities : data.sources).find(x => x.id === e.id);
      ui.confirm = {
        title: `Delete ${item.name}?`,
        body: e.type === 'priority' ? `Any money set aside for ${item.name} this month goes back to "left over to spend". This can't be undone.` : `Past deposits stay, but ${item.name} won't be suggested anymore. This can't be undone.`,
        yes: 'Delete',
        run: async () => { await store.remove(e.type === 'priority' ? 'priorities' : 'income_sources', item.id); await store.log(`deleted ${item.name}`); toast(`${item.name} deleted.`); },
      };
      ui.edit = null; render();
    };
  }
  if ($('c-yes')) {
    $('c-no').onclick = () => { ui.confirm = null; render(); };
    $('c-yes').onclick = () => act(async () => { const run = ui.confirm.run; ui.confirm = null; await run(); await refresh(); });
  }
  if ($('new-month')) $('new-month').onclick = () => {
    ui.confirm = {
      title: 'Start next month?',
      body: 'This clears this month\'s money, un-marks paid bills, and moves each due date ahead one month. Your priorities and income stay. This can\'t be undone.',
      yes: 'Start next month',
      run: async () => { await store.startNewMonth(); await store.log('started a new month'); ui.tab = 'home'; toast('New month started. Same priorities, nothing set aside yet.'); },
    };
    render();
  };
  if ($('reset')) $('reset').onclick = () => act(async () => { store.resetDemo(); await refresh(); toast('Example data reset.'); });
  if ($('signout')) $('signout').onclick = () => act(async () => { await store.signOut(); route(); });
}

// ---------- start ----------
async function route() {
  try {
    const user = await store.session();
    if (!user) return renderSignIn();
    const hid = await store.findHousehold();
    if (!hid) return renderSetup();
    await refresh();
  } catch (e) {
    console.error(e);
    $('app').innerHTML = `<div class="card"><h1>Couldn't load your budget</h1><p>${esc(friendlyError(e))}</p><button class="primary" id="retry">Try again</button></div>`;
    $('retry').onclick = route;
  }
}

document.querySelectorAll('#nav button').forEach(b => b.onclick = () => go(b.dataset.tab));
if (live) {
  let signedIn = false;
  store.onAuthChange(u => { if (Boolean(u) !== signedIn) { signedIn = Boolean(u); route(); } });
  // When the other adult changes something, show it the next time this phone opens the app.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && data && !ui.draft && !ui.edit) refresh().catch(() => {}); });
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
route();
