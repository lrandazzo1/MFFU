#!/usr/bin/env node
/* ============================================================================
   FSN — STUDIO SHARED-EPISODE CHECK

   `node scripts/studio-episode-check.mjs`

   index.html has no build step and no test suite, so CLAUDE.md makes a headless
   render the non-negotiable half of verifying a change to a script block. This
   is that render for the two Studio behaviours that have no other coverage:

     1. GENERATION LOCK — an archived season and a completed week of the live
        season both leave GENERATE WEEKLY RECAP disabled (not hidden) beside the
        note "Historical weeks and past seasons cannot generate new podcasts.",
        while the CURRENT week is still generatable.

     2. SHARED EPISODE RETRIEVAL — the invite-link / second-device path. The
        lookup must survive a league context that is still arriving (no share
        token yet at mount), adopt the returned audio_url and script the moment
        cloud sync resolves, and report an HTTP refusal in the endpoint's own
        words rather than the generic "Could not check the shared episode."

   The Studio screen is driven through window.__fsnRender() and real DOM clicks
   dispatched inside the page rather than Playwright's own pointer path: the
   app's fixed overlays intercept synthetic pointer events at phone width, which
   is a harness problem, not a rendering one.

   Exit code 0 means clean.
============================================================================ */

import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const LOCK_MESSAGE = 'Historical weeks and past seasons cannot generate new podcasts.';
const LEAGUE_ID = '778899';
const SHARE_TOKEN = 'T'.repeat(43);
const AUDIO_URL = 'https://example.test/podcast-episodes/' + LEAGUE_ID + '/2026/5.mp3';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      /* The one route the client boots against. `configured:false` is the honest
         answer for a local run with no APNs or VAPID keys. */
      if (url.pathname.startsWith('/api/notifications')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ configured: false, apns: false, web: false, groups: [] }));
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found in this harness' }));
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

/* A structurally real ESPN-shaped payload sitting on week 5, so weeks 1-4 are
   genuinely completed history and week 5 is the live board. */
function syntheticLeague() {
  const team = (id, abbrev, name, wins, losses, pf, pa) => ({
    id, abbrev, name, location: name, nickname: '',
    owners: ['{OWNER-' + id + '}'], playoffSeed: id, points: pf,
    record: { overall: { wins, losses, ties: 0, pointsFor: pf, pointsAgainst: pa } },
  });
  const matchup = (id, homeId, awayId, homeScore, awayScore, period) => ({
    id, matchupPeriodId: period, playoffTierType: 'NONE',
    winner: homeScore > awayScore ? 'HOME' : 'AWAY',
    home: { teamId: homeId, totalPoints: homeScore, pointsByScoringPeriod: { [period]: homeScore } },
    away: { teamId: awayId, totalPoints: awayScore, pointsByScoringPeriod: { [period]: awayScore } },
  });
  const schedule = [];
  for (let period = 1; period <= 5; period += 1) {
    schedule.push(matchup(period * 2 - 1, 1, 4, 120 + period, 90 + period, period));
    schedule.push(matchup(period * 2, 2, 3, 105 + period, 101 + period, period));
  }
  return {
    id: Number(LEAGUE_ID),
    seasonId: 2026,
    scoringPeriodId: 5,
    status: { currentMatchupPeriod: 5, latestScoringPeriod: 5, finalScoringPeriod: 17, isActive: true },
    settings: {
      name: 'Studio Check League', size: 4,
      scheduleSettings: { matchupPeriodCount: 14, playoffTeamCount: 4 },
    },
    members: [1, 2, 3, 4].map((i) => ({
      id: '{OWNER-' + i + '}', displayName: 'Manager ' + i,
      firstName: 'Manager', lastName: String(i),
    })),
    teams: [
      team(1, 'AAA', 'Alpha', 4, 1, 601.5, 470.2),
      team(2, 'BBB', 'Bravo', 3, 2, 540.1, 515.7),
      team(3, 'CCC', 'Charlie', 2, 3, 515.4, 540.9),
      team(4, 'DDD', 'Delta', 1, 4, 468.0, 598.2),
    ],
    schedule,
  };
}

