#!/usr/bin/env node
/* ============================================================================
   FSN — DESK WIRE WEEK CHECK

   `node scripts/desk-wire-week-check.mjs`

   index.html has no build step and no test suite, so CLAUDE.md makes a
   headless render the non-negotiable half of verifying anything that touches a
   script block. This is that check for the DESK WIRE — the single global
   article the News screen carries above the League Blog and the deterministic
   timeline.

   It is a reproduction of one reported leak. On the Week 4 screen the wire was
   painting a story dated Sep 28, which is Week 3 copy, and stamping a "Week 4
   opponent" chip onto it from the league's live week. One card, two weeks, and
   nothing on it to tell the reader which was which.

   The wire's article is chosen by the day-of-week router (FSNArticles.SLOTS)
   inside an eight-day window, and that window crosses the Tuesday rollover —
   so "newest article for today's slot" is, by construction, "newest article in
   any week". The fix is a week gate in renderDeskWire(): the article's own
   publish date has to resolve to the week on screen, and the week the card is
   painted under is handed to the annotation so the roster context is built for
   THAT week rather than for whatever week the league has rolled to.

   Asserted here, against the real file served to Chromium with
   /api/blog/global stubbed and the clock pinned to a Tuesday in Week 4:

     STALE     a story dated inside Week 3 is not painted on the Week 4 screen
     EMPTY     and the League Blog beside it says Week 4 in its own name rather
               than standing another week's coverage in the slot
     MATCH     a story dated inside Week 4 IS painted on the Week 4 screen
     CONTEXT   the roster context on that card names the week the card is
               painted under, never the league's live week
     SWITCH    moving the scrubber back to Week 3 flips the two: the Week 3
               story paints and the Week 4 story does not
     CLEAN     zero page errors, zero tagged console errors, no "hit a snag"

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

let failures = 0;
const pass = (msg) => console.log('  ok    ' + msg);
const fail = (msg) => { failures++; console.log('  FAIL  ' + msg); };
function expect(actual, wanted, label) {
  if (actual === wanted) pass(label + ' = ' + JSON.stringify(actual));
  else fail(label + ' = ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(wanted));
}
function truthy(value, label) { if (value) pass(label); else fail(label); }

/* --------------------------------------------------------------------------
   THE CLOCK

   Pinned, because every input to this feature is a calendar: the slot router
   reads the weekday, the freshness window reads the date, and the week gate
   maps a publish date onto a slate. A check that ran against the real clock
   would assert something different every day of the week and nothing at all
   out of season.

   Tuesday 29 September 2026, which is the day the leak was reported on:
   Week 4 opened that morning and the newest published story was Monday's,
   dated Sep 28 and therefore Week 3.
-------------------------------------------------------------------------- */
const NOW_ISO = '2026-09-29T15:00:00.000Z';
const SEASON = 2026;

/* The same calendar the app uses (nflRegularSeasonWeek in block 6),
   reimplemented rather than imported so the check is an independent statement
   of the contract instead of an echo of the implementation. Week 1 opens on the
   Tuesday before Labor Day + 3; every slate rolls on the Tuesday after. */
function nflRegularSeasonWeek(seasonYear, ref) {
  const sept1 = new Date(Date.UTC(seasonYear, 8, 1));
  const laborDay = new Date(Date.UTC(seasonYear, 8, 1 + ((8 - sept1.getUTCDay()) % 7)));
  const firstRoll = new Date(Date.UTC(
    laborDay.getUTCFullYear(), laborDay.getUTCMonth(), laborDay.getUTCDate() + 1));
  const days = Math.floor((ref.getTime() - firstRoll.getTime()) / 86400000);
  if (days < 0) return 0;
  return Math.min(18, Math.floor(days / 7) + 1);
}

const WEEK_3_DATE = '2026-09-28';   // Monday — the last day of week 3
const WEEK_4_DATE = '2026-09-29';   // Tuesday — week 4 opens

