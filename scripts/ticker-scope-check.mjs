#!/usr/bin/env node
/* ============================================================================
   FSN — TICKER SCOPE + SCROLL BOUNDS CHECK

   `node scripts/ticker-scope-check.mjs`

   Two regressions live at the edges of the app shell, and both are invisible to
   the content checks that read the middle of the screen.

   1. THE CRAWL SURVIVING A LEAGUE SWITCH.
      #tickerTrack is fixed to the top of every screen, so it is the one surface
      still visible while the rest of the app is empty mid-swap. It used to have
      no record of which league its strip belonged to: the moment anything in
      tickerItems() threw, safeRun() logged it and left the OUTGOING league's
      scores running across the top of the incoming one — permanently, because
      the next render threw in the same place. And because the crawl animation
      translates the track by -50% of ITS OWN width, swapping the strip's
      contents mid-cycle re-anchored that percentage onto a track of a different
      length, which reads as a ticker stuck or blank until the 42s cycle comes
      back around.

   2. SCROLLING PAST THE END OF THE CONTENT.
      #appShell padded for the fixed chrome by --ticker-h/--nav-h PLUS 9px of
      breathing room, while .screen subtracted only the raw chrome — so every
      screen was 9px taller than the space it had and scrolled that far into
      bare --ink below the tab bar, even an empty Record Book. The document also
      declared overscroll-behavior-y:auto, which let the whole page rubber-band
      well past both ends and armed pull-to-refresh over an app that owns its
      own refresh.

   This drives the real #leagueSwitcher against a stub ESPN relay (the same
   shape scripts/switch-curtain-check.mjs uses) and asserts:

     - the crawl carries the incoming league and nothing of the outgoing one
     - no intermediate frame of the crawl mixes the two leagues
     - clearLeagueStateForSwitch() unmounts the crawl in its own turn, not a
       frame later on the coalesced repaint
     - a scope change re-anchors the crawl animation instead of leaving it
       mid-cycle against the previous strip's width
     - a crawl that cannot be assembled degrades to the off-air strip rather
       than to the previous league's scores
     - a same-league render leaves the running crawl alone
     - every screen whose content fits the viewport has zero scrollable
       remainder, and the document and screens refuse to chain an overscroll
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

const CURRENT_YEAR = 2026;
const RELAY_DELAY_MS = 500;

const LEAGUE_A = '444444';
const LEAGUE_B = '555555';

/* Every visible string carries the League ID, so "which league is on the crawl
   right now" is answerable from the ticker's text alone. */
function leaguePayload(leagueId, season = CURRENT_YEAR) {
  const tag = 'L' + leagueId;
  const team = (i, wins, losses, pf, pa) => ({
    id: i,
    abbrev: (tag + i).slice(-4).toUpperCase(),
    name: tag + '-Team' + i,
    location: tag + '-Team' + i,
    nickname: '',
    owners: ['{OWNER-' + leagueId + '-' + i + '}'],
    playoffSeed: i,
    points: pf,
    record: { overall: { wins, losses, ties: 0, pointsFor: pf, pointsAgainst: pa } },
  });
  const matchup = (id, homeId, awayId, homeScore, awayScore, period) => ({
    id,
    matchupPeriodId: period,
    playoffTierType: 'NONE',
    winner: homeScore > awayScore ? 'HOME' : 'AWAY',
    home: { teamId: homeId, totalPoints: homeScore, pointsByScoringPeriod: { [period]: homeScore } },
    away: { teamId: awayId, totalPoints: awayScore, pointsByScoringPeriod: { [period]: awayScore } },
  });
  return {
    id: Number(leagueId),
    seasonId: season,
    scoringPeriodId: 2,
    status: { currentMatchupPeriod: 2, latestScoringPeriod: 2, finalScoringPeriod: 17, isActive: true },
    settings: {
      name: tag + ' League',
      size: 4,
      scheduleSettings: { matchupPeriodCount: 14, playoffTeamCount: 4 },
    },
    members: [1, 2, 3, 4].map((i) => ({
      id: '{OWNER-' + leagueId + '-' + i + '}',
      displayName: tag + '-Manager' + i,
      firstName: tag,
      lastName: 'Manager' + i,
    })),
    teams: [
      team(1, 2, 0, 240.5, 190.2),
      team(2, 1, 1, 210.1, 205.7),
      team(3, 1, 1, 205.4, 210.9),
      team(4, 0, 2, 188.0, 237.2),
    ],
    schedule: [
      matchup(1, 1, 4, 128.4, 92.1, 1),
      matchup(2, 2, 3, 105.6, 101.2, 1),
      matchup(3, 1, 3, 112.1, 104.2, 2),
      matchup(4, 2, 4, 104.5, 95.9, 2),
    ],
  };
}

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/notifications-register') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ configured: false }));
        return;
      }
      if (url.pathname === '/api/espn') {
        const target = url.searchParams.get('url') || '';
        const season = (target.match(/seasons\/(\d{4})/) || [])[1];
        const league = (target.match(/leagues\/(\d+)/) || [])[1];
        const historyLeague = (target.match(/leagueHistory\/(\d+)/) || [])[1];
        if (historyLeague) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'No archived seasons in this harness.' }));
          return;
        }
        if (!league || Number(season) !== CURRENT_YEAR) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'No such season for this league.' }));
          return;
        }
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(leaguePayload(league)));
        }, RELAY_DELAY_MS);
        return;
      }
      const file = url.pathname === '/' ? '/index.html' : url.pathname;
      const path = join(root, file.replace(/^\/+/, ''));
      if (!path.startsWith(root) || !existsSync(path)) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
      res.end(readFileSync(path));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
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
    .flatMap((name) => [
      join(dir, name, 'chrome-linux', 'chrome'),
      join(dir, name, 'chrome-linux', 'headless_shell'),
    ])
    .find((file) => existsSync(file)) || null;
}

