#!/usr/bin/env node
/* ============================================================================
   FSN NOTIFICATIONS — DISPATCH ROUTE AUDIT

   `node scripts/audit-notifications.mjs`

   lib/notifications/selftest.js covers the cadence engine, which is pure
   computation. This covers the thing the engine cannot: the HTTP route that
   fans out real pushes to real devices. Two properties matter enough to be
   asserted mechanically rather than reviewed by eye:

     1. It cannot be triggered by anyone without CRON_SECRET, and it fails
        CLOSED when that secret is not configured at all.
     2. `?dry=1` reaches ZERO push providers, writes ZERO database rows, and
        makes ZERO outbound requests, while still exercising the full
        evaluation path — timezones, cadence rules, and the send ledger.

     3. The once-a-day data pull is actually once a day: the cron declared in
        vercel.json fires once per calendar day, and the feed's rate limiter
        keeps a second invocation on the same day from reaching the upstream.

   Property 2 is the dangerous one. A dry run that silently dispatches for real
   is worse than having no dry run at all, because the operator believes they
   are safe. So this does not check a flag or read the source: it replaces the
   Supabase client, both transports and global fetch with instrumented doubles
   that RECORD every call, then asserts the recordings are empty.

   No credentials, no network, no database.
============================================================================ */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let passed = 0;
const failures = [];

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { passed++; return true; }
  failures.push(label + '\n     expected ' + b + '\n     actual   ' + a);
  return false;
}
function checkTrue(label, value) { return check(label, !!value, true); }

/* ==========================================================================
   INSTRUMENTED DOUBLES

   Installed into require.cache BEFORE the route is loaded, so the route's own
   top-level requires resolve to these instead of the real modules.
========================================================================== */

const calls = {
  apnsSend: [],
  apnsSession: 0,
  webpushSend: [],
  dbWrites: [],   // every insert / update / upsert / delete the route attempts
  dbReads: [],    // every select, so we can prove the dry run still evaluates
  fetches: [],    // every outbound request, so the daily pull can be counted
};

function resetCalls() {
  calls.apnsSend.length = 0;
  calls.apnsSession = 0;
  calls.webpushSend.length = 0;
  calls.dbWrites.length = 0;
  calls.dbReads.length = 0;
  calls.fetches.length = 0;
}

/* ---- Outbound-request double ---------------------------------------------
   The schedule feed reads globalThis.fetch at call time, so replacing it here
   intercepts the ONE external request the stack is allowed to make. Every
   assertion about the daily pull is a count read off this array — the audit
   never reaches the real upstream. */
const feedResponse = {
  season: { year: 2026, type: { type: 2 } },
  week: { number: 6 },
  events: [{ date: '2026-09-10T00:15Z', week: { number: 6 } }],
};
globalThis.fetch = async (url) => {
  calls.fetches.push(String(url));
  return { ok: true, status: 200, text: async () => JSON.stringify(feedResponse) };
};

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved, filename: resolved, path: dirname(resolved),
    loaded: true, children: [], paths: [], exports,
  };
}

/* ---- Supabase double ------------------------------------------------------
   A chainable query builder. Every method returns `this`, and `this` is
   thenable, so `await client.from(t).select().is().limit()` resolves wherever
   the route stops chaining. Reads return whatever the current fixture holds;
   writes are recorded and answered with the configured error (or none). */
let fixture = { devices: [], ledger: [], schedule: null, insertError: null };

function makeSupabaseDouble() {
  return {
    from(table) {
      const q = {
        _table: table,
        _op: null,
        _payload: null,
        select(cols) { this._op = 'select'; this._cols = cols; return this; },
        insert(row) { this._op = 'insert'; this._payload = row; return this; },
        upsert(row) { this._op = 'upsert'; this._payload = row; return this; },
        update(patch) { this._op = 'update'; this._payload = patch; return this; },
        delete() { this._op = 'delete'; return this; },
        is() { return this; },
        eq() { return this; },
        in() { return this; },
        gte() { return this; },
        limit() { return this; },
        then(resolve) {
          if (this._op === 'select') {
            calls.dbReads.push(this._table);
            if (this._table === 'notification_devices') {
              return Promise.resolve({ data: fixture.devices, error: null }).then(resolve);
            }
            if (this._table === 'notification_schedule') {
              return Promise.resolve({ data: fixture.schedule ? [fixture.schedule] : [], error: null }).then(resolve);
            }
            return Promise.resolve({ data: fixture.ledger, error: null }).then(resolve);
          }
          calls.dbWrites.push({ table: this._table, op: this._op, payload: this._payload });
          /* Model the row actually landing, so "the second run of the day" is a
             real scenario rather than a re-read of the same stale fixture. */
          if (this._table === 'notification_schedule' && this._op === 'upsert') {
            fixture.schedule = Object.assign({}, fixture.schedule, this._payload);
          }
          const error = (this._op === 'insert') ? fixture.insertError : null;
          return Promise.resolve({ data: null, error }).then(resolve);
        },
      };
      return q;
    },
  };
}

