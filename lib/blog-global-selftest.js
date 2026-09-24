'use strict';
/**
 * Global blog endpoint self-test — /api/blog/global.
 *
 *   npm run test:articles
 *
 * The corpus this serves is the general-audience blog: real-world NFL copy,
 * identical for every reader. It is NOT `blog_articles`, which holds one
 * league's private recaps per row. These assert that separation as much as
 * they assert the shape.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const route = require('../api/blog/articles');
const { trackedPlayers } = require('../lib/blog-global');

const MANIFEST = {
  generatedAt: '2026-09-14T00:00:00.000Z',
  count: 2,
  posts: [
    { title: 'Waiver wire risers', slug: 'waiver-wire-risers-week-2', publishDate: '2026-09-11',
      category: 'Waiver Wire', excerpt: 'Two low-owned names.', author: 'FSN Desk',
      tracked_players: [{ name: 'Kimani Vidal', position: 'RB', sleeperPlayerId: '' }] },
    // The older field name, which the compiled payload still emits beside it.
    { title: 'Trade deadline watch', slug: 'trade-deadline-watch', publishDate: '2026-09-08',
      category: 'Analysis', excerpt: 'Who is buying.', author: 'FSN Desk',
      entities: [{ name: 'Jalen McMillan', position: 'WR', sleeperPlayerId: '4567' }] },
  ],
};

const POST = {
  title: 'Waiver wire risers', slug: 'waiver-wire-risers-week-2', publishDate: '2026-09-11',
  category: 'Waiver Wire', excerpt: 'Two low-owned names.', author: 'FSN Desk',
  bodyHtml: '<p>Kimani Vidal is the add.</p>',
  tracked_players: [{ name: 'Kimani Vidal', position: 'RB', sleeperPlayerId: '' }],
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

const realFetch = globalThis.fetch;

async function call(query, options = {}) {
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    if (options.status) return { ok: false, status: options.status };
    if (String(url).includes('/posts/')) return { ok: true, status: 200, json: async () => POST };
    return { ok: true, status: 200, json: async () => MANIFEST };
  };
  try {
    const res = fakeRes();
    await route({ method: options.method || 'GET', headers: {}, query: { action: 'global', ...query } }, res);
    return { res, asked };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('the manifest lists every global article with its tracked players', async () => {
  const { res, asked } = await call({});
  assert.equal(res.code, 200);
  assert.equal(res.body.count, 2);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /\/content\/generated\/blog\/index\.json$/);

  const [first, second] = res.body.posts;
  assert.equal(first.slug, 'waiver-wire-risers-week-2');
  assert.deepEqual(first.tracked_players, [{ name: 'Kimani Vidal', position: 'RB', sleeperPlayerId: '' }]);
  // The older `entities` field resolves to the same thing, so a client never
  // has to know which build produced the payload it is reading.
  assert.deepEqual(second.tracked_players, [{ name: 'Jalen McMillan', position: 'WR', sleeperPlayerId: '4567' }]);
  for (const post of res.body.posts) {
    assert.equal('bodyHtml' in post, false, 'the manifest carries no bodies');
  }
});

test('a slug returns that one article with its body', async () => {
  const { res, asked } = await call({ slug: 'waiver-wire-risers-week-2' });
  assert.equal(res.code, 200);
  assert.match(asked[0], /\/posts\/waiver-wire-risers-week-2\.json$/);
  assert.equal(res.body.article.slug, 'waiver-wire-risers-week-2');
  assert.equal(res.body.article.bodyHtml, '<p>Kimani Vidal is the add.</p>');
  assert.equal(res.body.article.tracked_players[0].name, 'Kimani Vidal');
});

test('a slug that could walk the path is refused before any fetch', async () => {
  for (const slug of ['../../secrets', 'a/b', 'UPPER', 'has space', '.hidden', 'x'.repeat(200)]) {
    const { res, asked } = await call({ slug });
    assert.equal(res.code, 400, JSON.stringify(slug) + ' must be refused');
    assert.equal(asked.length, 0, 'and must never reach the content origin');
  }
});

test('an unpublished slug is a 404, an unreachable origin is a 502', async () => {
  const missing = await call({ slug: 'never-written' }, { status: 404 });
  assert.equal(missing.res.code, 404);
  assert.equal(missing.res.body.error, 'NOT_FOUND');
  assert.equal(missing.res.headers['cache-control'], 'no-store');

  const broken = await call({}, { status: 500 });
  assert.equal(broken.res.code, 502);
  assert.equal(broken.res.body.error, 'READ_FAILED');
});

test('published content is public and edge cached', async () => {
  const { res } = await call({});
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.match(res.headers['cache-control'], /public, max-age=300/);

  const preflight = await call({}, { method: 'OPTIONS' });
  assert.equal(preflight.res.code, 204);

  const post = await call({}, { method: 'POST' });
  assert.equal(post.res.code, 405);
  assert.equal(post.res.headers['cache-control'], 'no-store');
});

test('the global read takes no league_id and touches no league storage', async () => {
  /* The separation this endpoint exists to keep. It serves a corpus with no
     league in it, so it must not accept a league scope, and it must never
     reach for the table that holds private recaps. */
  const { res, asked } = await call({ league_id: '405485320' });
  assert.equal(res.code, 200);
  assert.equal('league_id' in res.body, false, 'no league is echoed');
  for (const url of asked) {
    assert.equal(/blog_articles|supabase/i.test(url), false, 'read league storage: ' + url);
    assert.match(url, /\/content\/generated\/blog\//, 'read something other than the compiled blog: ' + url);
  }
  for (const post of res.body.posts) {
    assert.equal('league_id' in post, false);
    assert.equal('week' in post, false, 'a global article belongs to no league week');
  }
});

test('trackedPlayers normalizes whatever the payload carried', () => {
  assert.deepEqual(trackedPlayers(null), []);
  assert.deepEqual(trackedPlayers({}), []);
  assert.deepEqual(trackedPlayers({ tracked_players: 'nope' }), []);
  // Entries with neither a name nor an id cannot be matched to a roster.
  assert.deepEqual(trackedPlayers({ tracked_players: [{ position: 'RB' }, null, 'x'] }), []);
  // tracked_players wins when a payload somehow carries both.
  assert.deepEqual(
    trackedPlayers({ tracked_players: [{ name: 'A' }], entities: [{ name: 'B' }] }),
    [{ name: 'A', position: '', sleeperPlayerId: '' }],
  );
});
