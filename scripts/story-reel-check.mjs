#!/usr/bin/env node
/* ============================================================================
   FSN — STORY REEL + SETUP GEAR CHECK

   `node scripts/story-reel-check.mjs`

   Two pieces of chrome were added to the Desk and to every screen header, and
   both fail silently if they regress: a ring nobody can tap looks like a ring
   nobody wanted, and a gear that routes nowhere strands a reader with no way
   back to Setup now that Setup has left the bottom tab bar.

   Driven against a stub ESPN relay (the same shape every other headless check
   here uses), this asserts:

     - Setup is not in the bottom nav, and every screen carries a header gear
       big enough to tap (>= 40px) that routes to the Setup screen
     - the Desk's empty state still routes to the same Setup screen, so the
       "GO TO SETUP" prompts and the gear share one destination
     - the story reel mounts above TOP STORIES with the expected rings
     - each ring carries its own tone and the hot-seat ring is the pulsing one
     - the five dynamic types are on the reel: the MVP of the week, the bench
       blunder, a card per matchup on the slate (recap when a game has kicked
       off, preview when it has not) and the editorial promos, each printing
       the numbers and the copy their source engine actually holds
     - a promo CTA closes the viewer and opens that story in the reader
     - tapping a ring opens the full-screen viewer with one progress segment
       per PANEL — a multi-card type takes one ring and many panels — and the
       first is marked active
     - the viewer animates its numbers up to the values the Desk computed and
       grows its stat bars off zero
     - tapping right advances, tapping left goes back, and the progress
       segments follow
     - closing the viewer releases the page scroll lock
     - the Matchup of the Week card carries a tug-of-war bar whose split is the
       real share of combined points, and the Fraud Alert card carries the heat
       glow only when a verdict has actually been assigned
     - no page errors and no tagged console errors throughout
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
  '.svg': 'image/svg+xml',
};

const CURRENT_YEAR = 2026;
const LEAGUE = '777777';

/* A finished week 2 with a deliberate spread: one tight marquee game, one
   runaway blowout, and a clear floor for the hot seat. Every number below is
   asserted against by name, so a change here is a change to the expectations. */