stub('@supabase/supabase-js', { createClient: () => makeSupabaseDouble() });

/* ---- Transport doubles ---------------------------------------------------
   `configured` is flipped per scenario so the audit can cover a deployment
   with no keys provisioned, which is exactly the state a first health check
   runs against. */
const transportState = { apns: true, web: true };

stub(join(root, 'lib/notifications/apns.js'), {
  isConfigured: () => transportState.apns,
  openSession: () => { calls.apnsSession++; return { __fake: true }; },
  closeSession: () => {},
  send: (session, token, notification) => {
    calls.apnsSend.push({ token, title: notification.title });
    return Promise.resolve({ ok: true, status: 200, reason: '', retryable: false, unregister: false });
  },
  apnsConfig: () => ({}),
});

stub(join(root, 'lib/notifications/webpush.js'), {
  isConfigured: () => transportState.web,
  publicKey: () => 'test-key',
  validSubscription: () => true,
  send: (subscription, notification) => {
    calls.webpushSend.push({ endpoint: subscription && subscription.endpoint, title: notification.title });
    return Promise.resolve({ ok: true, status: 201, reason: '', retryable: false, unregister: false });
  },
});

/* The route under audit, loaded only after the doubles are in place. */
const dispatch = require(join(root, 'api/notifications-dispatch.js'));

/* ==========================================================================
   REQUEST / RESPONSE DOUBLES
========================================================================== */

function makeRes() {
  const res = {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
  return res;
}

/* `withQuery:false` models a runtime that does NOT pre-parse the query string
   onto req.query — anything other than Vercel's Node helper layer. The route
   must still honour ?dry=1 there, because the failure mode is a "dry run" that
   silently dispatches for real. */
async function invoke({ method = 'GET', url = '/api/notifications-dispatch', headers = {}, withQuery = true } = {}) {
  const parsed = new URL(url, 'http://localhost');
  const req = { method, url, headers };
  if (withQuery) {
    req.query = Object.fromEntries(parsed.searchParams.entries());
  }
  const res = makeRes();
  await dispatch(req, res);
  return res;
}

/* A device that IS due for the Tuesday waiver alert at the pinned instant. */
function dueDevice(overrides) {
  return Object.assign({
    device_id: 'a'.repeat(64),
    platform: 'web',
    apns_token: null,
    subscription: { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } },
    league_id: '123456',
    team_id: '1',
    timezone: 'America/New_York',
    prefs: { tuesday: true, thursday: true, sunday: true },
    season_year: 2026,
    week: 1,
    first_kickoff_ms: null,
  }, overrides || {});
}

/* A cached schedule row whose last ATTEMPT is `hoursAgo` before the pinned
   clock. Inside the feed's interval it must suppress the outbound request
   entirely; outside it, exactly one request is allowed. */
function cachedSchedule(hoursAgo, now, overrides) {
  return Object.assign({
    id: 'nfl',
    season_year: 2026,
    week: 2,
    season_type: 2,
    first_kickoff_ms: null,
    source: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
    fetched_at: new Date(now - hoursAgo * 3600 * 1000).toISOString(),
    attempted_at: new Date(now - hoursAgo * 3600 * 1000).toISOString(),
    last_error: null,
  }, overrides || {});
}

const SECRET = 'audit-secret-value-0123456789';

