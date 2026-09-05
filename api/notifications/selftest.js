/* ============================================================================
   FSN NOTIFICATIONS — TRIGGER ENGINE SELF-TEST

   `node api/notifications/selftest.js`

   index.html has no test suite and the api/ routes have none either, so this
   is a standalone assertion script for the one part of the push stack that is
   pure computation and genuinely easy to get wrong: timezone-anchored
   scheduling across DST boundaries, the grace window, the opt-in gate, and
   copy determinism.

   It requires no credentials, no database, and no network. Exit code 0 means
   every case passed.
============================================================================ */

'use strict';

const E = require('./triggers');

let passed = 0;
const failures = [];

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { passed++; return; }
  failures.push(label + '\n     expected ' + b + '\n     actual   ' + a);
}

function checkTrue(label, value) { check(label, !!value, true); }

/* Readable UTC stamp for a failure message. */
const iso = (ms) => new Date(ms).toISOString();

/* ---------------------------------------------------------------------------
   1. tzParts / wallClockToInstant round-trip
--------------------------------------------------------------------------- */
{
  // 2026-09-08T13:00:00Z is 09:00 in New York (EDT, UTC-4) on a Tuesday.
  const p = E.tzParts('America/New_York', new Date(Date.UTC(2026, 8, 8, 13, 0, 0)));
  check('tzParts NY hour', p.hour, 9);
  check('tzParts NY weekday (Tue)', p.weekday, 2);
  check('tzParts NY day', p.day, 8);

  const back = E.wallClockToInstant('America/New_York', 2026, 9, 8, 9);
  check('wallClock->instant NY 09:00', iso(back), '2026-09-08T13:00:00.000Z');

  // Same wall clock, Los Angeles (PDT, UTC-7).
  const la = E.wallClockToInstant('America/Los_Angeles', 2026, 9, 8, 9);
  check('wallClock->instant LA 09:00', iso(la), '2026-09-08T16:00:00.000Z');

  // A zone with a half-hour offset, to catch offset math that assumes whole hours.
  const kolkata = E.wallClockToInstant('Asia/Kolkata', 2026, 9, 8, 9);
  check('wallClock->instant Kolkata 09:00', iso(kolkata), '2026-09-08T03:30:00.000Z');
}

/* ---------------------------------------------------------------------------
   2. DST correctness

   US fall-back is 2026-11-01. A Sunday 09:00 alert must stay 09:00 LOCAL on
   both sides of it, which means the UTC instant shifts by an hour. This is the
   case a fixed-offset implementation gets wrong.
--------------------------------------------------------------------------- */
{
  // Sunday 2026-10-25 09:00 EDT (UTC-4) -> 13:00Z
  const before = E.mostRecentLocalOccurrence(
    'America/New_York', 0, 9, Date.UTC(2026, 9, 25, 20, 0, 0));
  check('DST: Sun 09:00 local before fall-back', iso(before), '2026-10-25T13:00:00.000Z');

  // Sunday 2026-11-01 09:00 EST (UTC-5) -> 14:00Z
  const after = E.mostRecentLocalOccurrence(
    'America/New_York', 0, 9, Date.UTC(2026, 10, 1, 20, 0, 0));
  check('DST: Sun 09:00 local after fall-back', iso(after), '2026-11-01T14:00:00.000Z');
}

/* ---------------------------------------------------------------------------
   3. mostRecentLocalOccurrence never returns a future instant
--------------------------------------------------------------------------- */
{
  // Tuesday 2026-09-08, 07:00 local NY (11:00Z) — the 09:00 Tuesday window has
  // NOT opened yet, so the most recent occurrence is the previous Tuesday.
  const now = Date.UTC(2026, 8, 8, 11, 0, 0);
  const got = E.mostRecentLocalOccurrence('America/New_York', 2, 9, now);
  checkTrue('most recent occurrence is in the past', got <= now);
  check('pre-window Tuesday falls back a week', iso(got), '2026-09-01T13:00:00.000Z');
}

/* ---------------------------------------------------------------------------
   4. dueTriggers — opt-in gating, grace window, ledger suppression
--------------------------------------------------------------------------- */
{
  const device = {
    deviceId: 'test',
    timezone: 'America/New_York',
    seasonYear: 2026,
    week: 1,
    prefs: { tuesday: true, thursday: true, sunday: true },
  };
  const ids = (list) => list.map((d) => d.trigger.id);

  // Tuesday 2026-09-08 09:05 local NY = 13:05Z -> waiver_wire only.
  const tueMorning = Date.UTC(2026, 8, 8, 13, 5, 0);
  check('Tuesday 09:05 fires waivers only', ids(E.dueTriggers(device, tueMorning, [])), ['waiver_wire']);

  // Same instant, but the ledger already has the send -> nothing.
  const key = E.sendKey('waiver_wire', 2026, 1);
  check('ledger suppresses a repeat', ids(E.dueTriggers(device, tueMorning, [key])), []);

  // Tuesday 18:05 local: the recap window opens. The 09:00 waiver window is
  // 9h old, well past GRACE_MS, so it must NOT resurface.
  const tueEvening = Date.UTC(2026, 8, 8, 22, 5, 0);
  check('Tuesday 18:05 fires recap only', ids(E.dueTriggers(device, tueEvening, [])), ['weekly_recap']);

  // Two hours late still delivers (grace window).
  const lateCron = Date.UTC(2026, 8, 8, 15, 5, 0);
  check('2h-late cron still delivers waivers', ids(E.dueTriggers(device, lateCron, [])), ['waiver_wire']);

  // Four hours late is dropped.
  const tooLate = Date.UTC(2026, 8, 8, 17, 30, 0);
  check('4h-late cron drops the send', ids(E.dueTriggers(device, tooLate, [])), []);

  // Opted out of Tuesday -> nothing, even inside the window.
  const optedOut = Object.assign({}, device, { prefs: { thursday: true, sunday: true } });
  check('opted-out group never fires', ids(E.dueTriggers(optedOut, tueMorning, [])), []);

  // Absent prefs object is treated as consent-absent, not consent-granted.
  const noPrefs = Object.assign({}, device, { prefs: undefined });
  check('missing prefs means no consent', ids(E.dueTriggers(noPrefs, tueMorning, [])), []);

  // A non-boolean truthy value is not consent either.
  const sloppy = Object.assign({}, device, { prefs: { tuesday: 'yes' } });
  check('non-boolean pref is not consent', ids(E.dueTriggers(sloppy, tueMorning, [])), []);
}

