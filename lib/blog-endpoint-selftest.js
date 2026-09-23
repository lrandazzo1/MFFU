'use strict';
/**
 * Public blog-read endpoint self-test.
 *
 *   npm run test:articles
 *
 * The Supabase double records the query the route built, so the league scope,
 * the optional filters and the column allowlist are asserted on what was
 * actually sent rather than on what came back.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/blog/articles');

const ROW = {
  slug: '2026-week-3-tuesday-verdict-123456',
  headline: 'Tuesday Verdict: Week 3',
  match_impact_summary: 'Monday Back scored 20 points, just enough for Ridgeback FC.',
  content: '# Tuesday Verdict\n\nBody.\n',
  category: 'Matchup Recap',
  author: 'FFU News Desk',
  title: 'Tuesday Verdict: Week 3',
  excerpt: 'What the math says.',
  content_markdown: '# Tuesday Verdict\n\nBody.\n',
  article_type: 'tuesday_verdict',
  tracked_players: [{ player_id: 'p1', player_name: 'Monday Back', owner_team: 'Ridgeback FC', outcome_flag: 'GAME_WINNER' }],
  season: 2026,
  week: 3,
  published_at: '2026-09-22T13:00:00.000Z',
  // Never published: present here precisely so the test can prove it is dropped.
  id: 'uuid-value',
  league_id: '123456',
  created_at: 'x',
  updated_at: 'y',
};

function fakeDb(options = {}) {
  const calls = { table: null, columns: null, selects: [], filters: {}, lte: {}, order: null, limit: null };
  const query = {
    select(columns) { calls.columns = columns; calls.selects.push(columns); return query; },
    eq(column, value) { calls.filters[column] = value; return query; },
    lte(column, value) { calls.lte[column] = value; return query; },
    order(column, opts) { calls.order = { column, ...opts }; return query; },
    async limit(n) {
      calls.limit = n;
      /* A database that has not run the three-tier block of
         supabase/blog_articles.sql rejects the wide select with PostgREST's
         42703. The route is expected to retry with the legacy allowlist. */
      if (options.missingColumns && calls.selects.length === 1) {
        return { data: null, error: Object.assign(new Error('column blog_articles.headline does not exist'), { code: '42703' }) };
      }
      if (options.error) return { data: null, error: new Error(options.error) };
      return { data: options.rows === undefined ? [ROW] : options.rows, error: null };
    },
  };
  return { calls, from(table) { calls.table = table; return query; } };
}

function fakeRes() {
  const out = { code: 0, body: null, headers: {}, ended: false };
  return Object.assign(out, {
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; return out; },
    status(c) { out.code = c; return out; },
    json(b) { out.body = b; return out; },
    end() { out.ended = true; return out; },
  });
}

/* The route builds its own client from the environment, so the double is
   injected by stubbing the module the route requires. */
const supabaseModule = require('@supabase/supabase-js');
const realCreateClient = supabaseModule.createClient;

async function call(query, options = {}) {
  const db = options.db === null ? null : fakeDb(options);
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    if (db) {
      process.env.SUPABASE_URL = 'https://example.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
      supabaseModule.createClient = () => db;
    } else {
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    }
    const res = fakeRes();
    await handler({ method: options.method || 'GET', headers: {}, query }, res);
    return { res, db };
  } finally {
    supabaseModule.createClient = realCreateClient;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  }
}

test('a league-scoped read returns only the published fields', async () => {
  const { res, db } = await call({ league_id: '123456', season: '2026', week: '3' });

  assert.equal(res.code, 200);
  assert.equal(db.calls.table, 'blog_articles');
  assert.deepEqual(db.calls.filters, { league_id: '123456', season: 2026, week: 3 });
  assert.deepEqual(db.calls.order, { column: 'published_at', ascending: false });
  assert.equal(db.calls.limit, 10);

  const article = res.body.articles[0];
  assert.deepEqual(Object.keys(article).sort(), [
    'article_type', 'author', 'category', 'content', 'content_markdown',
    'excerpt', 'headline', 'match_impact_summary', 'published_at',
    'season', 'slug', 'title', 'tracked_players', 'week',
  ]);

  // The three tiers, in the order the card paints them.
  assert.equal(article.headline, 'Tuesday Verdict: Week 3');
  assert.equal(article.match_impact_summary, 'Monday Back scored 20 points, just enough for Ridgeback FC.');
  assert.equal(article.content, '# Tuesday Verdict\n\nBody.\n');
  assert.equal(article.category, 'Matchup Recap');
  assert.equal(article.author, 'FFU News Desk');
  // The operational columns never leave the server.
  for (const leaked of ['id', 'league_id', 'created_at', 'updated_at']) {
    assert.equal(leaked in article, false, leaked + ' must not be published');
  }
  assert.equal(article.tracked_players[0].outcome_flag, 'GAME_WINNER');
  assert.equal(res.body.count, 1);
  assert.equal(res.body.league_id, '123456');
});

