-- Standalone FSN landing-page waitlist.
-- Run in the Supabase SQL Editor. The browser never receives the service-role key.

create table if not exists public.waitlist_signups (
  email text primary key check (char_length(email) <= 254),
  platform text,
  source text,
  user_agent text,
  league_id text,
  espn_swid text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.waitlist_signups enable row level security;

-- No anon/authenticated policies are intentional. Only the landing project's
-- server-side /api/waitlist function writes with the service-role key.

create or replace function public.fsn_touch_waitlist_updated_at()
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

drop trigger if exists fsn_touch_waitlist_updated_at on public.waitlist_signups;
create trigger fsn_touch_waitlist_updated_at
before update on public.waitlist_signups
for each row execute function public.fsn_touch_waitlist_updated_at();

create index if not exists waitlist_created_at_idx
  on public.waitlist_signups (created_at desc);
