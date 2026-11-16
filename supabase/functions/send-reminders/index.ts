// Supabase Edge Function: send-reminders
// Runs every morning (see supabase/reminders.sql). For each phone with reminders on,
// it sends a calm heads-up when a bill is due soon and still needs money.
// Also hands the app its public key the first time reminders are turned on.
// Deploy with "Verify JWT" turned OFF so the daily schedule can call it.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const TIME_ZONE = 'America/Chicago';
const APP_URL = 'https://gregjohll-spec.github.io/budgeting-app/';
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// Make the key pair once and keep it in the private app_keys table.
async function vapidKeys() {
  const { data } = await sb.from('app_keys').select('name, value').in('name', ['vapid_public', 'vapid_private']);
  const got = Object.fromEntries((data ?? []).map((r) => [r.name, r.value]));
  if (got.vapid_public && got.vapid_private) return { pub: got.vapid_public, priv: got.vapid_private };
  const k = webpush.generateVAPIDKeys();
  const { error } = await sb.from('app_keys').insert([
    { name: 'vapid_public', value: k.publicKey },
    { name: 'vapid_private', value: k.privateKey },
  ]);
  if (error) {
    // Another call made them at the same moment: use those.
    const again = await sb.from('app_keys').select('name, value');
    const m = Object.fromEntries((again.data ?? []).map((r) => [r.name, r.value]));
    return { pub: m.vapid_public, priv: m.vapid_private };
  }
  return { pub: k.publicKey, priv: k.privateKey };
}

const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
function whenText(days: number, due: string) {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  const d = new Date(due + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const keys = await vapidKeys();
    const body = await req.json().catch(() => ({}));
    if (body?.setup) return json({ publicKey: keys.pub });

    webpush.setVapidDetails(APP_URL, keys.pub, keys.priv);
    const today = todayIso();

    const { data: subs, error } = await sb.from('push_subscriptions').select('*');
    if (error) throw error;
    if (!subs?.length) return json({ sent: 0 });

    const households = [...new Set(subs.map((s) => s.household_id))];
    const [pri, alc] = await Promise.all([
      sb.from('priorities').select('id, household_id, name, needed, due_date, paid').in('household_id', households).eq('paid', false).not('due_date', 'is', null),
      sb.from('allocations').select('priority_id, amount').in('household_id', households),
    ]);
    if (pri.error) throw pri.error;
    if (alc.error) throw alc.error;
    const setAside: Record<string, number> = {};
    for (const a of alc.data ?? []) setAside[a.priority_id] = (setAside[a.priority_id] ?? 0) + Number(a.amount);

    let sent = 0;
    for (const sub of subs) {
      for (const p of (pri.data ?? []).filter((x) => x.household_id === sub.household_id)) {
        const still = Number(p.needed) - (setAside[p.id] ?? 0);
        const days = daysBetween(today, p.due_date);
        // Remind on the chosen day before, and again the day before it's due.
        if (still <= 0 || !(days === sub.days_before || days === 1)) continue;
        // Never send the same reminder twice in one day.
        const mark = await sb.from('reminders_sent').insert({ subscription_id: sub.id, priority_id: p.id, sent_on: today }).select().maybeSingle();
        if (mark.error || !mark.data) continue;
        const payload = JSON.stringify({
          title: `Heads up: ${p.name}`,
          body: `It's due ${whenText(days, p.due_date)} and still needs ${money(still)}. Tap to see your plan.`,
        });
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
          sent++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          // The phone turned notifications off or the app was removed: forget this phone.
          if (code === 404 || code === 410) await sb.from('push_subscriptions').delete().eq('id', sub.id);
          else console.error('push failed', code, String(e));
        }
      }
    }
    return json({ sent });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
