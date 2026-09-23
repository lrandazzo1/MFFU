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

-- ---------------------------------------------------------------------------
-- THE THREE-TIER ARTICLE SHAPE
--
-- Additive, and additive in both directions: the legacy columns (`title`,
-- `content_markdown`) are kept exactly as they were, and the new ones sit
-- beside them. A reader resolves `headline = coalesce(headline, title)` and
-- `content = coalesce(content, content_markdown)`, so a row written before
-- this block existed reads correctly through the new names, and a row written
-- through the new names reads correctly through the old ones.
--
--   headline               tier 1 — the prominent title
--   match_impact_summary   tier 2 — the one-line callout under the headline
--   content                tier 3 — the markdown narrative
--   category               editorial shelf ("Matchup Recap", "Waiver Wire")
--   author                 the byline ("FSN News Desk")
--
-- Nullable on purpose. A NOT NULL headline would reject every existing row at
-- migration time, and a default would invent a headline for stories that
-- already have a perfectly good title.
-- ---------------------------------------------------------------------------

alter table public.blog_articles add column if not exists headline text;
alter table public.blog_articles add column if not exists match_impact_summary text not null default '';
alter table public.blog_articles add column if not exists content text;
alter table public.blog_articles add column if not exists category text not null default '';
alter table public.blog_articles add column if not exists author text not null default 'FSN News Desk';

-- The byline was "FFU News Desk" when the column was added. `add column if not
-- exists` is a no-op once the column exists, so it cannot correct the default
-- on a database that already ran this file: that needs an explicit set, and
-- the rows written under the old default need moving too. Both are safe to
-- re-run, and only the exact old string is touched, so a hand-set byline on
-- any row is left alone.
alter table public.blog_articles alter column author set default 'FSN News Desk';
update public.blog_articles set author = 'FSN News Desk' where author = 'FFU News Desk';

-- The blog index filtered to one shelf, newest first.
create index if not exists blog_articles_category_idx
  on public.blog_articles (league_id, category, published_at desc);

-- `article_type` stays the scheduled pipeline's enum, but a manually or
-- externally published article has no day-of-week to claim. `league_dispatch`
-- is the type for those. The constraint is widened, never narrowed: every
-- value that was legal before this line is still legal after it, so no
-- existing row can fail the re-run.
alter table public.blog_articles drop constraint if exists blog_articles_article_type_check;
alter table public.blog_articles add constraint blog_articles_article_type_check check (
  article_type in ('monday_sweat', 'tuesday_verdict', 'friday_tnf_preview', 'league_dispatch')
);

-- Keep the two naming generations in lockstep at write time, so neither can
-- drift and neither NOT NULL column can be violated by a writer that only
-- knows the other generation's names. This runs BEFORE the NOT NULL checks,
-- which is what lets an insert carrying only `headline`/`content` succeed.
create or replace function public.mffu_sync_blog_article_tiers()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- A writer that knows only the new names fills the legacy columns.
  new.title := coalesce(nullif(new.title, ''), nullif(new.headline, ''));
  new.content_markdown := coalesce(nullif(new.content_markdown, ''), nullif(new.content, ''));
  -- A writer that knows only the legacy names fills the new ones.
  new.headline := coalesce(nullif(new.headline, ''), nullif(new.title, ''));
  new.content := coalesce(nullif(new.content, ''), nullif(new.content_markdown, ''));
  return new;
end;
$$;

drop trigger if exists mffu_sync_blog_article_tiers on public.blog_articles;
create trigger mffu_sync_blog_article_tiers
before insert or update on public.blog_articles
for each row execute function public.mffu_sync_blog_article_tiers();

-- ---------------------------------------------------------------------------
-- `public.articles` — the three-tier view
--
-- The table is named `blog_articles` and stays that way: a rename would break
-- every route, every index name and the whole compiled pipeline for cosmetics.
-- This view is the three-tier reading of it under the shorter name, with the
-- legacy fallbacks already resolved, for anything that would rather select
-- `headline` than `coalesce(headline, title)`.
--
-- `security_invoker` so the view cannot become a way around the table's RLS:
-- it is read with the caller's own rights, and the table grants only
-- service_role.
-- ---------------------------------------------------------------------------

create or replace view public.articles
with (security_invoker = true) as
select
  id,
  league_id,
  slug,
  coalesce(nullif(headline, ''), title) as headline,
  match_impact_summary,
  coalesce(nullif(content, ''), content_markdown) as content,
  category,
  author,
  excerpt,
  article_type,
  season,
  week,
  tracked_players,
  published_at,
  created_at,
  updated_at,
  -- The legacy names, still readable through the view so one query can serve
  -- both generations of consumer.
  title,
  content_markdown
from public.blog_articles;

revoke all on public.articles from anon, authenticated;
grant select on public.articles to service_role;
