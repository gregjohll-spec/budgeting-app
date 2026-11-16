// Where the household's data lives.
// - SupabaseStore: the real app. Data is shared online between the two adults.
// - DemoStore: used when config.js has no Supabase details yet. Example data, saved only on this device.
// Both have the same methods, so the screens don't care which one is in use.

import { iso, startOfDay, addDays } from './budget.js';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

function shapeDeposits(rows, allocRows) {
  const byDep = {};
  for (const a of allocRows) (byDep[a.deposit_id] ||= {})[a.priority_id] = Number(a.amount);
  return rows.map(d => ({ ...d, amount: Number(d.amount), alloc: byDep[d.id] || {} }));
}

export class SupabaseStore {
  constructor(url, key) {
    this.mode = 'live';
    this.sb = window.supabase.createClient(url, key);
    this.user = null;
    this.householdId = null;
    this.me = null;
  }
  async session() {
    const { data } = await this.sb.auth.getSession();
    this.user = data.session?.user || null;
    return this.user;
  }
  onAuthChange(cb) {
    this.sb.auth.onAuthStateChange((_e, s) => {
      this.user = s?.user || null;
      cb(this.user);
    });
  }
  async sendSignInLink(email) {
    const { error } = await this.sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: location.origin + location.pathname },
    });
    if (error) throw error;
  }
  async signOut() {
    await this.sb.auth.signOut();
    this.user = null;
    this.householdId = null;
  }
  async findHousehold() {
    const { data, error } = await this.sb.from('members').select('household_id, display_name').eq('user_id', this.user.id).limit(1);
    if (error) throw error;
    if (!data.length) return null;
    this.householdId = data[0].household_id;
    this.me = data[0].display_name;
    return this.householdId;
  }
  async createHousehold(name, myName) {
    const { data, error } = await this.sb.rpc('create_household', { household_name: name, my_name: myName });
    if (error) throw error;
    this.householdId = data;
    this.me = myName;
    return data;
  }
  async joinHousehold(code, myName) {
    const { data, error } = await this.sb.rpc('join_household', { code, my_name: myName });
    if (error) throw error;
    this.householdId = data;
    this.me = myName;
    return data;
  }
  async load() {
    const h = this.householdId;
    const q = (t, sel = '*') => this.sb.from(t).select(sel).eq('household_id', h);
    const [hh, mem, src, pri, dep, alc, act] = await Promise.all([
      this.sb.from('households').select('*').eq('id', h).single(),
      q('members', 'user_id, display_name'),
      q('income_sources').order('name'),
      q('priorities').order('sort_order'),
      q('deposits').order('created_at'),
      q('allocations'),
      q('activity').order('created_at', { ascending: false }).limit(15),
    ]);
    for (const r of [hh, mem, src, pri, dep, alc, act]) if (r.error) throw r.error;
    return {
      household: hh.data,
      me: this.me,
      members: mem.data,
      sources: src.data.map(s => ({ ...s, amount: Number(s.amount) })),
      priorities: pri.data.map(p => ({ ...p, needed: Number(p.needed) })),
      deposits: shapeDeposits(dep.data, alc.data),
      activity: act.data,
    };
  }
  stamp() {
    return { updated_by: this.user.id, updated_at: new Date().toISOString() };
  }
  async log(what) {
    await this.sb.from('activity').insert({ household_id: this.householdId, user_id: this.user.id, who: this.me, what });
  }
  async addDeposit(dep, alloc) {
    const { data, error } = await this.sb.from('deposits')
      .insert({ ...dep, household_id: this.householdId, entered_by: this.user.id }).select('id').single();
    if (error) throw error;
    const rows = Object.entries(alloc).filter(([, v]) => v > 0)
      .map(([priority_id, amount]) => ({ deposit_id: data.id, priority_id, amount, household_id: this.householdId }));
    if (rows.length) {
      const r = await this.sb.from('allocations').insert(rows);
      if (r.error) {
        await this.sb.from('deposits').delete().eq('id', data.id);
        throw r.error;
      }
    }
    return data.id;
  }
  async deleteDeposit(id) {
    const { error } = await this.sb.from('deposits').delete().eq('id', id);
    if (error) throw error;
  }
  async save(table, row) {
    const body = { ...row, household_id: this.householdId, ...this.stamp() };
    const { data, error } = await this.sb.from(table).upsert(body).select('id').single();
    if (error) throw error;
    return data.id;
  }
  async remove(table, id) {
    const { error } = await this.sb.from(table).delete().eq('id', id);
    if (error) throw error;
  }
  async startNewMonth() {
    const { error } = await this.sb.rpc('start_new_month', { h: this.householdId });
    if (error) throw error;
  }
  // Reminders (see supabase/reminders.sql and supabase/functions/send-reminders)
  async vapidKey() {
    const { data, error } = await this.sb.rpc('vapid_public_key');
    if (error) throw error;
    if (data) return data;
    const r = await this.sb.functions.invoke('send-reminders', { body: { setup: true } });
    if (r.error) throw r.error;
    return r.data.publicKey;
  }
  async reminderFor(endpoint) {
    const { data, error } = await this.sb.from('push_subscriptions').select('days_before').eq('endpoint', endpoint).maybeSingle();
    if (error) throw error;
    return data;
  }
  async saveReminder(sub, days) {
    const j = sub.toJSON();
    const { error } = await this.sb.from('push_subscriptions').upsert({
      household_id: this.householdId, user_id: this.user.id, endpoint: j.endpoint,
      p256dh: j.keys.p256dh, auth: j.keys.auth, days_before: days,
    }, { onConflict: 'endpoint' });
    if (error) throw error;
  }
  async removeReminder(endpoint) {
    const { error } = await this.sb.from('push_subscriptions').delete().eq('endpoint', endpoint);
    if (error) throw error;
  }
  async renameMe(name) {
    await this.sb.from('members').update({ display_name: name }).eq('user_id', this.user.id).eq('household_id', this.householdId);
    this.me = name;
  }
}

