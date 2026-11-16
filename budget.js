// Money logic for the app. Pure functions only: no screen code, no storage.
// Everything takes the household data plus "today" so it can be tested.

export const DAY = 864e5;

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
export const addDays = (d, n) => new Date(d.getTime() + n * DAY);
export function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
// Same day next month; clamps to the last day (Jan 31 -> Feb 28).
export function addMonth(d) {
  const target = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), last));
  return target;
}

const STEP = { weekly: 7, biweekly: 14 };

// The next pay date on or after `today` for a source.
export function nextPayDate(source, today) {
  let d = parseDate(source.next_date);
  const t = startOfDay(today);
  while (d < t) d = STEP[source.freq] ? addDays(d, STEP[source.freq]) : addMonth(d);
  return d;
}

// Expected paychecks (sources with no spending limit) after today, up to and including `until`.
export function upcomingPaydays(sources, today, until) {
  const t = startOfDay(today);
  const out = [];
  for (const s of sources) {
    if (s.limit_kind) continue;
    let d = parseDate(s.next_date);
    let guard = 0;
    while (d <= until && guard++ < 200) {
      if (d > t) out.push({ source: s, date: d });
      d = STEP[s.freq] ? addDays(d, STEP[s.freq]) : addMonth(d);
    }
  }
  return out.sort((a, b) => a.date - b.date);
}

export function assignedTo(priority, deposits) {
  let sum = 0;
  for (const d of deposits) sum += Number(d.alloc[priority.id] || 0);
  return sum;
}
export const remainingFor = (p, deposits) => Math.max(0, Number(p.needed) - assignedTo(p, deposits));

export function daysUntilDue(p, today) {
  if (!p.due_date) return null;
  return Math.round((parseDate(p.due_date) - startOfDay(today)) / DAY);
}

// Priorities with no due date are planned to the end of the current month (at least a week out).
export function planHorizon(p, today) {
  if (p.due_date) return parseDate(p.due_date);
  const t = startOfDay(today);
  const monthEnd = new Date(t.getFullYear(), t.getMonth() + 1, 0);
  return monthEnd - t < 7 * DAY ? addDays(t, 7) : monthEnd;
}

export const SOON_DAYS = 5;

export function statusOf(p, deposits, today) {
  if (p.paid) return 'paid';
  if (remainingFor(p, deposits) <= 0) return 'ready';
  const n = daysUntilDue(p, today);
  if (n !== null && n <= SOON_DAYS) return 'heads-up';
  return 'on-track';
}

// Measure 3: how much to set aside from each upcoming paycheck before the due date.
export function setAsidePlan(p, data, today) {
  const r = remainingFor(p, data.deposits);
  if (r <= 0 || p.paid) return null;
  const pays = upcomingPaydays(data.sources, today, planHorizon(p, today));
  if (!pays.length) return { each: r, count: 0, pays };
  return { each: Math.ceil(r / pays.length), count: pays.length, pays };
}

// Suggest how to split new money across priorities.
// Limited money (FoodShare, housing assistance) only goes to matching priorities.
// Regular money is spread across the paychecks left before each due date, then any
// money still free tops up priorities in order before anything is left to spend.
export function suggestSplit(amount, limitKind, data, today) {
  let left = Number(amount);
  const alloc = {};
  const eligible = data.priorities.filter(p => !p.paid && (!limitKind || p.kind === limitKind));
  for (const p of eligible) {
    if (left <= 0) break;
    const r = remainingFor(p, data.deposits);
    if (r <= 0) continue;
    let give;
    if (limitKind) give = r;
    else {
      const n = daysUntilDue(p, today);
      const later = upcomingPaydays(data.sources, today, planHorizon(p, today)).length;
      give = n !== null && n <= 3 ? r : Math.ceil(r / (later + 1));
    }
    give = Math.min(give, left);
    if (give > 0) {
      alloc[p.id] = give;
      left -= give;
    }
  }
  for (const p of eligible) {
    if (left <= 0) break;
    const more = Math.min(remainingFor(p, data.deposits) - (alloc[p.id] || 0), left);
    if (more > 0) {
      alloc[p.id] = (alloc[p.id] || 0) + more;
      left -= more;
    }
  }
  return alloc;
}

// Money from deposits that isn't set aside for any priority.
export function leftToSpend(deposits) {
  let t = 0;
  for (const d of deposits) {
    t += Number(d.amount);
    for (const v of Object.values(d.alloc)) t -= Number(v);
  }
  return t;
}

// The priority to show first on the home screen.
export function nextUp(data, today) {
  const open = data.priorities.filter(p => !p.paid && remainingFor(p, data.deposits) > 0);
  const dated = open.filter(p => p.due_date).sort((a, b) => daysUntilDue(a, today) - daysUntilDue(b, today));
  return dated[0] || open[0] || null;
}

// Unassigned money split by what it can be used for. FoodShare leftovers can only buy food,
// so they are not counted as money that's free to spend on anything.
export function leftByKind(deposits, sources) {
  const out = { any: 0, food: 0, housing: 0 };
  for (const d of deposits) {
    const kind = sources.find(s => s.id === d.source_id)?.limit_kind || 'any';
    let t = Number(d.amount);
    for (const v of Object.values(d.alloc)) t -= Number(v);
    out[kind] += t;
  }
  return out;
}