/* The same league as of a given season. A past season is closed: ESPN reports it
   inactive and sitting on its final scoring period. */
function seasonLeague(year) {
  const league = syntheticLeague();
  if (year === 2026) return league;
  league.seasonId = year;
  league.season = year;
  league.scoringPeriodId = 17;
  league.status = {
    currentMatchupPeriod: 17, latestScoringPeriod: 17,
    finalScoringPeriod: 17, isActive: false,
  };
  return league;
}

function episodePayload(week) {
  return {
    status: 'ready',
    audioUrl: AUDIO_URL,
    episode: {
      title: 'WEEK ' + week + ' RECAP',
      week, year: 2026, leagueId: LEAGUE_ID,
      lines: [
        { host: 'DAN', text: 'Alpha closed out week ' + week + ' on top of the board.' },
        { host: 'STU', text: 'Delta has answers to find before the next slate arrives.' },
      ],
      stories: ['Alpha 125-95 Delta', 'Bravo 110-106 Charlie'],
      visuals: [], markers: [7.5], createdAt: Date.now(),
    },
  };
}

function resolveChromium() {
  const override = String(process.env.FSN_CHROMIUM_PATH || '').trim();
  if (override) return override;
  const dir = String(process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers');
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .filter((name) => name.startsWith('chromium'))
    .sort().reverse()
    .flatMap((name) => [
      join(dir, name, 'chrome-linux', 'chrome'),
      join(dir, name, 'chrome-linux', 'headless_shell'),
    ])
    .find((file) => existsSync(file)) || null;
}

/* ---- the SQL half: the policy the invite-link read depends on ------------- */
let failed = false;
const fail = (message) => { failed = true; console.error('  FAIL  ' + message); };
const pass = (message) => console.log('  ok    ' + message);

const sqlRaw = readFileSync(join(root, 'supabase', 'podcast_episodes.sql'), 'utf8');
/* Statements only. The file's own comments discuss the policy shapes it avoids,
   and matching those would make every assertion below read the prose instead of
   the SQL. */
const sql = sqlRaw.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
if (/create\s+policy\s+podcast_episodes_share_token_select[\s\S]*?for\s+select/i.test(sql))
  pass('podcast_episodes.sql declares an explicit SELECT policy');
else fail('podcast_episodes.sql has no explicit SELECT policy for shared reads');
if (/grant\s+select\s+on\s+public\.podcast_episodes\s+to\s+anon,\s*authenticated/i.test(sql))
  pass('anon/authenticated hold the SELECT table privilege the policy needs');
else fail('podcast_episodes.sql grants no SELECT privilege, so the policy can never apply');
if (/x-league-token/i.test(sql))
  pass('the SELECT policy is keyed on the per-league share token');
else fail('the SELECT policy does not read the share token; a league id alone is public');
if (/using\s*\(\s*true\s*\)/i.test(sql))
  fail('podcast_episodes.sql contains a blanket `using (true)` read policy');
else pass('no blanket read policy — episodes are not readable by league id alone');

const executablePath = resolveChromium();
if (!executablePath) {
  console.error('[studio-episode-check] no Chromium binary found under ' +
    (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') + '. Set FSN_CHROMIUM_PATH.');
  process.exit(1);
}
console.log('[studio-episode-check] chromium: ' + executablePath);

const server = await startServer();
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });

/* The shared-episode endpoint, answered from here so each scenario can change
   what the league's week looks like without restarting the app. */
let reply = { status: 200, body: { status: 'missing' } };
const requests = [];
/* The ESPN relay, so switching seasons is a real season load rather than a 404
   the app correctly reports as a relay failure. Each season gets the same
   synthetic league stamped with that year. */
await page.route('**/api/espn*', async (route) => {
  const target = new URL(route.request().url()).searchParams.get('url') || '';
  const year = Number((target.match(/\/seasons\/(\d{4})\//) || [])[1]) || 2026;
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(seasonLeague(year)),
  });
});
await page.route('**/api/generate-podcast*', async (route) => {
  const request = route.request();
  requests.push({
    url: request.url(),
    method: request.method(),
    token: request.headers()['x-league-token'] || '',
  });
  await route.fulfill({
    status: reply.status,
    contentType: 'application/json',
    body: JSON.stringify(reply.body),
  });
});

/* Onboarding only. Deliberately NOT fsn_saved_league_id: that makes boot
   rehydrate the league over the relay stub, and its multi-week walk lands
   minutes later — resetting #seasonYear and #weekNum through
   applyLiveLeaguePayload() in the middle of whichever scenario is running. This
   check seeds the league itself, synchronously, the way render-check does. */
await page.addInitScript(() => {
  try { window.localStorage.setItem('hasCompletedOnboarding', 'true'); }
  catch (err) { /* private mode */ }
});

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (err) => pageErrors.push(String((err && err.stack) || err)));
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  /* Only this app's own tagged errors. [Podcast] refusals this check provokes
     on purpose are filtered by the scenario that provokes them. */
  if (/\[(FSN|NewsDesk|Standings|Matchups|League Share|Podcast)/.test(text)) consoleErrors.push(text);
});

