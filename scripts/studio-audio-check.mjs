#!/usr/bin/env node
/* ============================================================================
   FSN — HEADLESS STUDIO AUDIO CHECK

   `node scripts/studio-audio-check.mjs`

   index.html has no build step and no test suite, so CLAUDE.md makes a headless
   render the second half of verifying a change. This one covers the Studio
   player specifically, because its two failure modes are invisible to the scope
   scan and to the whole-app render walk:

     1. An <audio> element whose src is assigned the empty string resolves it
        against the document URL. audio.src then reads back as index.html, the
        browser fetches the page and fails to decode it as MP3, and the reader
        gets an enabled Play button, a permanent 0:00 / 0:00 readout and
        "Could not play this episode on this device."
     2. Safari on iOS reports duration === Infinity for a ranged stream until it
        has buffered to the end, which produces the same 0:00 / 0:00 with a
        perfectly good episode loaded.

   The three scenarios below drive the real app against a stub
   /api/generate-podcast, asserting the empty player, a healthy episode and a
   broken episode URL in turn. Each scenario is a fresh page load, because the
   Studio only re-checks the shared episode when its league/week key changes.
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

const LEAGUE_ID = '999999';
const SEASON = 2026;
/* Matches LEAGUE_SHARE_TOKEN_RE in index.html, so the client actually sends
   the x-league-token header the Studio needs before it will look up audio. */
const SHARE_TOKEN = 'studio_audio_check_token_0123456789';

/* A real MPEG-1 Layer III stream: 44.1 kHz, 128 kbps, joint stereo, 417-byte
   constant-bitrate frames with silent granules. Built here rather than checked
   in so the fixture cannot drift from the format the podcast route uploads. */
function silentMp3(frames) {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0x64;
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}
const EPISODE_MP3 = silentMp3(200);
const EPISODE_SECONDS = 200 * 1152 / 44100;

/* Serves the repo, the notifications route the app boots against, a stub
   /api/generate-podcast whose answer each scenario sets, and the episode MP3
   itself — with the Accept-Ranges/CORS/Cache-Control headers Supabase Storage
   serves a public object with, so a ranged mobile request is exercised here
   rather than discovered on a phone. */
function startServer(state) {
  const requested = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      requested.push(url.pathname);

      if (url.pathname === '/api/notifications-register' || url.pathname === '/api/notifications') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ configured: false, apns: false, web: false, groups: [] }));
        return;
      }
      if (url.pathname === '/api/generate-podcast') {
        res.writeHead(state.podcastStatus || 200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(state.podcast));
        return;
      }
      if (url.pathname === '/missing-episode.mp3') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      if (url.pathname === '/episode.mp3') {
        const headers = {
          'Content-Type': 'audio/mpeg',
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=3600',
        };
        const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
        if (range) {
          const start = range[1] ? Number(range[1]) : 0;
          const end = range[2] ? Math.min(Number(range[2]), EPISODE_MP3.length - 1) : EPISODE_MP3.length - 1;
          const slice = EPISODE_MP3.subarray(start, end + 1);
          state.rangeRequests += 1;
          res.writeHead(206, { ...headers,
            'Content-Range': `bytes ${start}-${end}/${EPISODE_MP3.length}`,
            'Content-Length': String(slice.length) });
          res.end(slice);
          return;
        }
        res.writeHead(200, { ...headers, 'Content-Length': String(EPISODE_MP3.length) });
        res.end(EPISODE_MP3);
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
    server.listen(0, '127.0.0.1', () => resolve({ server, requested }));
  });
}

