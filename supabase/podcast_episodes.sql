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
-- No anon or authenticated policies. The API verifies the league share token.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('podcast-episodes', 'podcast-episodes', true, 25000000, array['audio/mpeg'])
on conflict (id) do update set public = true;
-- Public reads only. Uploads use the server-side service-role key, with upsert
-- disabled and a deterministic path for each league/season/week.
