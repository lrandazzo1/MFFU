#!/usr/bin/env node
/* ============================================================================
   FSN — DESKTOP SCROLL CHECK

   `node scripts/desktop-scroll-check.mjs`

   Every other headless check in this repo drives a phone viewport, because the
   app is a phone column. That is exactly how the web build shipped a page that
   could not be scrolled at all on a laptop.

   THE BUG THIS EXISTS FOR

   The document had three redundant scroll containers stacked between the
   viewport and the cards:

     html { overflow-x:hidden; overflow-y:scroll }   <- correct; propagates to
                                                        the viewport
     body { overflow-x:hidden; overflow-y:auto }     <- second scrollport
     .screen[data-active] { overflow-y:auto }        <- third
     .screen-shell        { overflow-y:auto }        <- fourth

   None of the inner three can ever actually scroll: each is auto-height, so its
   scrollHeight always equals its clientHeight. A scroll container that cannot
   scroll is precisely what `overscroll-behavior: none` seals shut. A wheel or
   trackpad gesture latches onto the innermost scrollport under the cursor,
   finds nothing to consume the delta with, and the containment then stops it
   chaining outward to the viewport. The page does not move. Phones were
   unaffected, which is why six phone-viewport checks stayed green.

   WHAT THIS ASSERTS

     1. Structural: from <body> down to the active screen's shell, nothing is a
        scroll container. Only the viewport (via the root element) and the
        genuinely-scrolling overlays are. This is the assertion that fails
        against the pre-fix file, and it is the one that guards the regression.
     2. Behavioural: a real wheel gesture over the middle of each screen moves
        window.scrollY, and moves it back. Be honest about what this one buys:
        headless Chromium chains a wheel out of a dead scrollport where the
        shipping browsers this was reported on do not, so it passed even against
        the broken file. It is a live smoke test for a harder break (a stuck
        overlay lock, a fixed-position trap, a scrollport that really does
        capture the delta), not a reproduction of the original bug. Assertion 1
        is what catches that.
     3. The overlays still work the other way round: the reader scrolls its own
        body and the page behind it stays locked.
     4. Zero page errors and zero tagged console errors throughout.

   The league is seeded at 12 teams so every screen is comfortably taller than a
   900px laptop viewport; a screen that genuinely fits is skipped for the wheel
   assertion rather than failed.
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

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if ((url.pathname === '/api/notifications-register' || url.pathname === '/api/notifications')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ configured: false, apns: false, web: false, vapidPublicKey: '', groups: [] }));
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

/* Twelve teams over two completed weeks, so every screen has enough rows to
   overflow a laptop viewport and the wheel assertion below is meaningful. */
function syntheticLeague() {
  const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot',
    'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima'];
  const teams = NAMES.map((name, i) => {
    const id = i + 1;
    const pf = 240 - i * 6.5;
    const pa = 190 + i * 4.25;
    return {
      id,
      abbrev: name.slice(0, 3).toUpperCase(),
      name,
      location: name,
      nickname: '',
      owners: ['{OWNER-' + id + '}'],
      playoffSeed: id,
      points: pf,
      record: { overall: { wins: i < 6 ? 2 : 1, losses: i < 6 ? 0 : 1, ties: 0, pointsFor: pf, pointsAgainst: pa } },
    };
  });

  const matchup = (id, homeId, awayId, homeScore, awayScore, period) => ({
    id,
    matchupPeriodId: period,
    playoffTierType: 'NONE',
    winner: homeScore > awayScore ? 'HOME' : 'AWAY',
    home: { teamId: homeId, totalPoints: homeScore, pointsByScoringPeriod: { [period]: homeScore } },
    away: { teamId: awayId, totalPoints: awayScore, pointsByScoringPeriod: { [period]: awayScore } },
  });

  const schedule = [];
  let id = 1;
  for (const period of [1, 2]) {
    for (let i = 0; i < 12; i += 2) {
      const home = i + 1;
      const away = period === 1 ? i + 2 : ((i + 3) % 12) + 1;
      if (home === away) continue;
      schedule.push(matchup(id++, home, away, 128.4 - i * 2.1, 92.1 + i * 3.4, period));
    }
  }

  return {
    id: 999999,
    seasonId: 2026,
    scoringPeriodId: 2,
    status: { currentMatchupPeriod: 2, latestScoringPeriod: 2, finalScoringPeriod: 17, isActive: true },
    settings: {
      name: 'Desktop Scroll League',
      size: 12,
      scheduleSettings: { matchupPeriodCount: 14, playoffTeamCount: 6 },
    },
    members: NAMES.map((name, i) => ({
      id: '{OWNER-' + (i + 1) + '}',
      displayName: 'Manager ' + (i + 1),
      firstName: 'Manager',
      lastName: String(i + 1),
    })),
    teams,
    schedule,
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
    .flatMap((name) => [
      join(dir, name, 'chrome-linux', 'chrome'),
      join(dir, name, 'chrome-linux', 'headless_shell'),
    ])
    .find((file) => existsSync(file)) || null;
}