const VIEWED_WEEK = nflRegularSeasonWeek(SEASON, new Date(NOW_ISO));
const STALE_WEEK = nflRegularSeasonWeek(SEASON, new Date(WEEK_3_DATE + 'T00:00:00Z'));
if (VIEWED_WEEK !== 4 || STALE_WEEK !== 3) {
  console.error('[desk-wire-week-check] the fixture calendar is wrong: ' + WEEK_4_DATE + ' resolves to week ' +
    VIEWED_WEEK + ' and ' + WEEK_3_DATE + ' to week ' + STALE_WEEK + '. Both dates must sit either side of a ' +
    'Tuesday rollover for this check to mean anything.');
  process.exit(1);
}

/* --------------------------------------------------------------------------
   THE FIXTURES

   Two stories, identical in every respect the day router looks at — both are
   recap copy, both are inside the eight-day freshness window, both name a
   player on the reader's own week-4 opponent — and different in exactly one:
   the day they were published, and therefore the week they belong to.

   `Sunday Wideout` plays for Cobalt Kings, who are Ridgeback FC's opponent in
   week 4 of the synthetic league below and NOT their opponent in week 3. That
   is what makes the context line a real assertion rather than a spelling test:
   the chip can only read "Week 4 opponent" if the opponent mapping was built
   for week 4 as well as the label.
-------------------------------------------------------------------------- */
function story(slug, publishDate, title) {
  return {
    slug,
    title,
    excerpt: 'Sunday Wideout carried the late window. One sentence of standing copy.',
    category: 'Recap',
    author: 'FSN Desk',
    publishDate,
    bodyHtml: '<p>Sunday Wideout carried the late window for a roster that needed it.</p>',
    tracked_players: [{ name: 'Sunday Wideout', position: 'WR', team: 'CK', sleeperPlayerId: '' }],
  };
}

const STALE_STORY = story('2026-09-28-monday-night-recap', WEEK_3_DATE, 'Monday Night Recap: the late window');
const FRESH_STORY = story('2026-09-29-week-4-opening-recap', WEEK_4_DATE, 'Week 4 Recap: the opening slate');

/* What /api/blog/global answers with. Mutated between phases. */
let servePosts = [];

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/blog/global') {
        const slug = url.searchParams.get('slug');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (slug) {
          const post = servePosts.find((row) => row.slug === slug) || null;
          res.end(JSON.stringify({ article: post }));
          return;
        }
        /* The manifest carries summaries only, exactly as lib/blog-global.js
           does: the body is a second read by slug. Serving bodies here would
           let a regression in that second read pass unnoticed. */
        res.end(JSON.stringify({
          generatedAt: NOW_ISO,
          count: servePosts.length,
          posts: servePosts.map(({ bodyHtml, ...summary }) => summary),
        }));
        return;
      }
      /* The league's own blog has nothing, which is the ordinary case for a
         fixture league and is what puts the League Blog on its week
         placeholder. */
      if (url.pathname === '/api/blog/articles') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          league_id: url.searchParams.get('league_id'),
          season: null, week: null, display_week: null,
          count: 0, articles: [],
        }));
        return;
      }
      if (url.pathname === '/api/notifications-register' || url.pathname === '/api/notifications') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ configured: false, apns: false, web: false, groups: [] }));
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
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
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/* A minimal ESPN-shaped league sitting on week 4, whose week-3 and week-4
   schedules pair the reader's team with DIFFERENT opponents. */
