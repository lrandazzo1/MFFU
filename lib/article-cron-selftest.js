'use strict';
/**
 * Scheduled-run self-test. Runs against the COMPILED output in lib/dist, which
 * is what /api/cron/generate-articles requires.
 *
 *   npm run test:articles
 *
 * The Supabase double records every read and write, so the idempotency query,
 * the per-league isolation and the audit trail are all asserted on what the
 * code actually sent, not on what it returned.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runArticleCron,
  activeLeagueIds,
  leaguesAlreadyPublished,
  authorizedByCronSecret,
  cronSecretConfigured,
  normalizeDay,
  leaguesWithFailedRuns,
  classifyFailure,
  rotateForWeek,
} = require('./dist/article-cron');

/* A minimal PostgREST-shaped double: `leagues` and `blog_articles` answer
   filtered selects, `cron_article_logs` collects inserts. */
function fakeDb(options = {}) {
  const leagues = options.leagues || ['100', '200', '300'];
  const published = options.published || [];
  /* Previously recorded outcomes, oldest first, exactly as `cron_article_logs`
     hands them back under `.order('executed_at', { ascending: true })`. */
  const history = options.history || [];
  const logs = [];
  const selects = [];
  const failReads = options.failReads || {};

  const table = (name) => {
    const filters = {};
    const query = {
      select(columns) { selects.push({ table: name, columns, filters }); return query; },
      eq(column, value) { filters[column] = value; return query; },
      order() { return query; },
      insert(row) { logs.push({ table: name, row }); return Promise.resolve({ data: [row], error: null }); },
      then(resolve, reject) { return rows().then(resolve, reject); },
    };
    async function rows() {
      if (failReads[name]) return { data: null, error: new Error(failReads[name]) };
      if (name === 'leagues') {
        return { data: leagues.map((league_id) => ({ league_id })), error: null };
      }
      if (name === 'blog_articles') {
        const hit = published.filter((row) =>
          row.season === filters.season && row.week === filters.week && row.article_type === filters.article_type);
        return { data: hit.map((row) => ({ league_id: row.league_id })), error: null };
      }
      if (name === 'cron_article_logs') {
        const hit = history.filter((row) =>
          row.season === filters.season && row.week === filters.week &&
          row.article_type === filters.article_type);
        return { data: hit, error: null };
      }
      return { data: [], error: null };
    }
    return query;
  };

  return { logs, selects, from: table };
}

const auditFor = (db) => db.logs.filter((entry) => entry.table === 'cron_article_logs').map((entry) => entry.row);

const SCOPE = { day: 'mon', season: 2026, week: 3 };

/* ------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------ */

test('the cron secret gates the route and never defaults open', () => {
  const original = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    assert.equal(cronSecretConfigured(), false);
    // With nothing configured, no presented value may pass. Not even an empty one.
    assert.equal(authorizedByCronSecret({ headers: { authorization: 'Bearer ' } }), false);
    assert.equal(authorizedByCronSecret({ headers: {} }), false);

    process.env.CRON_SECRET = 'sekret-value';
    assert.equal(cronSecretConfigured(), true);
    assert.equal(authorizedByCronSecret({ headers: { authorization: 'Bearer sekret-value' } }), true);
    assert.equal(authorizedByCronSecret({ headers: { 'x-cron-secret': 'sekret-value' } }), true);
    assert.equal(authorizedByCronSecret({ headers: { authorization: 'Bearer sekret-valu' } }), false);
    assert.equal(authorizedByCronSecret({ headers: { authorization: 'Bearer sekret-values' } }), false);
    assert.equal(authorizedByCronSecret({ headers: { authorization: 'sekret-value' } }), false);
    assert.equal(authorizedByCronSecret({}), false);
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = original;
  }
});

test('only the three scheduled days are accepted', () => {
  assert.equal(normalizeDay('mon'), 'mon');
  assert.equal(normalizeDay(' TUE '), 'tue');
  for (const bad of ['wed', 'sat', '', null, 'monday']) assert.throws(() => normalizeDay(bad));
});

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

test('active leagues are the distinct ids stored for this season', async () => {
  const db = fakeDb({ leagues: ['100', '200', '100', ' 300 ', ''] });
  assert.deepEqual(await activeLeagueIds(db, 2026), ['100', '200', '300']);
  assert.deepEqual(db.selects[0].filters, { season_year: 2026 });
});

