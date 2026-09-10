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

  /* Mark onboarding complete before boot so the first-time walkthrough does not
     auto-present over the six-screen walk below. This mirrors a returning
     visitor; the walkthrough's own open/navigate/finish behaviour is exercised
     explicitly in its dedicated section. */
  try { window.localStorage.setItem('hasCompletedOnboarding', 'true'); } catch (err) { /* private mode */ }

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
    const engine = await import('../lib/notifications/triggers.js');

    if (payload.platform !== 'web') fail('expected platform "web" in this runtime, got ' + payload.platform);
    else pass('payload declares the right platform');

    if (!engine.default.normalizeTimeZone(payload.timezone)) {
      fail('the server would reject the timezone the client sent: ' + payload.timezone);
    } else pass('server accepts the client timezone');

    const webpush = await import('../lib/notifications/webpush.js');
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

  /* ---- 6.5 FIRST-TIME WALKTHROUGH --------------------------------------
     The intro is re-openable from Setup. Open it, confirm it lands on the
     Welcome slide, step through the five tab-tour slides to the CTA (dots and
     Back tracking the position), confirm each tab tour renders its mini
     bottom-nav map, then finish and confirm both that it closed and that
     completion persisted to the localStorage flag the boot check reads. */
  await page.click('#tabBar .tab-btn[data-tab="setup"]');
  await page.waitForTimeout(300);

  if (!(await page.$('#ftuReopenBtn'))) {
    fail('the Setup tab has no walkthrough re-open trigger');
  } else {
    await page.click('#ftuReopenBtn');
    await page.waitForTimeout(500);

    const opened = await page.getAttribute('#ftuModal', 'data-open');
    if (opened !== 'true') fail('the walkthrough did not open from the Setup trigger');
    else pass('walkthrough opened from Setup');

    const backHiddenAtStart = await page.getAttribute('#ftuBack', 'hidden');
    if (backHiddenAtStart === null) fail('Back is offered on the first slide — nothing to go back to');
    else pass('first slide hides the Back control');

    // The five core tabs each get a tour slide with a highlighted bottom-nav map.
    const tourAudit = await page.evaluate(() => {
      const wanted = ['home', 'matchups', 'news', 'analytics', 'recordbook'];
      return wanted.map((key) => {
        const slide = document.querySelector('.ftu-tour[data-tour-tab="' + key + '"]');
        if (!slide) return { key, ok: false, why: 'missing slide' };
        const lit = slide.querySelector('.ftu-tabstrip .ftu-tab[data-on="true"]');
        const litLabel = lit ? (lit.querySelector('span') || {}).textContent : '';
        const cells = slide.querySelectorAll('.ftu-tabstrip .ftu-tab').length;
        return { key, ok: cells === 5 && !!lit, litLabel: litLabel || '' };
      });
    });
    const brokenTour = tourAudit.find((t) => !t.ok);
    if (brokenTour) fail('a tab-tour slide is malformed: ' + JSON.stringify(brokenTour));
    else pass('all 5 tab tours render a 5-cell nav map with the right tab lit');

    // Welcome → Desk → Matchups → News → Season Stats → Record Book → CTA.
    const dotCount = await page.evaluate(
      () => document.querySelectorAll('#ftuDots .ftu-dot').length
    );
    for (let i = 0; i < dotCount - 1; i++) {
      await page.click('#ftuNext');
      await page.waitForTimeout(420);
    }

    const onLastDot = await page.evaluate(() => {
      const dots = Array.from(document.querySelectorAll('#ftuDots .ftu-dot'));
      return dots.length === 7 && dots[dots.length - 1].dataset.active === 'true';
    });
    if (!onLastDot) fail('the dot indicator did not advance to the final (CTA) slide');
    else pass('advanced Welcome → 5 tab tours → CTA with dots tracking');

    const nextHiddenOnLast = await page.getAttribute('#ftuNext', 'hidden');
    if (nextHiddenOnLast === null) fail('the footer Next button still shows on the CTA slide, duplicating the CTA');
    else pass('CTA slide hands off to its own action button');

    const ctaText = (await page.innerText('#ftuFinish')).trim();
    if (!/connect your league/i.test(ctaText)) fail('the CTA button copy is wrong: ' + ctaText);
    else pass('CTA reads: ' + ctaText);

    await page.click('#ftuFinish');
    await page.waitForTimeout(500);

    const closedAfterFinish = await page.getAttribute('#ftuModal', 'data-open');
    if (closedAfterFinish === 'true') fail('the walkthrough stayed open after the CTA');
    else pass('CTA closed the walkthrough');

    const flag = await page.evaluate(() => {
      try { return window.localStorage.getItem('hasCompletedOnboarding'); } catch (err) { return null; }
    });
    if (flag !== 'true') fail('completion was not persisted (hasCompletedOnboarding=' + flag + ')');
    else pass('completion persisted so returning visitors are not pestered');

    const landedOnSetup = await page.getAttribute('.screen[data-screen="setup"]', 'data-active');
    if (landedOnSetup !== 'true') fail('the CTA did not land the reader on the Setup screen');
    else pass('CTA landed the reader on Setup to connect their league');
  }

  /* Score bindings must update on hydration, without tab switching. */
  await page.click('#tabBar .tab-btn[data-tab="home"]');
  for (const scenario of ['projected', 'missing', 'live', 'live-espn', 'negative', 'final-zero']) {
    const data = syntheticLeague();
    data.schedule.forEach(game=>{
      game.winner = 'UNDECIDED';
      for (const side of ['home','away']) {
        game[side].totalPoints = 0;
        game[side].totalPointsLive = 0;
        game[side].totalProjectedPoints = scenario === 'missing' ? null : (side === 'home' ? '127.8' : '109.4');
      }
      if(scenario === 'live') game.home.totalPoints = 42.7;
      /* The shape ESPN actually serves mid-slate: totalPoints parked at 0
         until the matchup period settles, the real running score streaming in
         totalPointsLive, and the forecast in totalProjectedPoints. This is the
         case that used to put 127.8 in the big score slot and 0.0 nowhere the
         reader could see. */
      if(scenario === 'live-espn'){
        game.home.totalPointsLive = 118.6;
        game.away.totalPointsLive = 104.2;
      }
      if(scenario === 'negative') game.home.totalPoints = -2;
      if(scenario === 'final-zero') game.winner = 'TIE';
    });
    await page.evaluate(data=> window.LeagueData.setEspnData(data), data);
    await page.waitForTimeout(250);
    const values = await page.evaluate(()=>({
      text:document.querySelector('#tickerTrack').textContent,
      items:Array.from(document.querySelectorAll('#tickerTrack .ticker-item')).map(el=>({
        tag:el.querySelector('.tk-tag')?.textContent || '',
        scores:Array.from(el.querySelectorAll('.tk-score')).map(score=>score.textContent),
      })),
      high:document.querySelector('#pulseHigh').textContent,
    }));
    /* The crawl carries four independent reads. Projections ride on their own
       labelled lines and never stand in for a real score, so ACTUAL HIGH /
       ACTUAL LOW appear only once a game is actually under way, and PROJ HIGH /
       PROJ LOW appear only when the feed supplies projections at all. */
    const tagged = (tag)=> values.items.find(entry=> entry.tag === tag);
    const pair = (hi, lo)=> (hi && lo) ? [hi.scores[0], lo.scores[0]] : null;
    const same = (a, b)=> JSON.stringify(a) === JSON.stringify(b);
    const expected = {
      /* pulse is the Desk's HIGH tile. It reads real points only: a week with
         nothing on the board reports — rather than a projection under a label
         that gives the reader no way to tell it is one. */
      projected:    { proj:['127.8','109.4'], actual:null,             pulse:'—' },
      missing:      { proj:null,              actual:null,             pulse:'—' },
      live:         { proj:['127.8','109.4'], actual:['42.7','0.0'],   pulse:'42.7' },
      'live-espn':  { proj:['127.8','109.4'], actual:['118.6','104.2'], pulse:'118.6' },
      negative:     { proj:['127.8','109.4'], actual:['0.0','-2.0'],   pulse:'0.0' },
      'final-zero': { proj:['127.8','109.4'], actual:['0.0','0.0'],    pulse:'0.0' },
    }[scenario];
    const seen = {
      proj: pair(tagged('PROJ HIGH'), tagged('PROJ LOW')),
      actual: pair(tagged('ACTUAL HIGH'), tagged('ACTUAL LOW')),
      pulse: values.high,
    };
    if(!same(seen.proj, expected.proj) || !same(seen.actual, expected.actual) || seen.pulse !== expected.pulse) {
      fail('score hydration ' + scenario + ': expected ' + JSON.stringify(expected) +
        ', saw ' + JSON.stringify(seen) + ' — ' + JSON.stringify(values.items));
    } else pass('score hydration ' + scenario);
    if(/FAAB|WINNING BID|undefined|\[object Object\]/i.test(values.text)) fail('invalid ticker text: ' + values.text);
    if(['projected','missing'].includes(scenario) && values.items.some(item=>item.tag === 'FRAUD')) fail('pregame fraud verdict');
  }

  /* ---- 6.7 MATCHUP CARD SCORE / PROJECTION SPLIT ------------------------
     The true score is the primary value on every card at every state, and the
     projection is a labelled sub-line beneath it. A week that has not kicked
     off must read 0.0 with "Projected: ..." underneath — never the projection
     promoted into the score slot. */
  for (const scenario of ['pregame', 'live', 'live-espn']) {
    const data = syntheticLeague();
    data.schedule.forEach(game=>{
      game.winner = 'UNDECIDED';
      for (const side of ['home','away']) {
        game[side].totalPoints = 0;
        game[side].totalPointsLive = 0;
        game[side].totalProjectedPoints = side === 'home' ? '127.8' : '109.4';
      }
      if(scenario === 'live') game.home.totalPoints = 42.7;
      if(scenario === 'live-espn'){
        game.home.totalPointsLive = 118.6;
        game.away.totalPointsLive = 104.2;
      }
    });
    await page.evaluate(data=> window.LeagueData.setEspnData(data), data);
    await page.click('#tabBar .tab-btn[data-tab="matchups"]');
    await page.waitForTimeout(300);

    const board = await page.evaluate(()=> Array.from(document.querySelectorAll('#matchupList .card')).map(card=>({
      actual: Array.from(card.querySelectorAll('[data-score-actual]')).map(el=> el.dataset.scoreActual),
      projected: Array.from(card.querySelectorAll('[data-score-projected]')).map(el=> el.dataset.scoreProjected),
      text: card.textContent.replace(/\s+/g, ' ').trim(),
    })));

    if(!board.length){ fail('matchup board rendered no cards (' + scenario + ')'); continue; }

    // Away side is rendered first, home second.
    const wantActual = { live:['0.0','42.7'], 'live-espn':['104.2','118.6'] }[scenario] || ['0.0','0.0'];
    const wantProjected = ['109.4','127.8'];
    const broken = board.find(card=>
      JSON.stringify(card.actual) !== JSON.stringify(wantActual) ||
      JSON.stringify(card.projected) !== JSON.stringify(wantProjected));
    if(broken) fail('matchup card score/projection split wrong (' + scenario + '): ' + JSON.stringify(broken));
    else pass('matchup cards (' + scenario + ') show true scores ' + JSON.stringify(wantActual) +
      ' with projections ' + JSON.stringify(wantProjected) + ' beneath');

    const mislabelled = board.find(card=> !/Projected: 109\.4/.test(card.text) || !/Projected: 127\.8/.test(card.text));
    if(mislabelled) fail('projection sub-label copy missing (' + scenario + '): ' + mislabelled.text);
    else pass('projection sub-labels read "Projected: ..." (' + scenario + ')');

    /* ---- Matchup of the Week ----
       The marquee card carries no projection at all: its two scores are real,
       and the combined total in its copy is the sum of those two. A projected
       number here would be indistinguishable from an actual one, because the
       card has nowhere to say which it is. */
    /* Read it on the Desk. The hydration repaint rebuilds the ACTIVE screen,
       so #motwCard still holds the previous scenario's markup while the
       matchup board is in front — asserting against it from here would be
       asserting against stale DOM. */
    await page.click('#tabBar .tab-btn[data-tab="home"]');
    await page.waitForTimeout(300);
    const motw = await page.evaluate(()=>{
      const card = document.getElementById('motwCard');
      return card ? card.textContent.replace(/\s+/g, ' ').trim() : '';
    });
    if(!motw){ fail('the Matchup of the Week card rendered nothing (' + scenario + ')'); continue; }

    const leaked = ['127.8','109.4'].filter(value=> motw.indexOf(value) !== -1);
    if(leaked.length){
      fail('the Matchup of the Week card printed projection value(s) ' + leaked.join(', ') +
        ' with nothing marking them as projections (' + scenario + '): ' + motw);
    } else {
      pass('Matchup of the Week carries no unlabelled projection (' + scenario + ')');
    }

    const wantCombined = { live:'42.7', 'live-espn':'222.8' }[scenario];
    if(!wantCombined){
      // A board with nothing scored quotes no combined total at all.
      // "Combined scoring will land once the slate finalizes" is the pregame
      // copy and carries no number; only "Combined <n>" is a quoted total.
      if(/Combined\s+\d/.test(motw)) fail('Matchup of the Week quoted a combined total before any game scored: ' + motw);
      else pass('Matchup of the Week quotes no combined total before kickoff (' + scenario + ')');
    } else if(motw.indexOf('Combined ' + wantCombined) !== -1){
      pass('Matchup of the Week quotes the real combined total ' + wantCombined + ' (' + scenario + ')');
    } else {
      fail('Matchup of the Week should quote a combined total of ' + wantCombined +
        ' from the two real scores (' + scenario + '): ' + motw);
    }
  }


  /* ---- 6.8 LIVE PROJECTION RECALCULATION --------------------------------
     A team's projection has to move while the slate is being played. The board
     used to print `totalProjectedPoints`, which the provider computes before
     kickoff and never touches again, so a manager whose Thursday-night starter
     doubled his projection still read the rigid pregame number on Friday.

     The engine now rebuilds the forecast from the lineup itself — banked points
     for players who are done, remaining forecast for everyone still to come —
     and these scenarios pin every branch of that chain, including the fallbacks
     that must keep behaving exactly as they did before. */
  {
    const WEEK = 2;

    /* One ESPN-shaped starter. `actual` null means his game has not begun, so
       no statSourceId-0 record exists for him — which is precisely how ESPN
       signals it. `complete` is the per-player "his game is over" flag. */
    const starter = (slotId, playerId, projected, actual, complete) => {
      const stats = [{ statSourceId:1, statSplitTypeId:1, scoringPeriodId:WEEK, appliedTotal:projected }];
      if (actual != null) stats.push({ statSourceId:0, statSplitTypeId:1, scoringPeriodId:WEEK, appliedTotal:actual });
      const entry = {
        lineupSlotId: slotId,
        playerId,
        appliedStatTotal: actual == null ? 0 : actual,
        playerPoolEntry: {
          id: playerId,
          player: { id: playerId, fullName: 'Player ' + playerId, defaultPositionId: 2, stats },
        },
      };
      if (complete) entry.gameComplete = true;
      return entry;
    };

    /* Nine starters in real lineup slots, plus a bench player carrying a fat
       projection that must never reach the team total. */
    const lineup = (idBase, projected, headliner, played) => {
      const slots = [0, 2, 2, 4, 4, 6, 23, 17, 16];
      const entries = slots.map((slot, i) => i === 0 && headliner
        ? starter(slot, idBase + i, headliner.projected, headliner.actual, headliner.complete)
        : starter(slot, idBase + i, projected, played ? projected : null, played));
      entries.push(starter(20, idBase + 90, 30.0, null, false));   // bench — excluded
      return { entries };
    };

    const sumActual = (roster) => roster.entries
      .filter((e) => e.lineupSlotId !== 20 && e.lineupSlotId !== 21)
      .reduce((total, e) => total + (e.appliedStatTotal || 0), 0);

    /* Home: eight starters at 12.0 (96.0) plus a headliner. Away: nine at 11.2
       (100.8) and nothing played, so away is the control that must not move. */
    const HOME_REST = 96.0, AWAY_TOTAL = 100.8;
    const PREGAME_HOME = 108.1;      // 96.0 + the headliner's 12.1 forecast

    const build = (headliner, opts) => {
      const options = opts || {};
      const data = syntheticLeague();
      data.schedule.forEach((game) => {
        if (game.matchupPeriodId !== WEEK) return;
        game.winner = options.winner || 'UNDECIDED';
        /* A settled week has every starter's game behind it; a live week has
           only the headliner's. */
        const homeRoster = lineup(1000, 12.0, headliner, !!options.settled);
        const awayRoster = lineup(2000, 11.2, null, !!options.settled);
        const homeActual = sumActual(homeRoster);
        const awayActual = options.awayActual != null ? options.awayActual : sumActual(awayRoster);

        game.home.rosterForCurrentScoringPeriod = options.stripRosters ? null : homeRoster;
        game.away.rosterForCurrentScoringPeriod = options.stripRosters ? null : awayRoster;
        game.home.totalProjectedPoints = String(PREGAME_HOME);
        game.away.totalProjectedPoints = String(AWAY_TOTAL);
        if (options.providerLive != null) game.home.totalProjectedPointsLive = options.providerLive;

        if (options.settled) {
          game.home.totalPoints = homeActual;
          game.away.totalPoints = awayActual;
        } else {
          game.home.totalPoints = 0;
          game.away.totalPoints = 0;
          game.home.totalPointsLive = homeActual;
          game.away.totalPointsLive = awayActual;
        }
      });
      return data;
    };

    /* The projection sub-lines on the week's cards, away side first. */
    const projectionsOnBoard = async (data) => {
      await page.evaluate((payload) => window.LeagueData.setEspnData(payload), data);
      await page.click('#tabBar .tab-btn[data-tab="matchups"]');
      await page.waitForTimeout(300);
      return page.evaluate(() => Array.from(document.querySelectorAll('#matchupList .card'))
        .map((card) => Array.from(card.querySelectorAll('[data-score-projected]'))
          .map((el) => el.dataset.scoreProjected)));
    };

    const expect = async (label, data, want, why) => {
      const board = await projectionsOnBoard(data);
      if (!board.length) { fail('live projection ' + label + ': the board rendered no cards'); return; }
      const wrong = board.find((card) => JSON.stringify(card) !== JSON.stringify(want));
      if (wrong) fail('live projection ' + label + ': expected ' + JSON.stringify(want) +
        ', saw ' + JSON.stringify(wrong) + ' — ' + why);
      else pass('live projection ' + label + ': ' + why);
    };

    // Nothing kicked off: every starter contributes his forecast and the team
    // total is the pregame number, arrived at honestly rather than copied.
    await expect('pregame', build({ projected:12.1, actual:null, complete:false }),
      [AWAY_TOTAL.toFixed(1), PREGAME_HOME.toFixed(1)],
      'an unplayed lineup sums to its pregame forecast ' + PREGAME_HOME.toFixed(1));

    // THE REPORTED BUG. The Thursday starter beat his 12.1 forecast with 24.6.
    // His banked points replace that forecast and the team climbs by the 12.5
    // he beat it by; the eight starters still to play keep theirs.
    await expect('thursday overperformance',
      build({ projected:12.1, actual:24.6, complete:false }),
      [AWAY_TOTAL.toFixed(1), (HOME_REST + 24.6).toFixed(1)],
      'a starter beating 12.1 with 24.6 lifts the team from ' + PREGAME_HOME.toFixed(1) +
      ' to ' + (HOME_REST + 24.6).toFixed(1) + ' instead of holding the stale pregame total');

    // The same starter, finished with 3.0 against a 12.1 forecast. Once his
    // game is known to be over there is nothing left to project, so the team
    // total falls below the pregame number rather than clinging to it.
    await expect('finished underperformance',
      build({ projected:12.1, actual:3.0, complete:true }),
      [AWAY_TOTAL.toFixed(1), (HOME_REST + 3.0).toFixed(1)],
      'a finished starter at 3.0 against a 12.1 forecast drops the team to ' +
      (HOME_REST + 3.0).toFixed(1));

    // A starter mid-game keeps his forecast as the floor: points already on the
    // board are never projected away, and the rest of his game is still worth
    // what it was worth.
    await expect('mid-game floor',
      build({ projected:12.1, actual:3.0, complete:false }),
      [AWAY_TOTAL.toFixed(1), PREGAME_HOME.toFixed(1)],
      'a starter still playing holds his 12.1 forecast at 3.0 scored');

    // ESPN's own live projection is computed against real game clocks, so when
    // the provider sends one it outranks anything derived here.
    await expect('provider live total',
      build({ projected:12.1, actual:24.6, complete:false }, { providerLive:133.3 }),
      [AWAY_TOTAL.toFixed(1), '133.3'],
      "ESPN's totalProjectedPointsLive outranks the locally derived number");

    // A decided matchup settles every starter at once, so the projection is the
    // final score and cannot disagree with it.
    await expect('settled matchup',
      build({ projected:12.1, actual:24.6, complete:false }, { settled:true, winner:'HOME' }),
      [AWAY_TOTAL.toFixed(1), (HOME_REST + 24.6).toFixed(1)],
      'a final matchup projects exactly what was scored');

    // REGRESSION GUARD. No rosters and no live total is every archive season,
    // every cloud-restored week and both third-party adapters. That path must
    // still print the provider's pregame forecast, untouched.
    await expect('no roster (pregame fallback)',
      build({ projected:12.1, actual:null, complete:false }, { stripRosters:true }),
      [AWAY_TOTAL.toFixed(1), PREGAME_HOME.toFixed(1)],
      'a payload with no lineups still falls back to totalProjectedPoints');

    /* The crawl reads the same number the cards do. PROJ HIGH must be the
       recalculated home total, not the pregame one it used to quote. */
    await page.evaluate((payload) => window.LeagueData.setEspnData(payload),
      build({ projected:12.1, actual:24.6, complete:false }));
    await page.click('#tabBar .tab-btn[data-tab="home"]');
    await page.waitForTimeout(300);
    const projHigh = await page.evaluate(() => {
      const item = Array.from(document.querySelectorAll('#tickerTrack .ticker-item'))
        .find((el) => (el.querySelector('.tk-tag') || {}).textContent === 'PROJ HIGH');
      return item ? (item.querySelector('.tk-score') || {}).textContent : '';
    });
    const wantHigh = (HOME_REST + 24.6).toFixed(1);
    if (projHigh !== wantHigh) {
      fail('the ticker PROJ HIGH reads ' + JSON.stringify(projHigh) + ' but the live projection is ' +
        wantHigh + ' — the crawl is still on the pregame snapshot');
    } else {
      pass('ticker PROJ HIGH quotes the recalculated live projection ' + wantHigh);
    }
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