function syntheticLeague() {
  const team = (id, name, pf, pa) => ({
    id, abbrev: name.slice(0, 3).toUpperCase(), name, location: name, nickname: '',
    primaryOwner: '{OWNER-' + id + '}', owners: ['{OWNER-' + id + '}'], playoffSeed: id, points: pf,
    record: { overall: { wins: 2, losses: 1, ties: 0, pointsFor: pf, pointsAgainst: pa } },
  });
  const player = (id, name, posId, points) => ({
    id, fullName: name, defaultPositionId: posId, proTeamId: 1, injuryStatus: 'ACTIVE',
    stats: [{ scoringPeriodId: 4, statSourceId: 0, statSplitTypeId: 1, appliedTotal: points, stats: {} }],
  });
  const entry = (slotId, p, points) => ({
    lineupSlotId: slotId, appliedStatTotal: points,
    playerPoolEntry: { id: p.id, appliedStatTotal: points, player: p },
  });
  const side = (teamId, entries, total) => ({
    teamId, totalPoints: total, rosterForCurrentScoringPeriod: { entries },
  });
  const game = (id, period, winner, home, away) => ({
    id, matchupPeriodId: period, scoringPeriodId: period, playoffTierType: 'NONE', winner, home, away,
  });
  const anchor = () => entry(2, player(101, 'Early Anchor', 2, 60), 60);
  const wideout = () => entry(2, player(102, 'Sunday Wideout', 3, 40), 40);
  const spare = () => entry(2, player(103, 'Third Rail', 2, 30), 30);
  return {
    id: 777777,
    seasonId: SEASON,
    scoringPeriodId: 4,
    status: { currentMatchupPeriod: 4, latestScoringPeriod: 4, finalScoringPeriod: 17, isActive: true },
    settings: { name: 'Fixture League', scoringSettings: {}, scheduleSettings: { matchupPeriodCount: 14 } },
    teams: [team(1, 'Ridgeback FC', 400, 360), team(2, 'Cobalt Kings', 380, 370), team(3, 'Harbor Pilots', 350, 390)],
    members: [
      { id: '{OWNER-1}', firstName: 'Alpha', lastName: 'One' },
      { id: '{OWNER-2}', firstName: 'Bravo', lastName: 'Two' },
      { id: '{OWNER-3}', firstName: 'Charlie', lastName: 'Three' },
    ],
    schedule: [
      /* Week 3: Ridgeback play Harbor Pilots. Cobalt Kings are NOT their
         opponent, so a context line built for week 3 cannot call Sunday
         Wideout an opponent's player. */
      game(1, 3, 'HOME', side(1, [anchor()], 121.4), side(3, [spare()], 98.2)),
      game(2, 3, 'HOME', side(2, [wideout()], 110.0), side(3, [spare()], 90.0)),
      /* Week 4: Ridgeback play Cobalt Kings, who roster Sunday Wideout. */
      game(3, 4, 'UNDECIDED', side(1, [anchor()], 104.2), side(2, [wideout()], 98.6)),
    ],
  };
}

/* Same resolution as scripts/render-check.mjs: prefer the highest build and a
   full chrome over the headless shell, which lacks pieces this page touches
   during layout. */