test('the idempotency query is scoped to season, week and article type', async () => {
  const db = fakeDb({ published: [{ league_id: '200', season: 2026, week: 3, article_type: 'monday_sweat' }] });
  const seen = await leaguesAlreadyPublished(db, { season: 2026, week: 3, article_type: 'monday_sweat' });
  assert.deepEqual([...seen], ['200']);
  assert.deepEqual(db.selects[0].filters, { season: 2026, week: 3, article_type: 'monday_sweat' });
});

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

test('every active league without this week\'s article gets one', async () => {
  const db = fakeDb();
  const calls = [];
  const summary = await runArticleCron(SCOPE, { db, generate: async (input) => { calls.push(input); return {}; } });

  assert.equal(summary.leagues, 3);
  assert.equal(summary.created, 3);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.failed, 0);
  assert.equal(summary.article_type, 'monday_sweat');
  assert.deepEqual(calls.map((c) => c.league_id), ['100', '200', '300']);
  assert.deepEqual(calls[0], { league_id: '100', season: 2026, week: 3, day: 'mon' });
  assert.deepEqual(auditFor(db).map((row) => row.status), ['created', 'created', 'created']);
});

test('a league that already has the article is skipped, never rewritten', async () => {
  const db = fakeDb({ published: [{ league_id: '200', season: 2026, week: 3, article_type: 'monday_sweat' }] });
  const calls = [];
  const summary = await runArticleCron(SCOPE, { db, generate: async (input) => { calls.push(input.league_id); return {}; } });

  assert.equal(summary.created, 2);
  assert.equal(summary.skipped, 1);
  assert.deepEqual(calls, ['100', '300']);
  const audit = auditFor(db);
  assert.equal(audit.find((row) => row.league_id === '200').status, 'skipped');
});

test('an article published for a DIFFERENT week or type does not block this one', async () => {
  const db = fakeDb({ published: [
    { league_id: '100', season: 2026, week: 2, article_type: 'monday_sweat' },
    { league_id: '200', season: 2026, week: 3, article_type: 'tuesday_verdict' },
  ] });
  const summary = await runArticleCron(SCOPE, { db, generate: async () => ({}) });
  assert.equal(summary.created, 3);
  assert.equal(summary.skipped, 0);
});

test('one league failing never stops the others, and the failure is recorded', async () => {
  const db = fakeDb();
  const summary = await runArticleCron(SCOPE, {
    db,
    generate: async (input) => {
      if (input.league_id === '200') throw Object.assign(new Error('ESPN box score read failed'), { status: 502 });
      return {};
    },
  });

  assert.equal(summary.created, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.leagues, 3);

  const audit = auditFor(db);
  assert.equal(audit.length, 3, 'every league is accounted for, including the one that threw');
  const failure = audit.find((row) => row.status === 'failed');
  assert.equal(failure.league_id, '200');
  assert.match(failure.error_message, /ESPN box score read failed \(status 502\)/);
  assert.equal(audit.filter((row) => row.status === 'created').length, 2);
  // The successes are the leagues either side of the failure, so the loop did
  // not simply stop and restart.
  assert.deepEqual(audit.map((row) => row.league_id), ['100', '200', '300']);
});

test('every league failing is reported, not thrown', async () => {
  const db = fakeDb();
  const summary = await runArticleCron(SCOPE, { db, generate: async () => { throw new Error('nope'); } });
  assert.equal(summary.failed, 3);
  assert.equal(summary.created, 0);
  assert.equal(auditFor(db).length, 3);
});

test('a failed audit write does not cost the remaining leagues their articles', async () => {
  const db = fakeDb();
  db.from = ((original) => (name) => {
    const query = original(name);
    if (name === 'cron_article_logs') query.insert = async () => ({ data: null, error: new Error('audit table missing') });
    return query;
  })(db.from);
  const summary = await runArticleCron(SCOPE, { db, generate: async () => ({}) });
  assert.equal(summary.created, 3);
  assert.equal(summary.failed, 0);
});