const server = await startServer();
const base = 'http://127.0.0.1:' + server.address().port;

const executablePath = resolveChromium();
if (!executablePath) {
  console.error('[ticker-scope-check] no Chromium binary found under ' +
    (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') + '. Set FSN_CHROMIUM_PATH to one.');
  server.close();
  process.exit(1);
}
console.log('[ticker-scope-check] chromium: ' + executablePath);

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

/* Record every distinct strip the crawl mounts, from before boot, so an
   intermediate frame carrying both leagues cannot be missed by polling. */
await page.addInitScript(({ a, b }) => {
  try {
    const store = window.localStorage;
    store.setItem('hasCompletedOnboarding', 'true');
    store.setItem('mffu.saved.leagues.v1', JSON.stringify([
      { id: b, provider: 'espn', name: 'L' + b + ' League', lastUsed: 2 },
      { id: a, provider: 'espn', name: 'L' + a + ' League', lastUsed: 1 },
    ]));
    store.setItem('fsn_saved_league_id', b);
    store.setItem('fsn.setup.v1', JSON.stringify({
      leagueId: b, season: '2026', week: '2', provider: 'espn', statsMode: 'career',
    }));
  } catch (err) { /* private mode — the asserts below will say the check could not run */ }

  window.__tickerFrames = [];
  const watch = () => {
    const track = document.getElementById('tickerTrack');
    if (!track) { requestAnimationFrame(watch); return; }
    const record = () => {
      const text = String(track.textContent || '');
      const last = window.__tickerFrames[window.__tickerFrames.length - 1];
      if (last !== text) window.__tickerFrames.push(text);
    };
    record();
    new MutationObserver(record).observe(track, { childList: true, subtree: true, characterData: true });
  };
  watch();
}, { a: LEAGUE_A, b: LEAGUE_B });

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (err) => pageErrors.push(String((err && err.stack) || err)));
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  // The stub relay has no archived seasons, so the background walk 404s and says so.
  if (/ESPN relay rejected .*HTTP 404/.test(text)) return;
  // Section 5 breaks the crawl on purpose; the loud log is the behaviour under test.
  if (/SYNTHETIC_TICKER_FAILURE/.test(text)) return;
  if (/\[(FSN|NewsDesk|Standings|Matchups|Timeline|Desk|LeagueSwitch|Ticker)/.test(text)) consoleErrors.push(text);
});

let failed = false;
const fail = (message) => { failed = true; console.error('  FAIL  ' + message); };
const pass = (message) => console.log('  ok    ' + message);

const tickerText = () => page.evaluate(() =>
  String(document.getElementById('tickerTrack').textContent || ''));

