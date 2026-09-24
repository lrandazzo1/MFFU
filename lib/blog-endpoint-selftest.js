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
  author: 'FSN News Desk',
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
  const calls = {
    table: null, columns: null, selects: [], filters: {}, lte: {}, order: null, limit: null,
    /* The two shapes the route can ask a scope in: `or` for the combined
       league-plus-global read, `is` for the global-only fallback. Recorded so
       a test asserts the filter the route actually built, not the rows that
       came back. */
    or: [], is: {}, queries: 0,
  };
  const query = {
    select(columns) { calls.columns = columns; calls.selects.push(columns); return query; },
    eq(column, value) { calls.filters[column] = value; return query; },
    or(expression) { calls.or.push(expression); return query; },
    is(column, value) { calls.is[column] = value; return query; },
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
      /* Fail only the fallback, leaving the league read good, so the route's
         "keep the answer, lose the stand-in" path is the thing under test. */
      if (options.failSecond && calls.queries > 1) {
        return { data: null, error: new Error('global fallback exploded') };
      }
      /* `rowsByQuery` serves a different set to each successive query, which is
         how the fallback is exercised: the league read answers with nothing
         and the global read that follows answers with something. */
      if (options.rowsByQuery) {
        const rows = options.rowsByQuery[calls.queries - 1];
        return { data: rows === undefined ? [] : rows, error: null };
      }
      return { data: options.rows === undefined ? [ROW] : options.rows, error: null };
    },
  };
  return { calls, from(table) { calls.table = table; calls.queries++; return query; } };
}

/* A league-wide editorial row: no league_id, which is what the database means
   by global. */
const GLOBAL_ROW = {
  ...ROW,
  slug: '2026-09-24-week-3-trending-adds',
  headline: 'Week 3 trending adds',
  title: 'Week 3 trending adds',
  category: 'Waiver Wire',
  author: 'FSN Desk',
  article_type: 'global_editorial',
  id: 'uuid-global',
  league_id: null,
};

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
    'scope', 'season', 'slug', 'title', 'tracked_players', 'week',
  ]);
  assert.equal(article.scope, 'league');

  // The three tiers, in the order the card paints them.
  assert.equal(article.headline, 'Tuesday Verdict: Week 3');
  assert.equal(article.match_impact_summary, 'Monday Back scored 20 points, just enough for Ridgeback FC.');
  assert.equal(article.content, '# Tuesday Verdict\n\nBody.\n');
  assert.equal(article.category, 'Matchup Recap');
  assert.equal(article.author, 'FSN News Desk');
  // The operational columns never leave the server.
  for (const leaked of ['id', 'league_id', 'created_at', 'updated_at']) {
    assert.equal(leaked in article, false, leaked + ' must not be published');
  }
  assert.equal(article.tracked_players[0].outcome_flag, 'GAME_WINNER');
  assert.equal(res.body.count, 1);
  assert.equal(res.body.league_id, '123456');
});

test('the column allowlist is explicit, never select(*)', async () => {
  const { db, res } = await call({ league_id: '123456' });
  assert.ok(!db.calls.columns.includes('*'));
  /* league_id IS selected: it is the only thing that tells a league row from a
     global one, and `scope` is derived from it. It is still never published,
     which is the assertion that matters and is made on the response below and
     in the field-list test above. */
  assert.ok(db.calls.columns.includes('league_id'));
  assert.equal('league_id' in res.body.articles[0], false);
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
  assert.equal(article.author, 'FSN News Desk');
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

/* ------------------------------------------------------------------ *
 * BOTH SCOPES, AND THE FALLBACK
 *
 * Why these exist: "articles appear in some leagues and not others" was
 * reported against this route. The route was not the cause (the cause was
 * ESPN rejecting eight of twelve leagues' stored connections, so those
 * leagues genuinely have no rows), but a league with no rows of its own
 * should still have something to read, and that is what `include_global`
 * and the fallback are for. These tests pin both, and pin that neither one
 * can put one league's private recap in front of another league.
 * ------------------------------------------------------------------ */

test('global articles are opt in, never mixed in by default', async () => {
  const { db, res } = await call({ league_id: '123456' });
  assert.deepEqual(db.calls.or, [], 'the default read must not widen past this league');
  assert.equal(db.calls.filters.league_id, '123456');
  assert.equal(res.body.include_global, false);
  assert.equal(res.body.global_fallback, false);
});

test('include_global asks for this league OR no league, and nothing else', async () => {
  const { db, res } = await call({ league_id: '123456', include_global: '1' });

  assert.deepEqual(db.calls.or, ['league_id.eq.123456,league_id.is.null']);
  /* The equality filter must be GONE, not merely accompanied: leaving it
     would AND with the or() and match nothing global. */
  assert.equal('league_id' in db.calls.filters, false);
  assert.equal(res.body.include_global, true);
});

test('a league id that could break out of the or() expression is refused', async () => {
  /* The or() filter is built by string interpolation, so this is the test that
     matters: readScope() must reject anything that could add a term. */
  for (const hostile of ['123,league_id.not.is.null', '123)or(league_id.gte.0', '1 2', '*', '']) {
    const { res } = await call({ league_id: hostile, include_global: '1' });
    assert.equal(res.code, 400, JSON.stringify(hostile) + ' must be refused before it reaches a filter');
  }
});

test('each row says which scope it came from', async () => {
  const { res } = await call({ league_id: '123456', include_global: '1' }, { rows: [ROW, GLOBAL_ROW] });
  assert.deepEqual(res.body.articles.map((a) => a.scope), ['league', 'global']);
  // Still never published, on either scope.
  for (const article of res.body.articles) assert.equal('league_id' in article, false);
});

test('a league with no recaps falls back to league-wide editorial', async () => {
  const { db, res } = await call(
    { league_id: '123456', season: '2026', week: '3', include_global: '1' },
    { rowsByQuery: [[], [GLOBAL_ROW]] },
  );

  assert.equal(res.code, 200);
  assert.equal(db.calls.queries, 2, 'the fallback is a second query');
  assert.equal(db.calls.is.league_id, null, 'the fallback asks for global rows only');
  assert.equal(res.body.global_fallback, true);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.articles[0].scope, 'global');
});

test('the fallback is not week filtered, because a global article carries its own week', async () => {
  const { db } = await call(
    { league_id: '123456', season: '2026', week: '7', include_global: '1' },
    { rowsByQuery: [[], [GLOBAL_ROW]] },
  );
  /* Season is still pinned: a retro view must not show this season's copy.
     Week is not, or the fallback would fire exactly never. */
  assert.equal(db.calls.filters.season, 2026);
  assert.equal(db.calls.filters.week, 7, 'the league read is still week scoped');
  assert.equal(db.calls.is.league_id, null);
});

test('a league that has its own recap never sees the fallback', async () => {
  const { db, res } = await call(
    { league_id: '123456', include_global: '1' },
    { rowsByQuery: [[ROW]] },
  );
  assert.equal(db.calls.queries, 1, 'no second query when the league has its own coverage');
  assert.equal(res.body.global_fallback, false);
  assert.equal(res.body.articles[0].scope, 'league');
});

test('a failed fallback keeps the league read rather than turning it into a 502', async () => {
  const { res, db } = await call(
    { league_id: '123456', include_global: '1' },
    { rowsByQuery: [[]], failSecond: true },
  );
  assert.equal(res.code, 200, 'losing the stand-in must not lose the answer');
  assert.equal(res.body.global_fallback, false);
  assert.equal(res.body.count, 0);
  assert.equal(db.calls.queries, 2, 'the fallback must actually have been attempted');
});