test('a dry run resolves the work without generating, publishing or logging', async () => {
  const db = fakeDb({ published: [{ league_id: '100', season: 2026, week: 3, article_type: 'monday_sweat' }] });
  let generated = 0;
  const summary = await runArticleCron({ ...SCOPE, dry_run: true }, { db, generate: async () => { generated++; return {}; } });
  assert.equal(generated, 0);
  assert.equal(summary.dry_run, true);
  assert.equal(summary.created, 2);
  assert.equal(summary.skipped, 1);
  assert.equal(auditFor(db).length, 0);
});

test('the run refuses to start when it cannot know what already exists', async () => {
  // Republishing every league because a read failed is worse than not running.
  await assert.rejects(
    runArticleCron(SCOPE, { db: fakeDb({ failReads: { blog_articles: 'blog_articles unreachable' } }), generate: async () => ({}) }),
    /blog_articles unreachable/,
  );
  await assert.rejects(
    runArticleCron(SCOPE, { db: fakeDb({ failReads: { leagues: 'leagues unreachable' } }), generate: async () => ({}) }),
    /leagues unreachable/,
  );
});

test('an empty league list is a clean no-op, not an error', async () => {
  const db = fakeDb({ leagues: [] });
  const summary = await runArticleCron(SCOPE, { db, generate: async () => { throw new Error('must not run'); } });
  assert.equal(summary.leagues, 0);
  assert.equal(summary.created, 0);
  assert.equal(auditFor(db).length, 0);
});

test('bad scopes are rejected before any league is touched', async () => {
  for (const bad of [{ day: 'wed' }, { season: 1900 }, { week: 0 }, { week: 19 }]) {
    const db = fakeDb();
    await assert.rejects(runArticleCron({ ...SCOPE, ...bad }, { db, generate: async () => ({}) }));
    assert.equal(auditFor(db).length, 0);
  }
  await assert.rejects(runArticleCron(SCOPE, {}), /not configured/);
});

test('each day writes its own article type and slug', async () => {
  const expected = {
    mon: ['monday_sweat', '2026-week-3-monday-sweat-100'],
    tue: ['tuesday_verdict', '2026-week-3-tuesday-verdict-100'],
    fri: ['friday_tnf_preview', '2026-week-3-friday-tnf-preview-100'],
  };
  for (const [day, [type, slug]] of Object.entries(expected)) {
    const db = fakeDb({ leagues: ['100'] });
    const summary = await runArticleCron({ ...SCOPE, day }, { db, generate: async () => ({}) });
    assert.equal(summary.article_type, type);
    assert.equal(summary.results[0].slug, slug);
    assert.equal(auditFor(db)[0].article_type, type);
    assert.equal(auditFor(db)[0].slug, slug);
  }
});

test('a spent time budget stops the run cleanly and reports what was left', async () => {
  const db = fakeDb({ leagues: ['100', '200', '300', '400'] });
  let tick = 0;
  // 0ms, 0ms, then past the budget: two leagues run, two are left for next time.
  const now = () => [0, 0, 0, 9999, 9999][Math.min(tick++, 4)];
  const summary = await runArticleCron({ ...SCOPE, budget_ms: 1000 }, { db, now, generate: async () => ({}) });

  assert.equal(summary.created + summary.skipped + summary.failed + summary.not_attempted, 4);
  assert.ok(summary.not_attempted > 0, 'the run must report the leagues it never reached');
  assert.equal(auditFor(db).length, summary.created + summary.skipped + summary.failed);
  // Nothing was marked failed: not reaching a league is not the same as failing it.
  assert.equal(summary.failed, 0);
});

/* ------------------------------------------------------------------ *
 * Queue rotation
 *
 * The run stops starting leagues when its time budget is spent, so a fixed
 * ascending order starved the same tail leagues every single week — and a league
 * that is never attempted reports no failure, so nothing anywhere said so.
 * ------------------------------------------------------------------ */