/* The Studio screen, as the app itself paints it. */
const studio = () => page.evaluate(() => {
  const el = (id) => document.getElementById(id);
  const note = el('studioArchiveLock');
  const button = el('studioGenerate');
  return {
    buttonLabel: (button.textContent || '').trim(),
    buttonDisabled: !!button.disabled,
    buttonHidden: !!button.hidden,
    noteHidden: !!note.hidden,
    noteText: (note.textContent || '').trim(),
    status: (el('studioStatus').textContent || '').trim(),
    title: (el('studioTitle').textContent || '').trim(),
    audioSrc: el('studioAudio').getAttribute('src') || '',
    playDisabled: !!el('studioPlay').disabled,
    feed: (el('studioFeed').innerText || '').trim(),
    week: (el('weekNum').value || '').trim(),
    season: (el('seasonYear').value || '').trim(),
  };
});

const openStudio = () => page.evaluate(() => {
  const tab = document.querySelector('#tabBar .tab-btn[data-tab="studio"]');
  if (tab) tab.click();
});

const stepWeek = (delta) => page.evaluate((d) => {
  const btn = document.querySelector('.screen[data-active="true"] [data-week-nav="' + d + '"]') ||
    document.querySelector('[data-week-nav="' + d + '"]:not([disabled])');
  if (!btn) throw new Error('no enabled week-nav control for delta ' + d);
  btn.click();
}, String(delta));

