// Screens and actions. Money rules live in budget.js; storage lives in store.js.
import * as B from './budget.js';
import { SupabaseStore, DemoStore } from './store.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { icon, ring, priorityIcon, incomeIcon } from './icons.js';

const live = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase);
const store = live ? new SupabaseStore(SUPABASE_URL, SUPABASE_ANON_KEY) : new DemoStore();

const ui = { view: 'home', id: null, draft: null, edit: null, confirm: null, signIn: { step: 'email', email: '' } };
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

// ---------- shared pieces ----------
const pctOf = p => (p.paid ? 100 : Math.min(100, (B.assignedTo(p, data.deposits) / p.needed) * 100));
const isDone = p => p.paid || B.remainingFor(p, data.deposits) <= 0;
const backBar = (to = 'home', label = 'Home') => `<button class="back" data-nav="${to}">${icon('back')}${label}</button>`;
const shortDue = p => {
  const n = B.daysUntilDue(p, today());
  if (n === null) return 'All month';
  if (n < 0) return 'Past due';
  if (n === 0) return 'Due today';
  if (n === 1) return 'Due tomorrow';
  return `Due ${nice(B.parseDate(p.due_date))}`;
};
const totals = () => {
  const pr = data.priorities.filter(p => !p.paid);
  const needed = pr.reduce((a, p) => a + Number(p.needed), 0);
  const set = pr.reduce((a, p) => a + Math.min(Number(p.needed), B.assignedTo(p, data.deposits)), 0);
  return { needed, set };
};

// ---------- home: one button and five tiles ----------
function renderHome() {
  const t = today(), pr = sorted();
  const names = data.members.map(m => m.display_name).join(' & ');
  const demo = store.mode === 'demo' ? '<p class="example">Example data, saved only on this device.</p>' : '';
  if (!pr.length || !data.sources.length) return `
    <h1>Hi ${esc(data.me)}</h1>${demo}
    <div class="card setup"><h2>Let's get you set up</h2><p class="muted">Three short steps.</p>
      <ol class="steps">
        <li class="${pr.length ? 'done' : ''}"><button data-nav="priority-new">${icon(pr.length ? 'check' : 'list')}<span>Add your bills and needs</span></button></li>
        <li class="${data.sources.length ? 'done' : ''}"><button data-nav="income-new">${icon(data.sources.length ? 'check' : 'wallet')}<span>Add your income</span></button></li>
        <li><button data-nav="add" ${pr.length && data.sources.length ? '' : 'disabled'}>${icon('plus')}<span>Add your first money</span></button></li>
      </ol></div>`;
  const ready = pr.filter(isDone).length;
  const soon = pr.some(p => B.statusOf(p, data.deposits, t) === 'heads-up');
  const nextPay = data.sources.map(s => ({ s, d: B.nextPayDate(s, t) })).filter(x => !x.s.limit_kind).sort((a, b) => a.d - b.d)[0];
  const tot = totals(), lk = B.leftByKind(data.deposits, data.sources);
  const nextBill = pr.filter(p => !p.paid && p.due_date && B.daysUntilDue(p, t) >= 0).sort((a, b) => B.daysUntilDue(a, t) - B.daysUntilDue(b, t))[0];
  const tile = (nav, ic, title, sum, extra = '') => `<button class="tile" data-nav="${nav}">${extra}<span class="tile-ico">${icon(ic)}</span><span class="tile-title">${title}</span><span class="tile-sum">${sum}</span></button>`;
  return `
    <header class="hello"><h1>Hi ${esc(names || data.me)}</h1><p class="muted">${t.toLocaleDateString('en-US', { month: 'long' })}</p></header>
    ${demo}
    <button class="big-add" data-nav="add">${icon('plus')}Add money</button>
    <div class="tiles">
      ${tile('priorities', 'list', 'Priorities', `${ready} of ${pr.length} ready`, soon ? '<span class="dot" aria-label="Something is due soon"></span>' : '')}
      ${tile('income', 'wallet', 'Income', nextPay ? `Next: ${esc(nextPay.s.person)}, ${weekday(nextPay.d)}` : `${data.sources.length} sources`)}
      ${tile('setaside', 'jar', 'Set aside', `${money(tot.set)} of ${money(tot.needed)}`)}
      ${tile('available', 'coins', 'Available', `${money(lk.any)} to spend`)}
      ${tile('upcoming', 'calendar', 'Coming up', nextBill ? `${esc(nextBill.name)} · ${B.daysUntilDue(nextBill, t) <= 6 ? weekday(B.parseDate(nextBill.due_date)) : nice(B.parseDate(nextBill.due_date))}` : 'Nothing due soon')}
      ${tile('household', 'people', 'Household', esc(names || data.me))}
    </div>`;
}

