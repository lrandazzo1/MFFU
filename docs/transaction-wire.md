# FSN transaction wire

## Failure recovery

Live collection does not require the transaction-cache migration to be present.
The cache GET returns `mode: "cache-unavailable"` when storage is unconfigured,
missing, or unreachable. The UI still attempts the live POST, even if an older
deployment returns a non-auth HTTP error for GET. POST returns verified live
articles with `storage: "unavailable"` if saving fails; it never reports a
successful durable write. Supabase requests have a five-second timeout, and
Sleeper's three weekly transaction reads run concurrently.

A provider outage returns previously stored articles only after provider access
has been verified for this request. The browser also retains its scoped, already
loaded stories when a refresh fails. HTTP 401/403 clears those stories and asks
the reader to reconnect; it is never converted into a stale-cache success.

An omitted ESPN transaction collection is marked with
`ESPN_TRANSACTIONS_UNAVAILABLE`, allowing verified roster injury observations to
continue. A malformed collection still raises an error. Missing detail is never
presented as proof that no transaction happened. No new injury transition is
inferred if the persistent baseline cannot be read.

Failures remain logged by stage (cache, baseline, provider, commit) with the
original error. The UI distinguishes live-only results, saved results, partial
provider detail, and reconnection requirements. Cron reports a degraded result
as unsuccessful rather than claiming it persisted unsaved articles.

This adds completed-transaction articles beside the existing News Desk stories.
It does not edit any existing generator, template pool, historical payload,
provider wrapper, cloud-sync handler, or existing database table.

## Deployment

1. Apply `supabase/transaction_wire.sql` to the existing Supabase project.
   The two new tables use RLS, no browser policies, and a service-role-only
   atomic commit function. No existing tables are migrated.
2. The routes use the existing `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY`. Keep the service key on the server.
3. Set `CRON_SECRET` if it is not already set for notifications.
4. Set `FSN_TRANSACTION_TARGETS` to a deployment-owned JSON array of league
   scopes for unattended collection. Example for a **public** Sleeper league:

   ```json
   [{"provider":"sleeper","league":"YOUR_NUMERIC_LEAGUE_ID","season":2026,"week":1}]
   ```

   Use the current season and a week from 1–18. The provider's current week
   takes precedence for roster injury observations and Sleeper fetch windows.
   At most ten configured scopes run sequentially. Size the target list to
   the deployment's function duration; a provider outage can exhaust a run.
   A failure in one scope is reported and does not prevent later scopes.

   For private ESPN leagues, add `headers` containing a valid
   `x-league-token`, or the member's `x-espn-s2` and `x-espn-swid` pair.
   Yahoo requires its existing signed session in `headers.cookie`; it remains
   revocable and expires under the existing OAuth session rules. An expired
   session makes that target fail visibly until reconnected. Do not commit
   private headers or this environment value to Git.
5. Deploy the PR after review. The daily cron runs at 12:00 UTC. It is the
   second cron, alongside the untouched notification schedule. With no
   configured targets it returns an explicit configuration error. Opening the
   News Desk also reads then refreshes the selected league, using that reader's
   existing access; adding a target is only necessary for unattended sync.

The PR does **not** apply the migration, change environment values, or deploy.

## API and lifecycle

`GET /api/transaction-wire?provider=...&league=...&season=...&week=...`
verifies provider access before returning up to 250 newest persisted articles.
`POST` at the same URL fetches recent events and persists new articles, then
returns the cache. Caller-provided article bodies are never accepted.
Both responses are private/non-cacheable. ESPN credentials follow the existing
relay boundary, Yahoo uses the existing OAuth session, and Sleeper is public.

In the UI the first cache read can render before the provider sync finishes.
Subsequent renders refresh after sixty seconds. There is no background browser
poller. A provider/cache failure leaves existing News Desk stories available and
shows a transaction-specific status message. League, provider and season isolate
all memory/database keys; disconnect clears this new in-memory cache. The wire
does not persist anything in browser storage. The established lead is retained.

Rows with known weeks render only in that week. Yahoo transaction timestamps do
not carry a fantasy scoring week, so those rows are shown only on the current
week, never retroactively assigned to an archived week. Full-reader and share
flows receive the same article object as the timeline.

## Evidence and editorial rules

- Completed adds/drops/waivers and trades only. Failed, pending, proposed and
  vetoed requests never become successful transaction news.
- The import window is fourteen days; Sleeper fetches the current and previous
  two weekly transaction collections. Yahoo pages up to 200 transactions and
  fails visibly if that ceiling would truncate the requested window. ESPN
  uses the existing `mTransactions2` response; upstream omissions are not
  represented as proof that a move never happened.
- Stable provider transaction IDs give immutable article IDs scoped by
  provider/league/season. SHA-256 selects independent opening, audit and closing
  variations. Generators use no randomness, current clock, network or model.
- A provider execution timestamp is required; proposal/creation times are not
  substituted. Missing player identities or invalid assets produce diagnostics,
  not invented names or stories. Unknown values remain unknown; a zero FAAB bid
  is preserved. All completed supported trades are covered, with no invented
  subjective "major trade" threshold.
- Both sides of player transfers and Sleeper draft-pick/FAAB transfers are
  itemized. Player counts are not described as trade valuations. No losing
  bid, workload prediction, fantasy-point gain, or injury diagnosis is inferred.
- Team scoring share and gap from the league average use verified nonnegative
  team totals. PF is never divided by W/L/T to invent PPG in median-game or
  doubleheader leagues. Active positional depth percentages use the actual
  observed roster and explicitly active designations. Roster/record context is
  timestamped as the ingestion observation, not reconstructed event-time state.
- Injury collection first establishes a baseline. Subsequent status changes
  on the same team's player produce stories; duplicate observations and roster
  transfers do not. Unknown statuses cannot imply recovery. A later recurrence
  has a distinct event ID. Injury dates mean first observed, not medical onset.
- Commit uses an advisory lock plus revision comparison. Article inserts and
  injury baseline advancement happen in one transaction; stale overlapping
  runs return a retryable conflict. `ON CONFLICT DO NOTHING` preserves first
  publication even if names, records or editorial code later change.

## Verification

```sh
npm run test:wire
npm run check:wire
npm run check:scope
npm run check:render
npm run check:news
```

Provider normalization tests use representative JSON fixtures; production
private-provider credentials are not part of the tests. Run an authenticated
staging sync after applying the migration to confirm the live feed's available
fields. Missing ESPN transaction/player detail is reported rather than silently
filled in. The migration was also executed twice in local PostgreSQL (PGlite),
verifying immutable inserts, stale-revision rejection, whole-batch rollback and
anonymous table/RPC denial. Confirm the migration against the target Supabase
project before launch; production credentials were not used in local tests.

Provider references: [Sleeper API](https://docs.sleeper.com/) and
[Yahoo Fantasy Sports API](https://sports.yahoo.com/developer/docs/).