test('the queue starts at a different league each week and loses none of them', () => {
  const leagues = ['100', '200', '300', '400', '500'];

  assert.deepEqual(rotateForWeek(leagues, 5), ['100', '200', '300', '400', '500']);
  assert.deepEqual(rotateForWeek(leagues, 6), ['200', '300', '400', '500', '100']);
  assert.deepEqual(rotateForWeek(leagues, 7), ['300', '400', '500', '100', '200']);

  // Every league leads exactly once over n consecutive weeks, and no rotation
  // ever drops or duplicates one.
  const leaders = new Set();
  for (let week = 1; week <= leagues.length; week++) {
    const order = rotateForWeek(leagues, week);
    assert.deepEqual([...order].sort(), [...leagues].sort(), 'week ' + week + ' lost a league');
    leaders.add(order[0]);
  }
  assert.equal(leaders.size, leagues.length);

  // Same week, same order: the rotation is a function of the week, never a clock
  // or a random draw, so a re-run covers the same leagues in the same sequence.
  assert.deepEqual(rotateForWeek(leagues, 11), rotateForWeek(leagues, 11));

  // Degenerate inputs are returned as they are, not thrown on.
  assert.deepEqual(rotateForWeek([], 3), []);
  assert.deepEqual(rotateForWeek(['100'], 3), ['100']);
  // The input is never mutated in place.
  const original = ['100', '200', '300'];
  rotateForWeek(original, 2);
  assert.deepEqual(original, ['100', '200', '300']);
});

test('the run itself walks the rotated order', async () => {
  const db = fakeDb({ leagues: ['100', '200', '300', '400'] });
  const calls = [];
  await runArticleCron(
    { day: 'mon', season: 2026, week: 5 },
    { db, generate: async (input) => { calls.push(input.league_id); return {}; } },
  );
  // Week 5 of four leagues starts at index 1.
  assert.deepEqual(calls, ['200', '300', '400', '100']);
});

test('a spent budget skips a different league than it did last week', async () => {
  const leagues = ['100', '200', '300', '400'];
  const reached = (week) => {
    const calls = [];
    // Two leagues' worth of budget, then out of time.
    let tick = 0;
    const now = () => [0, 0, 0, 9999, 9999, 9999][Math.min(tick++, 5)];
    return runArticleCron(
      { day: 'mon', season: 2026, week, budget_ms: 1000 },
      { db: fakeDb({ leagues }), now, generate: async (i) => { calls.push(i.league_id); return {}; } },
    ).then(() => calls);
  };

  const weekFour = await reached(4);
  const weekFive = await reached(5);
  assert.ok(weekFour.length && weekFive.length, 'each run must reach at least one league');
  assert.notDeepEqual(weekFour, weekFive,
    'a spent budget must not starve the same leagues every week');
});

/* ------------------------------------------------------------------ *
 * force_rerun: the repair after a credential fix
 * ------------------------------------------------------------------ */

const HISTORY_SCOPE = { season: 2026, week: 3, article_type: 'monday_sweat' };

test('the failed-league read reports only a league whose LATEST outcome failed', async () => {
  const db = fakeDb({ history: [
    { league_id: '100', status: 'failed', ...HISTORY_SCOPE },
    { league_id: '200', status: 'failed', ...HISTORY_SCOPE },
    { league_id: '200', status: 'created', ...HISTORY_SCOPE },  // repaired since
    { league_id: '300', status: 'created', ...HISTORY_SCOPE },
    { league_id: '400', status: 'failed', season: 2026, week: 2, article_type: 'monday_sweat' },
  ] });
  const failed = await leaguesWithFailedRuns(db, HISTORY_SCOPE);
  assert.deepEqual([...failed].sort(), ['100']);
});

test('an unreadable audit trail leaves a forced run with nothing extra to attempt', async () => {
  const db = fakeDb({ failReads: { cron_article_logs: 'logs table missing' } });
  const failed = await leaguesWithFailedRuns(db, HISTORY_SCOPE);
  assert.equal(failed.size, 0);
});

test('force_rerun re-attempts a league whose last outcome failed, and only that one', async () => {
  const db = fakeDb({
    leagues: ['100', '200', '300'],
    published: [
      { league_id: '100', season: 2026, week: 3, article_type: 'monday_sweat' },
      { league_id: '200', season: 2026, week: 3, article_type: 'monday_sweat' },
    ],
    history: [
      // 100 holds a row written by a run that failed; 200's published cleanly.
      { league_id: '100', status: 'failed', ...HISTORY_SCOPE },
      { league_id: '200', status: 'created', ...HISTORY_SCOPE },
    ],
  });
  const calls = [];
  const summary = await runArticleCron(
    { ...SCOPE, force_rerun: true },
    { db, generate: async (input) => { calls.push(input.league_id); return {}; } },
  );

  // 100 forced, 300 had no row at all, 200 left exactly as it is.
  assert.deepEqual(calls, ['100', '300']);
  assert.equal(summary.forced, 1);
  assert.equal(summary.created, 2);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.force_rerun, true);
});

