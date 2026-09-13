# FSN — Push Notifications

Weekly engagement alerts for the moments that matter in a fantasy week,
delivered by a single serverless job that runs **once a day** and pulls from the
external schedule source **once a day**.

Everything below is implemented; what is left is provisioning (keys, a SQL run,
and the Xcode capability), which needs accounts this repo cannot reach.

## The schedule, in one line

```
0 16 * * *   ->  /api/notifications-dispatch   (vercel.json)
```

One cron. One invocation per calendar day. At most one outbound request to the
external data source per day, for the entire install base. At most one push per
device per run.

## What gets sent

Five alerts across three reader-facing switches. Each fires at most once per
device per fantasy week, and a device receives **at most one per day**, because
there is one delivery instant per day.

Neither APNs nor Web Push accepts a "deliver at" time, so an alert lands when
the run sends it. The cadence is therefore expressed as a **local-hour band**:
each alert owns a stretch of its weekday, and the daily run delivers whichever
alert belongs at the hour the run lands on in *that device's* timezone.

| Switch | Alert | Local band on the device's clock | Who that is, at 16:00 UTC |
|---|---|---|---|
| **Tuesday** | Waiver wire results | Tue 06:00 – 13:59 | Honolulu 06:00 · LA 09:00 · Chicago 11:00 · NY 12:00 |
| **Tuesday** | Recap + power index drop | Tue 14:00 – 22:59 | London 17:00 · Berlin 18:00 |
| **Thursday** | Lineup lock warning | the last daily run before the week's real opening kickoff | whole league, same run |
| **Sunday** | Morning lineup check | Sun 06:00 – 11:59 | Honolulu 06:00 · LA 09:00 · Chicago 11:00 |
| **Sunday** | Game day pulse | Sun 12:00 – 22:59 | NY 12:00 · London 17:00 |

So one UTC instant produces a *different, correct* alert per timezone rather
than the same alert at five wrong local times.

The Thursday alert is anchored to the real opening kickoff — read from the
daily schedule pull — and fires on the last daily run that still precedes it. A
week whose opener is Saturday warns on Saturday's run; a week with **no** game
inside the next day stays silent rather than crying lock three days early.

### What a once-a-day schedule costs, stated plainly

- **A device outside UTC-10 … UTC+6 receives nothing.** At 16:00 UTC the run
  lands in the middle of its night, and no alert is placed before 06:00 or after
  22:00 local. Tokyo sees 01:00 and is skipped. The dispatcher counts these as
  `outsideDailyWindow` in its dry run so the silence is diagnosable rather than
  mysterious.
- **The lock warning is hours of notice, not two hours.** It is the last run
  before kickoff, which for a Thursday-night game and a 16:00 UTC cron is about
  eight hours.
- **A missed run is not re-offered the same day.** The next chance is the next
  run, and by then the alert's band has usually passed. The ledger makes that
  safe rather than duplicated.

Moving the cron's UTC hour moves which timezones are served. The bands are hours
wide on purpose: Hobby-plan crons are only guaranteed to fire *within the hour*
of their schedule, and an alert must not vanish because the platform drifted
forty minutes.

## The daily data pull

`lib/notifications/schedule-feed.js` reads the season year, the week number and
the week's opening kickoff from ESPN's **public, credential-free** NFL
scoreboard. None of those facts are per-league, so they are pulled **once for
the whole install base** — not per league, not per device — and cached in
`public.notification_schedule`. A thousand registered devices still cost one GET.

**The rate limit is enforced on the last attempt, not the last success.**
`attempted_at` is stamped whether the pull succeeded or failed, so a throttled
or broken upstream costs at most one request per 20 hours no matter how often
the route is invoked — by the cron, by a manual `curl`, or by ten of them in a
row. Gating on success would turn an upstream outage into a retry storm against
the source that is already struggling. A failed pull keeps the cached row,
records the error, and the dispatcher reports the row's age instead of going
silent.

This also fixes a real defect rather than only saving requests. Season and week
used to come from whatever the client last reported at registration: a reader
who opted in during Week 2 and never reopened the app kept reporting week 2, so
every later send collided with a Week-2 ledger row and that device went quiet
for the rest of the season. The feed is now authoritative; the device's own
report is the fallback for a run whose pull has never succeeded.

