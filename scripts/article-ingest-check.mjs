#!/usr/bin/env node
/* ============================================================================
   FSN — ARTICLE INGESTION + ENTITY MATCHING CHECK

   `node scripts/article-ingest-check.mjs`

   index.html has no build step and no test suite, so per CLAUDE.md a change to
   a script block is verified by loading the real file in Chromium and asserting
   against the running engine. This is that check for FSNArticles: the app's
   reader for the root-domain blog payload.

   ---- WHAT THIS CHECK GUARDS ----

   The GLOBAL blog feed: real-world NFL copy, identical for every reader,
   compiled from landing/content/blog and read by the app through
   /api/blog/global (falling back to the compiled payload). The point of the
   feature is the last step: the players an article names are matched against
   the reader's OWN roster, so a waiver piece reads as "on your roster" or
   "week 3 opponent" rather than as generic news.

   This is a different corpus from the League Blog, which is one league's own
   private recaps out of `blog_articles` and is covered by
   scripts/league-blog-check.mjs. Nothing here touches that table.

     A. THE PIPE WORKS END TO END, against a reachable payload:

          1. the weekly cadence routes every day to the slot the desk
             publishes, and every day comes back with that slot's article
          2. selection is deterministic, rejects unpublished and out-of-window
             copy, and breaks a same-day tie on slug rather than manifest order
          3. tracked_players survives build -> payload -> endpoint -> engine
          4. those players match this league's rosters by Sleeper id AND by
             name, through the punctuation and suffix variance between a
             desk's copy and a provider's roster, reading each team's LATEST
             week
          5. ownership is framed relative to the reader: their own player,
             this week's opponent's player, anyone else's, degrading to the
             neutral label when no team is claimed
          6. the card paints, with that reader-scoped context line on it

        THE SANITIZER is asserted here too. The fixture body carries an
        <img onerror>, a <script> and a javascript: link, and none may become
        live: this is what stands between a bad blog deploy and script
        execution inside a native shell.

     B. AN UNREACHABLE ORIGIN COSTS EXACTLY THE CARD. The engine reports
        `offline` with a reason, no card paints, and the deterministic News
        Desk underneath is untouched, with no uncaught error and no "hit a
        snag". It must still ATTEMPT the read: a silent no-read would mean the
        feature had been switched off rather than degrading.

   Exit code 0 means clean.
============================================================================ */

import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const BLOG_PREFIX = '/content/generated/blog/';

/* The engine routes on the reader's LOCAL calendar day, so the fixture dates
   are built from the same local clock the page will read. */
function localDateKey(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + (offsetDays || 0));
  const pad = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/* One article per slot, all published today, so whatever day this check runs
   the live slot has exactly one legitimate answer.

   Every body is built the same way on purpose: each names its rostered player
   twice, names one player nobody rosters, and carries hostile markup. Nothing
   in the app reads these bodies any more — that is the point of scenario A, and
   the payload has to be genuinely readable and genuinely hostile for "the app
   did not read it" to mean anything. */
const HOSTILE = '<script>window.__fsnWireInjected = true;</script>'
  + '<p onclick="window.__fsnWireInjected = true">A paragraph carrying an event attribute.</p>'
  + '<iframe src="https://example.com"></iframe>'
  + '<style>body{display:none}</style>';