function scenario(name, envPatch, fixturePatch) {
  resetCalls();
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.CRON_SECRET = SECRET;
  transportState.apns = true;
  transportState.web = true;
  fixture = { devices: [], ledger: [], schedule: null, insertError: null };
  Object.assign(process.env, envPatch || {});
  Object.assign(fixture, fixturePatch || {});
  return name;
}

/* ==========================================================================
   1. EXTERNAL CRON SECURITY
========================================================================== */
console.log('\n-- 1. External cron authentication --');
{
  scenario('no credentials');
  let res = await invoke();
  check('no Authorization header -> 401', res.statusCode, 401);
  check('no header reveals nothing beyond UNAUTHORIZED', res.body, { error: 'UNAUTHORIZED' });

  scenario('wrong secret');
  res = await invoke({ headers: { authorization: 'Bearer wrong-secret-value-000000' } });
  check('wrong bearer -> 401', res.statusCode, 401);

  scenario('right secret, wrong scheme');
  res = await invoke({ headers: { authorization: SECRET } });
  check('raw secret without the Bearer scheme -> 401', res.statusCode, 401);

  scenario('correct bearer');
  res = await invoke({ headers: { authorization: 'Bearer ' + SECRET } });
  check('correct Bearer -> 200', res.statusCode, 200);

  scenario('x-cron-secret header');
  res = await invoke({ headers: { 'x-cron-secret': SECRET } });
  check('x-cron-secret header -> 200 (for schedulers that cannot set Authorization)', res.statusCode, 200);

  /* The fail-closed case. An unset CRON_SECRET must not become "no auth
     required"; that would leave a public push fan-out on the internet. */
  scenario('CRON_SECRET unset', { CRON_SECRET: '' });
  res = await invoke({ headers: { authorization: 'Bearer ' + SECRET } });
  check('unset CRON_SECRET fails CLOSED -> 401', res.statusCode, 401);

  scenario('empty bearer against unset secret', { CRON_SECRET: '' });
  res = await invoke({ headers: { authorization: 'Bearer ' } });
  check('empty bearer vs empty secret does not match -> 401', res.statusCode, 401);

  scenario('method guard');
  res = await invoke({ method: 'DELETE', headers: { authorization: 'Bearer ' + SECRET } });
  check('DELETE -> 405', res.statusCode, 405);
  check('405 advertises the allowed methods', res.headers.allow, 'GET, POST');

  scenario('POST is allowed for schedulers that only POST');
  res = await invoke({ method: 'POST', headers: { authorization: 'Bearer ' + SECRET } });
  check('POST -> 200', res.statusCode, 200);

  scenario('unauthorised request touches nothing');
  await invoke();
  check('401 performed no database reads', calls.dbReads, []);
  check('401 performed no database writes', calls.dbWrites, []);
  check('401 sent no pushes', calls.webpushSend.length + calls.apnsSend.length, 0);
}

