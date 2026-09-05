/* ============================================================================
   FSN NOTIFICATIONS — TRIGGER ENGINE

   The pure, dependency-free half of the push stack. It answers one question:

       "For this device, at this instant, which weekly alerts are now due?"

   Nothing here touches the network, the database, or a push provider. That
   makes the cadence rules readable in one place and testable without
   credentials — `node api/notifications/selftest.js` exercises this file
   directly.

   ---- WHY AN HOURLY CRON RATHER THAN FIVE WEEKLY ONES ----

   The three engagement windows in the spec (Tuesday / Thursday / Sunday)
   expand to five distinct alerts, and each one has to land at a sensible hour
   in the READER's timezone. A `vercel.json` cron fires at one fixed UTC
   instant, so five weekly crons would wake a reader in Honolulu at 04:00 to
   tell them waivers cleared. Instead a single cron runs every hour and this
   engine decides, per device, whether that device's local window has just
   opened. A league spread across four timezones gets four correct send times
   from one schedule.

   ---- DELIVERY IS AT-MOST-ONCE, NOT AT-LEAST-ONCE ----

   Every trigger resolves to an absolute target instant. A trigger is due when
   that instant has passed, is still inside GRACE_MS, and the send ledger has
   no row for (device, trigger, season, week). The grace window is what makes a
   late or skipped cron run recoverable; the ledger is what stops the recovery
   from double-sending. A push that arrives 40 minutes late is useful. A
   duplicate push is an uninstall.

   ---- DETERMINISM ----

   Copy selection is seeded exactly like the News Desk's article generators:
   sha256 over league + season + week + trigger, sliced into an index. No
   Math.random, no Date.now inside the copy path. The same league in the same
   week always draws the same sentence, so a retry after a provider timeout
   cannot change the message a reader has already seen on another device.
   (This is a NEW generator alongside the News Desk, per CLAUDE.md rule 2 —
   it does not read, seed from, or mutate any existing article generator.)
============================================================================ */

'use strict';

const crypto = require('crypto');

const HOUR_MS = 3600 * 1000;

/* How long after its target instant a trigger may still fire. Three hours
   absorbs a missed hourly cron, a cold-start backlog, or a Vercel scheduling
   drift without ever letting a Tuesday-morning alert leak into the afternoon.
   Past this the send is dropped entirely: a stale reminder to set a lineup for
   a game that already kicked off is worse than silence. */
const GRACE_MS = 3 * HOUR_MS;

/* Kickoff-anchored triggers fire this long before the opening kickoff. Two
   hours clears the reader's window to actually open ESPN and move a player,
   and sits before the standard 20:15 ET TNF lock without landing mid-dinner. */
const TNF_LEAD_HOURS = 2;

const WEEKDAY_INDEX = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };

/* --------------------------------------------------------------------------
   CADENCE TABLE

   `group` is the preference key the reader toggles in Setup — the spec's three
   engagement windows — so one switch governs both Tuesday alerts rather than
   forcing a reader to reason about five.

   `weekday` / `hour` are LOCAL to the device's timezone.
   `anchor:'kickoff'` overrides that with an absolute instant derived from the
   week's real opening kickoff, so every device in the league is alerted at the
   same moment relative to the game rather than to its own wall clock.
-------------------------------------------------------------------------- */
const TRIGGERS = [
  {
    id: 'waiver_wire',
    group: 'tuesday',
    weekday: 2,
    hour: 9,
    category: 'WAIVERS',
    /* Waivers process overnight Tue on the standard ESPN/Sleeper calendar, so
       09:00 local is the first moment the results are real. */
  },
  {
    id: 'weekly_recap',
    group: 'tuesday',
    weekday: 2,
    hour: 18,
    category: 'RECAP',
    /* The post-mortem + power index drop. Deliberately nine hours after the
       waiver alert so the two Tuesday sends never arrive as a pair. */
  },
  {
    id: 'tnf_lock',
    group: 'thursday',
    weekday: 4,
    hour: 16,
    anchor: 'kickoff',
    leadHours: TNF_LEAD_HOURS,
    category: 'LINEUP LOCK',
    /* Anchored to the week's opening kickoff when the client has reported one.
       The 16:00 local figure is the fallback for a week whose schedule has not
       been hydrated yet, and is early enough to beat an international or
       Thanksgiving kickoff rather than assuming 20:15 ET. */
  },
  {
    id: 'sunday_lineup',
    group: 'sunday',
    weekday: 0,
    hour: 9,
    category: 'LINEUP',
    /* Roughly four hours before the 1pm ET main slate for an Eastern reader,
       and still pre-kickoff everywhere west of that. */
  },
  {
    id: 'gameday_pulse',
    group: 'sunday',
    weekday: 0,
    hour: 13,
    category: 'GAME DAY',
    /* Kickoff of the early slate: the live-scoring pulse, not a reminder. */
  },
];