// ---------- priorities ----------
function renderPriorities() {
  const pr = sorted();
  return `${backBar()}
    <div class="title-row"><h1>Priorities</h1><button class="primary small-btn" data-nav="priority-new">Add</button></div>
    <p class="muted small">Most important first.</p>
    <div class="list">${pr.map(p => {
      const st = B.statusOf(p, data.deposits, today());
      const right = p.paid ? 'Paid' : isDone(p) ? 'Ready' : `${money(B.remainingFor(p, data.deposits))} to go`;
      return `<button class="item ${st}" data-nav="priority" data-id="${p.id}">
        <span class="item-ico">${icon(priorityIcon(p))}</span>
        <span class="item-main"><span class="item-name">${esc(p.name)}</span><span class="item-sub ${st === 'heads-up' ? 'warn' : ''}">${shortDue(p)}</span></span>
        <span class="item-right">${ring(pctOf(p), 40, isDone(p))}<span class="small">${right}</span></span>
      </button>`;
    }).join('') || '<p>No priorities yet.</p>'}</div>`;
}

function renderPriority() {
  const p = data.priorities.find(x => x.id === ui.id);
  if (!p) { ui.view = 'priorities'; return renderPriorities(); }
  const a = B.assignedTo(p, data.deposits), r = B.remainingFor(p, data.deposits);
  const plan = B.setAsidePlan(p, ctx(), today());
  const pr = sorted(), i = pr.findIndex(x => x.id === p.id);
  let msg;
  if (p.paid) msg = 'Paid. One less thing to think about.';
  else if (r <= 0) msg = 'All set aside. Nice work.';
  else if (plan?.count) msg = `Set aside about <strong>${money(plan.each)}</strong> from each of your next ${plan.count === 1 ? 'paycheck' : plan.count + ' paychecks'}.`;
  else msg = `Still needs ${money(r)}.`;
  return `${backBar('priorities', 'Priorities')}
    <div class="hero">
      <div class="hero-ring">${ring(pctOf(p), 120, isDone(p))}<span class="hero-ico">${icon(priorityIcon(p))}</span></div>
      <h1>${esc(p.name)}</h1>
      <p class="hero-num">${money(Math.min(a, p.needed))} <span class="muted">of ${money(p.needed)}</span></p>
      <p class="muted">${dueText(p)}</p>
    </div>
    <div class="card soft"><p>${msg}</p></div>
    <div class="stack">
      <button class="primary" data-paid="${p.id}">${p.paid ? 'Not paid yet' : 'Mark as paid'}</button>
      <button data-edit="priority" data-id="${p.id}">Edit</button>
      ${i > 0 ? `<button data-up="${p.id}">Move up the list</button>` : ''}
    </div>`;
}

// ---------- income ----------
function renderIncome() {
  return `${backBar()}
    <div class="title-row"><h1>Income</h1><button class="primary small-btn" data-nav="income-new">Add</button></div>
    <div class="list">${data.sources.map(s => `<button class="item" data-edit="source" data-id="${s.id}">
        <span class="item-ico">${icon(incomeIcon(s))}</span>
        <span class="item-main"><span class="item-name">${esc(s.name)}</span><span class="item-sub">${FREQ[s.freq]} · next ${nice(B.nextPayDate(s, today()))}</span>${s.limit_kind ? `<span class="item-sub">${s.limit_kind === 'food' ? 'Food only' : 'Housing only'}</span>` : ''}</span>
        <span class="item-right num">${money(s.amount)}</span>
      </button>`).join('') || '<p>No income added yet.</p>'}</div>`;
}

