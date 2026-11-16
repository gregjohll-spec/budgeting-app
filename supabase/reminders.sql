-- Reminders: run this once in Supabase (SQL Editor -> New query -> paste -> Run),
-- AFTER schema.sql and AFTER deploying the send-reminders function (see README).
-- It stores which phones want reminders and checks every morning for bills that
-- are due soon and still need money.

-- Phones that turned reminders on. Each person manages only their own.
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  days_before int not null default 3 check (days_before between 1 and 7),
  created_at timestamptz not null default now()
);
alter table push_subscriptions enable row level security;
create policy "own reminders" on push_subscriptions for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and is_member(household_id));

-- Private: the reminder service's keys, and which reminders already went out.
-- Row-level security is on with no rules, so the app can't read these; only the service can.
create table app_keys (name text primary key, value text not null);
alter table app_keys enable row level security;
create table reminders_sent (
  subscription_id uuid not null references push_subscriptions(id) on delete cascade,
  priority_id uuid not null references priorities(id) on delete cascade,
  sent_on date not null,
  primary key (subscription_id, priority_id, sent_on)
);
alter table reminders_sent enable row level security;

-- The app needs the public half of the key to turn reminders on.
create or replace function vapid_public_key() returns text
language sql stable security definer set search_path = public as $$
  select value from app_keys where name = 'vapid_public';
$$;
grant execute on function vapid_public_key() to authenticated;

-- Check for reminders every day at 14:00 UTC (8 AM Central, 9 AM in summer).
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
select cron.schedule(
  'steady-budget-reminders',
  '0 14 * * *',
  $$ select net.http_post(
       url := 'https://tlnquwvdymrjpawxbplz.supabase.co/functions/v1/send-reminders',
       headers := '{"Content-Type": "application/json"}'::jsonb,
       body := '{}'::jsonb) $$
);
