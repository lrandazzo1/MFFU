-- FSN league blog articles.
--
-- Additive: this file creates one new table and one new trigger function. It
-- touches nothing in schema.sql, notifications.sql, transaction_wire.sql or
-- yahoo_oauth.sql, and it is safe to re-run.
--
-- Rows are written only by the server-side article pipeline
-- (lib/article-generator.ts) using the service-role key. Browsers never query
-- this table directly; a Vercel route is the data boundary, same as
-- /api/league and the transaction wire.

create table if not exists public.blog_articles (
  id uuid primary key default gen_random_uuid(),

  -- Stories are isolated per fantasy league. Every read is scoped by this
  -- column, so it is indexed on its own and again with the week coordinates.
  league_id text not null check (char_length(league_id) between 1 and 64),

  -- Deterministic: <season>-week-<n>-<day-slug>-<league_id>. Re-running the
  -- pipeline for the same league week overwrites its own row (upsert on this
  -- column) instead of stacking duplicates.
  slug text not null unique check (char_length(slug) between 1 and 200),

  title text not null,
  excerpt text not null default '',
  content_markdown text not null,

  article_type text not null check (
    article_type in ('monday_sweat', 'tuesday_verdict', 'friday_tnf_preview')
  ),

  season integer not null check (season between 1990 and 2100),
  week integer not null check (week between 1 and 18),

  -- [{ player_id, player_name, owner_team, outcome_flag, ... }]
  -- The math evidence (entering_margin, final_margin, player_points,
  -- projected_points) rides along so a published claim can be audited without
  -- refetching the box score.
  tracked_players jsonb not null default '[]'::jsonb
    check (jsonb_typeof(tracked_players) = 'array'),

  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotent adds for a project where an earlier blog_articles already exists.
alter table public.blog_articles add column if not exists league_id text;
alter table public.blog_articles add column if not exists slug text;
alter table public.blog_articles add column if not exists title text;
alter table public.blog_articles add column if not exists excerpt text not null default '';
alter table public.blog_articles add column if not exists content_markdown text;
alter table public.blog_articles add column if not exists article_type text;
alter table public.blog_articles add column if not exists season integer;
alter table public.blog_articles add column if not exists week integer;
alter table public.blog_articles add column if not exists tracked_players jsonb not null default '[]'::jsonb;
alter table public.blog_articles add column if not exists published_at timestamptz not null default now();
alter table public.blog_articles add column if not exists created_at timestamptz not null default now();
alter table public.blog_articles add column if not exists updated_at timestamptz not null default now();

create index if not exists blog_articles_league_idx
  on public.blog_articles (league_id);

-- The pipeline's own lookup: one league's article for one week and type.
create index if not exists blog_articles_league_week_idx
  on public.blog_articles (league_id, season, week, article_type);

-- The blog index page: newest first, within a league.
create index if not exists blog_articles_published_idx
  on public.blog_articles (league_id, published_at desc);

alter table public.blog_articles enable row level security;

-- Intentionally no anon/authenticated policies. Reads and writes both go
-- through a service-role route, so a leaked publishable key can never enumerate
-- another league's stories.
revoke all on public.blog_articles from anon, authenticated;
grant all on public.blog_articles to service_role;

create or replace function public.mffu_touch_blog_article_updated_at()
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

drop trigger if exists mffu_touch_blog_article_updated_at on public.blog_articles;
create trigger mffu_touch_blog_article_updated_at
before update on public.blog_articles
for each row execute function public.mffu_touch_blog_article_updated_at();
