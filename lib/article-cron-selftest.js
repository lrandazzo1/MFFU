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
} = require('./dist/article-cron');

/* A minimal PostgREST-shaped double: `leagues` and `blog_articles` answer
   filtered selects, `cron_article_logs` collects inserts. */
function fakeDb(options = {}) {
  const leagues = options.leagues || ['100', '200', '300'];
  const published = options.published || [];
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