/* The same shape render-check.mjs seeds: four teams, two scored weeks. Enough
   for LeagueData.hasLive() and for the News Desk to have stories, which is what
   unlocks the Studio's generate path. */
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
  return {
    id: Number(LEAGUE_ID), seasonId: SEASON, scoringPeriodId: 2,
    status: { currentMatchupPeriod: 2, latestScoringPeriod: 2, finalScoringPeriod: 17, isActive: true },
    settings: { name: 'Studio Audio Check League', size: 4,
      scheduleSettings: { matchupPeriodCount: 14, playoffTeamCount: 4 } },
    members: [1, 2, 3, 4].map((i) => ({ id: '{OWNER-' + i + '}',
      displayName: 'Manager ' + i, firstName: 'Manager', lastName: String(i) })),
    teams: [
      team(1, 'AAA', 'Alpha', 2, 0, 240.5, 190.2),
      team(2, 'BBB', 'Bravo', 1, 1, 210.1, 205.7),
      team(3, 'CCC', 'Charlie', 1, 1, 205.4, 210.9),
      team(4, 'DDD', 'Delta', 0, 2, 188.0, 237.2),
    ],
    schedule: [
      matchup(1, 1, 4, 128.4, 92.1, 1), matchup(2, 2, 3, 105.6, 101.2, 1),
      matchup(3, 1, 3, 112.1, 104.2, 2), matchup(4, 2, 4, 104.5, 95.9, 2),
    ],
  };
}

