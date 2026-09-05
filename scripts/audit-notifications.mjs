#!/usr/bin/env node
/* ============================================================================
   FSN NOTIFICATIONS — DISPATCH ROUTE AUDIT

   `node scripts/audit-notifications.mjs`

   api/notifications/selftest.js covers the cadence engine, which is pure
   computation. This covers the thing the engine cannot: the HTTP route that
   fans out real pushes to real devices. Two properties matter enough to be
   asserted mechanically rather than reviewed by eye:

     1. It cannot be triggered by anyone without CRON_SECRET, and it fails
        CLOSED when that secret is not configured at all.
     2. `?dry=1` reaches ZERO push providers and writes ZERO database rows,
        while still exercising the full evaluation path — timezones, cadence
        rules, and the send ledger.

   Property 2 is the dangerous one. A dry run that silently dispatches for real
   is worse than having no dry run at all, because the operator believes they
   are safe. So this does not check a flag or read the source: it replaces the
   Supabase client and both transports with instrumented doubles that RECORD
   every call, then asserts the recordings are empty.

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
  dbWrites: [],   // every insert / update / delete the route attempts
  dbReads: [],    // every select, so we can prove the dry run still evaluates
};

function resetCalls() {
  calls.apnsSend.length = 0;
  calls.apnsSession = 0;
  calls.webpushSend.length = 0;
  calls.dbWrites.length = 0;
  calls.dbReads.length = 0;
}

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
let fixture = { devices: [], ledger: [], insertError: null };

function makeSupabaseDouble() {
  return {
    from(table) {
      const q = {
        _table: table,
        _op: null,
        _payload: null,
        select(cols) { this._op = 'select'; this._cols = cols; return this; },
        insert(row) { this._op = 'insert'; this._payload = row; return this; },
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
            return Promise.resolve({ data: fixture.ledger, error: null }).then(resolve);
          }
          calls.dbWrites.push({ table: this._table, op: this._op, payload: this._payload });
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

stub(join(root, 'api/notifications/apns.js'), {
  isConfigured: () => transportState.apns,
  openSession: () => { calls.apnsSession++; return { __fake: true }; },
  closeSession: () => {},
  send: (session, token, notification) => {
    calls.apnsSend.push({ token, title: notification.title });
    return Promise.resolve({ ok: true, status: 200, reason: '', retryable: false, unregister: false });
  },
  apnsConfig: () => ({}),
});

stub(join(root, 'api/notifications/webpush.js'), {
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

const SECRET = 'audit-secret-value-0123456789';

function scenario(name, envPatch, fixturePatch) {
  resetCalls();
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.CRON_SECRET = SECRET;
  transportState.apns = true;
  transportState.web = true;
  fixture = { devices: [], ledger: [], insertError: null };
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
  /* Pinned to Tuesday 2026-09-08 09:05 America/New_York, inside the waiver
     window, so there is genuinely something to send. */
  const TUESDAY_0905_NY = Date.UTC(2026, 8, 8, 13, 5, 0);
  const realNow = Date.now;

  // --- control: a real run DOES send, so the dry-run assertions below mean something
  scenario('live run', null, { devices: [dueDevice()] });
  Date.now = () => TUESDAY_0905_NY;
  let res = await invoke({ headers: auth });
  Date.now = realNow;
  check('live run returns 200', res.statusCode, 200);
  checkTrue('live run actually sends (control for the dry-run assertions)', calls.webpushSend.length === 1);
  checkTrue('live run writes the ledger', calls.dbWrites.length > 0);

  // --- dry run via req.query (the Vercel path)
  scenario('dry run, req.query populated', null, { devices: [dueDevice()] });
  Date.now = () => TUESDAY_0905_NY;
  res = await invoke({ url: '/api/notifications-dispatch?dry=1', headers: auth });
  Date.now = realNow;
  check('dry run returns 200', res.statusCode, 200);
  check('dry run declares itself', res.body && res.body.dryRun, true);
  check('dry run sent ZERO web pushes', calls.webpushSend, []);
  check('dry run sent ZERO APNs pushes', calls.apnsSend, []);
  check('dry run opened ZERO APNs sessions', calls.apnsSession, 0);
  check('dry run wrote ZERO database rows', calls.dbWrites, []);
  checkTrue('dry run still READ the devices table', calls.dbReads.includes('notification_devices'));
  checkTrue('dry run still SCANNED the send ledger', calls.dbReads.includes('notification_sends'));
  checkTrue('dry run reports what would have sent', !!(res.body && res.body.plan && res.body.plan.length === 1));
  check('dry run names the trigger', res.body.plan[0].trigger, 'waiver_wire');

  // --- dry run when the runtime did NOT pre-parse the query string
  scenario('dry run, req.query absent', null, { devices: [dueDevice()] });
  Date.now = () => TUESDAY_0905_NY;
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
  Date.now = () => TUESDAY_0905_NY;
  res = await invoke({ url: '/api/notifications-dispatch?dry=1', headers: auth });
  Date.now = realNow;
  check('an already-sent alert is not reported as due', res.body && res.body.due, 0);

  // --- a health check must work BEFORE any transport keys are provisioned
  scenario('dry run with no transport configured', null, { devices: [dueDevice()] });
  transportState.apns = false;
  transportState.web = false;
  Date.now = () => TUESDAY_0905_NY;
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
   3. DOCUMENTATION SYNC
========================================================================== */
console.log('-- 3. Documentation sync --');
{
  const { readFileSync } = await import('node:fs');
  const doc = readFileSync(join(root, 'NOTIFICATIONS.md'), 'utf8');

  const notificationSources = [
    'api/notifications-dispatch.js', 'api/notifications-register.js',
    'api/notifications/triggers.js', 'api/notifications/apns.js', 'api/notifications/webpush.js',
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

  /* vercel.json must point at a route that exists. */
  const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
  const cronPaths = (vercel.crons || []).map((c) => c.path);
  check('vercel.json declares exactly one cron', cronPaths.length, 1);
  checkTrue('the cron path resolves to a real function',
    existsSync(join(root, cronPaths[0].replace(/^\//, '') + '.js')));
}

/* ------------------------------------------------------------------------- */
if (failures.length) {
  console.error('\n[audit] ' + failures.length + ' FAILED, ' + passed + ' passed\n');
  failures.forEach((f, i) => console.error('  ' + (i + 1) + ') ' + f + '\n'));
  process.exit(1);
}
console.log('\n[audit] all ' + passed + ' assertions passed');