const DEMO_KEY = 'budgeting-app-demo-v1';

export class DemoStore {
  constructor() {
    this.mode = 'demo';
    this.me = 'Jamie';
    try { this.db = JSON.parse(localStorage.getItem(DEMO_KEY)); } catch { this.db = null; }
    if (!this.db?.priorities) this.db = demoData();
  }
  persist() {
    try { localStorage.setItem(DEMO_KEY, JSON.stringify(this.db)); } catch { /* storage blocked: demo still works for this visit */ }
  }
  async session() { return { id: 'demo' }; }
  onAuthChange() {}
  async findHousehold() { return 'demo'; }
  async load() {
    const d = structuredClone(this.db);
    return { ...d, me: this.me, priorities: d.priorities.sort((a, b) => a.sort_order - b.sort_order) };
  }
  async log(what) {
    this.db.activity.unshift({ who: this.me, what, created_at: new Date().toISOString() });
    this.db.activity = this.db.activity.slice(0, 15);
    this.persist();
  }
  async addDeposit(dep, alloc) {
    const id = uid();
    this.db.deposits.push({ ...dep, id, entered_by: this.me, created_at: new Date().toISOString(), alloc: { ...alloc } });
    this.persist();
    return id;
  }
  async deleteDeposit(id) {
    this.db.deposits = this.db.deposits.filter(d => d.id !== id);
    this.persist();
  }
  async save(table, row) {
    const list = this.db[table === 'income_sources' ? 'sources' : 'priorities'];
    const id = row.id || uid();
    const i = list.findIndex(x => x.id === id);
    if (i >= 0) list[i] = { ...list[i], ...row };
    else list.push({ ...row, id });
    this.persist();
    return id;
  }
  async remove(table, id) {
    const key = table === 'income_sources' ? 'sources' : 'priorities';
    this.db[key] = this.db[key].filter(x => x.id !== id);
    if (key === 'priorities') for (const d of this.db.deposits) delete d.alloc[id];
    this.persist();
  }
  async startNewMonth() {
    this.db.deposits = [];
    for (const p of this.db.priorities) {
      p.paid = false;
      if (p.due_date) {
        const [y, m, d] = p.due_date.split('-').map(Number);
        const last = new Date(y, m + 1, 0).getDate();
        p.due_date = iso(new Date(y, m, Math.min(d, last)));
      }
    }
    this.persist();
  }
  async renameMe(name) { this.me = name; }
  resetDemo() { this.db = demoData(); this.persist(); }
}