test('the column allowlist is explicit, never select(*)', async () => {
  const { db } = await call({ league_id: '123456' });
  assert.ok(!db.calls.columns.includes('*'));
  assert.ok(!db.calls.columns.includes('league_id'));
  for (const column of [
    'slug', 'title', 'excerpt', 'content_markdown', 'article_type', 'tracked_players', 'published_at',
    'headline', 'match_impact_summary', 'content', 'category', 'author',
  ]) {
    assert.ok(db.calls.columns.includes(column), column + ' must be selected');
  }
});

test('a legacy row reads through the three-tier names', async () => {
  // Published before the new columns existed: title and content_markdown only.
  const legacy = { ...ROW };
  delete legacy.headline;
  delete legacy.match_impact_summary;
  delete legacy.content;
  delete legacy.category;
  delete legacy.author;

  const { res } = await call({ league_id: '123456' }, { rows: [legacy] });
  const article = res.body.articles[0];
  assert.equal(article.headline, legacy.title, 'headline falls back to title');
  assert.equal(article.content, legacy.content_markdown, 'content falls back to content_markdown');
  // No summary is an absent callout, never invented copy.
  assert.equal(article.match_impact_summary, '');
  // The shelf is worked out from the only thing the row recorded about itself.
  assert.equal(article.category, 'Matchup Recap');
  assert.equal(article.author, 'FFU News Desk');
  // And the legacy names are still published for the static blog build.
  assert.equal(article.title, legacy.title);
  assert.equal(article.content_markdown, legacy.content_markdown);
});

test('an empty headline or content falls back rather than publishing a blank', async () => {
  const blanked = { ...ROW, headline: '', content: '' };
  const { res } = await call({ league_id: '123456' }, { rows: [blanked] });
  assert.equal(res.body.articles[0].headline, ROW.title);
  assert.equal(res.body.articles[0].content, ROW.content_markdown);
});

test('a database without the three-tier columns is served, not 502ed', async () => {
  // The columns are added by supabase/blog_articles.sql. A deployment can
  // reach this route before that file has been run, and the articles are
  // sitting right there in the legacy columns.
  const { res, db } = await call({ league_id: '123456' }, { missingColumns: true });
  assert.equal(res.code, 200);
  assert.equal(db.calls.selects.length, 2, 'the read is retried once');
  assert.ok(db.calls.selects[0].includes('headline'), 'the first attempt asks for the new columns');
  assert.ok(!db.calls.selects[1].includes('headline'), 'the retry drops them');
  assert.equal(res.body.articles[0].headline, ROW.title, 'and the legacy shape still resolves');
});

test('season and week are optional; the league filter never is', async () => {
  const { res, db } = await call({ league_id: '123456' });
  assert.equal(res.code, 200);
  assert.deepEqual(db.calls.filters, { league_id: '123456' });

  const weekOnly = await call({ league_id: '123456', week: '5' });
  assert.deepEqual(weekOnly.db.calls.filters, { league_id: '123456', week: 5 });

  for (const missing of [{}, { league_id: '' }, { league_id: '../secrets' }, { league_id: 'x'.repeat(65) }]) {
    const bad = await call(missing);
    assert.equal(bad.res.code, 400);
    assert.equal(bad.res.body.error, 'INVALID_REQUEST');
    // A rejected request must not be cached as this league's answer.
    assert.equal(bad.res.headers['cache-control'], 'no-store');
  }
});

test('an unparseable filter is refused rather than silently dropped', async () => {
  // Returning the whole league because week=banana did not parse would answer
  // a question nobody asked.
  for (const bad of [{ week: 'banana' }, { week: '0' }, { week: '19' }, { season: '1900' }, { limit: '0' }, { limit: '51' }]) {
    const { res } = await call({ league_id: '123456', ...bad });
    assert.equal(res.code, 400, JSON.stringify(bad) + ' must be refused');
  }
  const capped = await call({ league_id: '123456', limit: '50' });
  assert.equal(capped.db.calls.limit, 50);
});

