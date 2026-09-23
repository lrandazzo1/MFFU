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
     RENDER     a published article paints its title, its markdown (headings,
                bullets, bold) and its tracked-player chips
     SAFETY     markup inside content_markdown is escaped, never injected
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

const requests = [];
let serveArticles = [];

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/blog/articles') {
        requests.push({
          league_id: url.searchParams.get('league_id'),
          season: url.searchParams.get('season'),
          week: url.searchParams.get('week'),
          limit: url.searchParams.get('limit'),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: serveArticles.length, articles: serveArticles }));
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
  truthy(requests.length > 0, 'the endpoint was called (' + requests.length + ' request(s))');
  if (requests.length) {
    expect(requests[0].season, '2026', 'the read is scoped to the viewed season');
    expect(requests[0].week, '2', 'the read is scoped to the viewed week');
    truthy(requests[0].league_id && requests[0].league_id.length > 0, 'the read carries a league_id');
  }

  /* ---- 2. RENDER: a published article -------------------------------- */
  serveArticles = [ARTICLE];
  await page.evaluate(() => window.FSNLeagueArticles.refresh());
  await page.waitForTimeout(900);
  await page.evaluate(() => { window.FSNBridge.call('renderLeagueBlog'); });
  await page.waitForTimeout(600);

  expect(await page.getAttribute('#leagueBlogWrap', 'hidden'), null, 'the section is visible once an article publishes');
  expect(await page.textContent('.lb-title'), 'Tuesday Verdict: Week 2', 'the article title renders');
  expect(await page.locator('.lb-md h2').first().textContent(), 'What the math says', 'a markdown heading renders as a heading');
  expect(await page.locator('.lb-md li').count(), 2, 'markdown bullets render as list items');
  expect(await page.locator('.lb-md strong').first().textContent(), 'actually', 'markdown bold renders as strong');

  /* ---- 3. SAFETY: markup in the body is escaped, never injected ------- */
  expect(await page.evaluate(() => window.__lbInjected === 1), false, 'an onerror/script payload in the body did not execute');
  expect(await page.locator('.lb-md img').count(), 0, 'an <img> in the body is not rendered as an element');
  expect(await page.locator('.lb-md script').count(), 0, 'a <script> in the body is not rendered as an element');
  truthy((await page.textContent('.lb-md')).includes('<img src=x'), 'the raw markup is shown as text instead');

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

  /* ---- 6. CACHE ------------------------------------------------------ */
  const before = requests.length;
  await page.evaluate(() => { window.FSNBridge.call('renderLeagueBlog'); });
  await page.waitForTimeout(500);
  expect(requests.length, before, 'a repaint inside the freshness window serves from cache');
  expect(await page.locator('.lb-chip').count(), 5, 'the cached repaint still shows the chips');

  /* ---- 7. REFRESH ---------------------------------------------------- */
  await page.click('#leagueBlogRefresh');
  await page.waitForTimeout(900);
  truthy(requests.length > before, 'the refresh control forces a new read');

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