function resolveChromium() {
  const override = String(process.env.FSN_CHROMIUM_PATH || '').trim();
  if (override) return override;
  const dir = String(process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers');
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .filter((name) => name.startsWith('chromium'))
    .sort()
    .reverse()
    .flatMap((name) => [
      join(dir, name, 'chrome-linux', 'chrome'),
      join(dir, name, 'chrome-linux', 'headless_shell'),
    ])
    .find((file) => existsSync(file)) || null;
}

const executablePath = resolveChromium();
if (!executablePath) {
  console.error('[desk-wire-week-check] no Chromium binary found under ' +
    (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') + '. Set FSN_CHROMIUM_PATH to one.');
  process.exit(1);
}

const server = await startServer();
const base = 'http://127.0.0.1:' + server.address().port + '/';
const browser = await chromium.launch({ executablePath });
/* UTC so the app's local-calendar math and this file's UTC math are the same
   calendar. The feature is timezone-sensitive by design (a Monday-night reader
   in California is still on Monday), and pinning the zone is what makes the
   pinned clock mean one specific day. */
const context = await browser.newContext({ viewport: { width: 414, height: 896 }, timezoneId: 'UTC' });

/* The pinned clock, installed before any page script runs. Playwright's own
   clock API only freezes timers; this feature reads `new Date()` directly in
   the slot router, the freshness window and the week gate. */
await context.addInitScript((iso) => {
  const fixed = new Date(iso).getTime();
  const RealDate = Date;
  function PinnedDate(...args) {
    if (!(this instanceof PinnedDate)) return new RealDate(fixed).toString();
    return args.length ? new RealDate(...args) : new RealDate(fixed);
  }
  PinnedDate.prototype = RealDate.prototype;
  PinnedDate.now = () => fixed;
  PinnedDate.parse = RealDate.parse;
  PinnedDate.UTC = RealDate.UTC;
  window.Date = PinnedDate;
}, NOW_ISO);

const page = await context.newPage();

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (err) => pageErrors.push(String((err && err.message) || err)));
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  if (/\[(FSN|NewsDesk|LeagueBlog|Standings|Matchups)/.test(text)) consoleErrors.push(text);
});

/* Repaint the wire from whatever the stub is serving now, for whatever week
   the scrubber is on. `force` skips FSNArticles' freshness gate, which would
   otherwise serve the previous phase's pick. */
async function repaint(week) {
  await page.evaluate(async (wk) => {
    if (wk != null) document.getElementById('weekNum').value = String(wk);
    /* Same order as renderNews(): the renderer names the week on screen, then
       the engine reads for it. Refreshing first would pick for the previous
       scope and the check would be asserting against its own sequencing. */
    window.FSNBridge.call('renderDeskWire');
    await window.FSNArticles.refresh({ force: true });
    window.FSNBridge.call('renderDeskWire');
    window.FSNBridge.call('renderLeagueBlog');
  }, week == null ? null : week);
  await page.waitForTimeout(700);
}

async function wireState() {
  return page.evaluate(() => {
    const wrap = document.getElementById('deskWireWrap');
    const ctx = document.querySelector('#deskWireWrap .wire-context');
    return {
      hidden: !!(wrap && wrap.hidden),
      /* textContent, not innerText: the card's own CSS uppercases the meta and
         the context, and a case-folded haystack would make every headline
         assertion below a coin toss. */
      text: (wrap && wrap.textContent) || '',
      context: (ctx && ctx.textContent) || '',
      annotationWeek: Number((window.FSNArticles.readerContext() || {}).currentWeek) || 0,
      liveWeek: Number((window.FSNArticles.readerContext() || {}).liveWeek) || 0,
    };
  });
}

try {
  servePosts = [STALE_STORY];
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__fsnRender === 'function' &&
    !!(window.LeagueData && window.LeagueData.setEspnData) &&
    !!(window.FSNArticles && window.FSNBridge), null, { timeout: 20000 });
  pass('the page booted with FSNArticles and FSNBridge published at global scope');

  await page.evaluate((data) => { window.LeagueData.setEspnData(data); window.__fsnRender(); }, syntheticLeague());
  await page.waitForTimeout(600);

  /* maybeShowFtu() opens the first-run walkthrough on a timer after boot, so a
     single check here races it: its backdrop eats every click for the rest of
     the run. Poll both overlays until the screen is actually clear. */
  for (let attempt = 0; attempt < 12; attempt++) {
    const open = await page.evaluate(() => ({
      profile: (document.getElementById('profilePicker') || {}).dataset?.open === 'true',
      ftu: (document.getElementById('ftuModal') || {}).dataset?.open === 'true',
    }));
    if (!open.profile && !open.ftu) {
      await page.waitForTimeout(400);
      const still = await page.evaluate(() => ({
        profile: (document.getElementById('profilePicker') || {}).dataset?.open === 'true',
        ftu: (document.getElementById('ftuModal') || {}).dataset?.open === 'true',
      }));
      if (!still.profile && !still.ftu) break;
    }
    if (open.profile) await page.click('#profileGuest');
    else if (open.ftu) await page.click('#ftuSkip');
    await page.waitForTimeout(400);
  }
  if (await page.getAttribute('.screen[data-screen="setup"]', 'data-active') === 'true') {
    await page.click('#setupClose');
    await page.waitForTimeout(500);
  }

  /* The reader claims Ridgeback FC, so "your week N opponent" has a subject.
     Written through FSNStore under the key both engines read. */
  await page.evaluate(() => { window.FSNStore.set('fsn_active_team_id', '1'); });

  await page.click('#tabBar .tab-btn[data-tab="news"]');
  await page.waitForTimeout(900);

  expect(await page.evaluate(() => Number(window.effectiveWeek()) || 0), VIEWED_WEEK,
    'the screen opens on the week the pinned clock puts the league in');
  expect(await page.evaluate(() => window.FSNArticles.slotForDate().id), 'recap',
    'and the pinned Tuesday routes the wire to the recap slot');

  /* ---- 1. STALE: week 3 copy on the week 4 screen ------------------- */
  await repaint(VIEWED_WEEK);
  const stale = await wireState();
  truthy(stale.hidden,
    'STALE: a story dated ' + WEEK_3_DATE + ' (week ' + STALE_WEEK + ') is not painted on the week ' +
    VIEWED_WEEK + ' screen');
  truthy(!stale.text.includes('Monday Night Recap'),
    'and its headline is nowhere on the screen');

  /* ---- 2. EMPTY: the slot beside it says the week in its own name --- */
  const blog = await page.evaluate(() => ({
    hidden: !!document.getElementById('leagueBlogWrap').hidden,
    label: (document.getElementById('leagueBlogState') || {}).textContent || '',
    text: (document.getElementById('leagueBlogFeed') || {}).innerText || '',
  }));
  truthy(!blog.hidden, 'EMPTY: the League Blog keeps its slot rather than vanishing');
  truthy(blog.text.includes('Week ' + VIEWED_WEEK + ' coverage begins'),
    'and names the week on screen instead of standing another week\'s coverage in it');
  truthy(blog.label.includes('WEEK ' + VIEWED_WEEK),
    'under the week\'s own header');

  /* ---- 3. MATCH: week 4 copy on the week 4 screen ------------------- */
  servePosts = [FRESH_STORY, STALE_STORY];
  await repaint(VIEWED_WEEK);
  const fresh = await wireState();
  truthy(!fresh.hidden, 'MATCH: a story dated ' + WEEK_4_DATE + ' IS painted on the week ' +
    VIEWED_WEEK + ' screen');
  truthy(fresh.text.includes('Week 4 Recap'), 'and it is the week 4 story, not the newest of any week');
  truthy(!fresh.text.includes('Monday Night Recap'), 'with the week 3 story still off the screen');

  /* ---- 4. CONTEXT: the roster line names the painted week ----------- */
  expect(fresh.annotationWeek, VIEWED_WEEK,
    'CONTEXT: the annotation is built for the week the card is painted under');
  truthy(fresh.context.length > 0, 'the card carries a roster context line');
  if (fresh.context.length) {
    truthy(/week\s*4\s*opponent/i.test(fresh.context),
      'which names the week on screen: ' + JSON.stringify(fresh.context.slice(0, 80)));
    truthy(!/week\s*(?!4\b)\d+\s*opponent/i.test(fresh.context),
      'and names no other week');
  }

  /* ---- 5. SWITCH: the scrubber moves and the two stories swap ------- */
  await repaint(STALE_WEEK);
  const back = await wireState();
  truthy(!back.hidden, 'SWITCH: week ' + STALE_WEEK + ' gets a card of its own');
  truthy(back.text.includes('Monday Night Recap'),
    'and it is the week ' + STALE_WEEK + ' story');
  truthy(!back.text.includes('Week 4 Recap'),
    'with the week 4 story no longer painted under a week ' + STALE_WEEK + ' heading');
  expect(back.annotationWeek, STALE_WEEK,
    'and the annotation follows the scrubber, not the league\'s live week');
  expect(back.liveWeek, VIEWED_WEEK,
    'while the league\'s live week is still what it always was');
  truthy(!/week\s*4\s*opponent/i.test(back.context),
    'so no week 4 opponent chip reaches a week ' + STALE_WEEK + ' card');

  /* ---- 6. CLEAN ----------------------------------------------------- */
  const snag = await page.evaluate(() => /hit a snag/i.test(document.body.innerText || ''));
  truthy(!snag, 'no "hit a snag" text anywhere on the page');
  expect(pageErrors.length, 0, 'zero uncaught page errors' +
    (pageErrors.length ? ': ' + pageErrors.join(' | ') : ''));
  expect(consoleErrors.length, 0, 'zero tagged console errors' +
    (consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''));
} catch (err) {
  fail('the check itself threw: ' + ((err && err.message) || err));
} finally {
  await browser.close();
  server.close();
}

if (failures) {
  console.log('\n[desk-wire-week-check] FAILED: ' + failures + ' assertion(s)');
  process.exit(1);
}
console.log('\n[desk-wire-week-check] clean');