// ---------- set aside: this month's money and where it went ----------
function renderSetAside() {
  const tot = totals(), pct = tot.needed ? (tot.set / tot.needed) * 100 : 100;
  const deps = [...data.deposits].sort((a, b) => String(b.deposit_date).localeCompare(String(a.deposit_date)));
  const pname = id => data.priorities.find(p => p.id === id)?.name || 'a removed priority';
  return `${backBar()}
    <div class="hero">
      <div class="hero-ring">${ring(pct, 120, pct >= 100)}<span class="hero-ico">${icon('jar')}</span></div>
      <h1>Set aside</h1>
      <p class="hero-num">${money(tot.set)} <span class="muted">of ${money(tot.needed)}</span></p>
      <p class="muted">for this month's priorities</p>
    </div>
    <h2>Money added this month</h2>
    <div class="list">${deps.map(d => {
      const parts = Object.entries(d.alloc).filter(([, v]) => v > 0);
      return `<details class="item-d"><summary>
          <span class="item-ico">${icon('wallet')}</span>
          <span class="item-main"><span class="item-name">${esc(d.label)}</span><span class="item-sub">${nice(B.parseDate(d.deposit_date))}</span></span>
          <span class="item-right num">${money(d.amount)}</span></summary>
        <ul class="parts">${parts.map(([id, v]) => `<li><span>${esc(pname(id))}</span><span class="num">${money(v)}</span></li>`).join('') || '<li>Nothing set aside</li>'}</ul>
        <button class="link" data-deldep="${d.id}">Remove this money</button>
      </details>`;
    }).join('') || '<p class="muted">Nothing yet. Tap Add money when you get paid.</p>'}</div>`;
}

// ---------- available ----------
function renderAvailable() {
  const lk = B.leftByKind(data.deposits, data.sources);
  return `${backBar()}
    <div class="hero">
      <div class="hero-badge">${icon('coins')}</div>
      <h1>Available</h1>
      <p class="hero-num">${money(lk.any)}</p>
      <p class="muted">free to spend after your priorities</p>
    </div>
    ${lk.food > 0 ? `<div class="card soft row-ico">${icon('cart')}<p>Plus <strong>${money(lk.food)}</strong> of FoodShare, for food only.</p></div>` : ''}
    ${lk.housing > 0 ? `<div class="card soft row-ico">${icon('house')}<p>Plus <strong>${money(lk.housing)}</strong> of housing assistance, for housing only.</p></div>` : ''}`;
}

// ---------- coming up: next two weeks of bills and paydays ----------
function renderUpcoming() {
  const t = today(), end = B.addDays(t, 14);
  const bills = data.priorities.filter(p => !p.paid && p.due_date && B.parseDate(p.due_date) <= end)
    .map(p => ({ date: B.parseDate(p.due_date), html: `<span class="item-ico">${icon(priorityIcon(p))}</span><span class="item-main"><span class="item-name">${esc(p.name)} due</span><span class="item-sub ${isDone(p) ? '' : 'warn'}">${isDone(p) ? 'Ready' : `${money(B.remainingFor(p, data.deposits))} still to set aside`}</span></span>`, id: p.id }));
  const pays = [];
  for (const s of data.sources) {
    let d = B.nextPayDate(s, t), g = 0;
    while (d <= end && g++ < 10) {
      pays.push({ date: d, html: `<span class="item-ico pay">${icon(incomeIcon(s))}</span><span class="item-main"><span class="item-name">${esc(s.name)}</span><span class="item-sub">About ${money(s.amount)} coming in</span></span>` });
      d = s.freq === 'weekly' ? B.addDays(d, 7) : s.freq === 'biweekly' ? B.addDays(d, 14) : B.addMonth(d);
    }
  }
  const all = [...bills, ...pays].sort((a, b) => a.date - b.date);
  const when = d => { const n = Math.round((d - t) / B.DAY); return n < 0 ? 'Past' : n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `${weekday(d)} ${nice(d)}`; };
  return `${backBar()}
    <h1>Coming up</h1><p class="muted">The next two weeks</p>
    <div class="list">${all.map(x => `<${x.id ? `button data-nav="priority" data-id="${x.id}"` : 'div'} class="item"><span class="when">${when(x.date)}</span>${x.html}</${x.id ? 'button' : 'div'}>`).join('') || '<p class="muted">Nothing due in the next two weeks.</p>'}</div>`;
}

