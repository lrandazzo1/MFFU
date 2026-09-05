#!/usr/bin/env node
/* ============================================================================
   FSN — HEADLESS RENDER CHECK

   `node scripts/render-check.mjs`

   index.html has no build step and no test suite, so CLAUDE.md makes this the
   non-negotiable second half of verifying a change: load the real file in
   Chromium, seed the data engine with a synthetic league, paint, walk every
   screen, and fail on anything that went wrong at runtime.

   It asserts:
     - zero uncaught page errors
     - zero [FSN*] / [NewsDesk] / [Standings] / [Matchups] console errors
     - no "hit a snag" text in any rendered panel
     - every tab actually activates

   Rendering bugs in this codebase are always runtime, never build-time. A green
   Vercel build only means the static file was served.

   The app is served over a real HTTP origin rather than file://, because the
   push service fetches /api/notifications-register on boot and file:// makes
   that a scheme error rather than the ordinary network failure the service is
   written to tolerate. The stub server answers that one route and 404s the
   rest, which is exactly the shape of a deployment with push unprovisioned.
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

/* Serve the repo root plus a stub for the one API route the client boots
   against. `configured:false` is the honest answer for a local run with no
   APNs or VAPID keys, and it is the branch the Setup card must render without
   throwing. */
function startServer(options) {
  const opts = options || {};
  const posts = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/notifications-register') {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (c) => { body += c; });
          req.on('end', () => {
            try { posts.push(JSON.parse(body)); }
            catch (err) { posts.push({ __unparseable: body, __error: String(err) }); }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, deviceId: 'f'.repeat(64) }));
          });
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          configured: !!opts.configured,
          apns: false,
          web: !!opts.configured,
          vapidPublicKey: opts.vapidPublicKey || '',
          groups: ['tuesday', 'thursday', 'sunday'],
        }));
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
    server.listen(0, '127.0.0.1', () => resolve({ server, posts }));
  });
}

/* A minimal but structurally real ESPN-shaped payload: two scored matchups
   across four teams, enough for standings, the matchup board, the power index
   and the News Desk to all have something to compute from. */
