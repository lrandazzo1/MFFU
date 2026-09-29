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

        Every week coordinate here is the week the episode RECAPS, which is the
        week before the one on screen: the recap is filed the morning after the
        Monday night final, so it anchors the following week's feed exactly as
        tuesday_verdict does. The scrubber on week 5 therefore looks up week 4,
        and the lock reads week 4's slate. See studioRecapWeek() in index.html.

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

/* The jump-to-current control is only rendered while viewing a PAST week, so
   its absence means the scrubber is already on the live week — a no-op, not a
   failure. Returns whether it had to move. */
const jumpToCurrentWeek = () => page.evaluate(() => {
  const btn = document.querySelector('[data-week-current]');
  if (!btn) return false;
  btn.click();
  return true;
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
  reply = { status: 200, body: episodePayload(4) };
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
  if (view.title === 'WEEK 4 RECAP') pass('the hero shows the shared episode title');
  else fail('the hero title is "' + view.title + '"');
  if (/Alpha closed out week 4/.test(view.feed) && /Delta has answers/.test(view.feed))
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

  /* A locked week still has to RETRIEVE its league's episode — week 3's, which
     is what week 4's feed carries. */
  const before = requests.length;
  reply = { status: 200, body: episodePayload(3) };
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

  /* ======================================================================
     6. THE TEMPORARY TESTING EXCEPTION — league 57155288, week 2 only
     ====================================================================== */

  const TEST_LEAGUE = '57155288';
  const TEST_AUDIO = 'https://example.test/podcast-episodes/' + TEST_LEAGUE + '/2026/2.mp3';

  /* Re-seed as the exception league. The payload keeps week 5 as the live week,
     so weeks 1-4 are closed history and week 2 is a genuinely locked week for
     every league but this one. Week 2's recap lives on the WEEK 3 feed, so that
     is the screen the exception has to open. */
  const asLeague = async (id) => {
    const payload = syntheticLeague();
    payload.id = Number(id);
    await page.evaluate((args) => {
      document.getElementById('leagueIdInput').value = String(args.id);
      try { window.localStorage.setItem('fsn.league.token.v1:' + args.id, args.token); } catch (err) { /* private mode */ }
      window.LeagueData.setEspnData(args.payload);
      window.__fsnRender();
    }, { id: String(id), token: SHARE_TOKEN, payload });
    await page.waitForTimeout(600);
    /* A league switch does not move the scrubber, and week 1 has its back
       button disabled — so start each league from the live week. */
    await jumpToCurrentWeek();
    await page.waitForTimeout(500);
  };

  /* An episode exists for the exception week, so its archive card can be
     clicked. Answer week 2 ready and every other week missing. */
  await page.unroute('**/api/generate-podcast*');
  await page.route('**/api/generate-podcast*', async (route) => {
    const url = new URL(route.request().url());
    const week = url.searchParams.get('week');
    requests.push({ url: route.request().url(), method: route.request().method(),
      token: route.request().headers()['x-league-token'] || '' });
    const body = week === '2'
      ? { status: 'ready', audioUrl: TEST_AUDIO,
          episode: { title: 'WEEK 2 RECAP', week: 2, year: 2026, leagueId: TEST_LEAGUE,
            lines: [{ host: 'DAN', text: 'Segment one, the FSN Index movers for week two.' },
              { host: 'STU', text: 'And the teams that slid, Dan, which is the louder half.' }],
             stories: ['Segment one', 'Segment two'],
             visuals: [
               { key: 'editorial', headline: 'Unlinked pre-roll slide' },
               { key: 'editorial', headline: 'Unlinked panel two' },
               { key: 'editorial', headline: 'Unlinked panel three' },
               { key: 'editorial', headline: 'Unlinked panel four' },
             ],
             markers: [7.5],
             story_reel_markers: [
               { startMs: 0, endMs: 3500 },
               { startMs: 3500, endMs: 7500 },
               { startMs: 7500, endMs: 11000 },
             ], createdAt: Date.now() } }
      : { status: 'missing' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await asLeague(TEST_LEAGUE);
  await openStudio();
  await page.waitForTimeout(800);

  /* Walk back from the live week to the week 3 feed, which recaps week 2. */
  for (let i = 0; i < 2; i += 1) { await stepWeek(-1); await page.waitForTimeout(350); }
  await page.waitForTimeout(900);
  view = await studio();

  if (view.week === '3') pass("exception: stepped the test league to week 2's feed (week 3)");
  else fail('exception: expected week 3, the scrubber says "' + view.week + '"');

  if (!view.buttonDisabled || view.buttonHidden)
    pass('exception: GENERATE is available for league ' + TEST_LEAGUE + ' on week 2');
  else fail('exception: GENERATE is still disabled for league ' + TEST_LEAGUE + ' on week 2');

  if (!view.noteHidden && /Testing exception/.test(view.noteText))
    pass('exception: the note explains why a closed week is open: "' + view.noteText + '"');
  else fail('exception: the testing note is ' + (view.noteHidden ? 'hidden' : '"' + view.noteText + '"'));

  if (view.noteText !== LOCK_MESSAGE)
    pass('exception: the global lock message is not shown while the exception is active');
  else fail('exception: the note still shows the global lock message');

  /* ---- the archive card for the exception week ---- */
  const archive = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#studioArchive [data-studio-episode]')];
    return cards.map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim());
  });
  if (archive.some((t) => /Week 2/.test(t)))
    pass('exception: the week 2 episode appears in Episode Archives (' + archive.length + ' card(s))');
  else fail('exception: no week 2 card in Episode Archives; found: ' + JSON.stringify(archive));

  /* Move away from week 2, then click the card: it must load that week's audio,
     title and script into the player regardless of the week on screen. */
  await stepWeek(1);
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('#studioArchive [data-studio-episode]')]
      .find((c) => /Week 2/.test(c.innerText || ''));
    if (!card) throw new Error('no week 2 archive card to click');
    card.click();
  });
  await page.waitForTimeout(700);
  view = await studio();

  if (view.audioSrc === TEST_AUDIO) pass('exception: clicking the card loaded the week 2 audio url');
  else fail('exception: player src is "' + view.audioSrc + '", expected ' + TEST_AUDIO);
  if (view.title === 'WEEK 2 RECAP') pass('exception: clicking the card loaded the week 2 title');
  else fail('exception: hero title is "' + view.title + '"');
  if (/FSN Index movers for week two/.test(view.feed) && /louder half/.test(view.feed))
    pass('exception: clicking the card loaded the week 2 Script Read-Along');
  else fail('exception: the week 2 script did not reach the read-along feed');
  if (!view.playDisabled) pass('exception: the play button is enabled for the archived week 2 episode');
  else fail('exception: the play button stayed disabled for the archived episode');

  /* The visual list is deliberately longer than the stories and the marker
     list. Only the three timed segments may become cards. */
  const reel = () => page.evaluate(() => {
    const feed = document.getElementById('studioFeed');
    const card = feed.querySelector('.studio-reel');
    return {
      index: card ? Number(card.dataset.reelIndex) : -1,
      count: feed.querySelectorAll('.sv-seg').length,
      active: [...feed.querySelectorAll('.sv-seg')].findIndex((seg) => seg.dataset.state === 'active'),
      text: (card && card.innerText) || '',
      time: document.getElementById('studioAudio').currentTime,
    };
  });
  await page.evaluate(() => document.querySelector('[data-studio-tab="reels"]').click());
  let card = await reel();
  if (card.count === 3 && card.index === 0 && card.active === 0 &&
      /Segment one/i.test(card.text) && !/Unlinked pre-roll slide/i.test(card.text))
    pass('Reel starts on marker 0 with exactly one card slot per marker and no pre-roll slide');
  else fail('Reel initial marker/card mapping: ' + JSON.stringify(card));

  await page.waitForTimeout(7300);
  card = await reel();
  if (card.index === 0) pass('paused audio does not advance the timed card on a slideshow timer');
  else fail('paused Reel advanced to card ' + card.index + ' without audio');

  await page.evaluate(() => {
    const audio = document.getElementById('studioAudio');
    audio.currentTime = 3.6;
    audio.dispatchEvent(new Event('timeupdate'));
  });
  card = await reel();
  if (card.index === 1 && card.active === 1 && /Segment two/i.test(card.text))
    pass('audio position inside marker 1 paints card 1 directly');
  else fail('Reel did not follow marker 1: ' + JSON.stringify(card));

  await page.evaluate(() => document.querySelector('[data-studio-nav="next"]').click());
  card = await reel();
  if (card.index === 2 && card.active === 2 && /Story 3/i.test(card.text) &&
      Math.abs(card.time - 7.5) < 0.2)
    pass('next navigates to marker 2 and seeks paused audio to its exact start');
  else fail('Reel navigation did not seek to marker 2: ' + JSON.stringify(card));

  await page.evaluate(() => document.querySelector('[data-studio-tab="script"]').click());

  /* ---- the guardrail still holds everywhere else ---- */
  /* The scrubber only has -1 / +1 controls; there is no data-week-nav="-2". */
  await stepWeek(-1); await page.waitForTimeout(350);
  await stepWeek(-1);
  await page.waitForTimeout(800);
  view = await studio();
  if (view.week === '2' && view.buttonDisabled && view.noteText === LOCK_MESSAGE)
    pass('exception is week-scoped: week 1 of the same league is still locked');
  else fail('exception leaked to the week ' + view.week + ' feed of the test league (disabled=' +
    view.buttonDisabled + ', note="' + view.noteText + '")');

  /* Week 1's feed has no completed slate behind it, so it says so in its own
     words rather than calling week 1 a historical week. */
  await stepWeek(-1);
  await page.waitForTimeout(800);
  view = await studio();
  if (view.week === '1' && view.buttonDisabled && !view.noteHidden &&
      /first episode arrives on the Week 2 feed/i.test(view.noteText))
    pass("week 1's feed says the season's first recap lands on week 2");
  else fail('week 1 feed: week=' + view.week + ', disabled=' + view.buttonDisabled +
    ', note=' + (view.noteHidden ? '(hidden)' : '"' + view.noteText + '"'));
  if (/first recap lands on week 2/i.test(view.buttonLabel))
    pass("week 1's button says where the first recap lands: \"" + view.buttonLabel + '"');
  else fail('week 1 button reads "' + view.buttonLabel + '"');

  await asLeague('778899');
  await openStudio();
  await page.waitForTimeout(500);
  for (let i = 0; i < 2; i += 1) { await stepWeek(-1); await page.waitForTimeout(300); }
  await page.waitForTimeout(800);
  view = await studio();
  if (view.week === '3' && view.buttonDisabled && view.noteText === LOCK_MESSAGE)
    pass('exception is league-scoped: week 2 of another league is still locked');
  else fail("exception leaked to league 778899 on week 2's feed (week " + view.week + ', disabled=' +
    view.buttonDisabled + ', note="' + view.noteText + '")');

  /* ======================================================================
     7. THE RECAPPED WEEK, STILL BEING PLAYED

     The recap is a Tuesday-morning artefact: it narrates a finished week, and
     the scheduled run will not build one until every Sunday and Monday night box
     score is closed. So the button must not offer to mint one while the week it
     would recap is still open — it stands disabled, saying when it unlocks, and
     an earlier week's finished episode still plays beside it.

     On the anchored contract the week 5 feed recaps WEEK 4, so week 4 is the one
     left open here. Week 3 stays final and holds the episode week 4's feed
     carries.
     ====================================================================== */

  /* The same league with week 4's matchups left undecided: no winner and no
     roster detail, which is what an in-progress slate looks like. */
  const openWeekPayload = () => {
    const payload = syntheticLeague();
    payload.schedule = payload.schedule.map((game) => (
      game.matchupPeriodId === 4 ? { ...game, winner: 'UNDECIDED' } : game
    ));
    return payload;
  };

  await page.unroute('**/api/generate-podcast*');
  const podcastRequests = [];
  await page.route('**/api/generate-podcast*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    podcastRequests.push({ method: request.method(), week: url.searchParams.get('week') });
    const body = url.searchParams.get('week') === '3'
      ? episodePayload(3)
      : { status: 'missing' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  const seed = async (payload) => {
    await page.evaluate((args) => {
      document.getElementById('leagueIdInput').value = String(args.id);
      try { window.localStorage.setItem('fsn.league.token.v1:' + args.id, args.token); }
      catch (err) { /* private mode */ }
      window.LeagueData.setEspnData(args.payload);
      window.__fsnRender();
    }, { id: LEAGUE_ID, token: SHARE_TOKEN, payload });
    await page.waitForTimeout(700);
  };

  /* Move to the live week FIRST, then seed. selectWeek() ends in
     syncWeekPayload(), which re-applies that week from the app's own week cache
     — the all-final league every earlier scenario walked — so a payload seeded
     before the jump is replaced a tick later and the screen under assertion is
     not the one that was seeded. */
  await openStudio();
  await jumpToCurrentWeek();
  await page.waitForTimeout(900);
  await seed(openWeekPayload());
  await page.waitForTimeout(600);
  view = await studio();
  if (view.week === '5') pass('open week: the scrubber is on the live week 5');
  else fail('open week: expected week 5, the scrubber says "' + view.week + '"');
  if (view.buttonDisabled) pass('open week: GENERATE is disabled while the recapped week is still being played');
  else fail('open week: GENERATE is still enabled over a half-played week');
  if (!view.buttonHidden) pass('open week: the button is disabled rather than hidden');
  else fail('open week: the button vanished instead of saying when it unlocks');
  if (/weekly recap unlocks tuesday after mnf/i.test(view.buttonLabel))
    pass('open week: the button says when it unlocks: "' + view.buttonLabel + '"');
  else fail('open week: the button reads "' + view.buttonLabel + '"');
  if (!view.noteHidden && /unlocks tuesday morning/i.test(view.noteText))
    pass('open week: the note explains the rule: "' + view.noteText + '"');
  else fail('open week: the note is ' + (view.noteHidden ? 'hidden' : '"' + view.noteText + '"'));
  if (view.noteText !== LOCK_MESSAGE)
    pass('open week: an open week is not reported as history');
  else fail('open week: the note calls the live week a historical one');

  /* The lookup asked for the RECAPPED week, not the week on screen. That is the
     Tuesday-morning bug this contract exists to prevent: asking for week 5 while
     the cron files week 4 answered `missing` over an episode the league had. */
  if (podcastRequests.some((r) => r.week === '4'))
    pass("open week: the week 5 feed looked up week 4's episode");
  else fail('open week: no lookup for week 4; weeks asked for were ' +
    JSON.stringify(podcastRequests.map((r) => r.week)));

  /* Tapping it anyway must change nothing and cost nothing. */
  const postsBefore = podcastRequests.filter((r) => r.method === 'POST').length;
  await page.evaluate(() => document.getElementById('studioGenerate').click());
  await page.waitForTimeout(600);
  if (podcastRequests.filter((r) => r.method === 'POST').length === postsBefore)
    pass('open week: a tap on the disabled button posts nothing');
  else fail('open week: a mid-week tap reached the generation endpoint');

  /* ---- an earlier feed still PLAYS its episode, and generates nothing ---- */
  await stepWeek(-1);
  await page.waitForTimeout(16000);
  view = await studio();
  if (view.week === '4') pass("open week: stepped back to week 3's feed (week 4)");
  else fail('open week: expected week 4, the scrubber says "' + view.week + '"');
  if (view.audioSrc === AUDIO_URL) pass("open week: week 4's feed still plays week 3's episode");
  else fail('open week: the week 4 feed player src is "' + view.audioSrc + '"');
  if (!view.playDisabled) pass("open week: the play button is enabled for the stored week 3 episode");
  else fail('open week: the stored week 3 episode cannot be played');
  if (!podcastRequests.some((r) => r.method === 'POST'))
    pass('open week: replaying a past week re-triggered no generation');
  else fail('open week: selecting a past week POSTed to the generation endpoint');

  /* ---- and the moment the week closes, the button is offered again ---- */
  await jumpToCurrentWeek();
  await page.waitForTimeout(900);
  await seed(syntheticLeague());
  await page.waitForTimeout(600);
  view = await studio();
  if (view.week === '5') pass('closed week: back on the live week 5');
  else fail('closed week: expected week 5, the scrubber says "' + view.week + '"');
  if (!view.buttonDisabled && !view.buttonHidden)
    pass('closed week: GENERATE is offered once every box score for the recapped week is final');
  else fail('closed week: GENERATE is still ' + (view.buttonHidden ? 'hidden' : 'disabled') +
    ' after the week closed');
  if (view.buttonLabel === 'GENERATE WEEKLY RECAP')
    pass('closed week: the button is back to "GENERATE WEEKLY RECAP"');
  else fail('closed week: the button reads "' + view.buttonLabel + '"');
  if (view.noteHidden) pass('closed week: no lock note over a generatable week');
  else fail('closed week: the note still reads "' + view.noteText + '"');

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