/* ==========================================================================
   2. DRY RUN
========================================================================== */
console.log('-- 2. Dry-run safety --');
{
  const auth = { authorization: 'Bearer ' + SECRET };
  /* Pinned to the cron's own instant: Tuesday 2026-09-08 16:00Z, which is
     12:00 in New York and therefore inside the waiver band, so there is
     genuinely something to send. */
  const CRON_RUN_TUESDAY = Date.UTC(2026, 8, 8, 16, 0, 0);
  const realNow = Date.now;

  // --- control: a real run DOES send, so the dry-run assertions below mean something
  scenario('live run', null, { devices: [dueDevice()] });
  Date.now = () => CRON_RUN_TUESDAY;
  let res = await invoke({ headers: auth });
  Date.now = realNow;
  check('live run returns 200', res.statusCode, 200);
  checkTrue('live run actually sends (control for the dry-run assertions)', calls.webpushSend.length === 1);
  checkTrue('live run writes the ledger', calls.dbWrites.length > 0);

  // --- dry run via req.query (the Vercel path)
  scenario('dry run, req.query populated', null, { devices: [dueDevice()] });
  Date.now = () => CRON_RUN_TUESDAY;
  res = await invoke({ url: '/api/notifications-dispatch?dry=1', headers: auth });
  Date.now = realNow;
  check('dry run returns 200', res.statusCode, 200);
  check('dry run declares itself', res.body && res.body.dryRun, true);
  check('dry run sent ZERO web pushes', calls.webpushSend, []);
  check('dry run sent ZERO APNs pushes', calls.apnsSend, []);
  check('dry run opened ZERO APNs sessions', calls.apnsSession, 0);
  check('dry run wrote ZERO database rows', calls.dbWrites, []);
  /* The dry run must not spend the day's one external request, and — the
     subtler half — must not stamp attempted_at, which would rate-limit the
     real cron run that follows it out of its own pull. */
  check('dry run made ZERO outbound requests', calls.fetches, []);
  checkTrue('dry run still READ the devices table', calls.dbReads.includes('notification_devices'));
  checkTrue('dry run still SCANNED the send ledger', calls.dbReads.includes('notification_sends'));
  checkTrue('dry run reports what would have sent', !!(res.body && res.body.plan && res.body.plan.length === 1));
  check('dry run names the trigger', res.body.plan[0].trigger, 'waiver_wire');

  // --- dry run when the runtime did NOT pre-parse the query string
  scenario('dry run, req.query absent', null, { devices: [dueDevice()] });
  Date.now = () => CRON_RUN_TUESDAY;
  res = await invoke({ url: '/api/notifications-dispatch?dry=1', headers: auth, withQuery: false });
  Date.now = realNow;
  check('dry=1 honoured from the URL when req.query is absent', res.body && res.body.dryRun, true);
  check('no pushes sent when req.query is absent', calls.webpushSend.length + calls.apnsSend.length, 0);
  check('no database writes when req.query is absent', calls.dbWrites, []);

  // --- the ledger must still suppress in a dry run, or the plan lies
  scenario('dry run respects the ledger', null, {
    devices: [dueDevice()],
    ledger: [{ device_id: 'a'.repeat(64), trigger_id: 'waiver_wire', season_year: 2026, week: 1 }],
  });
  Date.now = () => CRON_RUN_TUESDAY;
  res = await invoke({ url: '/api/notifications-dispatch?dry=1', headers: auth });
  Date.now = realNow;
  check('an already-sent alert is not reported as due', res.body && res.body.due, 0);

  // --- a health check must work BEFORE any transport keys are provisioned
  scenario('dry run with no transport configured', null, { devices: [dueDevice()] });
  transportState.apns = false;
  transportState.web = false;
  Date.now = () => CRON_RUN_TUESDAY;
  res = await invoke({ url: '/api/notifications-dispatch?dry=1', headers: auth });
  Date.now = realNow;
  check('dry run still returns a diagnostic with no transports provisioned', res.statusCode, 200);
  checkTrue('diagnostic reports transport readiness',
    !!(res.body && res.body.transports && res.body.transports.apns === false && res.body.transports.web === false));

  // --- a LIVE run with no transports must still refuse
  scenario('live run with no transport configured', null, { devices: [dueDevice()] });
  transportState.apns = false;
  transportState.web = false;
  res = await invoke({ headers: auth });
  check('live run with no transports -> 503', res.statusCode, 503);

  // --- dry run must not be reachable without the secret
  scenario('unauthenticated dry run', null, { devices: [dueDevice()] });
  res = await invoke({ url: '/api/notifications-dispatch?dry=1' });
  check('dry run still requires the secret -> 401', res.statusCode, 401);
}