function syntheticLeague() {
  const team = (id, abbrev, name, wins, losses, pf, pa) => ({
    id,
    abbrev,
    name,
    location: name,
    nickname: '',
    owners: ['{OWNER-' + id + '}'],
    playoffSeed: id,
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
    id: 999999,
    seasonId: 2026,
    scoringPeriodId: 2,
    status: { currentMatchupPeriod: 2, latestScoringPeriod: 2, finalScoringPeriod: 17, isActive: true },
    settings: {
      name: 'Render Check League',
      size: 4,
      scheduleSettings: { matchupPeriodCount: 14, playoffTeamCount: 4 },
    },
    members: [1, 2, 3, 4].map((i) => ({
      id: '{OWNER-' + i + '}',
      displayName: 'Manager ' + i,
      firstName: 'Manager',
      lastName: String(i),
    })),
    teams: [
      team(1, 'AAA', 'Alpha', 2, 0, 240.5, 190.2),
      team(2, 'BBB', 'Bravo', 1, 1, 210.1, 205.7),
      team(3, 'CCC', 'Charlie', 1, 1, 205.4, 210.9),
      team(4, 'DDD', 'Delta', 0, 2, 188.0, 237.2),
    ],
    schedule: [
      matchup(1, 1, 4, 128.4, 92.1, 1),
      matchup(2, 2, 3, 105.6, 101.2, 1),
      matchup(3, 1, 3, 112.1, 104.2, 2),
      matchup(4, 2, 4, 104.5, 95.9, 2),
    ],
  };
}

/* A real VAPID public key, so the client's base64url -> Uint8Array conversion
   is exercised on a genuine value rather than a placeholder that would make
   pushManager.subscribe reject for the wrong reason. */
const vapidPublicKey = (await import('web-push')).default.generateVAPIDKeys().publicKey;

const { server, posts } = await startServer({ configured: true, vapidPublicKey });
const port = server.address().port;
const base = 'http://127.0.0.1:' + port;

/* The environment pre-installs Chromium under PLAYWRIGHT_BROWSERS_PATH, but its
   build number will not always match whatever playwright version npm resolved,
   and downloading a second copy is blocked. Resolve the binary on disk instead
   of trusting playwright's version-derived path. */
function resolveChromium() {
  const override = String(process.env.FSN_CHROMIUM_PATH || '').trim();
  if (override) return override;
  const dir = String(process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers');
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((name) => name.startsWith('chromium'))
    /* Prefer the highest build, and a full chrome over the headless shell —
       the shell lacks pieces this page touches during layout. */
    .sort()
    .reverse()
    .flatMap((name) => [
      join(dir, name, 'chrome-linux', 'chrome'),
      join(dir, name, 'chrome-linux', 'headless_shell'),
    ]);
  return candidates.find((file) => existsSync(file)) || null;
}

const executablePath = resolveChromium();
if (!executablePath) {
  console.error('[render-check] no Chromium binary found under ' +
    (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') +
    '. Set FSN_CHROMIUM_PATH to one.');
  server.close();
  process.exit(1);
}
console.log('[render-check] chromium: ' + executablePath);

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });

/* Instrument the two APIs that must never be reached during boot, BEFORE any
   page script runs. The previous version of this check read a flag nothing ever
   set, which made the most important assertion in the file vacuous.

   pushManager.subscribe is also stubbed: headless Chromium has no push service,
   so a real subscribe would fail for reasons that have nothing to do with this
   codebase. The stub returns a well-formed subscription, which turns the opt-in
   scenario into a test of OUR payload rather than of Chromium's plumbing. */
await page.addInitScript(() => {
  window.__fsnPermissionRequested = false;
  window.__fsnSubscribeCalled = false;

  const realRequest = window.Notification && window.Notification.requestPermission;
  if (realRequest) {
    window.Notification.requestPermission = function () {
      window.__fsnPermissionRequested = true;
      return Promise.resolve('granted');
    };
  }
  try {
    Object.defineProperty(window.Notification, 'permission', {
      configurable: true,
      get() { return window.__fsnPermissionRequested ? 'granted' : 'default'; },
    });
  } catch (err) { /* some builds seal this; the requestPermission hook still holds */ }

  if (window.PushManager) {
    window.PushManager.prototype.getSubscription = function () { return Promise.resolve(null); };
    window.PushManager.prototype.subscribe = function () {
      window.__fsnSubscribeCalled = true;
      return Promise.resolve({
        toJSON() {
          return {
            endpoint: 'https://fcm.googleapis.com/fcm/send/fsn-render-check',
            keys: { p256dh: 'BJ2xN0mOc3rH1oB1Q0h0Ck8lTn1sQ2Zc9VvE7yYw3rQ8pLmN4xK6vB2jH9dF1sA3gT5uW7yI0oP2qR4tU6vX8z', auth: 'k2Yg7ZxQ1pL9mN3vB6cD8w' },
          };
        },
      });
    };
  }
});

const pageErrors = [];
const consoleErrors = [];

page.on('pageerror', (err) => pageErrors.push(String(err && err.stack || err)));
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  /* Only this app's own tagged errors. A CDN or favicon 404 in the harness is
     not a rendering regression. */
  if (/\[(FSN|NewsDesk|Standings|Matchups|League Share|Privacy|Yahoo|EditorialScheduleEngine)/.test(text)) {
    consoleErrors.push(text);
  }
});

let failed = false;
const fail = (message) => { failed = true; console.error('  FAIL  ' + message); };
const pass = (message) => console.log('  ok    ' + message);

