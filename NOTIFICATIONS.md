# FSN — Push Notifications

Weekly engagement alerts for the three moments that matter in a fantasy week.
Everything below is implemented; what is left is provisioning (keys, a SQL run,
and the Xcode capability), which needs accounts this repo cannot reach.

## What gets sent

Five alerts across three reader-facing switches. Each fires at most once per
device per fantasy week.

| Switch | Alert | When |
|---|---|---|
| **Tuesday** | Waiver wire results | Tue 09:00 *reader's local time* |
| **Tuesday** | Recap + power index drop | Tue 18:00 local |
| **Thursday** | TNF lineup lock warning | 2h before the week's **actual opening kickoff** |
| **Sunday** | Morning lineup check | Sun 09:00 local |
| **Sunday** | Game day pulse | Sun 13:00 local |

The Thursday alert is anchored to the real kickoff, read through the existing
`EditorialScheduleEngine.firstGameTimestamp()`, so a Saturday or international
opener moves it correctly instead of firing at a hardcoded 20:15 ET. If the
client has not reported a kickoff for the week, it falls back to 16:00 local
Thursday.

## Architecture

```
notificationService.js     global-scope client. Owns permission, token capture,
                           registration. NEVER prompts on boot.
sw.js                      service worker — Web Push receipt only, no caching.
index.html                 Setup screen card (markup + block-6 controller).

api/notifications-register.js   device registration / preferences / unsubscribe
api/notifications-dispatch.js   hourly cron target
api/notifications/triggers.js   pure cadence engine + deterministic copy
api/notifications/apns.js       APNs over HTTP/2, token auth, zero deps
api/notifications/webpush.js    VAPID Web Push (wraps `web-push`)
api/notifications/selftest.js   37 assertions, no credentials needed

supabase/notifications.sql      notification_devices + notification_sends
```

`notificationService.js` loads at global scope alongside
`editorialScheduleEngine.js` for the reason CLAUDE.md rule 1 exists: it is
driven from block 6 and fed league context from block 1, so it cannot live
inside either IIFE.

### Why hourly cron rather than five weekly ones

Each alert must land at a sensible hour in the *reader's* timezone. A
`vercel.json` cron fires at one fixed UTC instant, so five weekly crons would
wake a Honolulu reader at 04:00 to say waivers cleared. Instead one cron runs
hourly and `triggers.js` decides, per device, whether that device's local
window just opened. It also makes a missed run self-healing — the engine's
3-hour grace window re-offers a recent alert on the next pass.

> **Plan note:** Vercel's Hobby tier limits cron jobs to **once per day**, which
> is not enough for this design. Hourly requires **Pro**. On Hobby the route
> still works — trigger it from any external scheduler (GitHub Actions,
> cron-job.org) with `Authorization: Bearer $CRON_SECRET`.

### At-most-once delivery

The ledger row in `notification_sends` is inserted **before** the provider call.
Its composite primary key means two overlapping cron runs cannot both deliver.
The deliberate trade: a provider call that fails after the insert drops that one
alert rather than risking a duplicate. For a weekly nudge that is the right side
to fail on, and the drop is recorded as `status='failed'` rather than lost.

## Privacy

A device row is a push address, a timezone, and three booleans. Deliberately not
stored: email, ESPN cookies, SWID, display name, IP address. The primary key is
the SHA-256 of the push address, so the id is safe to log and to return to the
client while the address itself sits in one column only the dispatcher reads.
RLS is on with **no** anon or authenticated policies — service-role routes only,
the same boundary `public.leagues` already uses.

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
which defines the shared touch trigger it reuses).

### 2. Environment variables

Required by both transports:

| Variable | Notes |
|---|---|
| `SUPABASE_URL` | already set for `/api/league` |
| `SUPABASE_SERVICE_ROLE_KEY` | already set |
| `CRON_SECRET` | any long random string. **Without it the dispatcher refuses to run** rather than defaulting open. Vercel attaches it to scheduled invocations automatically. |

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

See `docs/ios-handoff.md`. The `iOS Build` GitHub Actions workflow
(`.github/workflows/ios-build.yml`) builds and signs the binary on a hosted
macOS runner, so a Mac is no longer required for a TestFlight build.

Steps 1 and 2 below are applied automatically by `npm run ios:configure`
(`scripts/ios-configure.mjs`), which writes the `aps-environment` entitlement
and the `remote-notification` background mode into the generated Xcode
project on every CI run. Step 3 is a one-time portal change only a human can
make.