const SCREENS = ['home', 'matchups', 'analytics', 'recordbook', 'news', 'setup'];

try {
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  if (await page.getAttribute('#profilePicker', 'data-open') === 'true') {
    await page.click('#profileGuest');
    await page.waitForTimeout(400);
  }

  /* ---- 1. The crawl is mounted for the booted league ---------------------- */
  const booted = await tickerText();
  if (new RegExp('L' + LEAGUE_B).test(booted)) pass('the crawl booted carrying league ' + LEAGUE_B);
  else fail('the crawl never carried league ' + LEAGUE_B + ' at boot; the check cannot measure a switch away from it');

  /* ---- 2. A real switch through the reader's own control ------------------ */
  await page.evaluate(() => { window.__tickerFrames = []; });
  await page.evaluate((value) => {
    const select = document.getElementById('leagueSwitcher');
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, 'espn:' + LEAGUE_A);
  await page.waitForTimeout(6000);

  const settled = await tickerText();
  if (new RegExp('L' + LEAGUE_A).test(settled)) pass('after the switch, the crawl carries the incoming league ' + LEAGUE_A);
  else fail('after the switch, the crawl never picked up the incoming league ' + LEAGUE_A);
  if (!new RegExp('L' + LEAGUE_B).test(settled)) pass('after the switch, nothing of the outgoing league ' + LEAGUE_B + ' is left on the crawl');
  else fail('after the switch, the crawl STILL carries the outgoing league ' + LEAGUE_B);

  const mixed = await page.evaluate(({ a, b }) => window.__tickerFrames
    .filter((text) => new RegExp('L' + a).test(text) && new RegExp('L' + b).test(text)).length,
    { a: LEAGUE_A, b: LEAGUE_B });
  if (mixed === 0) pass('no intermediate frame of the crawl mixed the two leagues');
  else fail(mixed + ' intermediate frame(s) of the crawl carried both leagues at once');

  /* ---- 3. The wipe happens in the switch's own turn ----------------------- */
  /* clearLeagueStateForSwitch() empties the stores and publishes, but that
     repaint is coalesced into the next animation frame. If the crawl waited on
     it, the outgoing league would sit over an emptied app for a frame. The
     crawl is unmounted synchronously instead, so the recorded frames must show
     the bar going EMPTY before anything of the incoming league appears. */
  const order = await page.evaluate(({ a, b }) => {
    const frames = window.__tickerFrames;
    const emptyAt = frames.findIndex((text) => text.trim() === '');
    const incomingAt = frames.findIndex((text) => new RegExp('L' + a).test(text));
    const outgoingAfterEmpty = emptyAt < 0 ? -1
      : frames.slice(emptyAt + 1).findIndex((text) => new RegExp('L' + b).test(text));
    return { frames: frames.length, emptyAt, incomingAt, outgoingAfterEmpty };
  }, { a: LEAGUE_A, b: LEAGUE_B });

  if (order.emptyAt < 0) {
    fail('the crawl was never unmounted during the switch — it went straight from one league\u2019s strip ' +
      'to the other, so any failure in between would have left the outgoing league on the bar');
  } else if (order.incomingAt >= 0 && order.emptyAt < order.incomingAt) {
    pass('the crawl was unmounted (frame ' + order.emptyAt + ') before the incoming league mounted (frame ' +
      order.incomingAt + ')');
  } else {
    fail('the crawl mounted the incoming league at frame ' + order.incomingAt + ' before it was ever ' +
      'unmounted (frame ' + order.emptyAt + ')');
  }
  if (order.outgoingAfterEmpty === -1 || order.outgoingAfterEmpty === undefined) {
    pass('the outgoing league never came back to the crawl after the unmount');
  } else if (order.outgoingAfterEmpty < 0) {
    pass('the outgoing league never came back to the crawl after the unmount');
  } else {
    fail('the outgoing league reappeared on the crawl after the unmount');
  }

  // Measure actual animation travel with both short and long rendered strips.
  const velocities = await page.evaluate(async () => {
    const track = document.getElementById('tickerTrack');
    const original = track.innerHTML;
    const results = [];
    for (const label of ['ESPN short', 'Sleeper very long team name '.repeat(20)]) {
      const item = '<span class="ticker-item">' + label + '</span>';
      track.innerHTML = item + item;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const animation = track.getAnimations()[0];
      animation.pause();
      animation.currentTime = 100;
      const start = new DOMMatrix(getComputedStyle(track).transform).m41;
      animation.currentTime = 600;
      const end = new DOMMatrix(getComputedStyle(track).transform).m41;
      results.push(Math.abs(end - start) / 0.5);
      animation.play();
    }
    track.innerHTML = original;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return results;
  });
  if (velocities.every(speed => Math.abs(speed - 90) < 0.1)) {
    pass('short and long ticker strips both travel at 90px/s: ' + velocities.join(', '));
  } else fail('ticker velocity varies with content width: ' + velocities.join(', '));

  /* ---- 4. A scope change re-anchors the crawl animation ------------------- */
  /* tickerScroll translates the track by -50% of ITS OWN width, so a strip
     swapped in mid-cycle is measured against a length it was never laid out
     for. Driven through the app\u2019s own render entry point, not a private
     handle: the league id lives on #leagueIdInput, which is what
     LeagueData.leagueId() reads. */
  const anim = await page.evaluate(() => {
    const track = document.getElementById('tickerTrack');
    const readTime = () => {
      const running = track.getAnimations()
        .find((a) => String((a.animationName || (a.effect && a.effect.target && '')) || '') === 'tickerScroll');
      return running ? Number(running.currentTime) : null;
    };
    return new Promise((resolve) => {
      setTimeout(() => {
        const before = readTime();
        // Same league, same strip: the running crawl must be left alone.
        window.__fsnRender();
        const sameLeague = readTime();
        // A different league: the -50% keyframe now measures a different strip.
        document.getElementById('leagueIdInput').value = '888888';
        window.__fsnRender();
        resolve({ before, sameLeague, afterSwitch: readTime() });
      }, 1200);
    });
  }).catch((err) => ({ error: String(err) }));

  if (anim && anim.error) {
    fail('the crawl-animation assert could not run: ' + anim.error);
  } else if (anim.before == null || anim.afterSwitch == null) {
    fail('the tickerScroll animation is not running on #tickerTrack; the crawl cannot be measured');
  } else {
    if (Math.abs(anim.sameLeague - anim.before) < 50) {
      pass('a same-league render left the running crawl in place (' + Math.round(anim.before) + 'ms in)');
    } else {
      fail('a same-league render restarted the crawl (' + Math.round(anim.before) + 'ms \u2192 ' +
        Math.round(anim.sameLeague) + 'ms) \u2014 the bar jumps under a reader mid-read');
    }
    if (anim.afterSwitch < anim.before) {
      pass('a league change re-anchored the crawl animation (' + Math.round(anim.before) + 'ms \u2192 ' +
        Math.round(anim.afterSwitch) + 'ms)');
    } else {
      fail('a league change left the crawl mid-cycle at ' + Math.round(anim.afterSwitch) +
        'ms, still measured against the previous strip\u2019s width');
    }
  }

  /* ---- 5. An unbuildable crawl degrades to off air, not to the last league -- */
  const degraded = await page.evaluate(() => {
    const track = document.getElementById('tickerTrack');
    document.getElementById('leagueIdInput').value = '777777';
    window.__fsnRender();
    const stale = String(track.textContent || '');
    const original = LeagueData.getWeekMatchups;
    LeagueData.getWeekMatchups = () => { throw new Error('SYNTHETIC_TICKER_FAILURE'); };
    try {
      document.getElementById('leagueIdInput').value = '666666';
      window.__fsnRender();
    } finally {
      LeagueData.getWeekMatchups = original;
    }
    return { stale, after: String(track.textContent || '') };
  }).catch((err) => ({ error: String(err) }));

  if (degraded && degraded.error) {
    fail('the degrade assert could not run: ' + degraded.error);
  } else if (!degraded.stale.trim()) {
    fail('the crawl was already empty before the degrade assert; it proves nothing');
  } else if (/Awaiting signal/.test(degraded.after)) {
    pass('a crawl that cannot be assembled degrades to the off-air strip, not to the previous league');
  } else {
    fail('a failing crawl left "' + degraded.after.slice(0, 80) + '" on the bar instead of the off-air strip');
  }

  /* ---- 6. Scroll bounds -------------------------------------------------- */
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2500);
  if (await page.getAttribute('#profilePicker', 'data-open') === 'true') {
    await page.click('#profileGuest');
    await page.waitForTimeout(400);
  }

  const chaining = await page.evaluate(() => {
    const active = document.querySelector('.screen[data-active="true"]');
    return {
      html: getComputedStyle(document.documentElement).overscrollBehaviorY,
      body: getComputedStyle(document.body).overscrollBehaviorY,
      screen: active ? getComputedStyle(active).overscrollBehaviorY : '',
      reader: getComputedStyle(document.getElementById('readerBody')).overscrollBehavior,
    };
  });
  if (chaining.html === 'none' && chaining.body === 'none') {
    pass('the document refuses to rubber-band past its own content (overscroll-behavior-y: none)');
  } else {
    fail('the document still bounces past its content (html=' + chaining.html + ', body=' + chaining.body + ')');
  }
  if (chaining.screen === 'none') pass('a screen will not chain an overscroll out into the document');
  else fail('the active screen chains its overscroll (overscroll-behavior-y=' + chaining.screen + ')');
  if (chaining.reader === 'contain') pass('the reader overlay will not chain an overscroll out into the page behind it');
  else fail('the reader overlay chains its overscroll (overscroll-behavior=' + chaining.reader + ')');

  for (const name of SCREENS) {
    await page.evaluate((screen) => {
      const tab = document.querySelector('[data-tab="' + screen + '"]');
      if (tab) tab.click();
    }, name);
    await page.waitForTimeout(300);
    const bounds = await page.evaluate(() => {
      const de = document.documentElement;
      const shell = document.getElementById('appShell');
      const active = document.querySelector('.screen[data-active="true"]');
      let contentBottom = 0;
      if (active) {
        active.querySelectorAll('*').forEach((el) => {
          const box = el.getBoundingClientRect();
          if (box.height > 0 || box.width > 0) contentBottom = Math.max(contentBottom, box.bottom + window.scrollY);
        });
      }
      return {
        maxScroll: Math.max(0, de.scrollHeight - de.clientHeight),
        contentBottom: Math.round(contentBottom),
        clientHeight: de.clientHeight,
        // The clearance the fixed tab bar needs, and the ONLY slack a fully
        // scrolled screen is allowed to leave below its last element.
        shellGap: Math.round(parseFloat(getComputedStyle(shell).paddingBottom) || 0),
      };
    });
    /* A screen whose content fits the viewport must not scroll at all. One that
       does not fit may scroll until its last element clears the tab bar, and
       not one pixel further: anything beyond that is bare --ink. */
    const fits = bounds.contentBottom <= bounds.clientHeight;
    if (fits) {
      if (bounds.maxScroll === 0) pass(name + ': content fits the viewport and the screen does not scroll at all');
      else fail(name + ': content fits the viewport but the screen still scrolls ' + bounds.maxScroll + 'px into dead space');
    } else {
      const overrun = bounds.maxScroll + bounds.clientHeight - bounds.contentBottom;
      const slack = overrun - bounds.shellGap;
      if (Math.abs(slack) <= 2) {
        pass(name + ': scroll ends exactly where the content does, with only the ' + bounds.shellGap +
          'px tab-bar clearance below it');
      } else if (slack > 2) {
        fail(name + ': scroll runs ' + slack + 'px past the tab-bar clearance \u2014 dead space below the content');
      } else {
        fail(name + ': scroll stops ' + (-slack) + 'px short, leaving the last element under the tab bar');
      }
    }
  }

  /* ---- 7. Runtime health ------------------------------------------------- */
  if (!pageErrors.length) pass('zero uncaught page errors');
  else pageErrors.forEach((e) => fail('page error: ' + e));
  if (!consoleErrors.length) pass('zero tagged console errors');
  else consoleErrors.forEach((e) => fail('console error: ' + e));

  const snag = await page.evaluate(() => /hit a snag/i.test(String(document.body.innerText || '')));
  if (!snag) pass('no "hit a snag" fallback anywhere after the switches');
  else fail('a "hit a snag" fallback is on screen');
} catch (err) {
  fail('the check itself threw: ' + ((err && err.stack) || err));
} finally {
  await browser.close();
  server.close();
}

console.log(failed ? '\n[ticker-scope-check] FAILED' : '\n[ticker-scope-check] clean');
if (failed) process.exit(1);