### It cannot trigger a Vercel redeploy

The pull runs **inside the serverless function**, invoked by Vercel Cron. In
full:

- Vercel Cron is an internal scheduled HTTP invocation of an already-deployed
  function. It is not a Git event, so it creates no deployment.
- The job writes one Supabase row and sends pushes. It does not write to the
  repository, call the Vercel API, hit a Deploy Hook, or touch a webhook.
- No GitHub Actions workflow is scheduled and none invokes the dispatcher — a
  workflow curling this route on a schedule would put the pull back on the
  repository's side of the fence, with the deploy-triggering surface that comes
  with it. `npm run audit:notifications` asserts both, mechanically, so a later
  change cannot quietly reintroduce it.

## Architecture

```
notificationService.js     global-scope client. Owns permission, token capture,
                           registration. NEVER prompts on boot.
sw.js                      service worker — Web Push receipt only, no caching.
index.html                 Setup screen card (markup + block-6 controller).

api/notifications-register.js       device registration / preferences / unsubscribe
api/notifications-dispatch.js       the once-a-day cron target
lib/notifications/triggers.js       pure cadence engine + deterministic copy
lib/notifications/schedule-feed.js  the once-a-day external pull + its rate limiter
lib/notifications/apns.js           APNs over HTTP/2, token auth, zero deps
lib/notifications/webpush.js        VAPID Web Push (wraps `web-push`)
lib/notifications/selftest.js       133 assertions, no credentials needed

supabase/notifications.sql          notification_devices + notification_sends
                                    + notification_schedule (the pull's cache)
```

`notificationService.js` loads at global scope alongside
`editorialScheduleEngine.js` for the reason CLAUDE.md rule 1 exists: it is
driven from block 6 and fed league context from block 1, so it cannot live
inside either IIFE.

### At-most-once delivery

The ledger row in `notification_sends` is inserted **before** the provider call.
Its composite primary key means a manual invocation overlapping the cron cannot
double-deliver. The deliberate trade: a provider call that fails after the
insert drops that one alert rather than risking a duplicate. For a weekly nudge
that is the right side to fail on, and the drop is recorded as `status='failed'`
rather than lost.

## Privacy

A device row is a push address, a timezone, and three booleans. Deliberately not
stored: email, ESPN cookies, SWID, display name, IP address. The primary key is
the SHA-256 of the push address, so the id is safe to log and to return to the
client while the address itself sits in one column only the dispatcher reads.
RLS is on with **no** anon or authenticated policies — service-role routes only,
the same boundary `public.leagues` already uses.

The daily pull carries no credentials and no reader data. It is an anonymous GET
for a public NFL scoreboard.

## The opt-in flow

The system permission prompt is reachable from exactly one control: the
**TURN ON ALERTS** button inside the rationale panel on the Setup screen. It
appears only after the reader flips the master switch and reads what the three
cadences are. Nothing on app launch asks the OS for anything.

`boot()` does one thing on launch: for a device that has **already** opted in
and **already** been granted permission, it silently re-registers, because APNs
tokens rotate and a stale token is a silently undelivered notification. That
path checks the existing permission state and returns early unless it is already
`granted`, so it cannot prompt.

This is asserted, not just intended — `scripts/render-check.mjs` instruments
`Notification.requestPermission` before any page script runs and fails if boot
or the master switch reaches it.

## Setup

### 1. Database

Run `supabase/notifications.sql` in the Supabase SQL Editor (after `schema.sql`,
which defines the shared touch trigger it reuses). It is additive and safe to
re-run: existing installs get the new `notification_schedule` cache table and
nothing else changes.

### 2. Environment variables

Required by both transports:

| Variable | Notes |
|---|---|
| `SUPABASE_URL` | already set for `/api/league` |
| `SUPABASE_SERVICE_ROLE_KEY` | already set |
| `CRON_SECRET` | any long random string. **Without it the dispatcher refuses to run** rather than defaulting open. Vercel attaches it to scheduled invocations automatically. |