try {
  await page.goto(base + '/', { waitUntil: 'load' });
  /* Boot is fire-and-forget in several places; give the microtask queue and the
     stubbed fetch a beat to settle before asserting. */
  await page.waitForTimeout(1200);

  /* ---- 1. The seams the smoke test is supposed to use exist -------------- */
  const seams = await page.evaluate(() => ({
    render: typeof window.__fsnRender === 'function',
    leagueData: !!(window.LeagueData && typeof window.LeagueData.setEspnData === 'function'),
    notifications: !!window.FSNNotifications,
    schedule: !!window.EditorialScheduleEngine,
    bridge: !!window.FSNBridge,
  }));
  for (const [name, present] of Object.entries(seams)) {
    if (present) pass('seam present: ' + name);
    else fail('seam missing: ' + name);
  }

  /* ---- 2. Seed a league and repaint ------------------------------------- */
  await page.evaluate((data) => {
    window.LeagueData.setEspnData(data);
    window.__fsnRender();
  }, syntheticLeague());
  await page.waitForTimeout(900);
  pass('seeded a synthetic league and repainted');

  /* The first live payload opens the team-profile chooser, which is modal and
     intercepts every tab tap until it is answered. Answer it the way a reader
     without a team would, so the walk below exercises the real post-onboarding
     app rather than fighting an overlay. */
  const pickerOpen = await page.getAttribute('#profilePicker', 'data-open');
  if (pickerOpen === 'true') {
    await page.click('#profileGuest');
    await page.waitForTimeout(500);
    pass('dismissed the first-run profile picker (continue as guest)');
  } else {
    pass('no profile picker to dismiss');
  }

  /* ---- 3. Walk every screen --------------------------------------------- */
  const tabs = await page.$$eval('#tabBar .tab-btn', (els) => els.map((e) => e.getAttribute('data-tab')));
  if (tabs.length !== 6) fail('expected 6 tabs, found ' + tabs.length);
  else pass('found all 6 tabs: ' + tabs.join(', '));

  for (const tab of tabs) {
    await page.click('#tabBar .tab-btn[data-tab="' + tab + '"]');
    await page.waitForTimeout(450);
    const active = await page.getAttribute('.screen[data-screen="' + tab + '"]', 'data-active');
    if (active === 'true') pass('screen activated: ' + tab);
    else fail('screen did not activate: ' + tab);

    const snag = await page.evaluate((name) => {
      const screen = document.querySelector('.screen[data-screen="' + name + '"]');
      return screen ? /hit a snag/i.test(screen.innerText) : false;
    }, tab);
    if (snag) fail('"hit a snag" rendered on screen: ' + tab);
  }

  /* ---- 4. The push card renders its unconfigured state honestly ---------- */
  await page.click('#tabBar .tab-btn[data-tab="setup"]');
  await page.waitForTimeout(500);

  const card = await page.evaluate(() => {
    const el = document.getElementById('notifyCard');
    if (!el) return null;
    const master = document.getElementById('notifyMaster');
    const status = document.getElementById('notifyStatus');
    const rationale = document.getElementById('notifyRationale');
    return {
      present: true,
      masterChecked: !!(master && master.checked),
      masterDisabled: !!(master && master.disabled),
      status: status ? status.textContent.trim() : '',
      rationaleHidden: !!(rationale && rationale.classList.contains('hidden')),
    };
  });

  if (!card) {
    fail('the Push Alerts card is not in the Setup screen');
  } else {
    pass('Push Alerts card rendered');
    if (card.masterChecked) fail('the master switch defaulted to ON — it must start off');
    else pass('master switch defaults to off');
    if (!card.rationaleHidden) fail('the permission rationale is visible before the reader asked for it');
    else pass('permission rationale stays hidden until the reader opts in');
    if (card.masterDisabled) fail('push is configured in this harness but the switch is disabled');
    else pass('switch is available when push is configured');
  }

  /* ---- 5. THE OPT-IN CONTRACT ------------------------------------------
     Boot must not have prompted, flipping the master switch must not prompt,
     and only the button inside the rationale panel may. This is the whole
     requirement, asserted in the order a reader would hit it. */
  let asked = await page.evaluate(() => window.__fsnPermissionRequested);
  if (asked) fail('boot requested notification permission — it must never prompt on launch');
  else pass('boot did not request notification permission');

  /* Click the LABEL, not the input. The input is deliberately clipped
     off-screen (focusable but not visible) so the whole row is one tap target
     and VoiceOver reads the state; that is exactly what a reader taps. */
  await page.click('#notifyMasterRow');
  await page.waitForTimeout(400);

  asked = await page.evaluate(() => window.__fsnPermissionRequested);
  if (asked) fail('flipping the master switch prompted — it must only reveal the rationale');
  else pass('flipping the master switch did not prompt');

  const rationaleShown = await page.evaluate(() =>
    !document.getElementById('notifyRationale').classList.contains('hidden'));
  if (!rationaleShown) fail('the rationale panel did not appear after opting in');
  else pass('rationale panel revealed, explaining the alerts before any prompt');

  /* Now the one control that is allowed to reach the OS. */
  await page.click('#notifyEnableBtn');
  await page.waitForTimeout(1200);

  asked = await page.evaluate(() => window.__fsnPermissionRequested);
  if (!asked) fail('the explicit opt-in button did not request permission');
  else pass('the opt-in button requested permission (the only path that may)');

  const subscribed = await page.evaluate(() => window.__fsnSubscribeCalled);
  if (!subscribed) fail('permission was granted but no push subscription was created');
  else pass('push subscription created after the grant');

  /* ---- 6. The registration payload must satisfy the real server validators */
  if (!posts.length) {
    fail('the client never POSTed a registration to /api/notifications-register');
  } else {
    const payload = posts[posts.length - 1];
    pass('client registered with platform=' + payload.platform + ', tz=' + payload.timezone);

    const register = await import('../api/notifications-register.js');
    const engine = await import('../api/notifications/triggers.js');

    if (payload.platform !== 'web') fail('expected platform "web" in this runtime, got ' + payload.platform);
    else pass('payload declares the right platform');

    if (!engine.default.normalizeTimeZone(payload.timezone)) {
      fail('the server would reject the timezone the client sent: ' + payload.timezone);
    } else pass('server accepts the client timezone');

    const webpush = await import('../api/notifications/webpush.js');
    if (!webpush.default.validSubscription(payload.subscription)) {
      fail('the server would reject the subscription shape the client sent');
    } else pass('server accepts the subscription shape');

    const cleaned = register.default.cleanPrefs(payload.prefs);
    const groups = ['tuesday', 'thursday', 'sunday'];
    if (groups.some((g) => typeof cleaned[g] !== 'boolean')) {
      fail('preferences did not survive the server cleaner: ' + JSON.stringify(cleaned));
    } else pass('preferences survive the server cleaner: ' + JSON.stringify(cleaned));

    if (!Number.isFinite(Number(payload.seasonYear)) || !Number.isFinite(Number(payload.week))) {
      fail('the client did not send a usable season/week: ' +
        JSON.stringify({ season: payload.seasonYear, week: payload.week }));
    } else pass('client sent league context: season ' + payload.seasonYear + ', week ' + payload.week);
  }

  /* ---- 7. Error budget --------------------------------------------------- */
  if (pageErrors.length) {
    fail(pageErrors.length + ' uncaught page error(s):');
    pageErrors.forEach((e) => console.error('        ' + e.split('\n')[0]));
  } else pass('zero uncaught page errors');

  if (consoleErrors.length) {
    fail(consoleErrors.length + ' tagged console error(s):');
    consoleErrors.forEach((e) => console.error('        ' + e));
  } else pass('zero [FSN*] console errors');

} finally {
  await browser.close();
  server.close();
}

if (failed) {
  console.error('\n[render-check] FAILED');
  process.exit(1);
}
console.log('\n[render-check] clean');
