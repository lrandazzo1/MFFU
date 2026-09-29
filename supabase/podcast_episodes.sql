-- Apply before deploying the shared podcast endpoint. Only the service-role
-- serverless function can claim or update a league-week episode.
create table if not exists public.podcast_episodes (
  league_id text not null check (league_id ~ '^[0-9]{1,20}$'),
  season integer not null check (season between 1990 and 2100),
  week integer not null check (week between 1 and 18),
  status text not null check (status in ('generating', 'ready', 'failed')),
  episode jsonb,
  audio_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (league_id, season, week),
  check (status <> 'ready' or (episode is not null and audio_url is not null))
);
alter table public.podcast_episodes enable row level security;
-- Writes stay service-role only: the API verifies the league share token before
-- it claims or updates a row. Reads have an explicit, token-scoped SELECT policy
-- at the end of this file.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('podcast-episodes', 'podcast-episodes', true, 25000000, array['audio/mpeg'])
on conflict (id) do update set public = true;
-- Public reads only. Uploads use the server-side service-role key, with upsert
-- disabled and a deterministic path for each league/season/week.

-- ------------------------------------------------------------
-- EXPLICIT SELECT POLICY FOR SHARED / INVITE-LINK READS
--
-- The table above ships with RLS on and no anon or authenticated policies,
-- which is correct for the write path: only /api/generate-podcast, holding the
-- service-role key, may claim a league-week or mark it ready.
--
-- Reads are the half that has a second caller. An invite-link reader and a
-- league-mate on a second device both present the per-league share token
-- (x-league-token) and nothing else, and both must be able to see the episode
-- their league already generated. This policy states that permission
-- explicitly instead of leaving it implicit in the service-role key, so a read
-- is authorised by the same secret the API checks.
--
-- What it deliberately is NOT: a blanket anon SELECT. The numeric ESPN league
-- id appears in every league URL, so `using (true)` — or any policy keyed on
-- league_id alone — would let anyone who can guess a league id read that
-- league's episodes and scripts. The token, not the id, is the key. Rows are
-- visible only to a caller presenting the share token stored for that
-- league_id, which is exactly the grant /api/generate-podcast already makes.

-- ---- WHY A PRIVATE SCHEMA AND NOT public ----
--
-- SECURITY DEFINER is required: public.leagues has RLS enabled with no anon
-- policies of its own, so a policy expression reading it directly would match
-- zero rows for every anon caller and silently deny every read. The function
-- returns only a boolean and never exposes the token it compares against.
--
-- But the EXECUTE grant that lets the policy evaluate ALSO publishes the
-- function as a PostgREST RPC endpoint when it lives in `public`. In the first
-- version of this file it did, and Supabase's own security advisor flagged it:
-- anyone could POST to /rest/v1/rpc/mffu_league_share_token_matches with a
-- league id and a guessed token and get back true or false. That is a share
-- token oracle — it turns a secret into something a caller can test against,
-- which is the opposite of what this policy exists to do.
--
-- PostgREST exposes only its configured schemas, so moving the function to one
-- it does not expose keeps the policy working and removes the endpoint. Nothing
-- but the policy ever calls it.

create schema if not exists mffu_private;
revoke all on schema mffu_private from public;
grant usage on schema mffu_private to anon, authenticated;

create or replace function mffu_private.league_share_token_matches(
  p_league_id text,
  p_token text
) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.leagues l
    where l.league_id = p_league_id
      and l.share_token is not null
      and p_token is not null
      and length(p_token) between 32 and 128
      and l.share_token = p_token
  );
$$;

revoke all on function mffu_private.league_share_token_matches(text, text) from public;
grant execute on function mffu_private.league_share_token_matches(text, text) to anon, authenticated;

-- PostgREST needs the table privilege as well as the policy; without the grant
-- a matching policy still answers permission denied.
grant select on public.podcast_episodes to anon, authenticated;

drop policy if exists podcast_episodes_share_token_select on public.podcast_episodes;
create policy podcast_episodes_share_token_select
  on public.podcast_episodes
  for select
  to anon, authenticated
  using (
    mffu_private.league_share_token_matches(
      podcast_episodes.league_id,
      nullif(current_setting('request.headers', true)::json ->> 'x-league-token', '')
    )
  );

-- Removes the exposed copy shipped by the first version of this file. Safe on a
-- database that never had it.
drop function if exists public.mffu_league_share_token_matches(text, text);

-- Outside PostgREST there are no request headers, so current_setting returns
-- null, the token is null, the function is false and the policy denies. The
-- service-role key continues to bypass RLS entirely for the write path.
