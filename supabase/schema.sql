-- MFFU League Cloud schema
-- Run once in Supabase SQL Editor, then add SUPABASE_URL and
-- SUPABASE_SERVICE_ROLE_KEY to the deployment environment.

create table if not exists public.mffu_leagues (
  league_id text primary key check (league_id ~ '^[0-9]{1,20}$'),
  settings jsonb not null default '{}'::jsonb,
  historical_archive jsonb not null default '[]'::jsonb,
  archive_summary jsonb not null default '{}'::jsonb,
  updated_by_hash text,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.mffu_leagues enable row level security;

-- No anon/authenticated policies are intentional: browsers never talk to
-- Supabase directly. /api/league-sync is the only data boundary and uses the
-- service-role key after performing ESPN commissioner verification for writes.

create or replace function public.mffu_bump_league_version()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists mffu_bump_league_version on public.mffu_leagues;
create trigger mffu_bump_league_version
before update on public.mffu_leagues
for each row execute function public.mffu_bump_league_version();

create index if not exists mffu_leagues_updated_at_idx
  on public.mffu_leagues (updated_at desc);