Optional:

| Variable | Notes |
|---|---|
| `NOTIFICATIONS_SCHEDULE_URL` | override the daily pull's URL (a mirror, a fixture). Must be `https:` on `site.api.espn.com` or `fantasy.espn.com`; anything else is refused loudly and the default is used. |

iOS (APNs):

| Variable | Notes |
|---|---|
| `APNS_KEY_P8` | full contents of `AuthKey_XXXXXXXXXX.p8`. Literal `\n` escapes are accepted. |
| `APNS_KEY_ID` | 10-char Key ID |
| `APNS_TEAM_ID` | 10-char Apple Developer Team ID |
| `APNS_BUNDLE_ID` | defaults to `app.fantasysportsnetwork` |
| `APNS_ENV` | `production` (default) or `sandbox` for development builds |

Web (VAPID) — generate with `npx web-push generate-vapid-keys`:

| Variable | Notes |
|---|---|
| `VAPID_PUBLIC_KEY` | served to browsers by the register route; public by design |
| `VAPID_PRIVATE_KEY` | never leaves the function |
| `VAPID_SUBJECT` | `mailto:` or `https:` contact |

Either transport works alone. With neither configured the Setup card says so
plainly and the switch stays disabled.

### 3. Xcode (native only)

Requires a Mac — see `ios/HANDOFF.md`. After `npm install && npx cap sync ios`:

1. **Signing & Capabilities → + Capability → Push Notifications**
2. **+ Capability → Background Modes → Remote notifications**
3. In the Apple Developer portal, confirm the App ID for
   `app.fantasysportsnetwork` has the Push Notifications service enabled, and
   that the `.p8` key in `APNS_KEY_P8` is authorised for it.

Capacitor's `@capacitor/push-notifications` handles `AppDelegate` registration;
no Swift changes are needed.

## Triggering the dispatcher by hand

The cron is the schedule; this is for verification. The route authenticates
every caller against `CRON_SECRET` and **fails closed**: if the variable is
unset, the route returns 401 to everyone rather than defaulting open. Two header
forms are accepted, because not every caller can set an `Authorization` header:

```bash
# What Vercel Cron sends automatically.
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://<deployment>/api/notifications-dispatch"

# Equivalent, for tools that only allow custom headers.
curl -H "x-cron-secret: $CRON_SECRET" \
  "https://<deployment>/api/notifications-dispatch"
```

`GET` and `POST` both work; anything else returns 405. The secret is compared in
constant time.

A live invocation delivers only what the cadence says is due. To force a push to
one device right now, see the next section.

Running this by hand is safe with respect to the upstream: the feed's rate
limiter means a second invocation on the same day makes **no** outbound request
and serves the cached week.

## The in-app debug button

The Setup screen shows a **SEND A TEST ALERT TO THIS DEVICE** button beneath
the three engagement switches once the device has registered — the same
lifecycle gate that hides the switches themselves before an opt-in. It POSTs
this device's own `deviceId` to `/api/notifications-selftest`, which fires
one real notification straight to the device that asked for it and reports
the provider's verbatim answer.

```
POST /api/notifications-selftest   { deviceId }   ->   { ok, delivery, ... }
```

The endpoint exists separately from `/api/notifications-dispatch?selftest=`
because that mode is `CRON_SECRET`-gated and a secret cannot ship to the
client. Instead this route authorizes on the deviceId itself: the id is the
SHA-256 of the push address, so only the device that registered — and
Supabase — hold it. A request whose id does not resolve to a row is refused
with a 403, and a per-device 30-second cooldown (stamped in a new
`notification_devices.last_test_at` column) rate-limits the button against
a leaked id.

Everything the dispatcher's own selftest mode promises applies here too: no
ledger row is written, `last_sent_at` is untouched, the schedule pull is
not spent, and a rejected send does not retire the device row.
`last_test_at` is a separate column from `last_sent_at` for exactly that
reason.

## Force-firing one device (`?selftest=`)

The section above triggers the *cadence*: it delivers whatever each device is
due for right now, which on most days, in most timezones, is nothing. That
makes it useless for the question you actually have when a build is sitting on
your phone — *does a push arrive at all?*