/* ---------------------------------------------------------------------------
   5. Kickoff anchoring — the whole league is warned at one absolute instant
--------------------------------------------------------------------------- */
{
  // TNF kickoff 2026-09-10 20:15 ET = 2026-09-11T00:15Z. Lead is 2h, so the
  // target instant is 2026-09-10T22:15Z regardless of the device's timezone.
  const kickoff = Date.UTC(2026, 8, 11, 0, 15, 0);
  const base = {
    deviceId: 'anchored',
    seasonYear: 2026,
    week: 1,
    firstKickoffMs: kickoff,
    prefs: { thursday: true },
  };
  const ny = Object.assign({}, base, { timezone: 'America/New_York' });
  const la = Object.assign({}, base, { timezone: 'America/Los_Angeles' });

  const at = Date.UTC(2026, 8, 10, 22, 20, 0); // 5 min after the anchor
  check('kickoff anchor fires in NY', E.dueTriggers(ny, at, []).map((d) => d.trigger.id), ['tnf_lock']);
  check('kickoff anchor fires in LA', E.dueTriggers(la, at, []).map((d) => d.trigger.id), ['tnf_lock']);

  const early = Date.UTC(2026, 8, 10, 21, 0, 0); // before the anchor
  check('kickoff anchor holds before the lead window', E.dueTriggers(ny, early, []), []);

  // With no hydrated kickoff, the trigger falls back to 16:00 local Thursday.
  const noKick = Object.assign({}, base, { timezone: 'America/New_York', firstKickoffMs: null });
  const thu16 = Date.UTC(2026, 8, 10, 20, 5, 0); // 16:05 EDT Thursday
  check('kickoff fallback uses local 16:00', E.dueTriggers(noKick, thu16, []).map((d) => d.trigger.id), ['tnf_lock']);
}

/* ---------------------------------------------------------------------------
   6. Bad timezone is contained, not fatal
--------------------------------------------------------------------------- */
{
  check('unknown timezone rejected', E.normalizeTimeZone('Mars/Olympus_Mons'), null);
  check('empty timezone rejected', E.normalizeTimeZone(''), null);
  check('valid timezone accepted', E.normalizeTimeZone('Europe/London'), 'Europe/London');

  const broken = {
    deviceId: 'broken',
    timezone: 'Not/AZone',
    seasonYear: 2026,
    week: 1,
    prefs: { tuesday: true },
  };
  // Must return [] rather than throwing — one bad row cannot take down a batch.
  check('bad timezone yields no sends', E.dueTriggers(broken, Date.UTC(2026, 8, 8, 13, 5, 0), []), []);
}

/* ---------------------------------------------------------------------------
   7. Copy determinism
--------------------------------------------------------------------------- */
{
  const ctx = { leagueId: '123456', seasonYear: 2026, week: 3 };
  const a = E.buildNotification('waiver_wire', ctx);
  const b = E.buildNotification('waiver_wire', ctx);
  check('same context yields identical copy', a, b);
  checkTrue('title carries the week', a.title.indexOf('Week 3') !== -1);
  check('payload carries routing data', a.data.trigger, 'waiver_wire');
  check('payload carries the group', a.data.group, 'tuesday');

  // A different week must be able to draw differently, and must at minimum
  // relabel — otherwise the seed is not actually reaching the draw.
  const other = E.buildNotification('waiver_wire', { leagueId: '123456', seasonYear: 2026, week: 4 });
  checkTrue('a different week changes the title', other.title !== a.title);

  // Every trigger must have a copy pool wired up.
  for (const t of E.TRIGGERS) {
    const n = E.buildNotification(t.id, ctx);
    checkTrue('copy exists for ' + t.id, !!(n && n.title && n.body));
  }

  check('unknown trigger returns null', E.buildNotification('nope', ctx), null);
}

/* --------------------------------------------------------------------------- */
if (failures.length) {
  console.error('\n[selftest] ' + failures.length + ' FAILED, ' + passed + ' passed\n');
  failures.forEach((f, i) => console.error('  ' + (i + 1) + ') ' + f + '\n'));
  process.exit(1);
}
console.log('[selftest] all ' + passed + ' assertions passed');
