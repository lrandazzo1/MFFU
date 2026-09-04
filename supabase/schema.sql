-- MFFU League Storage schema
-- Run this in Supabase SQL Editor. Browsers never receive the service-role key
-- and never query this table directly; Vercel's /api/league route is the data
-- boundary. Cookie JSON is an AES-256-GCM envelope, not plaintext credentials.

create table if not exists public.leagues (
  league_id text not null check (league_id ~ '^[0-9]{1,20}$'),
  season_year integer not null check (season_year between 1990 and 2100),
  history_json jsonb not null default '{}'::jsonb,
  cookies jsonb,
  -- Per-league share secret (H-1). The numeric ESPN league id is public — it
  -- appears in every league URL — so it can never be the thing that authorises
  -- a read of this row or a replay of the cookie envelope above. The token is
  -- 32 random bytes, base64url encoded, minted by /api/league on the first
  -- ESPN-verified member save and reused by every later save for the league.
  share_token text,
  updated_at timestamptz not null default now(),
  primary key (league_id, season_year)
);

-- Idempotent add for projects created before the share secret existed. Rows
-- left with a null share_token are legacy: /api/league still serves them to an
-- ESPN-verified member, and /api/espn refuses to lend their stored cookies to
-- anyone, until the next member save mints the league's token.
alter table public.leagues add column if not exists share_token text;

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

-- The share-token lookup is always scoped to one league id, so index the pair
-- rather than the secret alone.
create index if not exists leagues_share_token_idx
  on public.leagues (league_id, share_token);

-- ------------------------------------------------------------
-- Pre-launch waitlist. Populated only by the /api/waitlist route
-- (service-role key); browsers never write here directly.
-- ------------------------------------------------------------
create table if not exists public.waitlist_signups (
  email text primary key check (char_length(email) <= 254),
  platform text,
  source text,
  user_agent text,
  -- Optional pre-collection: commissioners can paste these ahead of launch so
  -- their desk is ready on day one. Written only via the service-role route.
  league_id text,
  espn_swid text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotent add for projects created before these columns existed.
alter table public.waitlist_signups add column if not exists league_id text;
alter table public.waitlist_signups add column if not exists espn_swid text;

alter table public.waitlist_signups enable row level security;
-- Intentionally no anon/authenticated policies: writes go through the
-- service-role key in /api/waitlist only.

drop trigger if exists mffu_touch_waitlist_updated_at on public.waitlist_signups;
create trigger mffu_touch_waitlist_updated_at
before update on public.waitlist_signups
for each row execute function public.mffu_touch_league_updated_at();

create index if not exists waitlist_created_at_idx
  on public.waitlist_signups (created_at desc);