const FIXTURE_POSTS = [
  {
    slug: 'sunday-matchup-breakdowns', title: 'Sunday matchup breakdowns', category: 'Matchup Preview',
    entities: [{ name: 'A.J. Brown', position: 'WR', sleeperPlayerId: '' },
               { name: 'Nobody Freeagent', position: 'TE', sleeperPlayerId: '' }],
    body: '<p>The board opens with <strong>A.J. Brown</strong> against a soft secondary.</p>'
      + '<p>A.J. Brown is the swing of the whole slate, and Nobody Freeagent is the other side of it.</p>' + HOSTILE,
  },
  {
    slug: 'monday-recap-highs-and-lows', title: 'Recap, the highs and the lows', category: 'Recap',
    entities: [{ name: 'Kenneth Walker III', position: 'RB', sleeperPlayerId: '' },
               { name: 'Nobody Freeagent', position: 'TE', sleeperPlayerId: '' }],
    body: '<p><strong>Kenneth Walker III</strong> carried the slate.</p>'
      + '<p>Kenneth Walker III again in the second half, while Nobody Freeagent sat.</p>' + HOSTILE,
  },
  {
    slug: 'wednesday-waiver-faab-targets', title: 'Waiver wire and FAAB targets', category: 'Waiver Wire',
    entities: [{ name: 'Kimani Vidal', position: 'RB', sleeperPlayerId: '4066' },
               { name: 'Nobody Freeagent', position: 'TE', sleeperPlayerId: '' }],
    body: '<p><strong>Kimani Vidal</strong> is the bid of the week.</p>'
      + '<p>Kimani Vidal again if the claim clears, and Nobody Freeagent is the cheap stash behind him.</p>' + HOSTILE,
  },
  {
    slug: 'thursday-injury-report', title: 'TNF recap and the injury report', category: 'Injury Report',
    entities: [{ name: 'Kimani Vidal', position: 'RB', sleeperPlayerId: '4066' },
               { name: 'Nobody Freeagent', position: 'TE', sleeperPlayerId: '' }],
    body: '<p>The <strong>Kimani Vidal</strong> workload held up on Thursday night.</p>'
      + '<p>Kimani Vidal is a start again next week; Nobody Freeagent is not.</p>' + HOSTILE,
  },
  {
    slug: 'saturday-analysis', title: 'Trade deadline watch', category: 'Analysis',
    entities: [{ name: 'A.J. Brown', position: 'WR', sleeperPlayerId: '' },
               { name: 'Nobody Freeagent', position: 'TE', sleeperPlayerId: '' }],
    body: '<p>Buyers and sellers, with <strong>A.J. Brown</strong> at the center of it.</p>'
      + '<p>A.J. Brown is the name that moves a rebuild, not Nobody Freeagent.</p>' + HOSTILE,
  },
];

function fixturePayload() {
  const today = localDateKey(0);
  const posts = FIXTURE_POSTS.map((p) => ({
    title: p.title, slug: p.slug, publishDate: today, category: p.category,
    excerpt: p.title + ' for the app wire check.', author: 'FSN Desk', entityCount: p.entities.length,
  }));
  const bySlug = {};
  FIXTURE_POSTS.forEach((p) => {
    bySlug[p.slug] = {
      title: p.title, slug: p.slug, publishDate: today, category: p.category,
      excerpt: p.title + ' for the app wire check.', author: 'FSN Desk',
      format: 'json', entities: p.entities, bodyHtml: p.body,
    };
  });
  return { index: { generatedAt: new Date().toISOString(), count: posts.length, posts }, bySlug };
}

/* Repo root plus the blog payload, plus the one API route the client boots
   against. `live:false` makes every blog read a 404, which is the offline
   scenario scenario B points the engine at.

   `blogReads` is the load-bearing instrumentation: the server counts every
   request that reaches the blog directory, so "the app never read the payload"
   is asserted at the origin rather than only from inside the page. */
function startServer(options) {
  const opts = options || {};
  const payload = fixturePayload();
  const state = { blogReads: [] };
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const json = (body) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(body));
      };
      if ((url.pathname === '/api/notifications-register' || url.pathname === '/api/notifications')) {
        json({ configured: false, apns: false, web: false, vapidPublicKey: '', groups: [] });
        return;
      }
      if (url.pathname.startsWith(BLOG_PREFIX)) {
        state.blogReads.push(url.pathname);
        if (!opts.live) {
          res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
          res.end('not found');
          return;
        }
        if (url.pathname === BLOG_PREFIX + 'index.json') { json(payload.index); return; }
        const slug = decodeURIComponent(url.pathname.replace(BLOG_PREFIX + 'posts/', '').replace(/\.json$/, ''));
        if (payload.bySlug[slug]) { json(payload.bySlug[slug]); return; }
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('not found');
        return;
      }
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = join(root, rel.replace(/^\/+/, ''));
      if (!file.startsWith(root) || !existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, state }));
  });
}

/* A Sleeper-shaped league: four rosters, each carrying the sleeperPlayerId the
   adapter now stamps, so both halves of the match (id and name) are exercised
   on a payload with the same shape the real adapter emits. Names are stored the
   way a provider stores them; the fixture articles write them the way a desk
   writes them. */
