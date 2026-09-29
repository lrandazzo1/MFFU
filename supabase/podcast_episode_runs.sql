-- ------------------------------------------------------------
-- SCHEDULED PODCAST USAGE LEDGER
--
-- Apply before enabling the Tuesday run
-- (/api/cron/generate-weekly-podcast).
--
-- One row per league per attempt, written whether the attempt succeeded or
-- not. It exists because that run automates a PAID provider: every dialogue
-- turn is an ElevenLabs call, the run fans out over every active league, and
-- docs/PODCAST_STUDIO.md warns in as many words not to distribute paid audio
-- generation broadly without a persistent usage ledger. Without this table the
-- only record of what a Tuesday cost is the invoice.
--
-- It answers three questions the `podcast_episodes` table cannot:
--
--   * what did this run actually spend — `turns` is the ElevenLabs call count
--     and `audio_bytes` the delivered MP3 size, per league;
--   * why did a league get no episode — `failure_reason` groups the causes,
--     since ESPN_AUTH needs a member to reconnect while TIMEOUT just needs
--     another run;
--   * was an episode thin — `populated_segments` counts how many of the four
--     segments carried real material, so an episode of empty rooms is visible
--     without listening to it.
--
-- Additive: it is written only by the cron handler and read only by an
-- operator. Nothing else in the app reads it, and `podcast_episodes` is
-- unchanged.
-- ------------------------------------------------------------

create table if not exists public.podcast_episode_runs (
  id bigserial primary key,
  -- Identifies one invocation across every row it wrote. Not unique: one run
  -- writes one row per league.
  run_id text not null,
  league_id text not null check (league_id ~ '^[0-9]{1,20}$'),
  season integer not null check (season between 1990 and 2100),
  week integer not null check (week between 1 and 18),
  status text not null check (status in ('created', 'skipped', 'failed')),
  -- ElevenLabs calls made for this league. Null for a skip, and 0 for a
  -- script-only run, which is a real distinction: 0 means "we built the
  -- episode and deliberately synthesized nothing".
  turns integer check (turns is null or turns >= 0),
  audio_bytes integer check (audio_bytes is null or audio_bytes >= 0),
  populated_segments integer check (populated_segments is null or populated_segments between 0 and 4),
  -- Set only on a failure; null on 'created' and 'skipped'.
  failure_reason text check (
    failure_reason is null or failure_reason in
      ('ESPN_AUTH', 'NO_MATCHUP_DATA', 'EMPTY_SCRIPT', 'TTS', 'STORAGE', 'TIMEOUT', 'OTHER')
  ),
  error_message text,
  created_at timestamptz not null default now()
);

-- "What did last Tuesday cost, and which leagues failed" is the only query this
-- table is read with, so index the run and the league-week it covers.
create index if not exists podcast_episode_runs_run_idx
  on public.podcast_episode_runs (run_id, league_id);
create index if not exists podcast_episode_runs_scope_idx
  on public.podcast_episode_runs (season, week, created_at desc);

alter table public.podcast_episode_runs enable row level security;

-- No anon or authenticated policies, and deliberately none of the token-scoped
-- read that podcast_episodes has. This is operator telemetry — error messages,
-- provider call counts, spend — and no league member has any reason to read
-- another league's failures. Only the service-role cron handler writes here,
-- and it bypasses RLS.

-- Spend for one run:
--   select status, count(*), sum(turns) as elevenlabs_calls,
--          sum(audio_bytes) as bytes
--   from public.podcast_episode_runs
--   where run_id = '2026-w2-podcast'
--   group by status;
--
-- Leagues that need a human rather than a retry:
--   select league_id, failure_reason, error_message
--   from public.podcast_episode_runs
--   where status = 'failed' and failure_reason = 'ESPN_AUTH'
--   order by created_at desc;