test('force_rerun never rewrites a league that published cleanly', async () => {
  const db = fakeDb({
    leagues: ['100', '200'],
    published: [
      { league_id: '100', season: 2026, week: 3, article_type: 'monday_sweat' },
      { league_id: '200', season: 2026, week: 3, article_type: 'monday_sweat' },
    ],
    history: [
      { league_id: '100', status: 'created', ...HISTORY_SCOPE },
      { league_id: '200', status: 'created', ...HISTORY_SCOPE },
    ],
  });
  const calls = [];
  const summary = await runArticleCron(
    { ...SCOPE, force_rerun: true },
    { db, generate: async (input) => { calls.push(input.league_id); return {}; } },
  );
  assert.deepEqual(calls, []);
  assert.equal(summary.forced, 0);
  assert.equal(summary.skipped, 2);
});

test('a normal run never reads the audit trail and never re-attempts a failed league', async () => {
  const db = fakeDb({
    leagues: ['100'],
    published: [{ league_id: '100', season: 2026, week: 3, article_type: 'monday_sweat' }],
    history: [{ league_id: '100', status: 'failed', ...HISTORY_SCOPE }],
  });
  const calls = [];
  const summary = await runArticleCron(SCOPE, { db, generate: async (i) => { calls.push(i.league_id); return {}; } });

  assert.deepEqual(calls, []);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.force_rerun, false);
  assert.equal(summary.forced, 0);
  // The read itself must not happen on a normal morning.
  assert.equal(db.selects.filter((entry) => entry.table === 'cron_article_logs').length, 0);
});

test('a credential failure is classified as ESPN_AUTH however the relay reports it', () => {
  assert.equal(classifyFailure(Object.assign(new Error('nope'), { status: 401 })), 'ESPN_AUTH');
  assert.equal(classifyFailure(Object.assign(new Error('nope'), { status: 403 })), 'ESPN_AUTH');
  assert.equal(
    classifyFailure(new Error('ESPN rejected the private-league cookies; espn_s2 expired')),
    'ESPN_AUTH',
  );
  // The relay's own read timeout must not be filed as a provider outage.
  assert.equal(classifyFailure(Object.assign(new Error('timed out'), { status: 504 })), 'TIMEOUT');
  assert.equal(classifyFailure(Object.assign(new Error('boom'), { status: 500 })), 'PROVIDER_DOWN');
});

/* ------------------------------------------------------------------ *
 * The HTTP route
 * ------------------------------------------------------------------ */

const handler = require('../api/cron/generate-articles');

function fakeRes() {
  const out = { code: 0, body: null, headers: {} };
  return Object.assign(out, {
    setHeader(key, value) { out.headers[key.toLowerCase()] = value; return out; },
    status(code) { out.code = code; return out; },
    json(body) { out.body = body; return out; },
  });
}

async function call(req) {
  const res = fakeRes();
  await handler({ method: 'POST', headers: {}, query: {}, ...req }, res);
  return res;
}

test('the route refuses an unauthenticated caller and says nothing else', async () => {
  const original = process.env.CRON_SECRET;
  try {
    process.env.CRON_SECRET = 'sekret-value';
    const res = await call({ query: { day: 'mon' } });
    assert.equal(res.code, 401);
    assert.deepEqual(res.body, { error: 'UNAUTHORIZED' });
    // Never cached, at any status.
    assert.equal(res.headers['cache-control'], 'no-store');

    // The day is not even parsed before the secret is checked, so an invalid
    // day cannot be used to probe the route.
    const probe = await call({ query: { day: 'wed' } });
    assert.equal(probe.code, 401);
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = original;
  }
});

test('the route refuses to run at all when no secret is configured', async () => {
  const original = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    const res = await call({ query: { day: 'mon' }, headers: { authorization: 'Bearer anything' } });
    assert.equal(res.code, 401);
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = original;
  }
});

