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

Requires a Mac — see `ios/HANDOFF.md`. After `npm install && npx cap sync ios`:

1. **Signing & Capabilities → + Capability → Push Notifications**
2. **+ Capability → Background Modes → Remote notifications**
3. In the Apple Developer portal, confirm the App ID for
   `app.fantasysportsnetwork` has the Push Notifications service enabled, and
   that the `.p8` key in `APNS_KEY_P8` is authorised for it.

Capacitor's `@capacitor/push-notifications` handles `AppDelegate` registration;
no Swift changes are needed.

## Verifying

```bash
npm run verify          # scope scan + trigger self-test + headless render
npm run test:triggers   # 37 assertions: DST, grace window, opt-in gate, determinism
npm run check:scope     # CLAUDE.md rule 1 — every identifier resolves
npm run check:render    # Chromium: all six screens, zero errors, opt-in contract
```

Once deployed, dry-run the schedule without sending anything:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://<deployment>/api/notifications-dispatch?dry=1"
```

That reports which devices are due for which trigger, the target instant, and
how late the run is — with no pushes sent and no ledger rows written.

## Determinism

Notification copy is seeded exactly like the News Desk: `sha256` over
league + season + week + trigger, sliced per draw. No `Math.random`, no
`Date.now` in the copy path. A retry after a provider timeout cannot change a
message a reader has already seen on another device.

These pools are **new and additive**. No existing article generator, seed term,
hash, or phase pool is read, extended, or reworded — CLAUDE.md rule 2.
