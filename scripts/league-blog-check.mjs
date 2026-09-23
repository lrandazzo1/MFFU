#!/usr/bin/env node
/* ============================================================================
   FSN — LEAGUE BLOG CHECK

   `node scripts/league-blog-check.mjs`

   index.html has no build step and no test suite, so CLAUDE.md makes a
   headless render the non-negotiable half of verifying anything that touches a
   script block. This is that check for the League Blog: the engine in block 1
   (FSNLeagueArticles) and the section block 6 paints above the deterministic
   timeline on the News Desk.

   It serves the real file to Chromium with /api/blog/articles stubbed, and
   asserts:

     EMPTY      a league with nothing published hides the section outright, so
                the desk renders exactly as it did before this feature
     RENDER     a published article paints its headline, its markdown
                (headings, bullets, bold) and its tracked-player chips
     TIERS      the three tiers land in order: headline, then the match impact
                callout, then the narrative, with the category badge and the
                author credit as the meta line
     LEGACY     an article carrying only title / content_markdown still paints
                a complete card, with no empty callout band
     ACTIVE     FSNSupabaseArticles.fetch() asks /api/blog/articles with
                active=1 and no week, and its stories stand in under a LATEST
                label when the week on screen has none of its own
     PRIORITY   the week on screen wins when it has coverage, so no article is
                ever painted twice
     GATE       the active feed is held back off the live season, where one
                season's copy would appear under another's name
     SAFETY     markup inside the narrative and the callout is escaped, never
                injected
     CHIPS      "N PLAYERS TRACKED", one chip per row, and a tap opens the
                player sheet with that row's own numbers
     FRAMING    a chip whose row is not GAME_WINNER never reads as a hero
     CACHE      a repaint serves from cache instead of re-fetching
     REFRESH    the refresh control forces a new read
     CLEAN      zero page errors, zero tagged console errors, no "hit a snag"

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
   THE ARTICLE FIXTURE

   One published article carrying every markdown construct the generator
   emits, a deliberate injection attempt in the body, and four tracked players
   covering all four outcome flags plus an unflagged row.
-------------------------------------------------------------------------- */
const ARTICLE = {
  slug: '2026-week-2-tuesday-verdict-777777',

  /* Tier 1 and tier 2. The headline deliberately differs from `title` so the
     check can prove which one the card paints, and the callout carries an
     injection attempt of its own: it is the most prominent line after the
     headline and is not run through the markdown subset, so it needs its own
     proof that it is escaped. */
  headline: 'Ridgeback FC Survive The Late Window',
  match_impact_summary: 'Monday Back scored 20 points, just enough for Ridgeback FC. <img src=x onerror="window.__lbInjected=1">',
  category: 'Matchup Recap',
  author: 'FFU News Desk',

  title: 'Tuesday Verdict: Week 2',
  excerpt: 'What the math says about week 2.',
  content_markdown: [
    '# Tuesday Verdict: Week 2',
    '',
    'The week 2 performances that **actually** moved a matchup.',
    '',
    '## What the math says',
    '',
    '- Monday Back won the matchup for Ridgeback FC.',
    '- Night Monster went for 31 and Ninth Street lost anyway. A monster game, wasted.',
    '',
    // Neither of these may ever become an element.
    '<img src=x onerror="window.__lbInjected=1">',
    '<script>window.__lbInjected=1;<\/script>',
  ].join('\n'),
  article_type: 'tuesday_verdict',
  season: 2026,
  week: 2,
  published_at: '2026-09-15T13:00:00.000Z',
  tracked_players: [
    { player_id: 'p2', player_name: 'Monday Back', owner_team: 'Ridgeback FC', opponent_team: 'Cobalt Kings',
      outcome_flag: 'GAME_WINNER', player_points: 20, projected_points: 15, entering_margin: -14, final_margin: 6, slot: 'MNF' },
    { player_id: 'p10', player_name: 'Night Monster', owner_team: 'Ninth Street', opponent_team: 'Gulf Current',
      outcome_flag: 'VALIANT_LOSS', player_points: 31, projected_points: 18, entering_margin: -20, final_margin: -9, slot: 'SNF' },
    { player_id: 'p6', player_name: 'Late Padder', owner_team: 'Harbor Pilots', opponent_team: 'Verdant Owls',
      outcome_flag: 'GARBAGE_TIME_BLOWOUT', player_points: 25, projected_points: 20, entering_margin: 40, final_margin: 65, slot: 'SUNDAY' },
    { player_id: 'p14', player_name: 'Monday Ghost', owner_team: 'Copper Ridge', opponent_team: 'Iron Lantern',
      outcome_flag: 'DUD_COST_WIN', player_points: 3, projected_points: 25, entering_margin: 12, final_margin: -8, slot: 'MNF' },
    { player_id: 'p1', player_name: 'Early Anchor', owner_team: 'Ridgeback FC', opponent_team: 'Cobalt Kings',
      outcome_flag: null, player_points: 60, projected_points: 58, entering_margin: 0, final_margin: 6, slot: 'SUNDAY' },
  ],
};

