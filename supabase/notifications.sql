-- ============================================================================
-- FSN PUSH NOTIFICATIONS — schema
-- Run this in the Supabase SQL Editor, after schema.sql.
--
-- Same trust boundary as public.leagues: browsers never touch these tables.
-- Every read and write goes through /api/notifications-register and
-- /api/notifications-dispatch using the service-role key, so RLS is enabled
-- with no anon or authenticated policies at all.
--
-- ---- WHAT IS DELIBERATELY NOT STORED ----
--
-- No email, no ESPN cookies, no SWID, no display name, no IP address. A device
-- row is a push address plus the three switches the reader flipped. The whole
-- point of the table is to send five messages a week; nothing else about the
-- reader is needed to do that, so nothing else is kept.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Registered push destinations.
--
-- device_id is the SHA-256 of the push address, not the address itself. That
-- gives a stable primary key that is safe to log, safe to put in the send
-- ledger, and safe to return to the client as a receipt, while the address it
-- was derived from stays in one column that only the dispatcher reads.
-- ----------------------------------------------------------------------------
create table if not exists public.notification_devices (
  device_id text primary key check (device_id ~ '^[0-9a-f]{64}$'),

  -- 'ios'  -> apns_token is set, subscription is null
  -- 'web'  -> subscription is set, apns_token is null
  platform text not null check (platform in ('ios', 'web')),

  -- APNs device token: 64+ hex chars in practice, bounded generously.
  apns_token text check (apns_token is null or apns_token ~ '^[0-9a-fA-F]{32,200}$'),

  -- Web Push subscription: { endpoint, keys: { p256dh, auth } }.
  subscription jsonb,

  -- Which league's alerts this device wants. A device that switches leagues
  -- re-registers and this is overwritten.
  league_id text check (league_id is null or league_id ~ '^[A-Za-z0-9_.-]{1,64}$'),

  -- The reader's own team, when they have picked a profile. Used only to skip
  -- alerts for a guest with no rooting interest; never rendered into copy.
  team_id text check (team_id is null or char_length(team_id) <= 32),

  -- IANA zone, e.g. 'America/New_York'. Drives every non-kickoff-anchored
  -- trigger, so a reader is alerted on their own clock.
  timezone text not null check (char_length(timezone) <= 64),

  -- The three engagement windows: { "tuesday": bool, "thursday": bool, "sunday": bool }.
  -- Absent key means OFF; the trigger engine requires an explicit `true`.
  prefs jsonb not null default '{}'::jsonb,

  -- Reported by the client so the dispatcher can key the send ledger and anchor
  -- the Thursday alert to the week's real opening kickoff.
  season_year integer check (season_year is null or season_year between 1990 and 2100),
  week integer check (week is null or week between 0 and 30),
  first_kickoff_ms bigint,

  -- Set when the push provider tells us the address is permanently dead
  -- (APNs 410 Unregistered, Web Push 404/410). A disabled row is skipped by
  -- the dispatcher but kept, so a re-register from the same device restores it
  -- with its preferences rather than starting from scratch.
  disabled_at timestamptz,
  disabled_reason text,

  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Shape integrity: exactly one transport per row, matching the platform.
  constraint notification_devices_transport_matches_platform check (
    (platform = 'ios' and apns_token is not null and subscription is null) or
    (platform = 'web' and subscription is not null and apns_token is null)
  )
);

alter table public.notification_devices enable row level security;
-- Intentionally no policies: service-role routes only.

-- The dispatcher's one hot query: every live device, oldest-touched first.
create index if not exists notification_devices_active_idx
  on public.notification_devices (updated_at desc)
  where disabled_at is null;

-- Used when a league is resolved to its subscribers.
create index if not exists notification_devices_league_idx
  on public.notification_devices (league_id)
  where disabled_at is null;

-- ----------------------------------------------------------------------------
-- Send ledger — the at-most-once guarantee.
--
-- The primary key IS the deduplication. The dispatcher inserts the ledger row
-- BEFORE calling the push provider, so two overlapping cron runs cannot both
-- win the insert, and a duplicate push is impossible even if the second run
-- starts while the first is still awaiting the provider.
--
-- The trade is explicit and deliberate: a provider call that fails after the
-- ledger insert drops that one alert rather than risking a double-send. For a
-- weekly engagement nudge that is the right side to fail on.
-- ----------------------------------------------------------------------------
create table if not exists public.notification_sends (
  device_id text not null references public.notification_devices (device_id) on delete cascade,
  trigger_id text not null check (char_length(trigger_id) <= 40),
  season_year integer not null,
  week integer not null,
  sent_at timestamptz not null default now(),
  -- 'sent' once the provider accepted it; 'failed' when it did not. Written
  -- after the fact so a failure is visible in the table rather than only in
  -- the function logs.
  status text not null default 'sent' check (status in ('sent', 'failed')),
  detail text,
  primary key (device_id, trigger_id, season_year, week)
);

alter table public.notification_sends enable row level security;
-- Intentionally no policies: service-role routes only.

-- Supports the dispatcher's per-device ledger read and the pruning sweep.
create index if not exists notification_sends_sent_at_idx
  on public.notification_sends (sent_at desc);

-- ----------------------------------------------------------------------------
-- Reuse the touch trigger already defined in schema.sql.
-- ----------------------------------------------------------------------------
drop trigger if exists mffu_touch_notification_devices on public.notification_devices;
create trigger mffu_touch_notification_devices
before update on public.notification_devices
for each row execute function public.mffu_touch_league_updated_at();

-- ----------------------------------------------------------------------------
-- Ledger pruning. The dedupe key is scoped to (season, week), so a row older
-- than a few weeks can never suppress a live send. The dispatcher calls this
-- opportunistically; it is safe to run by hand or from a scheduled job.
-- ----------------------------------------------------------------------------
create or replace function public.mffu_prune_notification_sends(retain_days integer default 45)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  removed integer;
begin
  delete from public.notification_sends
   where sent_at < now() - (retain_days || ' days')::interval;
  get diagnostics removed = row_count;
  return removed;
end;
$$;