function demoData() {
  const t = startOfDay(new Date());
  const off = n => iso(addDays(t, n));
  const P = { rent: uid(), elec: uid(), food: uid(), car: uid(), phone: uid(), gas: uid() };
  const S = { jamie: uid(), pat: uid(), fs: uid(), ha: uid() };
  const ago = n => addDays(t, -n).toISOString();
  return {
    household: { id: 'demo', name: 'Example household', invite_code: 'EXAMPLE1' },
    members: [{ user_id: 'a', display_name: 'Jamie' }, { user_id: 'b', display_name: 'Pat' }],
    sources: [
      { id: S.jamie, name: "Jamie's paycheck", person: 'Jamie', freq: 'biweekly', amount: 1150, next_date: off(3), limit_kind: null },
      { id: S.pat, name: "Pat's paycheck", person: 'Pat', freq: 'weekly', amount: 480, next_date: off(1), limit_kind: null },
      { id: S.fs, name: 'FoodShare', person: 'Pat', freq: 'monthly', amount: 290, next_date: off(19), limit_kind: 'food' },
      { id: S.ha, name: 'Housing assistance', person: 'Jamie', freq: 'monthly', amount: 300, next_date: off(14), limit_kind: 'housing' },
    ],
    priorities: [
      { id: P.rent, name: 'Rent', needed: 1200, due_date: off(15), kind: 'housing', sort_order: 0, paid: false },
      { id: P.elec, name: 'Electric bill', needed: 110, due_date: off(4), kind: 'other', sort_order: 1, paid: false },
      { id: P.food, name: 'Groceries', needed: 800, due_date: null, kind: 'food', sort_order: 2, paid: false },
      { id: P.car, name: 'Car insurance', needed: 140, due_date: off(6), kind: 'other', sort_order: 3, paid: false },
      { id: P.phone, name: 'Phone', needed: 85, due_date: off(9), kind: 'other', sort_order: 4, paid: false },
      { id: P.gas, name: 'Gas for the car', needed: 160, due_date: null, kind: 'other', sort_order: 5, paid: false },
    ],
    deposits: [
      { id: uid(), source_id: S.ha, label: 'Housing assistance', amount: 300, deposit_date: off(-15), entered_by: 'Jamie', alloc: { [P.rent]: 300 } },
      { id: uid(), source_id: S.jamie, label: "Jamie's paycheck", amount: 1150, deposit_date: off(-11), entered_by: 'Jamie', alloc: { [P.rent]: 500, [P.elec]: 60, [P.phone]: 85, [P.car]: 70, [P.gas]: 80, [P.food]: 320 } },
      { id: uid(), source_id: S.fs, label: 'FoodShare', amount: 290, deposit_date: off(-10), entered_by: 'Pat', alloc: { [P.food]: 290 } },
      { id: uid(), source_id: S.pat, label: "Pat's paycheck", amount: 480, deposit_date: off(-6), entered_by: 'Pat', alloc: { [P.rent]: 250, [P.gas]: 40, [P.car]: 30, [P.food]: 140 } },
    ],
    activity: [
      { who: 'Pat', what: "added Pat's paycheck ($480) and split it", created_at: ago(6) },
      { who: 'Jamie', what: "added Jamie's paycheck ($1,150) and split it", created_at: ago(11) },
    ],
  };
}
