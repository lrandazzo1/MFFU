'use strict';
/**
 * Publish endpoint self-test — /api/blog/articles/publish.
 *
 *   npm run test:articles
 *
 * The Supabase double records the row the route tried to write, so the three
 * tiers, the legacy mirror, the slug and the upsert target are asserted on
 * what was actually sent rather than on what came back.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
/* The route, not the handler module: the publish path is reached through
   api/blog/articles.js on ?action=publish (see the header of lib/blog-publish.js
   for why), so the tests exercise the dispatch as well as the handler. */
const handler = require('../api/blog/articles');

const SECRET = 'publish-secret';

const BODY = {
  league_id: '123456',
  season: 2026,
  week: 3,
  headline: 'Ridgeback FC Survive The Late Window',
  match_impact_summary: 'Monday Back scored 20 points, just enough for Ridgeback FC.',
  content: '# The late window\n\nBody copy.\n',
  category: 'Matchup Recap',
  author: 'FSN News Desk',
};

function fakeDb(options = {}) {
  const calls = { table: null, rows: [], conflict: null };
  const query = {
    upsert(row, opts) { calls.rows.push(row); calls.conflict = opts && opts.onConflict; return query; },
    select() { return query; },
    async single() {
      if (options.missingColumns && calls.rows.length === 1) {
        return { data: null, error: Object.assign(new Error('column blog_articles.headline does not exist'), { code: '42703' }) };
      }
      if (options.error) return { data: null, error: new Error(options.error) };
      const row = calls.rows[calls.rows.length - 1];
      return { data: { ...row, id: 'uuid-value' }, error: null };
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

const supabaseModule = require('@supabase/supabase-js');
const realCreateClient = supabaseModule.createClient;

/* Every environment variable the route reads is set for the call and restored
   after it, so the tests do not depend on each other's leftovers or on what
   the shell happened to export. */
async function call(body, options = {}) {
  const db = options.db === null ? null : fakeDb(options);
  const saved = {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
    secret: process.env.CRON_SECRET,
  };
  try {
    if (options.secret === null) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = options.secret || SECRET;

    if (db) {
      process.env.SUPABASE_URL = 'https://example.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
      supabaseModule.createClient = () => db;
    } else {
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    }

    const headers = options.headers !== undefined
      ? options.headers
      : { authorization: 'Bearer ' + (options.presented || SECRET) };
    const res = fakeRes();
    await handler({ method: options.method || 'POST', headers, body, query: { action: 'publish' } }, res);
    return { res, db };
  } finally {
    supabaseModule.createClient = realCreateClient;
    for (const [name, value] of [['SUPABASE_URL', saved.url], ['SUPABASE_SERVICE_ROLE_KEY', saved.key], ['CRON_SECRET', saved.secret]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('a three-tier publish writes every tier and mirrors the legacy columns', async () => {
  const { res, db } = await call(BODY);

  assert.equal(res.code, 200);
  assert.equal(res.body.ok, true);
  assert.equal(db.calls.table, 'blog_articles');
  assert.equal(db.calls.conflict, 'slug', 'the write is an upsert on the slug');

  const row = db.calls.rows[0];
  assert.equal(row.headline, BODY.headline);
  assert.equal(row.match_impact_summary, BODY.match_impact_summary);
  assert.equal(row.content, BODY.content);
  assert.equal(row.category, 'Matchup Recap');
  assert.equal(row.author, 'FSN News Desk');

  // The legacy columns are NOT NULL on the table and are what the static blog
  // build reads, so they are written in lockstep every time.
  assert.equal(row.title, BODY.headline);
  assert.equal(row.content_markdown, BODY.content);

  assert.equal(row.league_id, '123456');
  assert.equal(row.season, 2026);
  assert.equal(row.week, 3);
  assert.equal(row.article_type, 'league_dispatch', 'a story outside the schedule is a league dispatch');
  assert.equal(row.slug, '2026-week-3-matchup-recap-123456', 'the slug is deterministic');
  assert.ok(row.published_at, 'the row carries a publication timestamp');
  assert.deepEqual(row.tracked_players, []);

  assert.equal(res.body.article.headline, BODY.headline);
  assert.equal(res.body.article.match_impact_summary, BODY.match_impact_summary);
});

test('a legacy caller sending title and content_markdown gets the same row', async () => {
  const { res, db } = await call({
    league_id: '123456', season: 2026, week: 3,
    title: 'Legacy Headline',
    content_markdown: '# Legacy\n\nBody.\n',
  });
  assert.equal(res.code, 200);
  const row = db.calls.rows[0];
  assert.equal(row.headline, 'Legacy Headline', 'headline is filled from title');
  assert.equal(row.title, 'Legacy Headline');
  assert.equal(row.content, '# Legacy\n\nBody.\n', 'content is filled from content_markdown');
  assert.equal(row.content_markdown, '# Legacy\n\nBody.\n');
  // Nothing is invented for a caller that supplied no summary.
  assert.equal(row.match_impact_summary, '');
  assert.equal(row.author, 'FSN News Desk', 'the byline defaults to the desk');
});

test('the three tiers are validated, not trusted', async () => {
  const cases = [
    [{ ...BODY, league_id: '' }, 'league_id is required'],
    [{ ...BODY, league_id: '../secrets' }, 'a path-shaped league_id'],
    [{ ...BODY, league_id: 'x'.repeat(65) }, 'an over-long league_id'],
    [{ ...BODY, season: 1900 }, 'a season out of range'],
    [{ ...BODY, week: 0 }, 'week 0'],
    [{ ...BODY, week: 19 }, 'week 19'],
    [{ ...BODY, week: 'banana' }, 'an unparseable week'],
    [{ ...BODY, headline: '', title: '' }, 'no headline under either name'],
    [{ ...BODY, content: '', content_markdown: '' }, 'no content under either name'],
    [{ ...BODY, headline: 'x'.repeat(301) }, 'an over-long headline'],
    [{ ...BODY, match_impact_summary: 'x'.repeat(601) }, 'an over-long summary'],
    [{ ...BODY, content: 'x'.repeat(120001) }, 'an over-long body'],
    [{ ...BODY, article_type: 'not_a_type' }, 'an unknown article_type'],
    [{ ...BODY, tracked_players: 'nope' }, 'a tracked_players that is not an array'],
    [{ ...BODY, published_at: 'not-a-date' }, 'an unparseable published_at'],
  ];
  for (const [body, label] of cases) {
    const { res, db } = await call(body);
    assert.equal(res.code, 400, label + ' must be refused');
    assert.equal(res.body.error, 'INVALID_REQUEST');
    assert.equal(db.calls.rows.length, 0, label + ' must never reach the table');
  }
});

test('a body that is not a JSON object is refused', async () => {
  for (const body of [undefined, '', 'not json', '[1,2,3]', '"a string"']) {
    const { res } = await call(body);
    assert.equal(res.code, 400, JSON.stringify(body) + ' must be refused');
  }
});

test('the four scheduled article types are still accepted', async () => {
  for (const type of ['monday_sweat', 'tuesday_verdict', 'friday_tnf_preview', 'league_dispatch']) {
    const { res, db } = await call({ ...BODY, article_type: type });
    assert.equal(res.code, 200, type + ' must be accepted');
    assert.equal(db.calls.rows[0].article_type, type);
  }
});

test('an explicit slug wins, and tracked players survive', async () => {
  const { res, db } = await call({
    ...BODY,
    slug: '2026-week-3-tuesday-verdict-123456',
    tracked_players: [
      { player_id: 'p1', player_name: 'Monday Back', owner_team: 'Ridgeback FC', outcome_flag: 'GAME_WINNER' },
      'not an object',
      null,
    ],
  });
  assert.equal(res.code, 200);
  assert.equal(db.calls.rows[0].slug, '2026-week-3-tuesday-verdict-123456');
  // A malformed entry is dropped rather than stored: the column is what a
  // published claim is audited against.
  assert.equal(db.calls.rows[0].tracked_players.length, 1);
  assert.equal(db.calls.rows[0].tracked_players[0].player_name, 'Monday Back');
});

test('publishing needs the cron secret and never defaults open', async () => {
  // No secret configured: the route refuses every caller rather than opening.
  const unconfigured = await call(BODY, { secret: null });
  assert.equal(unconfigured.res.code, 503);
  assert.equal(unconfigured.res.body.error, 'PUBLISHING_NOT_CONFIGURED');
  assert.equal(unconfigured.db.calls.rows.length, 0);

  for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: SECRET }, { 'x-cron-secret': 'wrong' }]) {
    const { res, db } = await call(BODY, { headers });
    assert.equal(res.code, 401, JSON.stringify(headers) + ' must be refused');
    assert.equal(res.body.error, 'UNAUTHORIZED');
    assert.equal(db.calls.rows.length, 0, 'an unauthorized caller never reaches the table');
  }

  const viaHeader = await call(BODY, { headers: { 'x-cron-secret': SECRET } });
  assert.equal(viaHeader.res.code, 200, 'x-cron-secret is accepted too');
});

test('an unauthorized caller is refused before the body is even read', async () => {
  // A route that validated first would answer "week must be between 1 and 18"
  // to a caller holding no secret, which is a free probe for valid inputs.
  const { res } = await call({ league_id: '', week: 99 }, { headers: {} });
  assert.equal(res.code, 401);
  assert.equal(res.body.error, 'UNAUTHORIZED');
});

test('only POST and PUT publish', async () => {
  for (const method of ['GET', 'DELETE', 'OPTIONS', 'HEAD']) {
    const { res } = await call(BODY, { method });
    assert.equal(res.code, 405, method + ' must not publish');
    assert.equal(res.headers.allow, 'POST, PUT');
  }
});

test('a database without the three-tier columns still stores the story', async () => {
  const { res, db } = await call(BODY, { missingColumns: true });
  assert.equal(res.code, 200);
  assert.equal(db.calls.rows.length, 2, 'the write is retried once');
  assert.ok('headline' in db.calls.rows[0], 'the first attempt carries the new columns');
  for (const dropped of ['headline', 'match_impact_summary', 'content', 'category', 'author']) {
    assert.equal(dropped in db.calls.rows[1], false, dropped + ' is dropped from the retry');
  }
  // The story itself is not lost: it lands in the legacy columns.
  assert.equal(db.calls.rows[1].title, BODY.headline);
  assert.equal(db.calls.rows[1].content_markdown, BODY.content);
});

test('an unconfigured or failing database is reported, never cached', async () => {
  const unconfigured = await call(BODY, { db: null });
  assert.equal(unconfigured.res.code, 503);
  assert.equal(unconfigured.res.body.error, 'STORAGE_NOT_CONFIGURED');
  assert.equal(unconfigured.res.headers['cache-control'], 'no-store');

  const broken = await call(BODY, { error: 'duplicate key value violates unique constraint' });
  assert.equal(broken.res.code, 502);
  assert.equal(broken.res.body.error, 'WRITE_FAILED');
  // The upstream error text stays in the logs, not in the response.
  assert.equal(JSON.stringify(broken.res.body).includes('duplicate key'), false);
  assert.equal(broken.res.headers['cache-control'], 'no-store');
});

test('a successful publish is never cached', async () => {
  const { res } = await call(BODY);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('the publish path inherits none of the read route\'s public headers', async () => {
  /* The read is public, any-origin and cached for five minutes at the edge.
     The write is none of those. Both are now the same file, so the dispatch has
     to happen before applyHeaders() runs, and that is what this asserts. */
  const { res } = await call(BODY);
  assert.equal(res.code, 200);
  assert.equal('access-control-allow-origin' in res.headers, false,
    'a publish must not be CORS-exposed: a browser has no business holding the secret');
  assert.equal(res.headers['cache-control'], 'no-store');

  // And an unauthorized publish must not leak them either.
  const denied = await call(BODY, { headers: {} });
  assert.equal(denied.res.code, 401);
  assert.equal('access-control-allow-origin' in denied.res.headers, false);
});

test('the read route still reads when no publish action is asked for', async () => {
  /* The two halves share a file now; the dispatch must not swallow the read. */
  const readHandler = require('../api/blog/articles');
  const res = fakeRes();
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  try {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await readHandler({ method: 'GET', headers: {}, query: { league_id: '123456' } }, res);
  } finally {
    if (saved.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
  }
  // Unconfigured storage, which is the read path's own 503 and proves the
  // request was handled as a read rather than routed to the publisher.
  assert.equal(res.code, 503);
  assert.equal(res.body.error, 'STORAGE_NOT_CONFIGURED');
  assert.equal(res.headers['access-control-allow-origin'], '*', 'the read stays public');
});
