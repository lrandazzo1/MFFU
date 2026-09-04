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
  -- Optional pre-collection: a commissioner can paste their League ID ahead of
  -- launch so their desk is ready on day one. Written only via the
  -- service-role route. A League ID is not a credential.
  league_id text,
  -- RETIRED — no longer written by /api/waitlist. See the purge below.
  espn_swid text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotent add for projects created before these columns existed.
alter table public.waitlist_signups add column if not exists league_id text;
alter table public.waitlist_signups add column if not exists espn_swid text;

-- ------------------------------------------------------------
-- RETIRING waitlist_signups.espn_swid
--
-- The landing form used to collect an ESPN SWID cookie in a plain text input
-- and store it here unencrypted: a persistent ESPN account identifier, in the
-- clear, beside an email address, in a marketing table. Everywhere else in
-- this codebase the same value is treated as a credential (password field,
-- AES-256-GCM at rest in public.leagues, never returned to a browser). It also
-- bought nothing — a SWID cannot read a private league without espn_s2, which
-- was never collected here.
--
-- The form and /api/waitlist no longer collect or write it, so the column
-- stops growing on deploy. Rows captured BEFORE that change still hold
-- plaintext values and are not cleaned up automatically, because dropping
-- data is not something a schema file should do to a live project without the
-- operator deciding to.
--
-- Run this once against production to clear the historical values:
--
--   update public.waitlist_signups set espn_swid = null where espn_swid is not null;
--
-- Then, once you have confirmed nothing reads it, drop the column:
--
--   alter table public.waitlist_signups drop column if exists espn_swid;
-- ------------------------------------------------------------

alter table public.waitlist_signups enable row level security;
-- Intentionally no anon/authenticated policies: writes go through the
-- service-role key in /api/waitlist only.

drop trigger if exists mffu_touch_waitlist_updated_at on public.waitlist_signups;
create trigger mffu_touch_waitlist_updated_at
before update on public.waitlist_signups
for each row execute function public.mffu_touch_league_updated_at();

create index if not exists waitlist_created_at_idx
  on public.waitlist_signups (created_at desc);
