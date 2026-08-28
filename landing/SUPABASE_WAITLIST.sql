create table if not exists public.waitlist (
  email text primary key,
  provider text not null default 'espn' check (provider in ('espn', 'sleeper')),
  source text not null default 'landing',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.waitlist enable row level security;

-- The landing-page API writes with SUPABASE_SERVICE_ROLE_KEY server-side,
-- so no public insert policy is required and the table stays private.
