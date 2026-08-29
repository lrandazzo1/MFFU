-- MFFU League Storage schema
-- Run this in Supabase SQL Editor. Browsers never receive the service-role key
-- and never query this table directly; Vercel's /api/league route is the data
-- boundary. Cookie JSON is an AES-256-GCM envelope, not plaintext credentials.

create table if not exists public.leagues (
  league_id text not null check (league_id ~ '^[0-9]{1,20}$'),
  season_year integer not null check (season_year between 1990 and 2100),
  history_json jsonb not null default '{}'::jsonb,
  cookies jsonb,
  updated_at timestamptz not null default now(),
  primary key (league_id, season_year)
);

alter table public.leagues enable row level security;

-- Intentionally no anon/authenticated policies. The service-role key is used
-- only by /api/league after authenticated ESPN league access on every write.

create or replace function public.mffu_touch_league_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists mffu_touch_league_updated_at on public.leagues;
create trigger mffu_touch_league_updated_at
before update on public.leagues
for each row execute function public.mffu_touch_league_updated_at();

create index if not exists leagues_updated_at_idx
  on public.leagues (updated_at desc);

-- ------------------------------------------------------------
-- Pre-launch waitlist. Populated only by the /api/waitlist route
-- (service-role key); browsers never write here directly.
-- ------------------------------------------------------------
create table if not exists public.waitlist_signups (
  email text primary key check (char_length(email) <= 254),
  platform text,
  source text,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.waitlist_signups enable row level security;
-- Intentionally no anon/authenticated policies: writes go through the
-- service-role key in /api/waitlist only.

drop trigger if exists mffu_touch_waitlist_updated_at on public.waitlist_signups;
create trigger mffu_touch_waitlist_updated_at
before update on public.waitlist_signups
for each row execute function public.mffu_touch_league_updated_at();

create index if not exists waitlist_created_at_idx
  on public.waitlist_signups (created_at desc);