test('active=1 asks for the league\'s live stories, newest first', async () => {
  const { res, db } = await call({ league_id: '123456', active: '1', limit: '6' });

  assert.equal(res.code, 200);
  assert.equal(res.body.active, true, 'the response says which read it answered');
  // No week coordinate: this is "what has this league published lately".
  assert.deepEqual(db.calls.filters, { league_id: '123456' });
  assert.deepEqual(db.calls.order, { column: 'published_at', ascending: false });
  assert.equal(db.calls.limit, 6);

  // The only thing active adds is the published_at floor, so a story staged
  // for tomorrow morning cannot appear on a phone tonight.
  const floor = db.calls.lte.published_at;
  assert.ok(floor, 'active=1 filters on published_at');
  assert.ok(Date.parse(floor) <= Date.now() + 1000, 'the floor is now, not a future date');
  assert.ok(Date.parse(floor) > Date.now() - 60000, 'and it is computed per request, not at module load');
});

test('active composes with the other filters instead of replacing them', async () => {
  const { db } = await call({ league_id: '123456', active: '1', season: '2026', week: '3' });
  assert.deepEqual(db.calls.filters, { league_id: '123456', season: 2026, week: 3 });
  assert.ok(db.calls.lte.published_at, 'the active floor still applies');
});

test('a plain read applies no active floor and says so', async () => {
  const { res, db } = await call({ league_id: '123456', season: '2026', week: '3' });
  assert.deepEqual(db.calls.lte, {}, 'an ordinary read is unchanged by the active option');
  assert.equal(res.body.active, false);

  const off = await call({ league_id: '123456', active: '0' });
  assert.deepEqual(off.db.calls.lte, {});
  assert.equal(off.res.body.active, false);
});

test('an unrecognised active value is a typo in the caller, not a filter to guess', async () => {
  for (const bad of ['maybe', '2', 'active']) {
    const { res, db } = await call({ league_id: '123456', active: bad });
    assert.equal(res.code, 400, 'active=' + bad + ' must be refused');
    assert.equal(res.body.error, 'INVALID_REQUEST');
    assert.equal(db.calls.table, null, 'and must never reach the table');
  }
});

test('a league with nothing published is an empty list, not an error', async () => {
  const { res } = await call({ league_id: '123456' }, { rows: [] });
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.articles, []);
  assert.equal(res.body.count, 0);
});

test('a null or malformed tracked_players reads as no players tracked', async () => {
  const { res } = await call({ league_id: '123456' }, { rows: [{ ...ROW, tracked_players: null }] });
  assert.deepEqual(res.body.articles[0].tracked_players, []);
  const wrongShape = await call({ league_id: '123456' }, { rows: [{ ...ROW, tracked_players: { not: 'an array' } }] });
  assert.deepEqual(wrongShape.res.body.articles[0].tracked_players, []);
});

test('methods, preflight and caching behave', async () => {
  const preflight = await call({ league_id: '123456' }, { method: 'OPTIONS' });
  assert.equal(preflight.res.code, 204);
  assert.equal(preflight.res.headers['access-control-allow-origin'], '*');

  const post = await call({ league_id: '123456' }, { method: 'POST' });
  assert.equal(post.res.code, 405);
  assert.equal(post.res.headers.allow, 'GET, HEAD, OPTIONS');

  const ok = await call({ league_id: '123456' });
  assert.match(ok.res.headers['cache-control'], /public, max-age=300/);
  assert.match(ok.res.headers['cache-control'], /stale-while-revalidate=86400/);
});

test('an unconfigured or failing database is reported, never cached', async () => {
  const unconfigured = await call({ league_id: '123456' }, { db: null });
  assert.equal(unconfigured.res.code, 503);
  assert.equal(unconfigured.res.headers['cache-control'], 'no-store');

  const broken = await call({ league_id: '123456' }, { error: 'relation does not exist' });
  assert.equal(broken.res.code, 502);
  assert.equal(broken.res.body.error, 'READ_FAILED');
  // The upstream error text stays in the logs, not in a public payload.
  assert.equal(JSON.stringify(broken.res.body).includes('relation'), false);
  assert.equal(broken.res.headers['cache-control'], 'no-store');
});
