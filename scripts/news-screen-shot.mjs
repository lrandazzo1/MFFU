#!/usr/bin/env node
/* ============================================================================
   FSN — NEWS SCREEN SCREENSHOT

   `node scripts/news-screen-shot.mjs [--out FILE] [--league-id ID]`

   Boots the real index.html in Chromium against a stubbed /api/blog/articles,
   seeds a synthetic league, opens the News tab and writes a PNG of the screen
   with a three-tier article on it.

   This is a LOOK, not a check — scripts/league-blog-check.mjs is the check. It
   exists so a change to the League Blog card can be seen rather than inferred
   from assertions, and so the layout can be reviewed on a phone-width viewport
   without a device.

   The article it serves is a fixture, clearly marked as such below. It is not
   read from anyone's league and it is never written anywhere.
============================================================================ */

import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function arg(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}
const outFile = resolve(arg('out', join(root, 'news-screen.png')));

/* --payload FILE serves a real article payload instead of the fixture below,
   for looking at a story the pipeline actually published. The file is one
   article object, the shape /api/blog/articles returns. */
const payloadFile = arg('payload', '');
const weekArg = Number(arg('week', '')) || null;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/* THE FIXTURE. A tuesday_verdict as the pipeline composes one: the headline,
   the impact summary the outcome flags produced, the markdown body, and the
   tracked players the math flagged. */
const ARTICLE = {
  slug: '2026-week-3-tuesday-verdict-demo',
  headline: 'Ridgeback FC Survive The Late Window',
  match_impact_summary: 'Bijan Robinson scored 24.8 points, just enough for Ridgeback FC.',
  content: [
    '# Tuesday Verdict: Week 3',
    '',
    'The week 3 performances the math says **actually** moved a matchup.',
    '',
    '## What the math says',
    '',
    '- Bijan Robinson won the matchup for Ridgeback FC. They trailed by 18.4 before his game and finished 6.4 clear, and his 24.8 covered the whole deficit.',
    '- Puka Nacua went for 31.2 and Ninth Street lost anyway, by 9.1. A monster game, wasted.',
    '- Copper Ridge led by 12.2 before Kyren Williams played, then lost by 8.4. He finished on 3.1 against a 16.0 point projection, and that gap is the matchup.',
    '',
    '## Not called',
    '',
    'One lineup spot could not be placed in time against the scoreboard, so no swing is claimed for it.',
  ].join('\n'),
  category: 'Matchup Recap',
  author: 'FSN News Desk',
  article_type: 'tuesday_verdict',
  season: 2026,
  week: 3,
  published_at: '2026-09-22T13:00:00.000Z',
  tracked_players: [
    { player_id: 'p1', player_name: 'Bijan Robinson', owner_team: 'Ridgeback FC', opponent_team: 'Cobalt Kings',
      outcome_flag: 'GAME_WINNER', player_points: 24.8, projected_points: 17.2, entering_margin: -18.4, final_margin: 6.4, slot: 'MNF' },
    { player_id: 'p2', player_name: 'Puka Nacua', owner_team: 'Ninth Street', opponent_team: 'Gulf Current',
      outcome_flag: 'VALIANT_LOSS', player_points: 31.2, projected_points: 15.6, entering_margin: -24.1, final_margin: -9.1, slot: 'SNF' },
    { player_id: 'p3', player_name: 'Kyren Williams', owner_team: 'Copper Ridge', opponent_team: 'Iron Lantern',
      outcome_flag: 'DUD_COST_WIN', player_points: 3.1, projected_points: 16.0, entering_margin: 12.2, final_margin: -8.4, slot: 'MNF' },
  ],
};

const SERVED = payloadFile
  ? JSON.parse(readFileSync(resolve(payloadFile), 'utf8'))
  : null;