/* Tier 3 under the new name, byte for byte what the legacy column carries, so
   the check proves the card reads `content` without needing a second body to
   compare against. */
ARTICLE.content = ARTICLE.content_markdown;

/* The same story as it was published before the three-tier columns existed:
   `title` and `content_markdown` and nothing else. Its card must still be
   complete, and must show no callout at all rather than an empty band. */
/* The active feed's answer: a story from ANOTHER week, which is the whole
   point of the feed. Its headline and callout are distinct from the
   week-scoped fixture's so the check can prove which feed painted. */
const ACTIVE_ARTICLE = {
  slug: '2026-week-1-monday-sweat-777777',
  headline: 'Cobalt Kings Open On A Thin Bench',
  match_impact_summary: 'Sunday Wideout scored 40 points, not enough for Cobalt Kings.',
  content: '# Week 1 in the books\n\nThe **active** read carried this one.\n',
  category: 'Waiver Wire',
  author: 'FFU News Desk',
  article_type: 'monday_sweat',
  season: 2026,
  week: 1,
  published_at: '2026-09-08T13:00:00.000Z',
  tracked_players: [
    { player_id: 'p9', player_name: 'Sunday Wideout', owner_team: 'Cobalt Kings', opponent_team: 'Ridgeback FC',
      outcome_flag: 'VALIANT_LOSS', player_points: 40, projected_points: 22, entering_margin: -30, final_margin: -12, slot: 'SUNDAY' },
  ],
};

const LEGACY_ARTICLE = {
  slug: '2026-week-2-monday-sweat-777777',
  title: 'Monday Sweat: Week 2',
  excerpt: 'Before the late window.',
  content_markdown: '# Monday Sweat: Week 2\n\nOne **legacy** paragraph.\n',
  article_type: 'monday_sweat',
  season: 2026,
  week: 2,
  published_at: '2026-09-14T13:00:00.000Z',
  tracked_players: [],
};

const requests = [];
let serveArticles = [];
let serveActive = [];
const activeRequests = () => requests.filter((row) => row.active);
const weekRequests = () => requests.filter((row) => !row.active);

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/blog/articles') {
        const active = url.searchParams.get('active') === '1';
        const league_id = url.searchParams.get('league_id');
        requests.push({
          league_id,
          season: url.searchParams.get('season'),
          week: url.searchParams.get('week'),
          limit: url.searchParams.get('limit'),
          active,
        });
        /* The two feeds hit the same path and are told apart by `active`,
           exactly as the real route tells them apart. Serving them from one
           list would make every assertion below ambiguous. */
        const rows = active ? serveActive : serveArticles;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ league_id, active, count: rows.length, articles: rows }));
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