`?selftest=<deviceId>` answers that one. It sends a **real** notification to one
named device immediately, bypassing the weekday bands, the local-hour window and
the send ledger, and hands back the provider's verbatim answer.

```bash
DEPLOY=https://app.fantasysportsnetwork.app
DEVICE=<the 64-char hex device id>

curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "$DEPLOY/api/notifications-dispatch?selftest=$DEVICE" | jq
```

Pick which alert's copy to send with `&trigger=` — one of `waiver_wire`,
`weekly_recap`, `tnf_lock`, `sunday_lineup` (the default) or `gameday_pulse`.
The payload is byte-identical to the real alert; marking it as a test would
answer a different question than the one being asked.

### Finding your device id

The id is the SHA-256 of the push address, and it is what
`/api/notifications-register` returned to the app when the device registered.
Read it back out of Supabase:

```sql
select device_id, platform, timezone, prefs, disabled_at, disabled_reason,
       season_year, week, last_sent_at, created_at
from public.notification_devices
order by created_at desc;
```

An empty result means **no device has registered** — nothing is wrong with the
dispatcher, there is simply nothing for it to send to. See the checklist below.

### What it will not do

A diagnostic that quietly consumed the week's real alert for the device being
diagnosed would make the fault it is used to find worse, so this mode:

- writes **no** ledger row, stamps no `last_sent_at`, and changes no device
  state — running it mid-season cannot suppress that device's genuine weekly
  alert, and running it ten times in a row is harmless;
- **retires nothing**: a rejected self-test leaves the row enabled, unlike a
  rejection during a real run;
- makes **no** outbound schedule request, so it does not spend the day's one
  pull or move the rate limiter;
- takes exactly one device id. There is no fan-out form of this mode, and a
  value that is not 64 hex characters is refused rather than interpreted;
- still requires the secret. Without it, 401, same as every other mode.

A **retired** device is deliberately still testable — "it just stopped
arriving" is usually a row that was disabled after a dead-token rejection, and
the response reports `disabledAt` so you can see the daily cron is skipping it
even when the test push itself succeeds. Re-registering from the app clears it.

### Reading the answer

```jsonc
{
  "ok": true,
  "selftest": true,
  "device": {
    "deviceId": "…", "platform": "ios", "timezone": "America/New_York",
    "disabledAt": null,          // non-null -> the daily cron is skipping this row
    "disabledReason": null
  },
  "notification": { "trigger": "sunday_lineup", "title": "Set your lineup · Week 2", "body": "…" },
  "delivery": {
    "status": 200,               // 200 = Apple accepted it
    "apnsId": "…",               // Apple's own id for the push, for a support ticket
    "reason": null,              // Apple's rejection string when status is not 200
    "retryable": false,
    "unregister": false          // true -> this address is permanently dead
  },
  "apnsConfig": {
    "env": "production",         // which Apple host the send went to
    "host": "https://api.push.apple.com",
    "topic": "app.fantasysportsnetwork",   // the apns-topic header; must equal the bundle id
    "keyId": "…", "teamId": "…",
    "keyFormat": "pem",
    "keyUsable": true,           // false -> the .p8 in the environment will not sign
    "matches": "TestFlight / App Store builds (aps-environment=production)"
  },
  "ledgerWritten": false
}
```

`apnsConfig` is reported by `?dry=1` as well, so the environment can be checked
without sending anything. It never contains the private key.

## The APNs environment, and why TestFlight is the confusing case

The environment is chosen by the **signature on the installed binary**, not by
anything the app does at runtime, and the server has to be pointed at the
matching Apple host:

| Build | `aps-environment` | Apple host | `APNS_ENV` |
|---|---|---|---|
| Xcode → attached device | `development` | `api.sandbox.push.apple.com` | `sandbox` |
| **TestFlight** | `production` | `api.push.apple.com` | `production` (the default) |
| App Store | `production` | `api.push.apple.com` | `production` (the default) |