function startServer() {
  return new Promise((done) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/blog/articles') {
        const active = url.searchParams.get('active') === '1';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const article = SERVED || ARTICLE;
        res.end(JSON.stringify({
          league_id: url.searchParams.get('league_id'), active, count: 1, articles: [article],
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
    server.listen(0, '127.0.0.1', () => done(server));
  });
}

/* The same minimal ESPN-shaped league scripts/league-blog-check.mjs uses, on
   week 3 so the article's own week is the one on screen. */
function syntheticLeague() {
  const team = (id, name, pf, pa) => ({
    id, abbrev: name.slice(0, 3).toUpperCase(), name, location: name, nickname: '',
    primaryOwner: '{OWNER-' + id + '}', owners: ['{OWNER-' + id + '}'], playoffSeed: id, points: pf,
    record: { overall: { wins: 2, losses: 1, ties: 0, pointsFor: pf, pointsAgainst: pa } },
  });
  const player = (id, name, posId, points) => ({
    id, fullName: name, defaultPositionId: posId, proTeamId: 1, injuryStatus: 'ACTIVE',
    stats: [{ scoringPeriodId: 3, statSourceId: 0, statSplitTypeId: 1, appliedTotal: points, stats: {} }],
  });
  const entry = (slotId, p, points) => ({
    lineupSlotId: slotId, appliedStatTotal: points,
    playerPoolEntry: { id: p.id, appliedStatTotal: points, player: p },
  });
  const side = (teamId, entries, total) => ({ teamId, totalPoints: total, rosterForCurrentScoringPeriod: { entries } });
  const game = (id, period, winner, home, away) => ({
    id, matchupPeriodId: period, scoringPeriodId: period, playoffTierType: 'NONE', winner, home, away,
  });
  const wk = weekArg || (SERVED && Number(SERVED.week)) || 3;
  return {
    id: 311594,
    seasonId: 2026,
    scoringPeriodId: wk,
    status: { currentMatchupPeriod: wk, latestScoringPeriod: wk, finalScoringPeriod: 17, isActive: true },
    settings: { name: 'Ridgeback Invitational', scoringSettings: {}, scheduleSettings: { matchupPeriodCount: 14 } },
    teams: [team(1, 'Ridgeback FC', 342, 310), team(2, 'Cobalt Kings', 318, 330)],
    members: [{ id: '{OWNER-1}', firstName: 'Alpha', lastName: 'One' }, { id: '{OWNER-2}', firstName: 'Bravo', lastName: 'Two' }],
    schedule: [
      game(1, 1, 'HOME', side(1, [entry(2, player(101, 'Bijan Robinson', 2, 24.8), 24.8)], 121.4),
        side(2, [entry(2, player(102, 'Puka Nacua', 3, 31.2), 31.2)], 98.2)),
      game(2, 2, 'HOME', side(1, [entry(2, player(101, 'Bijan Robinson', 2, 18.2), 18.2)], 112.6),
        side(2, [entry(2, player(102, 'Puka Nacua', 3, 22.4), 22.4)], 104.8)),
      game(3, wk, 'UNDECIDED', side(1, [entry(2, player(101, 'Bijan Robinson', 2, 24.8), 24.8)], 108.2),
        side(2, [entry(2, player(102, 'Puka Nacua', 3, 31.2), 31.2)], 101.8)),
    ],
  };
}

function resolveChromium() {
  const override = String(process.env.FSN_CHROMIUM_PATH || '').trim();
  if (override) return override;
  const dir = String(process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers');
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .filter((name) => name.startsWith('chromium')).sort().reverse()
    .flatMap((name) => [join(dir, name, 'chrome-linux', 'chrome'), join(dir, name, 'chrome-linux', 'headless_shell')])
    .find((file) => existsSync(file)) || null;
}

const executablePath = resolveChromium();
if (!executablePath) {
  console.error('[news-screen-shot] no Chromium under ' + (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'));
  process.exit(1);
}

const server = await startServer();
const base = 'http://127.0.0.1:' + server.address().port + '/';
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 414, height: 1100 }, deviceScaleFactor: 2 });

const problems = [];
page.on('pageerror', (err) => problems.push('pageerror: ' + (err && err.message)));
page.on('console', (msg) => {
  if (msg.type() === 'error' && /\[(FSN|NewsDesk|LeagueBlog)/.test(msg.text())) problems.push('console: ' + msg.text());
});

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__fsnRender === 'function' &&
    !!(window.LeagueData && window.LeagueData.setEspnData) && !!window.FSNSupabaseArticles, null, { timeout: 20000 });

  await page.evaluate((data) => { window.LeagueData.setEspnData(data); window.__fsnRender(); }, syntheticLeague());
  await page.waitForTimeout(700);
  if (await page.getAttribute('#profilePicker', 'data-open') === 'true') {
    await page.click('#profileGuest'); await page.waitForTimeout(400);
  }
  if (await page.getAttribute('#ftuModal', 'data-open') === 'true') {
    await page.click('#ftuSkip'); await page.waitForTimeout(400);
  }

  await page.click('#tabBar .tab-btn[data-tab="news"]');
  await page.waitForTimeout(1400);
  await page.waitForSelector('.lb-card', { timeout: 10000 });

  mkdirSync(dirname(outFile), { recursive: true });

  /* The tab bar is a fixed overlay, so an element screenshot composites it
     over the bottom of the section and clips the tracked-player chips. It is
     not part of the section, so it is hidden for the capture and restored
     after: this is a picture of the card, not of the screen chrome. */
  await page.addStyleTag({ content: '#tabBar{visibility:hidden !important}' });
  await page.waitForTimeout(150);

  const wrap = await page.$('#leagueBlogWrap');
  await wrap.screenshot({ path: outFile });

  const headline = await page.textContent('.lb-title');
  const impact = (await page.locator('.lb-impact-text').count())
    ? await page.textContent('.lb-impact-text')
    : '(no callout: this article carries no match_impact_summary)';
  const meta = (await page.textContent('.lb-meta')).replace(/\s+/g, ' ').trim();
  const state = (await page.textContent('#leagueBlogState')).trim();

  console.log('[news-screen-shot] wrote ' + outFile);
  console.log('  header label  ' + JSON.stringify(state));
  console.log('  tier 1        ' + JSON.stringify(headline));
  console.log('  tier 2        ' + JSON.stringify(impact));
  console.log('  tier 3        ' + (await page.locator('.lb-md p, .lb-md li, .lb-md h2').count()) + ' rendered markdown nodes');
  console.log('  meta          ' + JSON.stringify(meta));
  console.log('  chips         ' + (await page.locator('.lb-chip').count()));
  if (problems.length) {
    console.log('\n[news-screen-shot] PROBLEMS:');
    for (const problem of problems) console.log('  ' + problem);
  } else {
    console.log('  clean         zero page errors, zero tagged console errors');
  }
} finally {
  await browser.close();
  server.close();
}
