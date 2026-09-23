-- Audit trail for the scheduled league blog runs.
--
-- Additive: one new table, one new index set. It touches nothing in
-- schema.sql, blog_articles.sql, notifications.sql, transaction_wire.sql or
-- yahoo_oauth.sql, and it is safe to re-run.
--
-- Written only by /api/cron/generate-articles with the service-role key. One
-- row per league per run, whether the article was created, skipped as already
-- present, or failed. The point is that a silent morning is distinguishable
-- from a morning where every league threw.

create table if not exists public.cron_article_logs (
  id uuid primary key default gen_random_uuid(),

  league_id text not null check (char_length(league_id) between 1 and 64),
  article_type text not null check (
    article_type in ('monday_sweat', 'tuesday_verdict', 'friday_tnf_preview')
  ),

  -- created: an article was generated and published.
  -- skipped: one already existed for this league, season, week and type.
  -- failed:  generation or the write threw; error_message says what.
  status text not null check (status in ('created', 'skipped', 'failed')),
  error_message text,

  -- Context, so a failure can be reproduced without reading the function logs.
  season integer check (season between 1990 and 2100),
  week integer check (week between 1 and 18),
  slug text,
  run_id text,

  executed_at timestamptz not null default now()
);

-- Idempotent adds for a project where an earlier cron_article_logs exists.
alter table public.cron_article_logs add column if not exists league_id text;
alter table public.cron_article_logs add column if not exists article_type text;
alter table public.cron_article_logs add column if not exists status text;
alter table public.cron_article_logs add column if not exists error_message text;
alter table public.cron_article_logs add column if not exists season integer;
alter table public.cron_article_logs add column if not exists week integer;
alter table public.cron_article_logs add column if not exists slug text;
alter table public.cron_article_logs add column if not exists run_id text;
alter table public.cron_article_logs add column if not exists executed_at timestamptz not null default now();

-- "What happened this morning", the question an operator actually asks.
create index if not exists cron_article_logs_executed_idx
  on public.cron_article_logs (executed_at desc);

-- "Why has this league gone quiet."
create index if not exists cron_article_logs_league_idx
  on public.cron_article_logs (league_id, executed_at desc);

-- "Show me every failure from one run."
create index if not exists cron_article_logs_run_idx
  on public.cron_article_logs (run_id, status);

alter table public.cron_article_logs enable row level security;

-- Intentionally no anon/authenticated policies: the service-role route is the
-- only writer and the only reader. Error text can quote upstream responses, so
-- it is never exposed to a browser.
revoke all on public.cron_article_logs from anon, authenticated;
grant all on public.cron_article_logs to service_role;