// ---------- household ----------
function renderHousehold() {
  return `${backBar()}
    <div class="hero">
      <div class="hero-badge">${icon('people')}</div>
      <h1>${esc(data.household?.name || 'Household')}</h1>
      <p class="muted">${data.members.map(m => esc(m.display_name)).join(' and ')}</p>
    </div>
    ${data.members.length < 2 ? `<div class="card"><h2>Invite your partner</h2><p class="small">They sign in with their own email, tap "Join", and enter:</p><p class="code">${esc(data.household.invite_code)}</p></div>` : ''}
    ${data.activity.length ? `<details class="card"><summary><h2>Recent changes</h2></summary><ul class="log">${data.activity.slice(0, 8).map(l => `<li><strong>${esc(l.who)}</strong> ${esc(l.what)} <span class="muted">· ${ago(l.created_at)}</span></li>`).join('')}</ul></details>` : ''}
    <div class="stack">
      <button id="new-month">Start next month</button>
      ${store.mode === 'demo' ? '<button id="reset">Reset example data</button>' : '<button id="signout">Sign out</button>'}
    </div>
    <p class="small muted center-text">Signed in as ${esc(data.me)}</p>`;
}

// ---------- add money: one question per screen ----------
function renderAdd() {
  const d = ui.draft;
  if (d?.step === 'amount') return renderAmount();
  if (d?.step === 'split') return renderSplit();
  return `${backBar()}
    <h1>Where's the money from?</h1>
    <div class="choices">
      ${data.sources.map(s => `<button class="choice" data-src="${s.id}"><span class="item-ico">${icon(incomeIcon(s))}</span><span class="item-name">${esc(s.name)}</span></button>`).join('')}
      <button class="choice" data-src="adhoc"><span class="item-ico">${icon('gift')}</span><span class="item-name">Something else</span></button>
    </div>`;
}

function renderAmount() {
  const d = ui.draft;
  return `<button class="back" id="back">${icon('back')}Back</button>
    <h1>How much${d.source ? ` is ${esc(d.source.name)}` : ''}?</h1>
    ${d.source ? '' : '<label for="adhoc-name">What is it?<input id="adhoc-name" placeholder="Tax refund, gift…"></label>'}
    <label class="money-in" for="amt"><span>$</span><input id="amt" inputmode="decimal" class="num" value="${d.amount || ''}" aria-label="Amount in dollars"></label>
    ${d.limit ? `<p class="muted">This can only go to ${d.limit} priorities.</p>` : ''}
    <p class="error" id="err" hidden></p>
    <button class="primary" id="to-split">Next</button>`;
}

function renderSplit() {
  const d = ui.draft;
  const rows = sorted().filter(p => !p.paid && (!d.limit || p.kind === d.limit) && (B.remainingFor(p, data.deposits) > 0 || d.alloc[p.id] > 0));
  const used = Object.values(d.alloc).reduce((a, b) => a + b, 0), left = d.amount - used;
  const leftWord = d.limit ? `Left over (${d.limit} only)` : 'Left to spend';
  return `<button class="back" id="back">${icon('back')}Back</button>
    <h1>Here's a suggested split</h1>
    <p class="muted">Change any amount if you like.</p>
    <div class="card">
      ${rows.length ? rows.map(p => `<div class="split-row"><label for="a-${p.id}"><span class="item-ico sm">${icon(priorityIcon(p))}</span><span>${esc(p.name)}</span></label><input id="a-${p.id}" data-pid="${p.id}" inputmode="decimal" class="num" value="${d.alloc[p.id] || 0}"></div>`).join('') : `<p>No ${d.limit ? d.limit + ' ' : ''}priorities need money right now.</p>`}
      <div class="total"><span id="left-label">${left >= 0 ? leftWord : 'Over by'}</span><span class="num" id="left">${money(Math.abs(left))}</span></div>
    </div>
    <button class="primary" id="save-split" ${left < 0 ? 'disabled' : ''}>Save</button>`;
}

