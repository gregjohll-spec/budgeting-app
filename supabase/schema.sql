-- Database setup for the budgeting app.
-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Every table belongs to one household, and only members of that household can see or change it.

create extension if not exists pgcrypto;

create table households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text not null unique default upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8)),
  created_at timestamptz not null default now()
);

create table members (
  household_id uuid not null references households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null,
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index on members(user_id);

create table income_sources (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name text not null,
  person text not null,
  freq text not null check (freq in ('weekly', 'biweekly', 'monthly')),
  amount numeric(12,2) not null check (amount >= 0),
  next_date date not null,
  -- null = can be used for anything; 'food' = FoodShare; 'housing' = housing assistance
  limit_kind text check (limit_kind in ('food', 'housing')),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

create table priorities (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name text not null,
  needed numeric(12,2) not null check (needed > 0),
  due_date date,
  kind text not null default 'other' check (kind in ('food', 'housing', 'other')),
  sort_order int not null default 0,
  paid boolean not null default false,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

create table deposits (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  source_id uuid references income_sources(id) on delete set null,
  label text not null,
  amount numeric(12,2) not null check (amount > 0),
  deposit_date date not null default current_date,
  entered_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table allocations (
  deposit_id uuid not null references deposits(id) on delete cascade,
  priority_id uuid not null references priorities(id) on delete cascade,
  household_id uuid not null references households(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  primary key (deposit_id, priority_id)
);

-- "Who entered or changed what" (Step 3 decision)
create table activity (
  id bigint generated always as identity primary key,
  household_id uuid not null references households(id) on delete cascade,
  user_id uuid references auth.users(id),
  who text not null,
  what text not null,
  created_at timestamptz not null default now()
);
create index on activity(household_id, created_at desc);

-- Access rules: a signed-in person can only reach households they belong to.
create or replace function is_member(h uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where household_id = h and user_id = auth.uid());
$$;

alter table households enable row level security;
alter table members enable row level security;
alter table income_sources enable row level security;
alter table priorities enable row level security;
alter table deposits enable row level security;
alter table allocations enable row level security;
alter table activity enable row level security;

create policy "members read their household" on households for select using (is_member(id));
create policy "members rename their household" on households for update using (is_member(id));
create policy "members see each other" on members for select using (is_member(household_id));
create policy "members update own name" on members for update using (user_id = auth.uid());

create policy "household access" on income_sources for all using (is_member(household_id)) with check (is_member(household_id));
create policy "household access" on priorities for all using (is_member(household_id)) with check (is_member(household_id));
create policy "household access" on deposits for all using (is_member(household_id)) with check (is_member(household_id));
create policy "household access" on allocations for all using (is_member(household_id)) with check (is_member(household_id));
create policy "household read" on activity for select using (is_member(household_id));
create policy "household write" on activity for insert with check (is_member(household_id) and user_id = auth.uid());

-- Start a household. The person who starts it becomes its first member.
create or replace function create_household(household_name text, my_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare h uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into households(name) values (household_name) returning id into h;
  insert into members(household_id, user_id, display_name) values (h, auth.uid(), my_name);
  return h;
end $$;

-- Join with the invite code shown in the app. Households are limited to two adults.
create or replace function join_household(code text, my_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare h uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select id into h from households where invite_code = upper(trim(code));
  if h is null then raise exception 'That code did not match a household'; end if;
  if (select count(*) from members where household_id = h) >= 2 then
    raise exception 'This household already has two people';
  end if;
  insert into members(household_id, user_id, display_name) values (h, auth.uid(), my_name)
    on conflict do nothing;
  return h;
end $$;

-- New month: no history is kept (Step 3 decision). Clears deposits, un-marks paid,
-- and moves each due date forward one month.
create or replace function start_new_month(h uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_member(h) then raise exception 'Not a member of this household'; end if;
  delete from deposits where household_id = h;
  update priorities set paid = false,
    due_date = case when due_date is null then null else (due_date + interval '1 month')::date end,
    updated_by = auth.uid(), updated_at = now()
    where household_id = h;
end $$;

grant execute on function create_household(text, text) to authenticated;
grant execute on function join_household(text, text) to authenticated;
grant execute on function start_new_month(uuid) to authenticated;