const executablePath = resolveChromium();
if (!executablePath) {
  console.error('[desktop-scroll-check] no Chromium binary found under ' +
    (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') + '. Set FSN_CHROMIUM_PATH to one.');
  process.exit(1);
}

const server = await startServer();
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ executablePath });
/* A 13" laptop. Not a phone, and not so tall that content stops overflowing. */
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.addInitScript(() => {
  try { window.localStorage.setItem('hasCompletedOnboarding', 'true'); } catch (err) { /* private mode */ }
});

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (err) => pageErrors.push(String((err && err.stack) || err)));
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  if (/\[(FSN|NewsDesk|Standings|Matchups|Home|League Share|Privacy|Yahoo|EditorialScheduleEngine)/.test(text)) {
    consoleErrors.push(text);
  }
});

let failed = false;
const fail = (message) => { failed = true; console.error('  FAIL  ' + message); };
const pass = (message) => console.log('  ok    ' + message);

try {
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForTimeout(1400);
  await page.evaluate((data) => {
    window.LeagueData.setEspnData(data);
    window.__fsnRender();
  }, syntheticLeague());
  await page.waitForTimeout(1100);
  if (await page.getAttribute('#profilePicker', 'data-open') === 'true') {
    await page.click('#profileGuest');
    await page.waitForTimeout(500);
  }

  /* ---- 1. Structural: one scroller only --------------------------------- */
  const structure = await page.evaluate(() => {
    const scrolls = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY) ||
             ['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX);
    };
    const active = document.querySelector('.screen[data-active="true"]');
    const shell = active ? active.querySelector('.screen-shell') : null;
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      rootOverflowY: rootStyle.overflowY,
      rootOverflowX: rootStyle.overflowX,
      rootOverscrollY: rootStyle.overscrollBehaviorY,
      bodyScrolls: scrolls(document.body),
      appShellScrolls: scrolls(document.getElementById('appShell')),
      screenScrolls: scrolls(active),
      shellScrolls: scrolls(shell),
    };
  });

  if (structure.rootOverflowY === 'scroll' && structure.rootOverflowX === 'hidden') {
    pass('the root element still owns the page overflow (y:scroll, x:hidden), which the UA gives the viewport');
  } else {
    fail('the root element no longer owns the page overflow (y=' + structure.rootOverflowY +
      ', x=' + structure.rootOverflowX + ')');
  }
  if (structure.rootOverscrollY === 'none') pass('the viewport still refuses to rubber-band past the content');
  else fail('the viewport bounces past its content (overscroll-behavior-y=' + structure.rootOverscrollY + ')');

  for (const [label, isScroller] of [
    ['<body>', structure.bodyScrolls],
    ['#appShell', structure.appShellScrolls],
    ['the active screen', structure.screenScrolls],
    ['.screen-shell', structure.shellScrolls],
  ]) {
    if (!isScroller) pass(label + ' is not a scroll container');
    else fail(label + ' is a scroll container. It is auto-height, so it can never scroll — a desktop wheel ' +
      'gesture latches onto it and never reaches the viewport.');
  }

  /* ---- 2. Behavioural: the wheel actually moves the page ----------------- */
  const tabs = await page.$$eval('#tabBar .tab-btn', (els) => els.map((e) => e.getAttribute('data-tab')));
  if (tabs.length !== 6) fail('expected 6 tabs, found ' + tabs.length);

  for (const tab of tabs) {
    await page.click('#tabBar .tab-btn[data-tab="' + tab + '"]');
    await page.waitForTimeout(420);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(80);

    const room = await page.evaluate(() => {
      const de = document.documentElement;
      return Math.max(0, de.scrollHeight - de.clientHeight);
    });
    if (room < 40) {
      pass(tab + ': content fits a 1440x900 laptop, nothing to scroll (skipped)');
      continue;
    }

    /* Over the middle of the content column, which is where the dead
       scrollports used to sit and eat the gesture. */
    await page.mouse.move(720, 520);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(320);
    const down = await page.evaluate(() => window.scrollY);
    if (down > 0) pass(tab + ': a wheel gesture over the content scrolls the page (scrollY=' + Math.round(down) + ')');
    else fail(tab + ': the page did not move under a wheel gesture — desktop scrolling is broken on this screen');

    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(320);
    const up = await page.evaluate(() => window.scrollY);
    if (up < down) pass(tab + ': the page scrolls back up again (scrollY=' + Math.round(up) + ')');
    else fail(tab + ': the page would not scroll back up (stuck at scrollY=' + Math.round(up) + ')');
  }

  /* ---- 3. The overlays still contain their own scroll -------------------- */
  await page.click('#tabBar .tab-btn[data-tab="news"]');
  await page.waitForTimeout(500);
  const opened = await page.evaluate(() => {
    const screen = document.querySelector('.screen[data-screen="news"]');
    const card = screen && screen.querySelector('[data-article]');
    if (!card) return false;
    card.click();
    return true;
  });
  await page.waitForTimeout(700);
  const readerOpen = await page.getAttribute('#reader', 'data-open');
  if (opened && readerOpen === 'true') {
    const overlay = await page.evaluate(() => ({
      locked: document.documentElement.classList.contains('overlay-open'),
      bodyScrolls: getComputedStyle(document.getElementById('readerBody')).overflowY,
      contained: getComputedStyle(document.getElementById('readerBody')).overscrollBehavior,
    }));
    if (overlay.locked) pass('the reader locks the page behind it');
    else fail('the reader did not lock the page behind it');
    if (overlay.bodyScrolls === 'auto' || overlay.bodyScrolls === 'scroll') {
      pass('the reader body is still its own scroller');
    } else {
      fail('the reader body stopped being a scroller (overflow-y=' + overlay.bodyScrolls + ')');
    }
    if (overlay.contained === 'contain') pass('the reader still contains its own overscroll');
    else fail('the reader stopped containing its overscroll (' + overlay.contained + ')');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const unlocked = await page.evaluate(() => !document.documentElement.classList.contains('overlay-open'));
    if (unlocked) pass('closing the reader releases the page scroll lock');
    else fail('the page is still locked after the reader closed');
  } else {
    pass('no reader-openable story on the News screen for this synthetic league (skipped)');
  }

  /* ---- 4. Runtime health ------------------------------------------------ */
  if (!pageErrors.length) pass('zero uncaught page errors');
  else pageErrors.forEach((e) => fail('page error: ' + e));
  if (!consoleErrors.length) pass('zero tagged console errors');
  else consoleErrors.forEach((e) => fail('console error: ' + e));
} catch (err) {
  fail('the check itself threw: ' + ((err && err.stack) || err));
} finally {
  await browser.close();
  server.close();
}

console.log(failed ? '\n[desktop-scroll-check] FAILED' : '\n[desktop-scroll-check] clean');
process.exit(failed ? 1 : 0);