function syntheticSleeperLeague() {
  const entry = (slot, id, name, points) => ({
    lineupSlotId: slot,
    appliedStatTotal: points,
    playerPoolEntry: { player: { fullName: name, defaultPositionId: 3, sleeperPlayerId: id } },
  });
  const roster = (teamId, players, total) => ({
    teamId,
    totalPoints: total,
    rosterForCurrentScoringPeriod: { entries: players },
  });
  const team = (id, name, wins, losses, pf, pa) => ({
    id, abbrev: name.slice(0, 3).toUpperCase(), name, location: name, nickname: '',
    primaryOwner: '{OWNER-' + id + '}', owners: ['{OWNER-' + id + '}'], playoffSeed: id,
    record: { overall: { wins, losses, ties: 0, pointsFor: pf, pointsAgainst: pa } },
  });

  /* Week 1 rosters deliberately disagree with week 2: Kimani Vidal starts on
     Delta and is on Alpha by week 2. The index must credit Alpha, because it
     reads only each team's latest week. */
  const week1 = [
    { id: 1, home: 1, away: 4, hp: 128.4, ap: 92.1,
      hr: [entry(2, '1001', 'AJ Brown', 22.4), entry(4, '2002', 'Kenneth Walker', 14.1)],
      ar: [entry(2, '4066', 'Kimani Vidal', 8.2)] },
    { id: 2, home: 2, away: 3, hp: 105.6, ap: 101.2,
      hr: [entry(2, '3003', 'Somebody Else', 11.0)],
      ar: [entry(2, '5005', 'Another Guy', 9.5)] },
  ];
  const week2 = [
    { id: 3, home: 1, away: 3, hp: 112.1, ap: 104.2,
      hr: [entry(2, '1001', 'AJ Brown', 19.8), entry(4, '2002', 'Kenneth Walker', 16.3), entry(4, '4066', 'Kimani Vidal', 12.6)],
      ar: [entry(2, '5005', 'Another Guy', 10.1)] },
    { id: 4, home: 2, away: 4, hp: 104.5, ap: 95.9,
      hr: [entry(2, '3003', 'Somebody Else', 13.2)],
      ar: [entry(2, '6006', 'Bench Warmer', 4.4)] },
  ];
  const games = (rows, period) => rows.map((r) => ({
    id: r.id, matchupPeriodId: period, playoffTierType: 'NONE',
    winner: r.hp > r.ap ? 'HOME' : 'AWAY',
    home: roster(r.home, r.hr, r.hp),
    away: roster(r.away, r.ar, r.ap),
  }));

  return {
    id: 888888, seasonId: 2026, scoringPeriodId: 2,
    status: { currentMatchupPeriod: 2, latestScoringPeriod: 2, finalScoringPeriod: 17, isActive: true },
    settings: { name: 'Wire Check League', size: 4, scheduleSettings: { matchupPeriodCount: 14, playoffTeamCount: 4 } },
    members: [1, 2, 3, 4].map((i) => ({
      id: '{OWNER-' + i + '}', displayName: 'Manager ' + i, firstName: 'Manager', lastName: String(i),
    })),
    teams: [
      team(1, 'Alpha', 2, 0, 240.5, 190.2),
      team(2, 'Bravo', 1, 1, 210.1, 205.7),
      team(3, 'Charlie', 1, 1, 205.4, 210.9),
      team(4, 'Delta', 0, 2, 188.0, 237.2),
    ],
    schedule: games(week1, 1).concat(games(week2, 2)),
  };
}