/* ==========================================================================
   3. THE ONCE-A-DAY DATA PULL

   The whole point of the schedule is that the external source is read once a
   day, whatever happens. Every assertion here is a COUNT of intercepted
   outbound requests, so it proves the behaviour rather than trusting the
   module's own bookkeeping.
========================================================================== */
console.log('-- 3. Daily data pull --');
{
  const auth = { authorization: 'Bearer ' + SECRET };
  const CRON_RUN = Date.UTC(2026, 8, 8, 16, 0, 0);
  const realNow = Date.now;

  const runLive = async (fixturePatch) => {
    scenario('daily pull', null, Object.assign({ devices: [dueDevice()] }, fixturePatch || {}));
    Date.now = () => CRON_RUN;
    try { return await invoke({ headers: auth }); }
    finally { Date.now = realNow; }
  };

  // --- cold cache: one pull, and the row is written
  let res = await runLive({ schedule: null });
  check('a cold cache pulls exactly once', calls.fetches.length, 1);
  checkTrue('the pull goes to the public ESPN scoreboard, with no credentials',
    calls.fetches[0].startsWith('https://site.api.espn.com/'));
  const scheduleWrites = calls.dbWrites.filter((w) => w.table === 'notification_schedule');
  check('the pull writes exactly one cache row', scheduleWrites.length, 1);
  check('the cache write is an upsert, not an insert that would collide', scheduleWrites[0].op, 'upsert');
  checkTrue('the cache write stamps attempted_at (the rate limiter)',
    !!scheduleWrites[0].payload.attempted_at);
  checkTrue('the response reports the pull', !!(res.body && res.body.schedule && res.body.schedule.pulledThisRun));

  // --- a fresh row: the second invocation of the same day must NOT re-pull
  res = await runLive({ schedule: cachedSchedule(1, CRON_RUN) });
  check('a run inside the interval makes ZERO outbound requests', calls.fetches.length, 0);
  check('a rate-limited run writes no cache row',
    calls.dbWrites.filter((w) => w.table === 'notification_schedule').length, 0);
  check('the response says the pull was rate-limited', res.body.schedule.reason, 'RATE_LIMITED');

  // --- a stale row: one pull, once
  res = await runLive({ schedule: cachedSchedule(30, CRON_RUN) });
  check('a stale cache pulls exactly once', calls.fetches.length, 1);

  // --- and the run right after it, in the same scenario, pulls nothing
  Date.now = () => CRON_RUN + 60000;
  const before = calls.fetches.length;
  await invoke({ headers: auth });
  Date.now = realNow;
  check('the very next invocation makes no further request', calls.fetches.length - before, 0);

  // --- the feed's live week wins over the week the device last reported.
  //     This is the season-long silence bug: a device stuck on an old week
  //     collides with its own ledger row forever.
  res = await runLive({ schedule: null, devices: [dueDevice({ week: 1, season_year: 2026 })] });
  const claim = calls.dbWrites.find((w) => w.table === 'notification_sends' && w.op === 'insert');
  checkTrue('the send was claimed', !!claim);
  check('the ledger row is keyed on the feed week, not the stale device week', claim.payload.week, 6);
  check('the response reports the live week', res.body.schedule.week, 6);

  // --- an upstream failure must not take the dispatch down with it
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.fetches.push(String(url)); throw new Error('UPSTREAM_DOWN'); };
  res = await runLive({ schedule: cachedSchedule(30, CRON_RUN, { week: 4 }) });
  globalThis.fetch = realFetch;
  check('a failed pull still returns 200 and dispatches', res.statusCode, 200);
  check('a failed pull falls back to the cached week', res.body.schedule.week, 4);
  check('a failed pull is reported, not hidden', res.body.schedule.reason, 'PULL_FAILED');
  checkTrue('a failed pull still stamps the rate limiter',
    !!calls.dbWrites.filter((w) => w.table === 'notification_schedule')[0].payload.attempted_at);

  // --- with nobody registered, the external source is not touched at all
  scenario('no devices', null, { devices: [], schedule: null });
  Date.now = () => CRON_RUN;
  res = await invoke({ headers: auth });
  Date.now = realNow;
  check('zero devices means zero outbound requests', calls.fetches, []);
}