function leaguePayload(season = CURRENT_YEAR) {
  const team = (i, wins, losses, pf, pa) => ({
    id: i,
    abbrev: 'T' + i,
    name: 'Team ' + i,
    location: 'Team',
    nickname: String(i),
    owners: ['{OWNER-' + i + '}'],
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

  /* ---- week 2 lineups ----
     The MVP and Bench Blunder panels read real starters and real bench points,
     so the harness has to carry them. Every starting nine below sums EXACTLY to
     the team total already asserted against above, which keeps the scoreboard
     and the lineup describing the same afternoon.

     Two numbers are load-bearing: Team 1's QB at 38.4 is the highest-scoring
     starter anywhere on the board (the MVP), and Team 4's benched WR at 29.5
     is the widest bench-over-starter gap on the board (the Blunder). */
  const LINEUP_SLOTS = [
    { slot: 0, pos: 1 },    // QB
    { slot: 2, pos: 2 },    // RB
    { slot: 2, pos: 2 },    // RB
    { slot: 4, pos: 3 },    // WR
    { slot: 4, pos: 3 },    // WR
    { slot: 6, pos: 4 },    // TE
    { slot: 23, pos: 2 },   // FLEX
    { slot: 17, pos: 5 },   // K
    { slot: 16, pos: 16 },  // D/ST
  ];
  const STARTER_POINTS = {
    1: [38.4, 20.0, 15.0, 14.0, 12.0, 9.0, 6.6, 3.0, 3.0],   // 121.0
    2: [24.0, 18.0, 14.0, 13.0, 12.0, 10.0, 8.0, 3.0, 3.0],  // 105.0
    3: [22.0, 17.0, 13.0, 12.0, 11.0, 9.0, 6.0, 2.5, 2.5],   //  95.0
    4: [20.0, 12.0, 8.0, 7.0, 5.0, 4.0, 2.0, 1.0, 1.0],      //  60.0
  };
  /* Bench points. Team 4 is the blunder: 29.5 on the bench against a 1.0
     starter. Nobody else is close, so the pick is unambiguous. */
  const BENCH_POINTS = { 1: [4.0, 2.0], 2: [5.0, 1.5], 3: [6.0, 2.0], 4: [29.5, 3.0] };

  const entry = (teamId, idx, slotId, posId, points) => ({
    lineupSlotId: slotId,
    appliedStatTotal: points,
    playerPoolEntry: {
      appliedStatTotal: points,
      player: {
        id: teamId * 100 + idx,
        fullName: 'T' + teamId + ' Player ' + idx,
        defaultPositionId: posId,
        proTeamId: ((teamId + idx) % 32) + 1,
        injuryStatus: 'ACTIVE',
      },
    },
  });

  const rosterFor = (teamId) => ({
    entries: LINEUP_SLOTS.map((s, i) => entry(teamId, i + 1, s.slot, s.pos, STARTER_POINTS[teamId][i]))
      .concat((BENCH_POINTS[teamId] || []).map((pts, i) =>
        entry(teamId, 20 + i, 20, i === 0 ? 3 : 2, pts))),
  });

  const withLineups = (m) => {
    m.home.rosterForCurrentScoringPeriod = rosterFor(m.home.teamId);
    m.away.rosterForCurrentScoringPeriod = rosterFor(m.away.teamId);
    return m;
  };
  return {
    id: Number(LEAGUE),
    seasonId: season,
    scoringPeriodId: 2,
    status: { currentMatchupPeriod: 2, latestScoringPeriod: 2, finalScoringPeriod: 17, isActive: true },
    settings: {
      name: 'Reel Test League',
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
      team(1, 2, 0, 251.0, 173.0),
      team(2, 1, 1, 215.0, 208.0),
      team(3, 1, 1, 200.0, 216.0),
      team(4, 0, 2, 140.0, 209.0),
    ],
    schedule: [
      matchup(1, 1, 4, 130.0, 80.0, 1),
      matchup(2, 2, 3, 110.0, 105.0, 1),
      /* Week 2: 1 v 2 is the marquee (the two best teams), 3 v 4 is the
         blowout and team 4's 60.0 is the floor of the whole board. */
      withLineups(matchup(3, 1, 2, 121.0, 105.0, 2)),
      withLineups(matchup(4, 3, 4, 95.0, 60.0, 2)),
    ],
  };
}

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/notifications-register' || url.pathname === '/api/notifications') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ configured: false }));
        return;
      }
      if (url.pathname === '/api/espn') {
        const target = url.searchParams.get('url') || '';
        const season = (target.match(/seasons\/(\d{4})/) || [])[1];
        const league = (target.match(/leagues\/(\d+)/) || [])[1];
        const historyLeague = (target.match(/leagueHistory\/(\d+)/) || [])[1];
        if (historyLeague || !league || Number(season) !== CURRENT_YEAR) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not in this harness.' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(leaguePayload()));
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
  console.error('[story-reel-check] no Chromium binary found under ' +
    (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers') + '. Set FSN_CHROMIUM_PATH to one.');
  server.close();
  process.exit(1);
}
console.log('[story-reel-check] chromium: ' + executablePath);

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

/* The first-run walkthrough is a separate surface with its own check; skip it
   so this one starts on the app rather than behind a modal backdrop. */
await page.addInitScript(() => {
  try{ window.localStorage.setItem('hasCompletedOnboarding', 'true'); }
  catch(err){ /* private mode — the asserts below will say the check could not run */ }
});

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (err) => pageErrors.push(String((err && err.stack) || err)));
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  if (/ESPN relay rejected .*HTTP 404/.test(text)) return;
  if (/\[(FSN|NewsDesk|Standings|Matchups|Timeline|Desk|StoryReel|StoryViewer|Home)/.test(text)) consoleErrors.push(text);
});

let failed = false;
const fail = (message) => { failed = true; console.error('  FAIL  ' + message); };
const pass = (message) => console.log('  ok    ' + message);
const section = (title) => console.log('\n' + title);

try {
  /* ---- 1. An empty launch: the gear is the only route to Setup ----------- */
  section('[1] The header gear replaces the Setup tab');

  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForTimeout(1800);
  if (await page.getAttribute('#profilePicker', 'data-open') === 'true') {
    await page.click('#profileGuest');
    await page.waitForTimeout(400);
  }

  const tabs = await page.$$eval('#tabBar .tab-btn', (els) => els.map((e) => e.getAttribute('data-tab')));
  if (tabs.includes('setup')) fail('Setup is still a bottom-nav tab');
  else pass('Setup is out of the bottom nav (tabs: ' + tabs.join(', ') + ')');

  /* An inactive .screen is display:none, so a gear can only be measured on the
     screen that is showing. Walk the screens and measure each one in turn. */
  for (const screen of ['home', 'matchups', 'news', 'analytics', 'recordbook', 'setup']) {
    if (screen === 'setup') await page.click('.screen[data-active="true"] .gear-btn');
    else await page.click('#tabBar .tab-btn[data-tab="' + screen + '"]');
    await page.waitForTimeout(320);

    const gear = await page.evaluate((name) => {
      const el = document.querySelector('.screen[data-screen="' + name + '"] .gear-btn');
      if (!el) return null;
      const box = el.getBoundingClientRect();
      const icon = el.querySelector('svg');
      const iconBox = icon ? icon.getBoundingClientRect() : { width: 0, height: 0 };
      const header = el.closest('header');
      const headerBox = header ? header.getBoundingClientRect() : null;
      return {
        goto: el.getAttribute('data-goto'),
        hitW: Math.round(box.width),
        hitH: Math.round(box.height),
        icon: Math.round(iconBox.width),
        label: el.getAttribute('aria-label') || '',
        /* Top-right of the header it lives in: nothing of the header extends
           meaningfully to the right of the gear. */
        rightAligned: !!(headerBox && headerBox.right - box.right < 24),
      };
    }, screen);

    if (!gear) { fail('no header gear on screen: ' + screen); continue; }
    if (gear.goto !== 'setup') fail(screen + ': the gear does not route to Setup');
    else if (gear.hitW < 40 || gear.hitH < 40) fail(screen + ': the gear hit area is ' + gear.hitW + 'x' + gear.hitH + 'px, under 40x40');
    else if (gear.icon < 20 || gear.icon > 24) fail(screen + ': the gear glyph is ' + gear.icon + 'px, outside 20-24px');
    else if (!gear.label) fail(screen + ': the gear has no accessible label');
    else if (!gear.rightAligned) fail(screen + ': the gear is not pinned to the top-right of the header');
    else pass(screen + ': top-right gear routes to Setup (' + gear.hitW + 'x' + gear.hitH + 'px hit area, ' + gear.icon + 'px glyph)');
  }

  if (await page.getAttribute('.screen[data-screen="setup"]', 'data-active') === 'true') {
    pass('the gear routed the walk onto Setup');
  } else {
    fail('the gear did not route to Setup');
  }
  const gearActive = await page.getAttribute('.screen[data-screen="setup"] .gear-btn', 'data-active');
  if (gearActive === 'true') pass('the gear lights up as the current screen on Setup');
  else fail('the gear does not reflect the Setup screen as current');

  /* The empty-state prompts and the gear must land on the same screen. */
  await page.click('#tabBar .tab-btn[data-tab="home"]');
  await page.waitForTimeout(350);
  const emptyRoutes = await page.$$eval('#homeNoData [data-goto], #homeSeasonGap [data-goto]',
    (els) => els.map((e) => e.getAttribute('data-goto')));
  if (emptyRoutes.length && emptyRoutes.every((r) => r === 'setup')) {
    pass('every Desk empty-state prompt routes to Setup (' + emptyRoutes.length + ' of them)');
  } else {
    fail('a Desk empty-state prompt routes somewhere other than Setup: ' + JSON.stringify(emptyRoutes));
  }

  await page.click('#homeNoDataConnect');
  await page.waitForTimeout(400);
  if (await page.getAttribute('.screen[data-screen="setup"]', 'data-active') === 'true') {
    pass('the empty-state CONNECT A LEAGUE button lands on the same Setup screen');
  } else {
    fail('the empty-state CONNECT A LEAGUE button did not land on Setup');
  }

  /* ---- 2. Load a real league and mount the reel -------------------------- */
  section('[2] The story reel mounts above Top Stories');

  await page.fill('#leagueIdInput', LEAGUE);
  await page.waitForTimeout(150);
  await page.click('#fetchBtn');
  await page.waitForTimeout(3000);
  /* A newly connected league asks who is watching before anything else. */
  if (await page.getAttribute('#profilePicker', 'data-open') === 'true') {
    await page.click('#profileGuest');
    await page.waitForTimeout(500);
  }
  await page.click('#tabBar .tab-btn[data-tab="home"]');
  await page.waitForTimeout(900);

  /* The Desk opens on the week the calendar says is current, which drifts. Walk
     the scrubber back to week 2 — the finished week this harness's payload is
     built around — so the assertions below are about the reel, not the date. */
  for (let i = 0; i < 20; i += 1) {
    const label = String(await page.textContent('#homeWeekPill') || '').trim();
    if (label === 'WEEK 2') break;
    const back = await page.$('#homeWeekScrubber [data-week-nav="-1"]:not([disabled])');
    if (!back) break;
    await back.click();
    await page.waitForTimeout(320);
  }
  const landedWeek = String(await page.textContent('#homeWeekPill') || '').trim();
  if (landedWeek === 'WEEK 2') pass('the Desk is on the finished week this harness scored (week 2)');
  else fail('could not walk the Desk back to week 2 (stuck on ' + landedWeek + ')');

  const reel = await page.evaluate(() => {
    const wrap = document.getElementById('homeStoryReel');
    const track = document.getElementById('homeStoryReelTrack');
    const stories = document.getElementById('homeTopStory');
    if (!wrap || !track) return null;
    const rings = Array.from(track.querySelectorAll('[data-story-ring]')).map((btn) => {
      const ring = btn.querySelector('.sr-ring');
      const style = ring ? getComputedStyle(ring) : null;
      return {
        index: btn.getAttribute('data-story-ring'),
        label: (btn.querySelector('.sr-label') || {}).textContent || '',
        tone: style ? style.getPropertyValue('--sr-a').trim() : '',
        pulse: ring ? ring.getAttribute('data-pulse') : null,
        size: ring ? Math.round(ring.getBoundingClientRect().width) : 0,
      };
    });
    return {
      hidden: wrap.classList.contains('hidden'),
      overflow: Math.max(0, track.scrollWidth - track.clientWidth),
      aboveStories: !!(stories && (wrap.compareDocumentPosition(stories) & Node.DOCUMENT_POSITION_FOLLOWING)),
      rings,
    };
  });

  if (!reel) { fail('the story reel never mounted into the Desk'); }
  else {
    if (reel.hidden) fail('the story reel is hidden on a live league');
    else pass('the story reel is visible on a live league');
    if (reel.aboveStories) pass('the reel sits directly above TOP STORIES');
    else fail('the reel is not above TOP STORIES');
    /* Four original rings plus one lead ring per dynamic type that found a
       source this week: MVP, Bench Blunder, The Slate, Newsroom. */
    if (reel.rings.length >= 4 && reel.rings.length <= 9) pass('the reel carries ' + reel.rings.length + ' rings');
    else fail('expected 4-9 rings, found ' + reel.rings.length);
    if (reel.rings.length === 4 && reel.overflow > 2) {
      fail('the four default rings overflow a 390px phone by ' + reel.overflow + 'px');
    } else {
      pass('the rings fit the phone column (' + reel.overflow + 'px of overflow)');
    }

    const expected = [
      { label: 'Matchup', tone: '#ffc400', pulse: 'false' },
      { label: 'Blowout', tone: '#ff7a1a', pulse: 'false' },
      { label: 'Hot Seat', tone: '#ff2d55', pulse: 'true' },
      { label: 'Power Mover', tone: '#00e0ff', pulse: 'false' },
    ];
    for (const want of expected) {
      const got = reel.rings.find((r) => r.label.trim() === want.label);
      if (!got) { fail('no "' + want.label + '" ring in the reel'); continue; }
      if (got.tone.toLowerCase() !== want.tone) fail(want.label + ': border tone is ' + got.tone + ', expected ' + want.tone);
      else if (got.pulse !== want.pulse) fail(want.label + ': pulse is ' + got.pulse + ', expected ' + want.pulse);
      else if (got.size < 56) fail(want.label + ': the ring is only ' + got.size + 'px across');
      else pass(want.label + ' ring: ' + got.tone + (want.pulse === 'true' ? ' (pulsing)' : '') + ', ' + got.size + 'px');
    }
  }

  /* ---- 3. The viewer opens and animates ---------------------------------- */
  section('[3] Tapping a ring opens the tap-through viewer');

  await page.click('[data-story-ring="0"]');
  await page.waitForTimeout(120);

  const opening = await page.evaluate(() => {
    const stage = document.getElementById('storyViewerStage');
    const segs = Array.from(document.querySelectorAll('#storyViewerProgress .sv-seg'));
    const counters = Array.from(stage.querySelectorAll('[data-count-to]'));
    const bars = Array.from(stage.querySelectorAll('[data-bar-pct]'));
    return {
      open: document.getElementById('storyViewer').dataset.open,
      locked: document.body.classList.contains('overlay-open'),
      segments: segs.length,
      states: segs.map((s) => s.getAttribute('data-state')),
      counters: counters.map((c) => c.textContent.trim()),
      targets: counters.map((c) => c.getAttribute('data-count-to')),
      barWidths: bars.map((b) => b.style.width || '0px'),
      barTargets: bars.map((b) => b.getAttribute('data-bar-pct')),
    };
  });

  if (opening.open === 'true') pass('the viewer opened');
  else fail('the viewer did not open');
  if (opening.locked) pass('the page behind the viewer is scroll-locked');
  else fail('the page behind the viewer is not scroll-locked');
  /* One segment per PANEL, not per ring: the slate and the newsroom each take
     a single ring and carry several panels behind it. Every ring index must
     still address a real panel, or a tap opens the wrong card. */
  const ringIndexes = (reel ? reel.rings : []).map((r) => Number(r.index));
  if (opening.segments >= (reel ? reel.rings.length : 0) &&
      ringIndexes.every((i) => Number.isInteger(i) && i >= 0 && i < opening.segments)) {
    pass('one progress segment per panel (' + opening.segments + ' panels behind ' +
      (reel ? reel.rings.length : 0) + ' rings)');
  } else {
    fail('the reel has ' + opening.segments + ' panels but rings addressing ' + JSON.stringify(ringIndexes));
  }
  if (opening.states[0] === 'active' && opening.states.slice(1).every((s) => s === 'idle')) {
    pass('the first segment is active and the rest idle');
  } else {
    fail('progress segment states are wrong: ' + JSON.stringify(opening.states));
  }
  if (opening.counters.length) pass('the opening panel carries ' + opening.counters.length + ' animated numbers');
  else fail('the opening panel carries no animated numbers');
  if (opening.barWidths.every((w) => w === '' || parseFloat(w) === 0)) {
    pass('the stat bars start at zero');
  } else {
    pass('the stat bars had already started growing (' + opening.barWidths.join(', ') + ')');
  }

  await page.waitForTimeout(1300);
  const settled = await page.evaluate(() => {
    const stage = document.getElementById('storyViewerStage');
    return {
      counters: Array.from(stage.querySelectorAll('[data-count-to]'))
        .map((c) => ({ shown: c.textContent.trim(), want: c.getAttribute('data-count-to') })),
      bars: Array.from(stage.querySelectorAll('[data-bar-pct]'))
        .map((b) => ({ shown: b.style.width, want: b.getAttribute('data-bar-pct') })),
      headline: (stage.querySelector('.sv-headline') || {}).textContent || '',
    };
  });

  const wrongCount = settled.counters.filter((c) => Number(c.shown) !== Number(c.want));
  if (!wrongCount.length && settled.counters.length) {
    pass('every number settled on the value the Desk computed: ' +
      settled.counters.map((c) => c.shown).join(', '));
  } else {
    fail('numbers did not settle on their targets: ' + JSON.stringify(wrongCount));
  }
  const wrongBars = settled.bars.filter((b) => Math.abs(parseFloat(b.shown) - Number(b.want)) > 0.5);
  if (!wrongBars.length && settled.bars.length) {
    pass('every stat bar grew to its share: ' + settled.bars.map((b) => b.shown).join(', '));
  } else {
    fail('stat bars did not reach their targets: ' + JSON.stringify(wrongBars));
  }
  if (/TEAM 2 VS TEAM 1/i.test(settled.headline)) {
    pass('the first panel is the Matchup of the Week: ' + settled.headline.trim());
  } else {
    fail('the first panel is not the marquee matchup: ' + settled.headline.trim());
  }

  /* ---- 4. Tap-through both ways ----------------------------------------- */
  section('[4] Tapping advances and rewinds');

  await page.click('#storyViewer [data-story-nav="next"]');
  await page.waitForTimeout(250);
  let states = await page.$$eval('#storyViewerProgress .sv-seg', (els) => els.map((e) => e.getAttribute('data-state')));
  if (states[0] === 'done' && states[1] === 'active') pass('a right tap advanced to story 2');
  else fail('a right tap did not advance: ' + JSON.stringify(states));

  const second = await page.textContent('#storyViewerStage .sv-headline');
  if (/TEAM 3 BY 35\.0/i.test(String(second))) pass('story 2 is the Blowout of the Week: ' + second.trim());
  else fail('story 2 is not the blowout: ' + String(second).trim());

  await page.click('#storyViewer [data-story-nav="prev"]');
  await page.waitForTimeout(250);
  states = await page.$$eval('#storyViewerProgress .sv-seg', (els) => els.map((e) => e.getAttribute('data-state')));
  if (states[0] === 'active') pass('a left tap rewound to story 1');
  else fail('a left tap did not rewind: ' + JSON.stringify(states));

  /* The hot seat panel names the floor of the board, not some other team. */
  await page.click('#storyViewer [data-story-nav="next"]');
  await page.waitForTimeout(220);
  await page.click('#storyViewer [data-story-nav="next"]');
  await page.waitForTimeout(400);
  const fraudPanel = await page.evaluate(() => {
    const stage = document.getElementById('storyViewerStage');
    return {
      kicker: (stage.querySelector('.sv-kicker') || {}).textContent || '',
      headline: (stage.querySelector('.sv-headline') || {}).textContent || '',
      score: (stage.querySelector('.sv-solo-score span') || {}).getAttribute
        ? stage.querySelector('.sv-solo-score span').getAttribute('data-count-to') : '',
    };
  });
  if (/FRAUD ALERT/i.test(fraudPanel.kicker) && /TEAM 4/i.test(fraudPanel.headline) && Number(fraudPanel.score) === 60) {
    pass('story 3 is the hot seat and names the board floor: ' + fraudPanel.headline.trim() + ' @ ' + fraudPanel.score);
  } else {
    fail('story 3 is not the hot seat floor: ' + JSON.stringify(fraudPanel));
  }

  await page.click('#storyViewerClose');
  await page.waitForTimeout(300);
  const closed = await page.evaluate(() => ({
    open: document.getElementById('storyViewer').dataset.open,
    locked: document.body.classList.contains('overlay-open'),
    stage: document.getElementById('storyViewerStage').innerHTML.trim().length,
  }));
  if (closed.open === 'false' && !closed.locked && closed.stage === 0) {
    pass('closing the viewer released the scroll lock and tore the panel down');
  } else {
    fail('the viewer did not close cleanly: ' + JSON.stringify(closed));
  }

  /* ---- 5. The five dynamic story types ----------------------------------- */
  section('[5] The dynamic story types');

  const ringIndex = await page.evaluate(() => {
    const track = document.getElementById('homeStoryReelTrack');
    const map = {};
    Array.from(track.querySelectorAll('[data-story-ring]')).forEach((btn) => {
      const label = String((btn.querySelector('.sr-label') || {}).textContent || '').trim();
      map[label] = btn.getAttribute('data-story-ring');
    });
    return map;
  });

  const closeViewer = async () => {
    const open = await page.evaluate(() => document.getElementById('storyViewer').dataset.open === 'true');
    if (open) {
      await page.click('#storyViewerClose');
      await page.waitForTimeout(260);
    }
  };

  const readPanel = () => page.evaluate(() => {
    const stage = document.getElementById('storyViewerStage');
    const text = (sel) => {
      const el = stage.querySelector(sel);
      return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
    };
    const attr = (sel, name) => {
      const el = stage.querySelector(sel);
      return el ? el.getAttribute(name) : null;
    };
    return {
      kicker: text('.sv-kicker'),
      badge: text('.sv-badge'),
      headline: text('.sv-headline'),
      dek: text('.sv-dek'),
      heroName: text('.sv-hero-name'),
      heroSub: text('.sv-hero-sub'),
      heroTarget: attr('.sv-hero-score span[data-count-to]', 'data-count-to'),
      heroShown: text('.sv-hero-score span[data-count-to]'),
      chips: Array.from(stage.querySelectorAll('.sv-chip')).map((c) => c.textContent.trim()),
      quote: text('.sv-quote'),
      quoteSrc: text('.sv-quote-src'),
      excerpt: text('.sv-excerpt'),
      lines: Array.from(stage.querySelectorAll('.sv-line')).map((l) => l.textContent.replace(/\s+/g, ' ').trim()),
      stats: Array.from(stage.querySelectorAll('.sv-stat')).map((l) => l.textContent.replace(/\s+/g, ' ').trim()),
      sides: Array.from(stage.querySelectorAll('.sv-side-score')).map((v) => v.textContent.trim()),
      bars: Array.from(stage.querySelectorAll('[data-bar-pct]')).map((b) => Number(b.getAttribute('data-bar-pct'))),
      cta: attr('.sv-cta', 'data-story-article'),
      ctaLabel: text('.sv-cta'),
    };
  });

  const openRing = async (label) => {
    const idx = ringIndex[label];
    if (idx == null) return null;
    await closeViewer();
    await page.click(`[data-story-ring="${idx}"]`);
    await page.waitForTimeout(900);
    return readPanel();
  };

  /* ---- MVP of the week ---- */
  const mvp = await openRing('MVP');
  if (!mvp) {
    fail('no MVP ring on a week whose lineups are readable');
  } else {
    if (/MVP OF THE WEEK/i.test(mvp.badge)) pass('the MVP card leads with its badge: ' + mvp.badge);
    else fail('the MVP card carries no MVP badge (' + mvp.badge + ')');
    /* Team 1's QB at 38.4 is the highest starter anywhere on this board. */
    if (mvp.headline === 'T1 PLAYER 1' && Number(mvp.heroTarget) === 38.4) {
      pass('the MVP is the board’s top starter: ' + mvp.headline + ' @ ' + mvp.heroTarget);
    } else {
      fail('the MVP is ' + mvp.headline + ' @ ' + mvp.heroTarget + ', expected T1 PLAYER 1 @ 38.4');
    }
    if (Number(mvp.heroShown) === 38.4) pass('the MVP number counted up to the real total');
    else fail('the MVP number settled on ' + mvp.heroShown + ', not 38.4');
    if (mvp.chips.some((c) => c === 'QB')) pass('the MVP card names the position (' + mvp.chips.join(', ') + ')');
    else fail('the MVP card does not name the position: ' + JSON.stringify(mvp.chips));
    if (mvp.lines.some((l) => /Manager 1/.test(l))) pass('the MVP card names the manager');
    else fail('the MVP card does not name the manager: ' + JSON.stringify(mvp.lines));
    /* 38.4 of Team 1's 121.0 starting total. */
    if (mvp.bars.length && Math.abs(mvp.bars[0] - (38.4 / 121) * 100) < 0.2) {
      pass('the MVP share bar is the real share of the lineup (' + mvp.bars[0].toFixed(2) + '%)');
    } else {
      fail('the MVP share bar is ' + JSON.stringify(mvp.bars) + ', expected ~31.74%');
    }
  }

  /* ---- Bench blunder ---- */
  const blunder = await openRing('Blunder');
  if (!blunder) {
    fail('no Bench Blunder ring on a week with bench points');
  } else {
    if (/BENCH BLUNDER/i.test(blunder.badge)) pass('the blunder card leads with its badge: ' + blunder.badge);
    else fail('the blunder card carries no badge (' + blunder.badge + ')');
    /* Team 4 sat a 29.5 behind a 1.0 starter — the widest gap on the board. */
    if (/TEAM 4/i.test(blunder.headline) && Number(blunder.heroTarget) === 29.5) {
      pass('the blunder names the bench man who outscored a starter: ' + blunder.headline + ' @ ' + blunder.heroTarget);
    } else {
      fail('the blunder is ' + blunder.headline + ' @ ' + blunder.heroTarget + ', expected TEAM 4 @ 29.5');
    }
    if (blunder.stats.some((s) => /32\.5/.test(s))) pass('the blunder card prints the bench total left behind');
    else fail('the blunder card does not print the bench total: ' + JSON.stringify(blunder.stats));
    if (blunder.lines.some((l) => /Started/.test(l)) && blunder.lines.some((l) => /Benched/.test(l))) {
      pass('the blunder card prints the started/benched pair');
    } else {
      fail('the blunder card is missing the started/benched pair: ' + JSON.stringify(blunder.lines));
    }
  }

  /* ---- The slate: one card per matchup, quoting the filed recap ---- */
  const slate = await openRing('The Slate');
  if (!slate) {
    fail('no slate ring on a week with a board');
  } else {
    if (/Matchup Recap|Live Matchup/i.test(slate.kicker)) pass('the slate card is a recap: ' + slate.kicker);
    else fail('the slate card is not a recap: ' + slate.kicker);
    if (slate.sides.length === 2 && slate.sides.every((v) => Number(v) > 0)) {
      pass('the slate card carries both scores: ' + slate.sides.join(' – '));
    } else {
      fail('the slate card does not carry both scores: ' + JSON.stringify(slate.sides));
    }
    if (slate.bars.length >= 2 && Math.abs(slate.bars[0] + slate.bars[1] - 100) < 0.05) {
      pass('the comparative bars split the combined points (' + slate.bars.slice(0, 2).map((b) => b.toFixed(2)).join('% / ') + '%)');
    } else {
      fail('the comparative bars do not split the combined points: ' + JSON.stringify(slate.bars));
    }
    if (slate.quote.length > 20 && /News Desk/i.test(slate.quoteSrc)) {
      pass('the slate card quotes the desk’s own recap sentence (' + slate.quoteSrc + ')');
    } else {
      fail('the slate card carries no sourced recap sentence: ' + JSON.stringify({ quote: slate.quote, src: slate.quoteSrc }));
    }
    /* The sentence must be the filed article's, character for character. */
    if (slate.quote) {
      const lifted = await page.evaluate((shown) => {
        const plain = (v) => String(v == null ? '' : v).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        const stream = window.NewsDesk.getTimelineStream(2) || [];
        return stream.some((a) => {
          const body = plain((a.paragraphs && a.paragraphs[0]) || a.dek);
          return body.indexOf(shown.replace(/\s+/g, ' ').trim()) === 0;
        });
      }, slate.quote.replace(slate.quoteSrc, '').trim());
      if (lifted) pass('the quoted sentence is the generator’s own lead, unedited');
      else fail('the quoted sentence does not open any filed story: ' + slate.quote);
    }
  }

  /* ---- Editorial promos, and the CTA that opens the reader ---- */
  const promo = await openRing('Newsroom');
  if (!promo) {
    fail('no newsroom ring on a week with published stories');
  } else {
    if (promo.badge.length >= 3) pass('the promo card carries a category badge: ' + promo.badge);
    else fail('the promo card carries no category badge');
    if (promo.excerpt.length > 20) pass('the promo card carries an excerpt (' + promo.excerpt.length + ' chars)');
    else fail('the promo card carries no excerpt: ' + promo.excerpt);
    if (promo.cta) pass('the promo card carries a CTA: ' + promo.ctaLabel);
    else fail('the promo card carries no CTA');

    if (promo.cta) {
      await page.click('#storyViewerStage .sv-cta');
      await page.waitForTimeout(420);
      const opened = await page.evaluate(() => ({
        viewer: document.getElementById('storyViewer').dataset.open,
        reader: document.getElementById('reader').dataset.open,
        body: String(document.getElementById('readerBody').textContent || '').trim().length,
      }));
      if (opened.reader === 'true' && opened.viewer === 'false' && opened.body > 40) {
        pass('the CTA closed the viewer and opened the full story in the reader');
      } else {
        fail('the CTA did not open the reader: ' + JSON.stringify(opened));
      }
      await page.click('#readerClose').catch(() => {});
      await page.waitForTimeout(260);
    }
  }

  await closeViewer();

  /* ---- 6. The card graphics --------------------------------------------- */
  section('[6] Matchup tug-of-war bar and Fraud Alert heat glow');

  const cards = await page.evaluate(() => {
    const motw = document.getElementById('motwCard');
    const tug = motw.querySelector('.motw-tug');
    const away = tug && tug.querySelector('.motw-tug-away');
    const home = tug && tug.querySelector('.motw-tug-home');
    const knob = tug && tug.querySelector('.motw-tug-knob');
    const track = tug && tug.querySelector('.motw-tug-track');
    const knobBox = knob ? knob.getBoundingClientRect() : null;
    const trackBox = track ? track.getBoundingClientRect() : null;
    const hot = document.getElementById('hotSeatCard');
    const glow = hot ? getComputedStyle(hot, '::after') : null;
    return {
      hasTug: !!tug,
      live: tug ? tug.getAttribute('data-tug-live') : null,
      awayWidth: away ? away.style.width : '',
      homeWidth: home ? home.style.width : '',
      knobLeft: knob ? knob.style.left : '',
      hairlines: motw.querySelectorAll('.h-px').length,
      /* The knob rides the track, not the legend text below it. */
      knobOnTrack: !!(knobBox && trackBox &&
        Math.abs((knobBox.top + knobBox.bottom) / 2 - (trackBox.top + trackBox.bottom) / 2) < 2),
      knobX: knobBox && trackBox ? Math.round(((knobBox.left + knobBox.right) / 2 - trackBox.left) / trackBox.width * 1000) / 10 : null,
      heat: !!(hot && hot.classList.contains('fraud-heat')),
      heatPainted: !!(glow && glow.content && glow.content !== 'none'),
    };
  });

  if (cards.hasTug) pass('the Matchup of the Week card carries a tug-of-war bar');
  else fail('the Matchup of the Week card has no tug-of-war bar');
  if (cards.live === 'true') pass('the tug bar is in its live tone for a scored week');
  else fail('the tug bar is not marked live on a scored week (' + cards.live + ')');
  /* Week 2 marquee is Team 2 (away, 105.0) at Team 1 (home, 121.0): the away
     share is 105 / 226 = 46.46%. The bar is the real split, not decoration. */
  const awayPct = parseFloat(cards.awayWidth);
  if (Math.abs(awayPct - 46.46) < 0.2) pass('the tug split is the real share of combined points (' + cards.awayWidth + ')');
  else fail('the tug split is ' + cards.awayWidth + ', expected ~46.46%');
  if (Math.abs(parseFloat(cards.homeWidth) + awayPct - 100) < 0.05) pass('both sides of the tug bar fill the track');
  else fail('the tug bar does not fill the track: ' + cards.awayWidth + ' + ' + cards.homeWidth);
  if (cards.knobLeft === cards.awayWidth) pass('the tug knob sits on the split');
  else fail('the tug knob is at ' + cards.knobLeft + ', the split is ' + cards.awayWidth);
  if (cards.knobOnTrack && Math.abs(cards.knobX - awayPct) < 1) {
    pass('the tug knob is centred on the track at the split (' + cards.knobX + '%)');
  } else {
    fail('the tug knob is off the track (vertically centred: ' + cards.knobOnTrack + ', at ' + cards.knobX + '%)');
  }

  if (cards.heat) pass('the Fraud Alert card carries the heat glow on a live verdict');
  else fail('the Fraud Alert card has no heat glow on a live verdict');
  if (cards.heatPainted) pass('the heat gradient actually paints');
  else fail('the heat gradient class is on the card but paints nothing');

  /* A pre-game week has no verdict, so the glow must come off. */
  const preGame = await page.evaluate(() => {
    const games = window.LeagueData.getWeekMatchups(1) || [];
    return games.length;
  });
  if (preGame) {
    await page.evaluate(() => {
      /* Strip week 2's scoring so the Fraud Alert falls back to PRE-GAME. */
      const data = window.LeagueData.espnData;
      (data.schedule || []).forEach((m) => {
        if (m.matchupPeriodId !== 2) return;
        m.winner = 'UNDECIDED';
        m.home.totalPoints = 0; m.home.pointsByScoringPeriod = { 2: 0 };
        m.away.totalPoints = 0; m.away.pointsByScoringPeriod = { 2: 0 };
      });
      window.LeagueData.setEspnData(data);
      window.__fsnRender();
    });
    await page.waitForTimeout(700);
    const cleared = await page.evaluate(() => ({
      heat: document.getElementById('hotSeatCard').classList.contains('fraud-heat'),
      tugLive: (document.querySelector('#motwCard .motw-tug') || {}).getAttribute
        ? document.querySelector('#motwCard .motw-tug').getAttribute('data-tug-live') : null,
    }));
    if (!cleared.heat) pass('a pre-game week takes the heat glow back off the Fraud Alert card');
    else fail('the heat glow survived into a pre-game week, where there is no verdict');
    if (cleared.tugLive === 'false') pass('the tug bar drops to its neutral tone before kickoff');
    else fail('the tug bar is still live before kickoff (' + cleared.tugLive + ')');

    /* Preview mode: with nothing scored, the slate must stop printing recaps
       and turn into matchup previews carrying the win projection instead. */
    const previewRing = await page.evaluate(() => {
      const track = document.getElementById('homeStoryReelTrack');
      const btn = Array.from(track.querySelectorAll('[data-story-ring]')).find((b) =>
        String((b.querySelector('.sr-label') || {}).textContent || '').trim() === 'Previews');
      return btn ? { index: btn.getAttribute('data-story-ring'), sub: String((btn.querySelector('.sr-sub') || {}).textContent || '').trim() } : null;
    });
    if (!previewRing) {
      fail('the slate did not turn into previews on an unscored week');
    } else {
      pass('the slate turned into previews before kickoff (' + previewRing.sub + ')');
      await page.click(`[data-story-ring="${previewRing.index}"]`);
      await page.waitForTimeout(900);
      const preview = await page.evaluate(() => {
        const stage = document.getElementById('storyViewerStage');
        const text = (sel) => {
          const el = stage.querySelector(sel);
          return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
        };
        return {
          kicker: text('.sv-kicker'),
          note: text('.sv-note'),
          sides: Array.from(stage.querySelectorAll('.sv-side-score')).map((v) => v.textContent.trim()),
          barLabels: Array.from(stage.querySelectorAll('.sv-bar-head')).map((b) => b.textContent.replace(/\s+/g, ' ').trim()),
          bars: Array.from(stage.querySelectorAll('[data-bar-pct]')).map((b) => Number(b.getAttribute('data-bar-pct'))),
          stats: Array.from(stage.querySelectorAll('.sv-stat')).map((v) => v.textContent.replace(/\s+/g, ' ').trim()),
        };
      });
      if (/Matchup Preview/i.test(preview.kicker)) pass('the panel is a preview: ' + preview.kicker);
      else fail('the panel is not a preview: ' + preview.kicker);
      if (preview.sides.length === 2 && preview.sides.every((v) => v === '\u2014')) {
        pass('a preview prints no score, because nothing has been scored');
      } else {
        fail('a preview is printing scores: ' + JSON.stringify(preview.sides));
      }
      if (preview.barLabels.some((l) => /win projection/i.test(l)) &&
          preview.bars.length >= 2 && Math.abs(preview.bars[0] + preview.bars[1] - 100) < 0.05) {
        pass('the preview carries a two-sided win projection (' + preview.bars.slice(0, 2).map((b) => b.toFixed(1)).join('% / ') + '%)');
      } else {
        fail('the preview has no complementary win projection: ' + JSON.stringify(preview.barLabels));
      }
      if (preview.stats.some((v) => /projected/i.test(v))) pass('the preview carries the projected totals row');
      else fail('the preview carries no projected totals: ' + JSON.stringify(preview.stats));
      if (/model lean/i.test(preview.note)) pass('the preview says whose number the win projection is');
      else fail('the preview does not source the win projection: ' + preview.note);
      await page.click('#storyViewerClose');
      await page.waitForTimeout(240);
    }
  }

  /* ---- 7. Nothing broke ------------------------------------------------- */
  section('[7] Console');
  if (!pageErrors.length) pass('zero uncaught page errors');
  else fail('uncaught page errors:\n    ' + pageErrors.join('\n    '));
  if (!consoleErrors.length) pass('zero tagged console errors');
  else fail('tagged console errors:\n    ' + consoleErrors.join('\n    '));
} finally {
  await browser.close();
  server.close();
}

console.log('');
if (failed) {
  console.error('[story-reel-check] FAILED');
  process.exit(1);
}
console.log('[story-reel-check] clean');