// ---------- forms (unchanged fields, simpler words) ----------
function renderEdit() {
  const e = ui.edit;
  if (e.type === 'priority') {
    const p = data.priorities.find(x => x.id === e.id) || { name: '', needed: '', due_date: '', kind: 'other' };
    return `<button class="back" id="f-cancel">${icon('back')}Cancel</button>
      <h1>${e.id ? 'Edit priority' : 'Add a priority'}</h1><div class="card">
      <label for="f-name">What is it?<input id="f-name" value="${esc(p.name)}" placeholder="Rent, groceries, phone…"></label>
      <label for="f-needed">How much this month?<input id="f-needed" inputmode="decimal" class="num" value="${esc(p.needed)}"></label>
      <label for="f-due">Due date <span class="muted small">(skip if it's spent all month)</span><input id="f-due" type="date" value="${esc(p.due_date || '')}"></label>
      <label for="f-kind">Type<select id="f-kind">${Object.entries(KIND).map(([k, v]) => `<option value="${k}" ${p.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <p class="error" id="err" hidden></p>
      <button class="primary" id="f-save">Save</button>${e.id ? '<button class="link danger" id="f-delete">Delete this priority</button>' : ''}</div>`;
  }
  const s = data.sources.find(x => x.id === e.id) || { name: '', person: data.me, freq: 'biweekly', amount: '', next_date: '', limit_kind: null };
  return `<button class="back" id="f-cancel">${icon('back')}Cancel</button>
    <h1>${e.id ? 'Edit income' : 'Add income'}</h1><div class="card">
    <label for="f-name">Name<input id="f-name" value="${esc(s.name)}" placeholder="Pat's paycheck, FoodShare…"></label>
    <label for="f-person">Whose?<select id="f-person">${data.members.map(m => `<option ${m.display_name === s.person ? 'selected' : ''}>${esc(m.display_name)}</option>`).join('')}</select></label>
    <label for="f-freq">How often?<select id="f-freq">${Object.entries(FREQ).map(([k, v]) => `<option value="${k}" ${s.freq === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label for="f-amount">Usual amount<input id="f-amount" inputmode="decimal" class="num" value="${esc(s.amount)}"></label>
    <label for="f-next">Next pay date<input id="f-next" type="date" value="${esc(s.next_date)}"></label>
    <label for="f-limit">What can it pay for?<select id="f-limit"><option value="">Anything</option>${Object.entries(LIMIT).map(([k, v]) => `<option value="${k}" ${s.limit_kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <p class="error" id="err" hidden></p>
    <button class="primary" id="f-save">Save</button>${e.id ? '<button class="link danger" id="f-delete">Delete this income</button>' : ''}</div>`;
}

function renderConfirmBox() {
  const c = ui.confirm;
  return `<h1>${esc(c.title)}</h1><div class="card"><p>${esc(c.body)}</p>
    <div class="stack"><button class="primary" id="c-yes">${esc(c.yes)}</button><button id="c-no">Cancel</button></div></div>`;
}

// ---------- render + wiring ----------
const VIEWS = { home: renderHome, priorities: renderPriorities, priority: renderPriority, income: renderIncome, setaside: renderSetAside, available: renderAvailable, household: renderHousehold, upcoming: renderUpcoming, add: renderAdd };
function render() {
  $('nav').hidden = false;
  $('app').innerHTML = ui.confirm ? renderConfirmBox() : ui.edit ? renderEdit() : (VIEWS[ui.view] || renderHome)();
  document.querySelectorAll('#nav button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === (ui.view === 'add' ? 'add' : 'home') && !ui.edit ? 'page' : 'false'));
  wire();
}
function go(view, id = null) {
  if (view === 'priority-new') { ui.edit = { type: 'priority', id: null, back: ui.view }; render(); return window.scrollTo(0, 0); }
  if (view === 'income-new') { ui.edit = { type: 'source', id: null, back: ui.view }; render(); return window.scrollTo(0, 0); }
  ui.view = view; ui.id = id; ui.draft = null; ui.edit = null; ui.confirm = null;
  render(); window.scrollTo(0, 0);
}

function wire() {
  document.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => go(b.dataset.nav, b.dataset.id || null));

  // Add money: pick a source
  document.querySelectorAll('[data-src]').forEach(b => b.onclick = () => {
    const s = data.sources.find(x => x.id === b.dataset.src) || null;
    ui.draft = { step: 'amount', source: s, label: s?.name || '', amount: s ? Number(s.amount) : 0, limit: s?.limit_kind || null, alloc: {} };
    render();
  });
  if ($('back')) $('back').onclick = () => { ui.draft.step = ui.draft.step === 'split' ? 'amount' : null; if (!ui.draft.step) ui.draft = null; render(); };
  if ($('to-split')) $('to-split').onclick = () => {
    const amount = parseFloat($('amt').value), d = ui.draft;
    if (!(amount > 0)) { $('err').textContent = 'Enter an amount above $0.'; $('err').hidden = false; return; }
    if (!d.source) d.label = $('adhoc-name').value.trim() || 'One-time money';
    Object.assign(d, { step: 'split', amount, alloc: B.suggestSplit(amount, d.limit, ctx(), today()) });
    render();
  };
  document.querySelectorAll('[data-pid]').forEach(inp => inp.oninput = () => {
    ui.draft.alloc[inp.dataset.pid] = Math.max(0, parseFloat(inp.value) || 0);
    const left = ui.draft.amount - Object.values(ui.draft.alloc).reduce((a, b) => a + b, 0);
    $('left').textContent = money(Math.abs(left));
    $('left-label').textContent = left >= 0 ? (ui.draft.limit ? `Left over (${ui.draft.limit} only)` : 'Left to spend') : 'Over by';
    $('save-split').disabled = left < 0;
  });
  if ($('save-split')) $('save-split').onclick = () => act(async () => {
    $('save-split').disabled = true;
    const d = ui.draft, t = today();
    const before = new Set(data.priorities.filter(p => B.remainingFor(p, data.deposits) <= 0).map(p => p.id));
    const alloc = Object.fromEntries(Object.entries(d.alloc).filter(([, v]) => v > 0));
    const depId = await store.addDeposit({ source_id: d.source?.id || null, label: d.label, amount: d.amount, deposit_date: B.iso(t) }, alloc);
    let oldSource = null;
    if (d.source) {
      const nextDate = B.iso(B.nextPayDate(d.source, B.addDays(t, 1)));
      if (nextDate !== d.source.next_date) {
        oldSource = pick(d.source, S_COLS);
        await store.save('income_sources', { ...oldSource, next_date: nextDate });
      }
    }
    await store.log(`added ${d.label} (${money(d.amount)})`);
    ui.draft = null; ui.view = 'home';
    await refresh(); window.scrollTo(0, 0);
    const done = data.priorities.filter(p => !p.paid && B.remainingFor(p, data.deposits) <= 0 && !before.has(p.id));
    const undo = async () => {
      await store.deleteDeposit(depId);
      if (oldSource) await store.save('income_sources', oldSource);
      await store.log(`undid adding ${d.label}`);
    };
    if (done.length) toast(done.length > 2 ? `✓ ${done.length} priorities are now ready. Nice work.` : `✓ ${done.map(p => p.name).join(' and ')} ${done.length > 1 ? 'are' : 'is'} ready. Nice work.`, undo, true);
    else toast('Saved.', undo);
  });

  // Priority screen actions
  document.querySelectorAll('[data-up]').forEach(b => b.onclick = () => act(async () => {
    const pr = sorted(), i = pr.findIndex(p => p.id === b.dataset.up);
    const a = pick(pr[i - 1], P_COLS), c = pick(pr[i], P_COLS);
    await store.save('priorities', { ...a, sort_order: i });
    await store.save('priorities', { ...c, sort_order: i - 1 });
    await store.log(`moved ${c.name} up`);
    await refresh();
    toast(`${c.name} moved up.`, async () => { await store.save('priorities', a); await store.save('priorities', c); });
  }));
  document.querySelectorAll('[data-paid]').forEach(b => b.onclick = () => act(async () => {
    const p = pick(data.priorities.find(x => x.id === b.dataset.paid), P_COLS);
    await store.save('priorities', { ...p, paid: !p.paid });
    await store.log(p.paid ? `marked ${p.name} as not paid` : `marked ${p.name} as paid`);
    await refresh();
    toast(p.paid ? `${p.name} is back on the list.` : `✓ ${p.name} is paid.`, () => store.save('priorities', p), !p.paid);
  }));
  document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { ui.edit = { type: b.dataset.edit, id: b.dataset.id || null }; render(); window.scrollTo(0, 0); });

  // Set aside: remove a deposit
  document.querySelectorAll('[data-deldep]').forEach(b => b.onclick = () => {
    const dep = data.deposits.find(d => d.id === b.dataset.deldep);
    ui.confirm = {
      title: `Remove ${dep.label}?`,
      body: `This takes ${money(dep.amount)} out of this month, along with what it set aside. This can't be undone.`,
      yes: 'Remove it',
      run: async () => { await store.deleteDeposit(dep.id); await store.log(`removed ${dep.label} (${money(dep.amount)})`); toast(`${dep.label} removed.`); },
    };
    render();
  });

  // Forms
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
        await store.log(old ? `changed ${name}` : `added ${name}`);
        ui.edit = null; if (ui.view === 'home' && !old) ui.view = data.sources.length ? 'priorities' : 'home';
        await refresh();
        toast(old ? `${name} saved.` : `${name} added.`, old ? () => store.save('priorities', pick(old, P_COLS)) : () => store.remove('priorities', id));
      } else {
        const amount = parseFloat($('f-amount').value), next_date = $('f-next').value;
        if (!name || !(amount >= 0) || !next_date) return err('Add a name, the usual amount, and the next pay date.');
        const old = data.sources.find(x => x.id === e.id);
        const row = { ...(old ? pick(old, S_COLS) : {}), name, person: $('f-person').value, freq: $('f-freq').value, amount, next_date, limit_kind: $('f-limit').value || null };
        const id = await store.save('income_sources', row);
        await store.log(old ? `changed ${name}` : `added ${name}`);
        ui.edit = null; await refresh();
        toast(`${name} saved.`, old ? () => store.save('income_sources', pick(old, S_COLS)) : () => store.remove('income_sources', id));
      }
    });
    if ($('f-delete')) $('f-delete').onclick = () => {
      const e = ui.edit, item = (e.type === 'priority' ? data.priorities : data.sources).find(x => x.id === e.id);
      ui.confirm = {
        title: `Delete ${item.name}?`,
        body: e.type === 'priority' ? `Money set aside for ${item.name} goes back to Available. This can't be undone.` : `Money already added stays. ${item.name} just won't be listed anymore. This can't be undone.`,
        yes: 'Delete',
        run: async () => {
          await store.remove(e.type === 'priority' ? 'priorities' : 'income_sources', item.id);
          await store.log(`deleted ${item.name}`);
          if (ui.view === 'priority') ui.view = 'priorities';
          toast(`${item.name} deleted.`);
        },
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
      body: 'This clears this month\'s money, un-marks paid bills, and moves due dates ahead one month. Your priorities and income stay. This can\'t be undone.',
      yes: 'Start next month',
      run: async () => { await store.startNewMonth(); await store.log('started a new month'); ui.view = 'home'; toast('New month started.'); },
    };
    render();
  };
  if ($('reset')) $('reset').onclick = () => act(async () => { store.resetDemo(); ui.view = 'home'; await refresh(); toast('Example data reset.'); });
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