1. **Signing & Capabilities → + Capability → Push Notifications** — automated.
2. **+ Capability → Background Modes → Remote notifications** — automated.
3. In the Apple Developer portal, confirm the App ID for
   `app.fantasysportsnetwork` has the Push Notifications service enabled, and
   that the `.p8` key in `APNS_KEY_P8` is authorised for it. **The archive
   fails to sign if the App ID lacks the Push Notifications service**, since
   the entitlement above has to be satisfied by the provisioning profile.
   The iOS build workflow has a repository variable that turns the push
   entitlement off if you need a build before that is sorted out — see
   docs/ios-release.md.

Capacitor's `@capacitor/push-notifications` handles `AppDelegate` registration;
no Swift changes are needed.

## Triggering the dispatcher externally

The route authenticates every caller against `CRON_SECRET` and **fails closed**:
if the variable is unset, the route returns 401 to everyone rather than
defaulting open. Two header forms are accepted, because not every scheduler can
set an `Authorization` header:

```bash
# What Vercel Cron sends automatically.
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://<deployment>/api/notifications-dispatch"

# Equivalent, for schedulers that only allow custom headers.
curl -H "x-cron-secret: $CRON_SECRET" \
  "https://<deployment>/api/notifications-dispatch"
```

`GET` and `POST` both work; anything else returns 405. The secret is compared in
constant time.

This is the path to use on Vercel Hobby, where cron is limited to once per day —
point GitHub Actions, cron-job.org, or any hourly scheduler at the URL above.

## Health check (`?dry=1`)

`?dry=1` runs the **entire** evaluation lifecycle — reads every live device,
scans the send ledger, normalises each timezone, and applies every cadence rule
— then returns what it *would* have done and stops. It opens no APNs session,
sends no Web Push, and writes no database row.

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://<deployment>/api/notifications-dispatch?dry=1"
```

```jsonc
{
  "ok": true,
  "dryRun": true,
  "now": "2026-09-08T13:05:00.000Z",
  "transports": { "apns": false, "web": true },  // which providers are provisioned
  "deliverable": true,                           // could a live run send anything at all
  "evaluated": 4,                                // live devices considered
  "due": 1,                                      // alerts a live run would send now
  "ledgerRowsScanned": 0,                        // dedupe rows inside the lookback
  "ledgerLookbackDays": 21,
  "devices": {
    "total": 4, "ios": 1, "web": 3,
    "missingTimezone": 1,                        // rows whose zone Intl rejects
    "noGroupsEnabled": 1                         // registered but every switch off
  },
  "planTruncated": false,                        // `due` is always the real total
  "plan": [{
    "deviceId": "…", "platform": "web", "timezone": "America/New_York",
    "trigger": "waiver_wire", "group": "tuesday",
    "targetAt": "2026-09-08T13:00:00.000Z",
    "lateByMinutes": 5,
    "wouldDeliver": true                         // false when that transport is unconfigured
  }]
}
```

`missingTimezone` and `noGroupsEnabled` exist so an empty `plan` is diagnosable
rather than mysterious — they are the two conditions that silence a device
outright.

A dry run still **requires** the secret, and it deliberately still answers `200`
when no transport is provisioned: the first health check anyone runs is against
a deployment whose keys are not set yet, and that is exactly when the schedule
needs verifying. A *live* run with no transport configured returns `503`.

## Verifying

```bash
npm run verify              # everything below, in order
npm run check:scope         # CLAUDE.md rule 1 — every identifier resolves
npm run test:triggers       # 37 assertions: DST, grace window, opt-in gate, determinism
npm run audit:notifications # 42 assertions: cron auth + dry-run safety + doc sync
npm run check:render        # Chromium: all six screens, zero errors, opt-in contract
```

`audit:notifications` replaces the Supabase client and both transports with
instrumented doubles, drives the real route handler, and asserts the recordings
are empty for `?dry=1`. It does not read the source or trust a flag — it proves
no provider was called and no row was written, with a live-run control in the
same file to show the doubles are actually wired.

## Determinism

Notification copy is seeded exactly like the News Desk: `sha256` over
league + season + week + trigger, sliced per draw. No `Math.random`, no
`Date.now` in the copy path. A retry after a provider timeout cannot change a
message a reader has already seen on another device.

These pools are **new and additive**. No existing article generator, seed term,
hash, or phase pool is read, extended, or reworded — CLAUDE.md rule 2.