TestFlight is a **production** signature — that is the part that catches people
out, because it is a pre-release channel that behaves like a release build here.
`ios/App.entitlements` pins `aps-environment` to `production` and
`scripts/verify-ios-release.py` asserts it on the exported archive, so the
default `APNS_ENV=production` is already the correct pairing for TestFlight.
**Do not set `APNS_ENV` to `sandbox` while testing through TestFlight.**

When the two disagree, Apple does not say so. It accepts the connection and
answers every push with `400 BadDeviceToken`, which the dispatcher then treats
as a permanently dead address and retires the row. Symptom: pushes silently stop
and the device row acquires a `disabled_reason` of BadDeviceToken.

### Reading a rejection

| status / reason | What it means | Fix |
|---|---|---|
| `200` | Apple accepted it. If nothing appears on the phone, the problem is on the device: notification permission, Focus mode, or the app was never granted alerts. | — |
| `400` BadDeviceToken | The token was issued under the *other* APNs environment, or for a different app. | Match `APNS_ENV` to the build's `aps-environment` (TestFlight = `production`), then re-register from the app to capture a fresh token. |
| `400` DeviceTokenNotForTopic | The `apns-topic` sent does not equal the app's bundle id. | Set `APNS_BUNDLE_ID` to the binary's real bundle id. |
| `403` InvalidProviderToken | The signed JWT was rejected — usually the `.p8`, key id, or team id is wrong, or the key is not enabled for this App ID. | Check `keyUsable` in the response, then the key's Push Notifications service in the Developer portal. |
| `410` Unregistered | The app was deleted from the device. | Reinstall and re-register. |
| `429` / `500` / `503` | Apple is throttling or briefly unavailable. | Retry later; the dispatcher marks these retryable. |

## When nothing arrives: the order to check it in

Work down this list — each step is cheap and rules out everything above it.

1. **Are the keys provisioned at all?**

   ```bash
   curl -sS https://app.fantasysportsnetwork.app/api/notifications-register | jq
   ```

   `{"configured": false, "apns": false}` means `APNS_KEY_P8`, `APNS_KEY_ID` or
   `APNS_TEAM_ID` is missing from the deployment's environment. This is the
   first thing to check, because it fails **silently and early**: the app reads
   this endpoint on boot, sees push is unavailable, and disables the Setup
   switch — so the device can never register, the devices table stays empty,
   and the daily cron has nothing to send to. Every other symptom follows from
   this one.

2. **Has the schema been applied in full?** `supabase/notifications.sql` creates
   three tables. Confirm all three exist:

   ```sql
   select table_name from information_schema.tables
   where table_schema = 'public' and table_name like 'notification_%';
   ```

   A missing `notification_schedule` does not stop delivery, but the daily pull
   can neither cache nor rate-limit itself: every invocation re-fetches the
   scoreboard and every run falls back to the week each device last reported.

3. **Has the device registered?** Run the device query above. Empty means the
   app never captured a token — either step 1 is unfixed, or the reader never
   turned the master switch on and granted permission.

4. **Force-fire it** with `?selftest=` and read `delivery.reason` against the
   table above.

5. **Only then look at the cadence.** `?dry=1` reports `missingTimezone`,
   `noGroupsEnabled` and `outsideDailyWindow` — the three conditions that
   silence a device that is otherwise perfectly configured.

## Authorization and rate limits, in one place

- **Every** mode — live, `?dry=1`, `?selftest=` — is gated on the same secret,
  compared in constant time, and fails **closed**: with `CRON_SECRET` unset the
  route answers 401 to everyone rather than defaulting open. Vercel attaches the
  bearer to its own scheduled invocations automatically.
- **The external schedule source** is capped at one request per 20 hours, on the
  last *attempt* rather than the last success, so no number of manual
  invocations can turn into a retry storm. `?dry=1` and `?selftest=` make no
  outbound request at all.
- **Apple** is not rate-limited by us and does not need to be at this size:
  every push in a run is serialised over a single HTTP/2 session, one device at
  a time, capped at 2000 devices per invocation. A `429` from Apple is recorded
  as retryable on the ledger row rather than retried inside the run.
- **Duplicate suppression** is the ledger's composite primary key, so a manual
  live invocation that overlaps the cron cannot double-deliver. `?selftest=`
  sits outside that mechanism entirely — by writing nothing, it can neither
  duplicate nor consume a real send.