test('the route rejects other methods and invalid days', async () => {
  const original = process.env.CRON_SECRET;
  const originalUrl = process.env.SUPABASE_URL;
  try {
    process.env.CRON_SECRET = 'sekret-value';
    delete process.env.SUPABASE_URL;
    const auth = { authorization: 'Bearer sekret-value' };

    const wrongMethod = await call({ method: 'DELETE', query: { day: 'mon' }, headers: auth });
    assert.equal(wrongMethod.code, 405);
    assert.equal(wrongMethod.headers.allow, 'GET, POST');

    const badDay = await call({ query: { day: 'wed' }, headers: auth });
    assert.equal(badDay.code, 400);
    assert.equal(badDay.body.error, 'INVALID_DAY');

    // Authenticated, valid day, but the environment has no storage: a clear
    // 503 rather than a crash or a silent success.
    const noStorage = await call({ query: { day: 'mon' }, headers: auth });
    assert.equal(noStorage.code, 503);
    assert.equal(noStorage.body.error, 'STORAGE_NOT_CONFIGURED');

    // GET is accepted too, so a Vercel cron (which only issues GET) works.
    const get = await call({ method: 'GET', query: { day: 'fri' }, headers: auth });
    assert.equal(get.code, 503);
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = original;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
  }
});

/* ------------------------------------------------------------------ *
 * The ESPN read boundary
 *
 * The scheduled run calls api/espn IN-PROCESS, once per league, and checks its
 * time budget only BETWEEN leagues. So an upstream read with no ceiling is not
 * one slow league, it is every league after it: the invocation is killed at its
 * maxDuration with no summary and no audit rows. These two assert the ceiling
 * exists and that a read which hits it is reported as a timeout rather than as
 * a provider outage, because the run retries one and not the other.
 * ------------------------------------------------------------------ */

const espnRelay = require('../api/espn');
const BOX_SCORE_URL =
  'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026' +
  '/segments/0/leagues/123456?scoringPeriodId=3&view=mMatchupScore';

function relayRes() {
  const out = { code: 0, body: null };
  const res = {
    setHeader() { return res; },
    status(value) { out.code = value; return res; },
    json(value) { out.body = value; return res; },
    send(value) { out.body = value; return res; },
    end() { return res; },
  };
  return { out, res };
}

/* No Supabase in this process, so the relay has no stored session to look up
   and reaches the upstream read directly — which is the code under test. */
async function callRelay(fetchStub) {
  const realFetch = global.fetch;
  const env = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  global.fetch = fetchStub;
  try {
    const { out, res } = relayRes();
    await espnRelay({ method: 'GET', headers: {}, query: { url: BOX_SCORE_URL }, url: '/api/espn' }, res);
    return out;
  } finally {
    global.fetch = realFetch;
    if (env.url) process.env.SUPABASE_URL = env.url;
    if (env.key) process.env.SUPABASE_SERVICE_ROLE_KEY = env.key;
  }
}

test('every ESPN read carries an abort signal, so no league can hang the run', async () => {
  const signals = [];
  const out = await callRelay(async (url, options) => {
    signals.push(options && options.signal);
    return new Response('{"teams":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  });

  assert.equal(out.code, 200);
  assert.equal(signals.length, 1);
  assert.ok(signals[0] && typeof signals[0].aborted === 'boolean',
    'the upstream fetch must be given an AbortSignal; without one a stalled ESPN connection ' +
    'consumes the whole scheduled run and every league after it loses its article');
});

test('an ESPN read that runs out of time is a 504, not a 502', async () => {
  const out = await callRelay(async () => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  });

  assert.equal(out.code, 504);
  assert.equal(out.body.code, 'ESPN_READ_TIMEOUT');
  // 504 is what classifyFailure reads as retryable; 502 would file it as the
  // provider's own fault and tell an operator ESPN is down.
  assert.equal(classifyFailure(Object.assign(new Error(out.body.error), { status: out.code })), 'TIMEOUT');
});

test('an ESPN read that fails for any other reason is still a 502', async () => {
  const out = await callRelay(async () => { throw new Error('socket hang up'); });
  assert.equal(out.code, 502);
});
