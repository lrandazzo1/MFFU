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

-- ---------------------------------------------------------------------------
-- WHY A LEAGUE PRODUCED NO ARTICLE
--
-- `error_message` holds the provider's own words, which is what you need once
-- you already know which league to look at. It is the wrong shape for the
-- question that actually gets asked, which is "articles show up in some
-- leagues and not others, why": that one is answered by grouping, and you
-- cannot group on free text.
--
-- `failure_reason` is the groupable form, written by classifyFailure() in
-- lib/article-cron.ts. The distinction that matters most is ESPN_AUTH against
-- everything else: a league whose saved ESPN connection no longer
-- authenticates will never publish no matter how many times the run is
-- retried, because a member has to reconnect it, while TIMEOUT and
-- PROVIDER_DOWN are worth retrying. Those need opposite responses and the raw
-- message buries the difference.
--
-- Nullable, with no default and no check constraint: it is null for every
-- 'created' and 'skipped' row and for every row written before this column
-- existed, and a new cause should be able to start being recorded without a
-- migration standing between it and the log.
-- ---------------------------------------------------------------------------

alter table public.cron_article_logs add column if not exists failure_reason text;

-- The operator's query: the causes behind one week's missing articles.
create index if not exists cron_article_logs_failure_reason_idx
  on public.cron_article_logs (season, week, failure_reason)
  where failure_reason is not null;