const TRIGGERS_BY_ID = TRIGGERS.reduce((map, t) => { map[t.id] = t; return map; }, {});

/* The three reader-facing switches. Order is the order they render in Setup. */
const PREF_GROUPS = ['tuesday', 'thursday', 'sunday'];

/* ==========================================================================
   TIMEZONE MATH

   Node on Vercel ships full ICU, so Intl carries the complete tz database and
   handles DST transitions correctly. Doing this by hand with fixed offsets is
   what produces the classic "the alert moved an hour in November" bug.
========================================================================== */

/* Wall-clock parts for `date` as observed in `timeZone`. */
function tzParts(timeZone, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map = {};
  for (const part of dtf.formatToParts(date)) map[part.type] = part.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: WEEKDAY_INDEX[map.weekday],
  };
}

/* Milliseconds `timeZone` is AHEAD of UTC at `date`. */
function tzOffsetMs(timeZone, date) {
  const p = tzParts(timeZone, date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  /* formatToParts drops sub-second precision, so round the instant the same
     way before differencing or every offset picks up a spurious remainder. */
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/* Absolute instant for a wall-clock reading in `timeZone`.

   Two passes, not one. The first guess uses the offset in force at the naive
   UTC interpretation of the wall clock, which is wrong for any reading that
   sits on the far side of a DST transition from that guess; re-resolving the
   offset at the corrected instant fixes it. A third pass would never change
   the answer for a real tz — offsets shift by at most an hour or two and the
   second pass has already crossed the boundary. */
function wallClockToInstant(timeZone, year, month, day, hour) {
  const naive = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
  let instant = naive - tzOffsetMs(timeZone, new Date(naive));
  instant = naive - tzOffsetMs(timeZone, new Date(instant));
  return instant;
}

/* The most recent instant at which it was `hour`:00 on `weekday` in `timeZone`,
   at or before `now`. */
function mostRecentLocalOccurrence(timeZone, weekday, hour, now) {
  const local = tzParts(timeZone, new Date(now));
  let daysBack = (local.weekday - weekday + 7) % 7;
  /* Same weekday but the hour has not arrived yet -> the occurrence we want is
     the one a full week earlier, not one still in this device's future. */
  if (daysBack === 0 && local.hour < hour) daysBack = 7;

  const base = Date.UTC(local.year, local.month - 1, local.day);
  const target = new Date(base - daysBack * 24 * HOUR_MS);
  const instant = wallClockToInstant(
    timeZone,
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    target.getUTCDate(),
    hour
  );

  /* A spring-forward transition can delete the target hour outright (02:00
     does not exist on the US spring-forward Sunday). wallClockToInstant then
     lands just past `now`; step back a week so the caller still gets a real
     past occurrence rather than a future one it would silently never fire. */
  if (instant > now) return instant - 7 * 24 * HOUR_MS;
  return instant;
}

/* A timezone string Intl actually recognises, or null. Device-supplied, so it
   is never trusted into Intl without this check — an unknown zone throws a
   RangeError that would otherwise take down the whole dispatch batch. */
function normalizeTimeZone(value) {
  const tz = String(value || '').trim();
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return tz;
  } catch (err) {
    return null;
  }
}

/* ==========================================================================
   DUE-TRIGGER RESOLUTION
========================================================================== */

/* The ledger key for one (device, trigger, week) send. Weeks are per-season so
   the season is part of the key; a league that replays week 3 of a prior
   season cannot suppress week 3 of the live one. */
function sendKey(triggerId, seasonYear, week) {
  return triggerId + ':' + String(seasonYear || 0) + ':' + String(week || 0);
}

/* Absolute target instant for one trigger and one device, or null when the
   trigger cannot be placed (unusable timezone).

   Kickoff-anchored triggers ignore the device's wall clock entirely: the whole
   league is warned the same number of hours before the same kickoff. */
function targetInstantFor(trigger, device, now) {
  if (trigger.anchor === 'kickoff') {
    const kickoff = Number(device.firstKickoffMs);
    if (Number.isFinite(kickoff) && kickoff > 0) {
      return kickoff - (trigger.leadHours || TNF_LEAD_HOURS) * HOUR_MS;
    }
    /* No hydrated schedule for this week yet — fall through to the local-hour
       fallback so the reader is still warned on Thursday. */
  }
  const tz = normalizeTimeZone(device.timezone);
  if (!tz) return null;
  return mostRecentLocalOccurrence(tz, trigger.weekday, trigger.hour, now);
}

/* Is this device opted in to the group this trigger belongs to?

   Absent means OFF. A device row only exists once the reader has opted in at
   all, but an unrecognised or missing group key must never be read as consent. */
function groupEnabled(device, trigger) {
  const prefs = (device && device.prefs) || {};
  return prefs[trigger.group] === true;
}

/* --------------------------------------------------------------------------
   dueTriggers(device, now, sentKeys)

     device   { timezone, prefs, seasonYear, week, firstKickoffMs }
     now      epoch ms (injected, never read from Date.now here, so a test can
              pin the clock and the dispatcher can evaluate a whole batch
              against one consistent instant)
     sentKeys Set of sendKey() strings already delivered for this device

   Returns the trigger definitions that should fire right now, each with the
   resolved target instant and ledger key attached.
-------------------------------------------------------------------------- */
function dueTriggers(device, now, sentKeys) {
  const already = sentKeys instanceof Set ? sentKeys : new Set(sentKeys || []);
  const due = [];

  for (const trigger of TRIGGERS) {
    if (!groupEnabled(device, trigger)) continue;

    const key = sendKey(trigger.id, device.seasonYear, device.week);
    if (already.has(key)) continue;

    let target;
    try {
      target = targetInstantFor(trigger, device, now);
    } catch (err) {
      console.error(
        '[FSNPush] trigger "' + trigger.id + '" could not be placed for device ' +
        String(device && device.deviceId) + ' (timezone ' + String(device && device.timezone) + ')',
        err
      );
      continue;
    }
    if (target == null) {
      console.warn(
        '[FSNPush] skipping trigger "' + trigger.id + '" for device ' +
        String(device && device.deviceId) + ': no usable timezone (' +
        String(device && device.timezone) + ')'
      );
      continue;
    }

    const age = now - target;
    if (age < 0) continue;            // window has not opened yet
    if (age > GRACE_MS) continue;     // too stale to be useful

    due.push({ trigger, target, key, age });
  }

  /* Oldest window first, so a backlog drains in the order the reader would
     have received it. */
  due.sort((a, b) => a.target - b.target);
  return due;
}

/* ==========================================================================
   DETERMINISTIC COPY

   Seeded selection, same contract as the News Desk: one hash, sliced per
   draw. These pools are new and self-contained — no existing narrative pool is
   read, extended, or reworded here.
========================================================================== */

function seedHash(parts) {
  return crypto.createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

/* Draw `pool[i]` using the `slot`-th 6-hex-digit window of the seed. Distinct
   slots give independent draws from one hash, so a title and a body chosen for
   the same trigger do not move in lockstep. */
function pick(pool, seed, slot) {
  if (!pool.length) return '';
  const start = (slot * 6) % 56;
  const chunk = parseInt(seed.slice(start, start + 6), 16);
  return pool[chunk % pool.length];
}

const COPY = {
  waiver_wire: {
    title: ['Waivers cleared', 'The wire has settled', 'Waiver results are in'],
    body: [
      'Overnight claims processed. See who landed what before the league chat does.',
      'FAAB is spent and the wire is open again. Check what got through.',
      'Your claims have been settled — the Transaction Wire is live on the Desk.',
    ],
  },
  weekly_recap: {
    title: ['The post-mortem is up', 'Power index updated', 'This week is written'],
    body: [
      'Power rankings re-cut, the week recapped, and the fallout filed.',
      'Your league just got re-ranked. The Post-Mortem desk has the receipts.',
      'Fresh power index, fresh recap, fresh grievances. Read it on the Desk.',
    ],
  },
  tnf_lock: {
    title: ['Thursday lineup lock', 'TNF kicks off soon', 'Lock is coming'],
    body: [
      'Kickoff is close. Anyone in tonight’s game locks when the ball is in the air.',
      'Last call to move a Thursday starter before the roster locks.',
      'Check your Thursday players now — after kickoff they are frozen.',
    ],
  },
  sunday_lineup: {
    title: ['Set your lineup', 'Sunday check', 'Lineups lock today'],
    body: [
      'Inactives are landing and your bench is still your problem. Take a look.',
      'Morning lineup check: injuries, byes, and anyone you forgot to start.',
      'The slate starts soon. One last pass over your starters.',
    ],
  },
  gameday_pulse: {
    title: ['Game day pulse', 'The slate is live', 'Kickoff'],
    body: [
      'Scores are moving. Follow your matchup live on the Desk.',
      'Your week is officially underway — live scoring is on.',
      'Ball is in the air. The matchup board is tracking every point.',
    ],
  },
};

/* --------------------------------------------------------------------------
   buildNotification(triggerId, ctx)

     ctx { leagueId, seasonYear, week, teamName? }

   Returns { title, body, category, data } ready for either transport. The
   payload carries only routing metadata — league, season, week, trigger — and
   never a team name that did not come from the league's own public roster.
-------------------------------------------------------------------------- */
function buildNotification(triggerId, ctx) {
  const trigger = TRIGGERS_BY_ID[triggerId];
  if (!trigger) {
    console.error('[FSNPush] buildNotification called for unknown trigger "' + String(triggerId) + '"');
    return null;
  }
  const c = ctx || {};
  const pool = COPY[triggerId];
  if (!pool) {
    console.error('[FSNPush] no copy pool registered for trigger "' + triggerId + '"');
    return null;
  }

  const seed = seedHash([
    'fsn:push:v1',
    String(c.leagueId || ''),
    String(c.seasonYear || ''),
    String(c.week || ''),
    triggerId,
  ]);

  const week = Number(c.week) || 0;
  const title = pick(pool.title, seed, 0);
  const body = pick(pool.body, seed, 1);

  return {
    title: week > 0 ? title + ' · Week ' + week : title,
    body,
    category: trigger.category,
    data: {
      trigger: triggerId,
      group: trigger.group,
      leagueId: String(c.leagueId || ''),
      season: String(c.seasonYear || ''),
      week: String(week),
      /* Deep link back into the app. The Desk is the right landing screen for
         every one of these; the trigger id lets a future build route finer
         without changing the payload shape. */
      url: '/?goto=home',
    },
  };
}

module.exports = {
  TRIGGERS,
  TRIGGERS_BY_ID,
  PREF_GROUPS,
  GRACE_MS,
  HOUR_MS,
  dueTriggers,
  buildNotification,
  sendKey,
  normalizeTimeZone,
  tzParts,
  tzOffsetMs,
  wallClockToInstant,
  mostRecentLocalOccurrence,
};