try {
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  /* ---- seed the league on week 5, with NO share token yet ---------------- */
  await page.evaluate((data) => {
    document.getElementById('leagueIdInput').value = String(data.id);
    window.LeagueData.setEspnData(data);
    window.__fsnRender();
  }, syntheticLeague());
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const picker = document.getElementById('profilePicker');
    if (picker && picker.dataset.open === 'true') document.getElementById('profileGuest').click();
  });
  await page.waitForTimeout(400);
  pass('seeded a synthetic league sitting on week 5');

  /* ======================================================================
     1. LEAGUE CONTEXT STILL ARRIVING — no token at mount
     ====================================================================== */
  await openStudio();
  await page.waitForTimeout(300);
  if (requests.length === 0) pass('no lookup is attempted while this browser holds no share token');
  else fail('the lookup fired ' + requests.length + ' time(s) with no share token to send');

  /* The one fast retry, then the honest standing message. */
  await page.waitForTimeout(1800);
  let view = await studio();
  if (/Setup/.test(view.status) && view.status.length > 10)
    pass('a missing share token is named in the status line: "' + view.status + '"');
  else fail('a missing share token left the status line at "' + view.status + '"');
  if (!/Could not check the shared episode/.test(view.status))
    pass('the generic "Could not check the shared episode" line is not shown for a missing token');
  else fail('a missing token still reports "Could not check the shared episode"');

  /* ======================================================================
     2. CLOUD SYNC RESOLVES — the token lands, the episode must follow
     ====================================================================== */
  reply = { status: 200, body: episodePayload(5) };
  await page.evaluate(([league, token]) => {
    window.localStorage.setItem('fsn.league.token.v1:' + league, token);
  }, [LEAGUE_ID, SHARE_TOKEN]);

  /* No re-render and no tab switch: the standing poll installed above is what
     has to notice. This is the second-device case — the token arrives from the
     cloud hydrate long after Studio painted. */
  await page.waitForTimeout(16000);
  view = await studio();
  if (requests.length > 0) pass('the standing poll picked the lookup up once the token appeared');
  else fail('the lookup never ran after the share token arrived');
  if (requests.length && requests[requests.length - 1].token === SHARE_TOKEN)
    pass('the lookup sent the league share token');
  else fail('the lookup did not carry the share token');
  if (requests.length && new URL(requests[requests.length - 1].url).searchParams.get('leagueId') === LEAGUE_ID)
    pass('the lookup queried the connected league id, not a placeholder');
  else fail('the lookup queried leagueId=' +
    (requests.length ? new URL(requests[requests.length - 1].url).searchParams.get('leagueId') : '(none)'));

  if (view.audioSrc === AUDIO_URL) pass('the player adopted the returned audio_url');
  else fail('the player src is "' + view.audioSrc + '", expected the returned audio_url');
  if (!view.playDisabled) pass('the play button is enabled once the shared audio resolves');
  else fail('the play button stayed disabled over a ready shared episode');
  if (view.title === 'WEEK 5 RECAP') pass('the hero shows the shared episode title');
  else fail('the hero title is "' + view.title + '"');
  if (/Alpha closed out week 5/.test(view.feed) && /Delta has answers/.test(view.feed))
    pass('the returned script is rendered in the read-along feed');
  else fail('the returned script did not reach the feed');
  if (!/NO EPISODE YET/.test(view.feed)) pass('"NO EPISODE YET" is gone once the episode resolves');
  else fail('"NO EPISODE YET" is still rendered over a ready episode');
  if (view.buttonHidden) pass('GENERATE is hidden while an episode is ready to play');
  else fail('GENERATE is still offered over a ready episode');

  /* ======================================================================
     3. A COMPLETED WEEK OF THE LIVE SEASON
     ====================================================================== */
  reply = { status: 200, body: { status: 'missing' } };
  await stepWeek(-1);
  await page.waitForTimeout(900);
  view = await studio();
  if (view.week === '4') pass('stepped back to week 4 of the live season');
  else fail('expected to be on week 4, the scrubber says "' + view.week + '"');
  if (view.buttonDisabled) pass('GENERATE is disabled on a completed week');
  else fail('GENERATE is still enabled on a completed week');
  if (!view.buttonHidden) pass('GENERATE is disabled rather than hidden on a completed week');
  else fail('GENERATE is hidden on a completed week; it must be visible and disabled');
  if (!view.noteHidden && view.noteText === LOCK_MESSAGE)
    pass('the completed-week note reads exactly: ' + LOCK_MESSAGE);
  else fail('the completed-week note is ' + (view.noteHidden ? 'hidden' : '"' + view.noteText + '"'));

  /* A locked week still has to RETRIEVE its league's episode. */
  const before = requests.length;
  reply = { status: 200, body: episodePayload(4) };
  await page.waitForTimeout(16000);
  view = await studio();
  if (requests.length > before) pass('a completed week still polls for its shared episode');
  else fail('a completed week stopped looking for the episode its league generated');
  if (view.audioSrc === AUDIO_URL) pass("a completed week plays its league's shared episode");
  else fail('a completed week did not adopt its shared episode audio');

  /* ======================================================================
     4. AN ARCHIVED SEASON
     ====================================================================== */
  reply = { status: 200, body: { status: 'missing' } };
  const archivedBefore = requests.length;
  await page.evaluate(() => {
    const select = document.querySelector('[data-season-select]');
    if (!select) throw new Error('no season selector rendered');
    select.value = '2025';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  /* switchSeasonYear() is async: it drops the live payload, fetches the archived
     season through the relay and repaints. Read the screen after it settles. */
  await page.waitForTimeout(3000);
  await openStudio();
  await page.waitForTimeout(600);
  view = await studio();
  if (view.season === '2025') pass('switched to the 2025 archived season');
  else fail('expected season 2025, the picker says "' + view.season + '"');
  if (view.buttonDisabled) pass('GENERATE is disabled on an archived season');
  else fail('GENERATE is still enabled on an archived season');
  if (!view.buttonHidden) pass('GENERATE is disabled rather than hidden on an archived season');
  else fail('GENERATE is hidden on an archived season; it must be visible and disabled');
  if (!view.noteHidden && view.noteText === LOCK_MESSAGE)
    pass('the archived-season note reads exactly: ' + LOCK_MESSAGE);
  else fail('the archived-season note is ' + (view.noteHidden ? 'hidden' : '"' + view.noteText + '"'));

  await page.waitForTimeout(2500);
  if (requests.length === archivedBefore)
    pass('an archived season never calls the episode endpoint');
  else fail('an archived season made ' + (requests.length - archivedBefore) + ' episode request(s)');

  /* ======================================================================
     5. AN HTTP REFUSAL SPEAKS IN THE ENDPOINT'S OWN WORDS
     ====================================================================== */
  const refusal = 'Save or join this league with a valid invite before generating audio';
  reply = { status: 403, body: { error: refusal } };
  await page.evaluate(() => {
    const select = document.querySelector('[data-season-select]');
    select.value = '2026';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(3000);
  await openStudio();
  await page.waitForTimeout(2500);
  view = await studio();
  if (view.status === refusal) pass("a 403 is reported in the endpoint's own words");
  else fail('a 403 reported "' + view.status + '" instead of the endpoint\'s sentence');

  /* That refusal is a real failure and must be logged, tagged, with the error. */
  const logged = consoleErrors.filter((t) => /\[Podcast\].*HTTP 403/.test(t));
  if (logged.length) pass('the refusal is logged loudly as [Podcast] … HTTP 403');
  else fail('the HTTP 403 refusal was swallowed without a tagged console.error');

  /* ---- nothing threw, and nothing degraded into a snag ------------------- */
  const snag = await page.evaluate(() =>
    /hit a snag/i.test(document.querySelector('.screen[data-screen="studio"]').innerText));
  if (snag) fail('"hit a snag" rendered on the Studio screen');
  else pass('Studio rendered every scenario without degrading to a snag');

  if (pageErrors.length) fail('uncaught page errors:\n    ' + pageErrors.join('\n    '));
  else pass('zero uncaught page errors');

  /* Every [Podcast] error this run should contain is the 403 above. Anything
     else, and any other subsystem's tagged error, is a regression. */
  const unexpected = consoleErrors.filter((t) => !/\[Podcast\].*HTTP 403/.test(t));
  if (unexpected.length) fail('unexpected tagged console errors:\n    ' + unexpected.join('\n    '));
  else pass('zero unexpected [FSN*] / [Podcast] console errors');
} finally {
  await browser.close();
  server.close();
}

if (failed) {
  console.error('[studio-episode-check] FAILED');
  process.exit(1);
}
console.log('[studio-episode-check] generation lock and shared-episode retrieval clean');
