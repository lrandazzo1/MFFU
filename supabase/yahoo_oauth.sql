-- MFFU Yahoo OAuth credential storage
-- Run this migration in the Supabase SQL Editor after supabase/schema.sql.
-- Browsers have no policies on either table. Only Vercel serverless functions
-- holding SUPABASE_SERVICE_ROLE_KEY can read or write these rows.
-- access_token and refresh_token contain AES-256-GCM JSON envelopes generated
-- with YAHOO_TOKEN_ENCRYPTION_KEY; plaintext OAuth credentials are never stored.

create table if not exists public.yahoo_oauth_tokens (
  yahoo_user_id text primary key check (char_length(yahoo_user_id) between 1 and 255),
  access_token jsonb not null,
  refresh_token jsonb not null,
  token_expiry timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint yahoo_access_token_envelope_check
    check (access_token ->> 'alg' = 'A256GCM' and access_token ->> 'v' = '1'),
  constraint yahoo_refresh_token_envelope_check
    check (refresh_token ->> 'alg' = 'A256GCM' and refresh_token ->> 'v' = '1')
);

create table if not exists public.yahoo_oauth_sessions (
  session_hash text primary key check (session_hash ~ '^[a-f0-9]{64}$'),
  yahoo_user_id text not null references public.yahoo_oauth_tokens(yahoo_user_id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (session_hash, yahoo_user_id)
);

alter table public.yahoo_oauth_tokens enable row level security;
alter table public.yahoo_oauth_sessions enable row level security;

-- Intentionally no anon or authenticated policies. The service-role boundary is
-- /api/auth/yahoo and /api/yahoo; neither endpoint returns token envelopes.

create or replace function public.mffu_touch_yahoo_token_updated_at()
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

drop trigger if exists mffu_touch_yahoo_token_updated_at on public.yahoo_oauth_tokens;
create trigger mffu_touch_yahoo_token_updated_at
before update on public.yahoo_oauth_tokens
for each row execute function public.mffu_touch_yahoo_token_updated_at();

create index if not exists yahoo_oauth_tokens_expiry_idx
  on public.yahoo_oauth_tokens (token_expiry);

create index if not exists yahoo_oauth_sessions_user_idx
  on public.yahoo_oauth_sessions (yahoo_user_id);

create index if not exists yahoo_oauth_sessions_expiry_idx
  on public.yahoo_oauth_sessions (expires_at);

-- Optional maintenance query for a scheduled Supabase job:
-- delete from public.yahoo_oauth_sessions where expires_at < now();