/* A minimal ESPN-shaped league: enough for the News Desk to render week 2. */
function syntheticLeague() {
  const team = (id, name, pf, pa) => ({
    id, abbrev: name.slice(0, 3).toUpperCase(), name, location: name, nickname: '',
    primaryOwner: '{OWNER-' + id + '}', owners: ['{OWNER-' + id + '}'], playoffSeed: id, points: pf,
    record: { overall: { wins: 1, losses: 1, ties: 0, pointsFor: pf, pointsAgainst: pa } },
  });
  const player = (id, name, posId, points) => ({
    id, fullName: name, defaultPositionId: posId, proTeamId: 1, injuryStatus: 'ACTIVE',
    stats: [{ scoringPeriodId: 2, statSourceId: 0, statSplitTypeId: 1, appliedTotal: points, stats: {} }],
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
  return {
    id: 777777,
    seasonId: 2026,
    scoringPeriodId: 2,
    status: { currentMatchupPeriod: 2, latestScoringPeriod: 2, finalScoringPeriod: 17, isActive: true },
    settings: { name: 'Fixture League', scoringSettings: {}, scheduleSettings: { matchupPeriodCount: 14 } },
    teams: [team(1, 'Ridgeback FC', 200, 180), team(2, 'Cobalt Kings', 180, 200)],
    members: [{ id: '{OWNER-1}', firstName: 'Alpha', lastName: 'One' }, { id: '{OWNER-2}', firstName: 'Bravo', lastName: 'Two' }],
    schedule: [
      game(1, 1, 'HOME', side(1, [entry(2, player(101, 'Early Anchor', 2, 60), 60)], 121.4),
        side(2, [entry(2, player(102, 'Sunday Wideout', 3, 40), 40)], 98.2)),
      game(2, 2, 'UNDECIDED', side(1, [entry(2, player(101, 'Early Anchor', 2, 60), 60)], 104.2),
        side(2, [entry(2, player(102, 'Sunday Wideout', 3, 40), 40)], 98.6)),
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
  console.error('[league-blog-check] no Chromium binary found under ' +
    (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') + '. Set FSN_CHROMIUM_PATH to one.');
  process.exit(1);
}

const server = await startServer();
const base = 'http://127.0.0.1:' + server.address().port + '/';
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (err) => pageErrors.push(String(err && err.message || err)));
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  if (/\[(FSN|NewsDesk|LeagueBlog|Standings|Matchups)/.test(text)) consoleErrors.push(text);
});

try {
  /* ---- 1. EMPTY: nothing published ---------------------------------- */
  serveArticles = [];
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__fsnRender === 'function' &&
    !!(window.LeagueData && window.LeagueData.setEspnData) && !!window.FSNLeagueArticles, null, { timeout: 20000 });
  pass('the page booted with FSNLeagueArticles published at global scope');

  await page.evaluate((data) => { window.LeagueData.setEspnData(data); window.__fsnRender(); }, syntheticLeague());
  await page.waitForTimeout(600);

  if (await page.getAttribute('#profilePicker', 'data-open') === 'true') {
    await page.click('#profileGuest');
    await page.waitForTimeout(400);
  }
  if (await page.getAttribute('#ftuModal', 'data-open') === 'true') {
    await page.click('#ftuSkip');
    await page.waitForTimeout(400);
  }

  /* Chips are tapped later, so the News screen has to be the ACTIVE one: an
     inactive .screen is not visible and Playwright will not click through it. */
  await page.click('#tabBar .tab-btn[data-tab="news"]');
  await page.waitForTimeout(900);

  expect(await page.getAttribute('#leagueBlogWrap', 'hidden') !== null, true,
    'a league with nothing published hides the section outright');
  truthy(weekRequests().length > 0, 'the week-scoped endpoint was called (' + weekRequests().length + ' request(s))');
  if (weekRequests().length) {
    const first = weekRequests()[0];
    expect(first.season, '2026', 'the week-scoped read is scoped to the viewed season');
    expect(first.week, '2', 'the week-scoped read is scoped to the viewed week');
    truthy(first.league_id && first.league_id.length > 0, 'the week-scoped read carries a league_id');
  }

  /* The active feed is the second half of the wiring, and it fires on the same
     pass rather than only once the week-scoped read comes back empty. */
  truthy(await page.evaluate(() => !!(window.FSNSupabaseArticles && typeof window.FSNSupabaseArticles.fetch === 'function')),
    'FSNSupabaseArticles.fetch is published at global scope');
  truthy(activeRequests().length > 0, 'the active endpoint was called (' + activeRequests().length + ' request(s))');
  if (activeRequests().length) {
    const first = activeRequests()[0];
    truthy(first.league_id && first.league_id.length > 0, 'the active read carries a league_id');
    expect(first.week, null, 'the active read sends no week');
    expect(first.season, null, 'the active read sends no season');
  }
  expect(await page.getAttribute('#leagueBlogWrap', 'hidden') !== null, true,
    'with neither feed carrying anything the section stays hidden');

  /* ---- 2. RENDER: a published article -------------------------------- */
  /* Both feeds are given something from here on, so every assertion below is
     also an assertion about which feed won. */
  serveActive = [ACTIVE_ARTICLE];
  serveArticles = [ARTICLE];
  await page.evaluate(() => window.FSNSupabaseArticles.refresh());
  await page.waitForTimeout(600);
  await page.evaluate(() => window.FSNLeagueArticles.refresh());
  await page.waitForTimeout(900);
  await page.evaluate(() => { window.FSNBridge.call('renderLeagueBlog'); });
  await page.waitForTimeout(600);

  expect(await page.getAttribute('#leagueBlogWrap', 'hidden'), null, 'the section is visible once an article publishes');
  expect(await page.textContent('.lb-title'), 'Ridgeback FC Survive The Late Window',
    'TIER 1: the headline renders, not the legacy title');
  expect(await page.locator('.lb-md h2').first().textContent(), 'What the math says', 'a markdown heading renders as a heading');
  expect(await page.locator('.lb-md li').count(), 2, 'markdown bullets render as list items');
  expect(await page.locator('.lb-md strong').first().textContent(), 'actually', 'markdown bold renders as strong');

  /* The active feed has a story too, and must NOT paint while the week on
     screen has its own: one article per slot, never both. */
  expect(await page.locator('.lb-card').count(), 1, 'PRIORITY: exactly one card is painted');
  truthy(!(await page.textContent('#leagueBlogFeed')).includes('Cobalt Kings Open On A Thin Bench'),
    'the active feed does not paint alongside the week on screen');
  truthy((await page.textContent('#leagueBlogState')).includes('WEEK 2'),
    'the header says which week is on screen');

  /* ---- 2b. TIERS: headline, callout, narrative, meta ----------------- */
  expect(await page.locator('.lb-card').first().locator('.lb-impact').count(), 1,
    'TIER 2: the match impact summary renders in its own callout');
  truthy((await page.textContent('.lb-impact-text')).includes('just enough for Ridgeback FC'),
    'the callout carries the impact summary text');

  /* The tiers must be in order in the document, not merely both present: the
     callout is only a callout if it sits between the headline and the body. */
  const order = await page.evaluate(() => {
    const card = document.querySelector('.lb-card');
    if (!card) return null;
    const at = (sel) => {
      const el = card.querySelector(sel);
      if (!el) return -1;
      return Array.prototype.indexOf.call(card.querySelectorAll('*'), el);
    };
    return { title: at('.lb-title'), impact: at('.lb-impact'), body: at('.lb-md'), meta: at('.lb-meta') };
  });
  truthy(order && order.title >= 0 && order.title < order.impact,
    'the callout sits below the headline');
  truthy(order && order.impact < order.body, 'the narrative sits below the callout');
  truthy(order && order.body < order.meta, 'the meta line sits below the narrative');

  const meta = await page.textContent('.lb-meta');
  truthy(meta.includes('MATCHUP RECAP'), 'the meta line carries the category');
  truthy(meta.includes('FFU News Desk'), 'the meta line credits the author');
  truthy((await page.textContent('.lb-kicker')).includes('Matchup Recap'),
    'the category badge replaces the generic type label on the kicker');

  /* ---- 3. SAFETY: markup in the body is escaped, never injected ------- */
  expect(await page.evaluate(() => window.__lbInjected === 1), false, 'an onerror/script payload in the body did not execute');
  expect(await page.locator('.lb-md img').count(), 0, 'an <img> in the body is not rendered as an element');
  expect(await page.locator('.lb-md script').count(), 0, 'a <script> in the body is not rendered as an element');
  truthy((await page.textContent('.lb-md')).includes('<img src=x'), 'the raw markup is shown as text instead');
  // The callout gets the same proof: it is escaped, and it is not markdown.
  expect(await page.locator('.lb-impact img').count(), 0, 'an <img> in the callout is not rendered as an element');
  truthy((await page.textContent('.lb-impact-text')).includes('<img src=x'),
    'raw markup in the callout is shown as text');

  /* ---- 4. CHIPS ------------------------------------------------------ */
  expect(await page.locator('.lb-chip').count(), 5, 'one chip per tracked player');
  truthy((await page.textContent('.lb-chips-head')).includes('5 PLAYERS TRACKED'), 'the chip header counts the tracked players');

  await page.locator('.lb-chip', { hasText: 'Monday Back' }).first().click();
  await page.waitForTimeout(300);
  expect(await page.getAttribute('#lbPlayerSheet', 'data-open'), 'true', 'tapping a chip opens the player sheet');
  expect(await page.textContent('#lbSheetName'), 'Monday Back', 'the sheet names the tapped player');
  truthy((await page.textContent('#lbSheetTeam')).includes('Ridgeback FC'), 'the sheet names his fantasy team');
  const stats = await page.textContent('#lbSheetStats');
  truthy(stats.includes('20'), 'the sheet quotes his points');
  truthy(stats.includes('-14'), 'the sheet quotes the margin before his game');
  truthy(stats.includes('+6'), 'the sheet quotes the final margin');
  truthy((await page.textContent('#lbSheetVerdict')).includes('Won the matchup'), 'a GAME_WINNER reads as having won it');

  await page.click('#lbSheetClose');
  await page.waitForTimeout(250);
  expect(await page.getAttribute('#lbPlayerSheet', 'data-open'), 'false', 'the sheet closes');

  /* ---- 5. FRAMING: the outcome contract survives into the app -------- */
  await page.locator('.lb-chip', { hasText: 'Night Monster' }).first().click();
  await page.waitForTimeout(300);
  const wasted = await page.textContent('#lbSheetVerdict');
  truthy(wasted.includes('wasted'), 'a VALIANT_LOSS reads as a wasted monster game');
  truthy(!/hero|game-saver|saved the/i.test(wasted), 'a VALIANT_LOSS is never framed as a hero');
  await page.click('#lbSheetClose');

  await page.locator('.lb-chip', { hasText: 'Late Padder' }).first().click();
  await page.waitForTimeout(300);
  const padding = await page.textContent('#lbSheetVerdict');
  truthy(padding.includes('stat-padding'), 'a GARBAGE_TIME_BLOWOUT reads as unneeded stat-padding');
  truthy(!/hero|game-saver|saved the/i.test(padding), 'a GARBAGE_TIME_BLOWOUT is never framed as a hero');
  await page.click('#lbSheetClose');

  await page.locator('.lb-chip', { hasText: 'Early Anchor' }).first().click();
  await page.waitForTimeout(300);
  const plain = await page.textContent('#lbSheetVerdict');
  truthy(plain.includes('No decisive swing'), 'an unflagged player claims no swing');
  truthy(!/hero|game-saver|saved the|won the matchup/i.test(plain), 'an unflagged player is never credited with the win');
  await page.click('#lbSheetClose');

  /* ---- 5b. LEGACY: a pre-three-tier article still paints ------------- */
  serveArticles = [LEGACY_ARTICLE];
  await page.evaluate(() => window.FSNLeagueArticles.refresh());
  await page.waitForTimeout(900);
  await page.evaluate(() => { window.FSNBridge.call('renderLeagueBlog'); });
  await page.waitForTimeout(600);

  expect(await page.getAttribute('#leagueBlogWrap', 'hidden'), null, 'a legacy article still shows the section');
  expect(await page.textContent('.lb-title'), 'Monday Sweat: Week 2',
    'a legacy headline falls back to the title');
  truthy((await page.textContent('.lb-md')).includes('legacy'), 'a legacy body falls back to content_markdown');
  expect(await page.locator('.lb-impact').count(), 0,
    'an article with no summary paints no callout rather than an empty band');
  truthy((await page.textContent('.lb-meta')).includes('MATCHUP RECAP'),
    'a legacy article gets the shelf its article type belongs to');
  truthy((await page.textContent('.lb-meta')).includes('FFU News Desk'),
    'a legacy article gets the default byline');

  /* ---- 5c. ACTIVE: the stand-in when this week has nothing ----------- */
  serveArticles = [];
  await page.evaluate(() => window.FSNLeagueArticles.refresh());
  await page.waitForTimeout(900);
  await page.evaluate(() => { window.FSNBridge.call('renderLeagueBlog'); });
  await page.waitForTimeout(600);

  expect(await page.getAttribute('#leagueBlogWrap', 'hidden'), null,
    'ACTIVE: a week with nothing of its own no longer hides the section');
  expect(await page.textContent('.lb-title'), 'Cobalt Kings Open On A Thin Bench',
    'the active feed paints its own headline');
  truthy((await page.textContent('.lb-impact-text')).includes('not enough for Cobalt Kings'),
    'the active feed paints tier 2 in the callout');
  truthy((await page.textContent('.lb-md')).includes('active'),
    'the active feed paints tier 3 as markdown');
  expect(await page.locator('.lb-md strong').first().textContent(), 'active',
    'the markdown subset applies to the active feed too');
  truthy((await page.textContent('.lb-meta')).includes('WAIVER WIRE'),
    'the active feed carries its own category');
  truthy((await page.textContent('#leagueBlogState')).includes('LATEST'),
    'the header says LATEST so the reader knows it is not this week');
  truthy((await page.textContent('.lb-kicker')).includes('WEEK 1'),
    'the card names the week the story actually belongs to');
  expect(await page.locator('.lb-chip').count(), 1, 'the active feed keeps its tracked-player chips');

  /* A tap still opens the sheet from the active feed's own row. */
  await page.locator('.lb-chip', { hasText: 'Sunday Wideout' }).first().click();
  await page.waitForTimeout(300);
  expect(await page.textContent('#lbSheetName'), 'Sunday Wideout', 'a chip on an active-feed card opens its own row');
  truthy((await page.textContent('#lbSheetVerdict')).includes('wasted'), 'and the outcome contract holds there too');
  await page.click('#lbSheetClose');
  await page.waitForTimeout(250);

  /* ---- 5d. GATE: the active feed stays out of another season --------- */
  const activeBeforeGate = activeRequests().length;
  await page.evaluate(() => {
    document.getElementById('seasonYear').value = '2019';
    window.FSNBridge.call('renderLeagueBlog');
  });
  await page.waitForTimeout(600);
  expect(await page.getAttribute('#leagueBlogWrap', 'hidden') !== null, true,
    'GATE: a retro season view paints no active coverage');
  expect(activeRequests().length, activeBeforeGate,
    'and does not even ask for it');

  await page.evaluate(() => {
    document.getElementById('seasonYear').value = '2026';
    window.FSNBridge.call('renderLeagueBlog');
  });
  await page.waitForTimeout(600);
  truthy((await page.textContent('#leagueBlogState')).includes('LATEST'),
    'returning to the live season brings the active coverage back');

  /* Back to the three-tier fixture for the cache and refresh checks. */
  serveArticles = [ARTICLE];
  await page.evaluate(() => window.FSNLeagueArticles.refresh());
  await page.waitForTimeout(900);
  await page.evaluate(() => { window.FSNBridge.call('renderLeagueBlog'); });
  await page.waitForTimeout(600);
  expect(await page.locator('.lb-chip').count(), 5, 'the three-tier fixture is back on screen');

  /* ---- 6. CACHE ------------------------------------------------------ */
  const before = requests.length;
  await page.evaluate(() => { window.FSNBridge.call('renderLeagueBlog'); });
  await page.waitForTimeout(500);
  expect(requests.length, before, 'a repaint inside the freshness window serves from cache');
  expect(await page.locator('.lb-chip').count(), 5, 'the cached repaint still shows the chips');

  /* ---- 7. REFRESH ---------------------------------------------------- */
  const weekBefore = weekRequests().length;
  const activeBefore = activeRequests().length;
  await page.click('#leagueBlogRefresh');
  await page.waitForTimeout(1200);
  truthy(weekRequests().length > weekBefore, 'the refresh control forces a new week-scoped read');
  /* Both feeds, or the reader gets fresh copy in one slot and this morning's
     in the other. */
  truthy(activeRequests().length > activeBefore, 'the refresh control forces a new active read');

  /* ---- 8. CLEAN ------------------------------------------------------ */
  const snag = await page.evaluate(() => document.body.innerText.includes('hit a snag'));
  expect(snag, false, 'no "hit a snag" text anywhere on the page');
  expect(pageErrors.length, 0, 'zero uncaught page errors' + (pageErrors.length ? ': ' + pageErrors.join(' | ') : ''));
  expect(consoleErrors.length, 0, 'zero tagged console errors' + (consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''));
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? '\n[league-blog-check] FAILED' : '\n[league-blog-check] clean');
process.exit(failures ? 1 : 0);