function resolveChromium() {
  const override = String(process.env.FSN_CHROMIUM_PATH || '').trim();
  if (override) return override;
  const dir = String(process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers');
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .filter((name) => name.startsWith('chromium'))
    .sort()
    .reverse()
    .flatMap((name) => [join(dir, name, 'chrome-linux', 'chrome'), join(dir, name, 'chrome-linux', 'headless_shell')])
    .find((file) => existsSync(file)) || null;
}

const executablePath = resolveChromium();
if (!executablePath) {
  console.error('[article-ingest-check] no Chromium binary found under ' +
    (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') + '. Set FSN_CHROMIUM_PATH to one.');
  process.exit(1);
}

let failed = false;
const fail = (message) => { failed = true; console.error('  FAIL  ' + message); };
const pass = (message) => console.log('  ok    ' + message);
const expect = (actual, wanted, label) => {
  if (actual === wanted) pass(label + ' = ' + JSON.stringify(actual));
  else fail(label + ' = ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(wanted));
};

const liveServer = await startServer({ live: true });
const deadServer = await startServer({ live: false });
const liveBase = 'http://127.0.0.1:' + liveServer.server.address().port;
const deadBase = 'http://127.0.0.1:' + deadServer.server.address().port;

const browser = await chromium.launch({ executablePath });

/* Every day of the week, and the slug each slot has exactly one legitimate
   answer for. Computed here rather than read back from the engine, so the
   assertions stay independent of the thing they are checking. */
const WEEK_PLAN = ['pregame', 'recap', 'recap', 'waiver', 'roster', 'roster', 'open'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function openApp(base, articlesOrigin) {
  const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
  const pageErrors = [];
  const consoleErrors = [];
  /* Blog requests seen from the browser side as well as from the origin: a read
     that never leaves the page (a cache hit, a service worker) still counts as
     the app reaching for external editorial. */
  const blogRequests = [];
  page.on('pageerror', (err) => pageErrors.push(String((err && err.stack) || err)));
  page.on('request', (req) => {
    if (req.url().includes(BLOG_PREFIX)) blogRequests.push(req.url());
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/\[(FSN|NewsDesk|Standings|Matchups)/.test(text)) consoleErrors.push(text);
  });
  await page.addInitScript(({ origin }) => {
    window.FSN_ARTICLES_ORIGIN = origin;
    window.__fsnWireInjected = false;
    try { window.localStorage.clear(); } catch (err) { /* private mode */ }
    try { window.localStorage.setItem('hasCompletedOnboarding', 'true'); } catch (err) { /* private mode */ }
  }, { origin: articlesOrigin });
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  return { page, pageErrors, consoleErrors, blogRequests };
}

/* Seed the synthetic league, repaint, and dismiss the profile picker so the
   reader is an explicit guest rather than an unanswered prompt. */
async function seedLeague(page) {
  await page.evaluate((data) => {
    window.LeagueData.setEspnData(data);
    window.__fsnRender();
  }, syntheticSleeperLeague());
  await page.waitForTimeout(600);
  if ((await page.getAttribute('#profilePicker', 'data-open')) === 'true') {
    await page.click('#profileGuest');
    await page.waitForTimeout(400);
  }
}

try {
  /* ---- A. A reachable blog payload the app must still not read ---------- */
  console.log('\n[A] the live blog origin is reachable — the app must stay disconnected from it');
  const live = await openApp(liveBase, liveBase);
  const page = live.page;

  const seam = await page.evaluate(() => !!(window.FSNArticles && typeof window.FSNArticles.refresh === 'function'));
  if (seam) pass('seam present: window.FSNArticles');
  else fail('seam missing: window.FSNArticles');

  /* The launch hook is inert: booting the app must not reach for the payload or
     settle the engine into any state that implies it tried. */
  const boot = await page.evaluate(() => window.FSNArticles.current().status);
  expect(boot, 'idle', 'engine status after boot, with no explicit refresh');

  /* 1. Cadence routing, every day, without moving the clock. */
  const plan = await page.evaluate(() => [0, 1, 2, 3, 4, 5, 6].map((d) => window.FSNArticles.slotForDay(d).id));
  expect(plan.join(','), WEEK_PLAN.join(','), 'weekly cadence Sun..Sat');

  /* 2. Selection: the right category per slot, and the three rejections. The
        rows are inline rather than fetched, so this exercises the selector
        without the check itself reading the blog payload it asserts nobody
        reads. */
  const selection = await page.evaluate(() => {
    const A = window.FSNArticles;
    const today = '2026-09-09';
    const rows = [
      { slug: 'prev', title: 'Sunday matchup breakdowns', category: 'Matchup Preview', publishDate: today },
      { slug: 'recap', title: 'Highs and lows', category: 'Recap', publishDate: today },
      { slug: 'waiver', title: 'FAAB targets', category: 'Waiver Wire', publishDate: today },
      { slug: 'roster', title: 'Injury report', category: 'Injury Report', publishDate: today },
    ];
    const pick = (day, list, key) => {
      const got = A.selectForSlot(list || rows, A.slotForDay(day), key || today);
      return got ? got.slug : null;
    };
    return {
      sunday: pick(0), monday: pick(1), wednesday: pick(3), thursday: pick(4),
      future: pick(3, [{ slug: 'waiver', title: 'FAAB targets', category: 'Waiver Wire', publishDate: '2026-09-10' }]),
      stale: pick(3, [{ slug: 'waiver', title: 'FAAB targets', category: 'Waiver Wire', publishDate: '2026-08-01' }]),
      offSlot: pick(3, [{ slug: 'recap', title: 'Highs and lows', category: 'Recap', publishDate: today }]),
      tie: pick(6, [
        { slug: 'zeta', title: 'Zeta', category: 'Analysis', publishDate: today },
        { slug: 'alpha', title: 'Alpha', category: 'Analysis', publishDate: today },
      ]),
    };
  });
  expect(selection.sunday, 'prev', 'Sunday routes to the preview');
  expect(selection.monday, 'recap', 'Monday routes to the recap');
  expect(selection.wednesday, 'waiver', 'Wednesday routes to the waiver piece');
  expect(selection.thursday, 'roster', 'Thursday routes to the injury report');
  expect(selection.future, null, 'a post dated tomorrow is not surfaced');
  expect(selection.stale, null, 'a post outside the publishing window is not surfaced');
  expect(selection.offSlot, null, 'a post from another slot is not surfaced');
  expect(selection.tie, 'alpha', 'a same-day tie breaks on slug, not manifest order');

  /* ---- 3. Entity matching against this league's rosters ----------------- */
  await seedLeague(page);

  const owners = await page.evaluate(() => {
    const A = window.FSNArticles;
    const label = (entity) => {
      const owner = A.ownerOf(entity);
      return owner ? owner.teamName : null;
    };
    return {
      byId: label({ name: 'Totally Different Name', sleeperPlayerId: '4066' }),
      byPunctuation: label({ name: 'A.J. Brown', sleeperPlayerId: '' }),
      bySuffix: label({ name: 'Kenneth Walker III', sleeperPlayerId: '' }),
      latestWeekWins: label({ name: 'Kimani Vidal', sleeperPlayerId: '' }),
      unrostered: label({ name: 'Nobody Freeagent', sleeperPlayerId: '' }),
      rosterCount: A.ownership().count,
    };
  });
  expect(owners.byId, 'Alpha', 'matched by Sleeper player id');
  expect(owners.byPunctuation, 'Alpha', '"A.J. Brown" matches roster "AJ Brown"');
  expect(owners.bySuffix, 'Alpha', '"Kenneth Walker III" matches roster "Kenneth Walker"');
  expect(owners.latestWeekWins, 'Alpha', 'ownership reads the latest week, not the first');
  expect(owners.unrostered, null, 'an unrostered player has no owner');
  if (owners.rosterCount >= 6) pass('roster index built: ' + owners.rosterCount + ' players');
  else fail('roster index too small: ' + owners.rosterCount);

  /* ---- 4. Reader-scoped ownership framing -------------------------------
     With no active team claimed the tag reads generically ("owned by ..."). Team
     1 (Alpha) rosters all three matched players, so a reader on Team 1 must see
     them as their own. Team 3 (Charlie) plays Team 1 in the league's current
     week (2), so the same three players must reframe as that week's opponent.
     Driven through the exported helpers rather than a rendered card: there is
     no card, and these are the functions any future surface would call. */
  const framing = await page.evaluate(() => {
    const A = window.FSNArticles;
    const NAMES = ['A.J. Brown', 'Kenneth Walker III', 'Kimani Vidal'];
    const read = (teamId) => {
      window.FSNStore.set('fsn_active_team_id', teamId);
      const context = A.readerContext();
      return {
        context,
        rows: NAMES.map((name) => {
          const owner = A.ownerOf({ name, sleeperPlayerId: '' });
          return {
            name,
            role: A.ownerRole(owner, context),
            tag: A.ownerTagText(owner, context),
            label: A.ownerLabel(owner),
          };
        }),
      };
    };
    return { self: read('1'), opponent: read('3'), guest: read('guest'), cleared: read('') };
  });

  const selfRows = framing.self.rows;
  if (selfRows.every((r) => r.role === 'self' && /^on your roster$/i.test(r.tag))) {
    pass('a reader on Team 1 sees "on your roster" for every player Alpha rosters');
  } else fail('reader on Team 1 did not see the personalized tag: ' + JSON.stringify(selfRows));

  const oppRows = framing.opponent.rows;
  if (oppRows.every((r) => r.role === 'opponent' && /^your week 2 opponent\b/i.test(r.tag))) {
    pass('a reader on Team 3 sees the Week-2 opponent framing for every Alpha player');
  } else fail('reader on Team 3 did not see the opponent tag: ' + JSON.stringify(oppRows));

  if (oppRows.every((r) => /·\s*Manager 1\b/.test(r.tag))) {
    pass('the opponent tag names the manager it belongs to');
  } else fail('the opponent tag does not name the manager: ' + JSON.stringify(oppRows.map((r) => r.tag)));

  if (framing.cleared.rows.every((r) => r.role === 'other' && /^owned by /i.test(r.tag))) {
    pass('a cleared reader falls back to the neutral "owned by" tag');
  } else fail('cleared reader did not fall back to the neutral tag: ' + JSON.stringify(framing.cleared.rows));

  if (framing.guest.rows.every((r) => r.role === 'other' && /^owned by /i.test(r.tag))) {
    pass('the guest profile is treated as no claimed team, not as a team named "guest"');
  } else fail('the guest profile did not fall back to the neutral tag: ' + JSON.stringify(framing.guest.rows));

  expect(framing.self.context.activeTeamId, '1', "readerContext() surfaces the reader's active team id");
  expect(framing.self.context.currentWeek, 2, 'readerContext() surfaces the league\'s current week');
  expect(framing.guest.context.activeTeamId, '', 'readerContext() reports the guest profile as no team');

  /* Leave the reader as a guest for the desk assertions below. */
  await page.evaluate(() => window.FSNStore.set('fsn_active_team_id', ''));

  /* ---- 5. The engine routes and reads, every day of the week ------------
     The page clock is pinned to each of the next seven calendar days in turn
     and the engine is re-driven. Every day must route to its own slot (so the
     calendar router is exercised end to end) AND come back with the article
     that slot publishes. The fixture manifest carries a post for every slot,
     so a day that settles empty means the read or the routing broke. */
  const base = new Date();
  base.setHours(12, 0, 0, 0);
  for (let i = 0; i < 7; i++) {
    const when = new Date(base);
    when.setDate(base.getDate() + i);
    const day = when.getDay();
    const slotId = WEEK_PLAN[day];
    await page.clock.setFixedTime(when);
    await page.evaluate(() => window.FSNArticles.refresh({ force: true }));
    await page.waitForTimeout(250);
    const row = await page.evaluate(() => {
      const state = window.FSNArticles.current();
      return {
        status: state.status,
        slot: state.slot && state.slot.id,
        hasPost: !!state.post,
        readerUrl: state.readerUrl,
        reason: state.reason,
        slug: state.post && state.post.slug,
        annotated: window.FSNArticles.annotated(),
      };
    });
    if (row.slot !== slotId) fail(DAY_NAMES[day] + ': routed to slot ' + row.slot + ', expected ' + slotId);
    else if (row.status !== 'ready') fail(DAY_NAMES[day] + ': engine status is "' + row.status + '", expected "ready"');
    else if (!row.hasPost) fail(DAY_NAMES[day] + ': routed to ' + slotId + ' but produced no post');
    else if (row.annotated === null) fail(DAY_NAMES[day] + ': annotated() returned nothing for a ready post');
    else if (!row.readerUrl) fail(DAY_NAMES[day] + ': the engine published no reader URL for its post');
    else pass(DAY_NAMES[day] + ' -> ' + slotId + ' -> ' + row.slug);
  }
  await page.clock.setFixedTime(new Date());

  /* ---- 6. The News Desk carries the wire, matched to this roster -------- */
  await page.click('#tabBar .tab-btn[data-tab="news"]');
  await page.waitForTimeout(900);
  await page.evaluate(() => window.FSNArticles.refresh({ force: true }));
  await page.waitForTimeout(600);

  const desk = await page.evaluate(() => {
    const screen = document.querySelector('.screen[data-screen="news"]');
    return {
      wireWrap: !!document.getElementById('deskWireWrap'),
      wireCards: document.querySelectorAll('.wire-card-compact').length,
      wireRegistered: window.FSNBridge.has('renderDeskWire'),
      deskPainted: !!document.getElementById('newsLeadWrap').innerHTML.trim(),
      timelinePainted: document.querySelectorAll('#timelineFeed .tl-card').length,
      injected: window.__fsnWireInjected === true,
      snag: screen ? /hit a snag/i.test(screen.innerText) : true,
    };
  });
  expect(desk.wireWrap, true, 'the #deskWireWrap card is mounted on the News Desk');
  expect(desk.wireRegistered, true, 'the desk-wire renderer is registered on FSNBridge');
  expect(desk.deskPainted, true, 'the deterministic News Desk still painted its own lead');
  if (desk.timelinePainted > 0) pass('the deterministic timeline painted ' + desk.timelinePainted + ' cards');
  else fail('the deterministic timeline painted nothing');
  expect(desk.snag, false, '"hit a snag" on the News Desk');

  /* THE WHOLE POINT OF THE FEATURE: the story is on screen, and the players it
     names are labelled against the reader's own roster. */
  if (desk.wireCards > 0) pass('a wire card is painted (' + desk.wireCards + ')');
  else fail('the wire read an article but painted no card');

  const wired = await page.evaluate(() => {
    const view = window.FSNArticles.annotated();
    const wrap = document.getElementById('deskWireWrap');
    return {
      matched: (view && view.matches || []).map((m) => ({ name: m.name, role: m.role, owner: !!m.owner })),
      unmatched: (view && view.unmatched || []).map((u) => u.name),
      tracked: (view && view.post && view.post.tracked_players || []).map((t) => t.name),
      contextText: wrap ? (wrap.querySelector('.wire-context') || {}).textContent || '' : '',
    };
  });

  /* tracked_players is what the parser extracted and what the app matches on.
     It must survive the whole pipe: build -> payload -> endpoint -> engine. */
  if (wired.tracked.length > 0) pass('tracked_players reached the app: ' + wired.tracked.join(', '));
  else fail('the article arrived with no tracked_players to match');

  const owned = wired.matched.filter((m) => m.owner);
  if (owned.length > 0) pass('tracked players matched to a roster: ' + owned.map((m) => m.name + ' (' + m.role + ')').join(', '));
  else fail('no tracked player matched any roster: ' + JSON.stringify(wired));

  if (/roster|opponent|available|around the league/i.test(wired.contextText)) {
    pass('the card frames them for the reader: ' + JSON.stringify(wired.contextText.slice(0, 80)));
  } else fail('the card painted no reader-scoped context line: ' + JSON.stringify(wired.contextText));

  /* ---- 6b. THE SANITIZER --------------------------------------------------
     The header of this file required this coverage be restored in the same
     commit that re-enables external editorial, and it is right to: this is
     what stands between a bad blog deploy and script execution inside a
     native shell. The fixture body carries an <img onerror>, a <script> and a
     javascript: link. None may become live. */
  expect(desk.injected, false, 'nothing from the blog payload executed');

  const sanitized = await page.evaluate(() => {
    const wrap = document.getElementById('deskWireWrap');
    const html = wrap ? wrap.innerHTML : '';
    return {
      scripts: wrap ? wrap.querySelectorAll('script').length : -1,
      images: wrap ? wrap.querySelectorAll('img').length : -1,
      onerror: /onerror\s*=/i.test(html),
      jsHref: /href\s*=\s*["']?javascript:/i.test(html),
      injected: window.__fsnWireInjected === true,
    };
  });
  expect(sanitized.scripts, 0, 'no <script> survived into the wire card');
  expect(sanitized.images, 0, 'no <img> survived into the wire card');
  expect(sanitized.onerror, false, 'no onerror attribute survived into the wire card');
  expect(sanitized.jsHref, false, 'no javascript: href survived into the wire card');
  expect(sanitized.injected, false, 'the payload still executed nothing after painting');

  /* The read itself happened. */
  if (liveServer.state.blogReads.length > 0) pass('the app read the blog origin (' + liveServer.state.blogReads.length + ' read(s))');
  else fail('the app made no read of the blog origin');

  if (live.pageErrors.length) fail('page errors with a reachable blog origin: ' + JSON.stringify(live.pageErrors.slice(0, 3)));
  else pass('no uncaught page errors with a reachable blog origin');
  if (live.consoleErrors.length) fail('tagged console errors with a reachable blog origin: ' + JSON.stringify(live.consoleErrors.slice(0, 3)));
  else pass('no tagged console errors with a reachable blog origin');
  await page.close();

  /* ---- B. The origin is unreachable ------------------------------------
     A phone is offline often, and the blog is a card on a screen, not the
     screen. So an unreachable origin must cost exactly that card: the engine
     reports `offline` with a reason, the wire paints nothing, and the
     deterministic News Desk underneath is untouched, with no uncaught error
     and no "hit a snag" anywhere. */
  console.log('\n[B] the blog origin is unreachable - the desk below must be untouched');
  const dead = await openApp(liveBase, deadBase);
  await seedLeague(dead.page);
  await dead.page.click('#tabBar .tab-btn[data-tab="news"]');
  await dead.page.waitForTimeout(1200);

  const degraded = await dead.page.evaluate(async () => {
    const screen = document.querySelector('.screen[data-screen="news"]');
    const bootStatus = window.FSNArticles.current().status;
    await window.FSNArticles.refresh({ force: true });
    const state = window.FSNArticles.current();
    return {
      wireWrap: !!document.getElementById('deskWireWrap'),
      bootStatus,
      status: state.status,
      hasPost: !!state.post,
      snag: screen ? /hit a snag/i.test(screen.innerText) : true,
      deskPainted: !!document.getElementById('newsLeadWrap').innerHTML.trim(),
      wireCards: document.querySelectorAll('.wire-card-compact').length,
      reason: state.reason,
      timelinePainted: document.querySelectorAll('#timelineFeed .tl-card').length,
    };
  });
  /* The mount point is always in the document; what changes is whether the
     renderer put a card in it. */
  expect(degraded.wireWrap, true, 'the wire mount point is still in the document');
  expect(degraded.status, 'offline', 'engine status after an explicit refresh against an unreachable origin');
  expect(degraded.hasPost, false, 'no post with an unreachable origin');
  expect(degraded.wireCards, 0, 'no wire card is painted with an unreachable origin');
  if (String(degraded.reason || '').trim()) pass('the offline state says why: ' + JSON.stringify(degraded.reason));
  else fail('the offline state carries no reason');

  /* What must NOT change. */
  expect(degraded.snag, false, '"hit a snag" on the News Desk with an unreachable origin');
  expect(degraded.deskPainted, true, 'the deterministic News Desk still painted');
  if (degraded.timelinePainted > 0) pass('the deterministic timeline still painted ' + degraded.timelinePainted + ' cards');
  else fail('an unreachable blog origin took the deterministic timeline down with it');

  /* It did try. A silent no-read here would mean the feature is off again
     rather than degrading, which is the regression this section now guards. */
  if (dead.blogRequests.length > 0) pass('the app attempted the read (' + dead.blogRequests.length + ' request(s))');
  else fail('the app made no attempt to read the blog origin');

  if (dead.pageErrors.length) fail('page errors with an unreachable origin: ' + JSON.stringify(dead.pageErrors.slice(0, 3)));
  else pass('no uncaught page errors with an unreachable origin');
  if (dead.consoleErrors.length) fail('tagged console errors with an unreachable origin: ' + JSON.stringify(dead.consoleErrors.slice(0, 3)));
  else pass('no tagged console errors with an unreachable origin');
  await dead.page.close();
} catch (err) {
  fail('the check itself threw: ' + ((err && err.stack) || err));
} finally {
  await browser.close();
  liveServer.server.close();
  deadServer.server.close();
}

if (failed) {
  console.error('\n[article-ingest-check] FAILED');
  process.exit(1);
}
console.log('\n[article-ingest-check] clean');