/* ==========================================================================
   4. DOCUMENTATION SYNC
========================================================================== */
console.log('-- 4. Documentation sync --');
{
  const { readFileSync } = await import('node:fs');
  const doc = readFileSync(join(root, 'NOTIFICATIONS.md'), 'utf8');

  const notificationSources = [
    'api/notifications-dispatch.js', 'api/notifications-register.js',
    'lib/notifications/triggers.js', 'lib/notifications/apns.js', 'lib/notifications/webpush.js',
    'lib/notifications/schedule-feed.js',
  ].map((rel) => readFileSync(join(root, rel), 'utf8')).join('\n');

  const readVars = new Set([...notificationSources.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]));

  /* Backticked SCREAMING_CASE in the prose, narrowed to tokens containing an
     underscore. Without that narrowing this also matches HTTP verbs and status
     words the docs legitimately quote (`GET`, `POST`), which is a false alarm
     rather than a stale variable. The narrowing is safe because it only relaxes
     the doc->code direction; the code->doc direction below, which is the one
     that matters for an operator missing a required variable, is unfiltered. */
  const documented = new Set(
    [...doc.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)].map((m) => m[1]).filter((v) => v.includes('_'))
  );

  const undocumented = [...readVars].filter((v) => !documented.has(v)).sort();
  const stale = [...documented].filter((v) => !readVars.has(v)).sort();

  check('every env var the code reads is documented', undocumented, []);
  check('every env var documented is actually read', stale, []);

  /* The route path in the docs must be the route that exists on disk. A
     health-check command that 404s is worse than no command. */
  const pathsInDoc = [...doc.matchAll(/\/api\/(notifications-[a-z-]+)/g)].map((m) => m[1]);
  const unique = [...new Set(pathsInDoc)].sort();
  const { existsSync } = await import('node:fs');
  const missing = unique.filter((p) => !existsSync(join(root, 'api', p + '.js')));
  check('every /api/ path named in the docs exists', missing, []);
  checkTrue('the docs document the dry-run health check', /dry=1/.test(doc));
  checkTrue('the docs document the bearer token for external schedulers',
    /Authorization: Bearer \$CRON_SECRET/.test(doc));

  checkTrue('the docs state the once-a-day schedule', /once a day|once-a-day/i.test(doc));
}

/* ==========================================================================
   5. SCHEDULE SHAPE

   "Once a day" is a claim about a cron string, so it is parsed rather than
   read. A five-field expression fires once per day only when the minute and
   hour are both fixed and the three date fields are wildcards; anything else
   — a step, a list, a range, a bare `*` — is a different cadence wearing the
   same words, and on the Hobby plan it is also a deploy that Vercel rejects.
========================================================================== */
console.log('-- 5. Schedule shape --');
{
  const { readFileSync, existsSync, readdirSync } = await import('node:fs');
  const doc = readFileSync(join(root, 'NOTIFICATIONS.md'), 'utf8');

  const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
  const crons = vercel.crons || [];
  check('vercel.json declares exactly one cron', crons.length, 1);

  const cron = crons[0] || {};
  check('the cron targets the dispatcher', cron.path, '/api/notifications-dispatch');
  checkTrue('the cron path resolves to a real function',
    existsSync(join(root, String(cron.path || '').replace(/^\//, '') + '.js')));

  const fields = String(cron.schedule || '').trim().split(/\s+/);
  check('the schedule is a five-field cron expression', fields.length, 5);
  const [minute, hour, dom, month, dow] = fields;
  checkTrue('the minute is a fixed value, not a wildcard or a step', /^\d{1,2}$/.test(minute));
  checkTrue('the hour is a fixed value, not a wildcard or a step', /^\d{1,2}$/.test(hour));
  check('it fires on every day of the month', dom, '*');
  check('it fires in every month', month, '*');
  check('it fires on every weekday', dow, '*');

  /* One fixed instant per day is what the trigger engine's local-hour bands are
     built around, so the UTC hour is not free to drift: the docs quote it and
     the engine's comments reason from it. */
  checkTrue('the docs quote the same cron expression as vercel.json',
    doc.includes(String(cron.schedule)));

  /* The daily pull must run on Vercel's own scheduler, inside the serverless
     function. A workflow that curls the dispatcher on a schedule would put the
     data pull back on GitHub's side of the fence — a repository actor, with the
     deploy-triggering surface that comes with it — which is exactly what this
     design moved away from. */
  const workflowDir = join(root, '.github', 'workflows');
  const workflows = existsSync(workflowDir)
    ? readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f))
    : [];
  const scheduled = [];
  const touchingDispatch = [];
  for (const file of workflows) {
    const body = readFileSync(join(workflowDir, file), 'utf8');
    if (/^\s*schedule:/m.test(body)) scheduled.push(file);
    if (/notifications-dispatch/.test(body)) touchingDispatch.push(file);
  }
  check('no GitHub workflow runs on a schedule', scheduled, []);
  check('no GitHub workflow invokes the dispatcher', touchingDispatch, []);
}

/* ------------------------------------------------------------------------- */
if (failures.length) {
  console.error('\n[audit] ' + failures.length + ' FAILED, ' + passed + ' passed\n');
  failures.forEach((f, i) => console.error('  ' + (i + 1) + ') ' + f + '\n'));
  process.exit(1);
}
console.log('\n[audit] all ' + passed + ' assertions passed');