function readyEpisode(audioUrl) {
  return {
    status: 'ready',
    audioUrl,
    episode: {
      title: 'Week 2 Recap', week: 2, year: SEASON, leagueId: LEAGUE_ID,
      stories: ['Alpha rolled Delta', 'Bravo edged Charlie'],
      lines: [
        { host: 'DAN', text: 'Week 2 on the FSN Desk. Alpha rolled Delta.' },
        { host: 'STU', text: 'Bravo edged Charlie by four and change.' },
      ],
      markers: [2.5, 5.2], visuals: [], createdAt: Date.now(),
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

const state = { podcast: { status: 'missing' }, podcastStatus: 200, rangeRequests: 0 };
const { server } = await startServer(state);
const base = 'http://127.0.0.1:' + server.address().port;

const executablePath = resolveChromium();
if (!executablePath) {
  console.error('[studio-audio-check] no Chromium under ' +
    (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') + '. Set FSN_CHROMIUM_PATH.');
  server.close();
  process.exit(1);
}
console.log('[studio-audio-check] chromium: ' + executablePath);

const browser = await chromium.launch({ executablePath, args: ['--mute-audio'] });

let failed = false;
const fail = (message) => { failed = true; console.error('  FAIL  ' + message); };
const pass = (message) => console.log('  ok    ' + message);

/* One scenario: a fresh page with the share token already stored, the league
   seeded, and the Studio tab opened so renderStudio reaches studioCheckShared. */
async function openStudio() {
  const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
  const pageErrors = [];
  const podcastErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String((err && err.stack) || err)));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (/\[Podcast\]/.test(msg.text())) podcastErrors.push(msg.text());
  });
  await page.addInitScript(([leagueId, token]) => {
    try {
      window.localStorage.setItem('hasCompletedOnboarding', 'true');
      window.localStorage.setItem('fsn.league.token.v1:' + leagueId, token);
    } catch (err) { /* private mode */ }
  }, [LEAGUE_ID, SHARE_TOKEN]);

  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  /* LeagueData.leagueId() reads #leagueIdInput first and only then its meta, so
     without this the Studio scopes itself to the 'league' placeholder and finds
     no share token to send. */
  await page.evaluate(([data, leagueId, season]) => {
    document.getElementById('leagueIdInput').value = leagueId;
    document.getElementById('seasonYear').value = String(season);
    window.LeagueData.setEspnData(data);
    window.LeagueData.setMeta('leagueId', leagueId);
    window.LeagueData.setMeta('season', String(season));
    window.__fsnRender();
  }, [syntheticLeague(), LEAGUE_ID, SEASON]);
  await page.waitForTimeout(700);
  if ((await page.getAttribute('#profilePicker', 'data-open')) === 'true') {
    await page.click('#profileGuest');
    await page.waitForTimeout(400);
  }
  /* The bottom tab bar is not hit-testable in this headless viewport (the home
     screen's own content sits over it, which render-check.mjs trips on too), so
     the tab is activated through the element rather than a synthetic tap. The
     Play button below IS hit-testable, and that is the control whose gesture
     handling this check is about. */
  await page.evaluate(() => document.querySelector('#tabBar .tab-btn[data-tab="studio"]').click());
  await page.waitForTimeout(1500);
  return { page, pageErrors, podcastErrors };
}

/* Everything the assertions below need, read in one pass so the player cannot
   change between reads. */
function playerState() {
  const audio = document.getElementById('studioAudio');
  return {
    hasSrcAttribute: audio.hasAttribute('src'),
    srcAttribute: audio.getAttribute('src') || '',
    currentSrc: audio.currentSrc || '',
    networkState: audio.networkState,
    readyState: audio.readyState,
    duration: audio.duration,
    paused: audio.paused,
    currentTime: audio.currentTime,
    errorCode: audio.error ? audio.error.code : null,
    playDisabled: document.getElementById('studioPlay').disabled,
    seekDisabled: document.getElementById('studioSeek').disabled,
    time: document.getElementById('studioTime').textContent,
    status: document.getElementById('studioStatus').textContent,
    title: document.getElementById('studioTitle').textContent,
  };
}

try {
  /* ---- 1. No episode for this week -------------------------------------- */
  console.log('\n[1] Studio with no generated episode');
  state.podcast = { status: 'missing' };
  {
    const { page, pageErrors, podcastErrors } = await openStudio();
    const before = await page.evaluate(playerState);

    if (before.hasSrcAttribute)
      fail('the audio element carries src="' + before.srcAttribute + '" with no episode loaded');
    else pass('no src attribute on the audio element');

    /* This is the whole bug: src="" resolves against the document, so currentSrc
       becomes the page and the browser decodes index.html as audio. */
    if (before.currentSrc)
      fail('currentSrc resolved to "' + before.currentSrc + '" — the empty src fell back to the document URL');
    else pass('currentSrc is empty (the page is not being loaded as audio)');
    if (before.networkState !== 0)
      fail('networkState is ' + before.networkState + ', expected 0 (NETWORK_EMPTY)');
    else pass('networkState is NETWORK_EMPTY');

    if (!before.playDisabled) fail('Play is enabled with no episode loaded');
    else pass('Play is disabled');
    if (!before.seekDisabled) fail('the seek bar is enabled with no episode loaded');
    else pass('seek bar is disabled');
    if (before.time !== '0:00 / 0:00') fail('expected 0:00 / 0:00, got "' + before.time + '"');
    else pass('readout is 0:00 / 0:00');
    if (!/no episode generated yet/i.test(before.status))
      fail('empty state not announced; status reads "' + before.status + '"');
    else pass('status announces the empty state: "' + before.status + '"');

    /* A disabled button cannot be clicked, so call the handler the way a stray
       programmatic click would and prove the guard holds rather than the
       playback failure message appearing. */
    await page.evaluate(() => document.getElementById('studioPlay').click());
    await page.waitForTimeout(400);
    const after = await page.evaluate(playerState);
    if (/could not play|unable to stream/i.test(after.status))
      fail('a click with no episode produced a playback error: "' + after.status + '"');
    else pass('clicking Play with no episode produces no playback error');
    if (after.currentSrc) fail('a click with no episode loaded "' + after.currentSrc + '"');
    else pass('clicking Play with no episode loads nothing');

    if (pageErrors.length) fail('uncaught page errors: ' + pageErrors.join(' | '));
    else pass('no uncaught page errors');
    if (podcastErrors.length) fail('[Podcast] console errors: ' + podcastErrors.join(' | '));
    else pass('no [Podcast] console errors');
    await page.close();
  }

  /* ---- 2. A real episode plays and reports its duration ------------------ */
  console.log('\n[2] Studio with a ready episode');
  state.podcast = readyEpisode(base + '/episode.mp3');
  state.rangeRequests = 0;
  {
    const { page, pageErrors, podcastErrors } = await openStudio();
    await page.waitForFunction(() => {
      const a = document.getElementById('studioAudio');
      return a.readyState >= 1 && Number.isFinite(a.duration) && a.duration > 0;
    }, null, { timeout: 15000 }).catch(() => {});
    const loaded = await page.evaluate(playerState);

    if (!loaded.hasSrcAttribute) fail('the episode URL was never applied to the audio element');
    else pass('src attribute is the episode URL');
    if (loaded.playDisabled) fail('Play is still disabled with a ready episode');
    else pass('Play is enabled');
    if (loaded.seekDisabled) fail('the seek bar is still disabled with a ready episode');
    else pass('seek bar is enabled');

    const shown = /(\d+):(\d\d)\s*\/\s*(\d+):(\d\d)/.exec(loaded.time);
    const shownDuration = shown ? Number(shown[3]) * 60 + Number(shown[4]) : 0;
    if (!shownDuration)
      fail('duration still reads "' + loaded.time + '" for a ' + EPISODE_SECONDS.toFixed(1) + 's episode');
    else if (Math.abs(shownDuration - EPISODE_SECONDS) > 1.5)
      fail('duration reads "' + loaded.time + '", expected about ' + EPISODE_SECONDS.toFixed(1) + 's');
    else pass('duration reads "' + loaded.time + '"');

    /* A real click is a user gesture, which is what Safari and Chromium both
       require before play() will resolve. */
    await page.click('#studioPlay');
    await page.waitForTimeout(1500);
    const playing = await page.evaluate(playerState);
    if (playing.paused) fail('playback did not start; status reads "' + playing.status + '"');
    else pass('playback started on a Play tap');
    if (!(playing.currentTime > 0)) fail('currentTime never advanced past 0');
    else pass('currentTime advanced to ' + playing.currentTime.toFixed(2) + 's');
    if (/could not play|unable to stream/i.test(playing.status))
      fail('a healthy episode reported "' + playing.status + '"');
    else pass('no playback error on a healthy episode');

    await page.click('#studioPlay');
    await page.waitForTimeout(300);
    const paused = await page.evaluate(playerState);
    if (!paused.paused) fail('a second tap did not pause');
    else pass('a second tap pauses');

    if (pageErrors.length) fail('uncaught page errors: ' + pageErrors.join(' | '));
    else pass('no uncaught page errors');
    if (podcastErrors.length) fail('[Podcast] console errors: ' + podcastErrors.join(' | '));
    else pass('no [Podcast] console errors');
    await page.close();
  }

  /* ---- 3. A broken episode URL fails loudly and honestly ----------------- */
  console.log('\n[3] Studio with an unreachable episode URL');
  state.podcast = readyEpisode(base + '/missing-episode.mp3');
  {
    const { page, pageErrors, podcastErrors } = await openStudio();
    await page.waitForTimeout(2000);
    const broken = await page.evaluate(playerState);

    if (!/unable to stream/i.test(broken.status))
      fail('a 404 episode left the status reading "' + broken.status + '"');
    else pass('status reports the stream failure: "' + broken.status + '"');
    if (broken.errorCode === null) fail('the audio element recorded no MediaError for a 404');
    else pass('the audio element recorded MediaError code ' + broken.errorCode);
    if (!podcastErrors.length)
      fail('the failure was swallowed — no [Podcast] console error (CLAUDE.md rule 3)');
    else pass('the failure was logged: ' + podcastErrors[0].slice(0, 110));

    /* renderStudio writes this line too, so a repaint must not replace a real
       failure with the ordinary empty-state message. */
    await page.evaluate(() => window.__fsnRender());
    await page.waitForTimeout(500);
    const repainted = await page.evaluate(playerState);
    if (!/unable to stream/i.test(repainted.status))
      fail('a repaint cleared the failure; status now reads "' + repainted.status + '"');
    else pass('the failure survives a repaint');

    if (pageErrors.length) fail('uncaught page errors: ' + pageErrors.join(' | '));
    else pass('no uncaught page errors');
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

if (failed) {
  console.error('\n[studio-audio-check] FAILED');
  process.exit(1);
}
console.log('\n[studio-audio-check] clean — empty, healthy and broken player states all behave.');