## Health check (`?dry=1`)

`?dry=1` runs the **entire** evaluation lifecycle — reads every live device,
reads the cached schedule, scans the send ledger, normalises each timezone, and
applies every band rule — then returns what it *would* have done and stops. It
opens no APNs session, sends no Web Push, writes no database row, and **makes no
outbound request**: a rehearsal must not spend the day's one pull, and must not
stamp `attempted_at` and thereby rate-limit the real run out of its own.

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://<deployment>/api/notifications-dispatch?dry=1"
```

```jsonc
{
  "ok": true,
  "dryRun": true,
  "now": "2026-09-08T16:00:00.000Z",
  "transports": { "apns": false, "web": true },  // which providers are provisioned
  "deliverable": true,                           // could a live run send anything at all
  "schedule": {
    "seasonYear": 2026,
    "week": 1,
    "firstKickoffAt": "2026-09-11T00:15:00.000Z",
    "fetchedAt": "2026-09-08T16:00:03.000Z",
    "ageHours": 0,                               // >24 means the pull has been failing
    "pulledThisRun": false,                      // always false in a dry run, by design
    "reason": "CACHE_ONLY",
    "lastError": null
  },
  "evaluated": 4,                                // live devices considered
  "due": 1,                                      // alerts a live run would send now
  "ledgerRowsScanned": 0,                        // dedupe rows inside the lookback
  "ledgerLookbackDays": 21,
  "devices": {
    "total": 4, "ios": 1, "web": 3,
    "missingTimezone": 1,                        // rows whose zone Intl rejects
    "noGroupsEnabled": 1,                        // registered but every switch off
    "outsideDailyWindow": 1                      // zone too far from the cron's UTC hour
  },
  "planTruncated": false,                        // `due` is always the real total
  "plan": [{
    "deviceId": "…", "platform": "web", "timezone": "America/New_York",
    "trigger": "waiver_wire", "group": "tuesday",
    "season": 2026, "week": 1,
    "localHour": 12,                             // where the run landed on their clock
    "idealHour": 9,                              // where the alert would rather be
    "idealAt": "2026-09-08T13:00:00.000Z",
    "offsetFromIdealMinutes": 180,
    "wouldDeliver": true                         // false when that transport is unconfigured
  }]
}
```

`missingTimezone`, `noGroupsEnabled` and `outsideDailyWindow` exist so an empty
`plan` is diagnosable rather than mysterious — they are the three conditions
that silence a device outright.

A dry run still **requires** the secret, and it deliberately still answers `200`
when no transport is provisioned: the first health check anyone runs is against
a deployment whose keys are not set yet, and that is exactly when the schedule
needs verifying. A *live* run with no transport configured returns `503`.

## Verifying

```bash
npm run verify              # everything below, in order
npm run check:scope         # CLAUDE.md rule 1 — every identifier resolves
npm run test:triggers       # 133 assertions: DST, local bands, kickoff anchoring,
                            # the opt-in gate, determinism, and the pull's rate limiter
npm run audit:notifications # 73 assertions: cron auth, dry-run safety, the daily
                            # pull's request count, cron shape, doc sync
npm run check:render        # Chromium: all six screens, zero errors, opt-in contract
```

`audit:notifications` replaces the Supabase client, both transports **and global
`fetch`** with instrumented doubles, drives the real route handler, and asserts
the recordings. It also pins the self-test mode's guarantees: one device, zero
database writes, zero outbound requests, and no reachability without the secret. It does not read the source or trust a flag: the "once a day"
claim is a count of intercepted outbound requests, and the "once a day" cron is
a parsed cron expression, not a phrase in a comment.

## Determinism

Notification copy is seeded exactly like the News Desk: `sha256` over
league + season + week + trigger, sliced per draw. No `Math.random`, no
`Date.now` in the copy path. A retry after a provider timeout cannot change a
message a reader has already seen on another device.

These pools are **new and additive**. No existing article generator, seed term,
hash, or phase pool is read, extended, or reworded — CLAUDE.md rule 2.
