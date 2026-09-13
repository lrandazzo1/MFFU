/* ============================================================================
   FSN NOTIFICATIONS — TRIGGER ENGINE

   The pure, dependency-free half of the push stack. It answers one question:

       "For this device, at this daily run, which weekly alert is now due?"

   Nothing here touches the network, the database, or a push provider. That
   makes the cadence rules readable in one place and testable without
   credentials — `node lib/notifications/selftest.js` exercises this file
   directly.

   ---- THE CADENCE (revised) ----

   Three engagement moments, one per weekday, no Sunday send:

     * MONDAY   -> the breakdown of the weekend's big performers
     * TUESDAY  -> game recaps (post-mortem for the week just played)
     * FRIDAY   -> Thursday-Night-Football breakdown + weekend matchup preview

   Sunday is deliberately silent: the app is meant to be checked live on
   Sunday, not buzzed by a redundant push while the reader is already watching
   scores move. The dispatcher's cron still fires every day so the season /
   week feed stays warm, but nothing is ever due on Sun/Wed/Thu/Sat.

   ---- WHY ONE DAILY RUN, AND WHAT THAT COSTS ----

   The dispatcher is invoked exactly ONCE PER DAY (see vercel.json). That is
   not a preference: Vercel's Hobby plan caps cron frequency at once per day,
   and the once-daily budget is also what keeps the external schedule pull
   inside its rate limit — see lib/notifications/schedule-feed.js.

   Neither APNs nor Web Push can accept a "deliver at" time, so a push lands
   when the run sends it. One run per day therefore means one delivery instant
   per day, and the honest consequence is stated rather than hidden:

     * A device gets AT MOST ONE alert per run, and so at most one per day.
     * An alert cannot be placed at an arbitrary local hour. It is placed at
       whatever local hour the daily run happens to fall on in that device's
       timezone.

   So the cadence is expressed the only way that survives a single run: each
   trigger owns the whole deliverable-hours band on its weekday, so the run
   selects one alert for anyone reached that day. With the cron at 16:00 UTC
   the run lands at 06:00 in Honolulu, 09:00 in Los Angeles, 12:00 in New York,
   17:00 in London and 22:00 at UTC+6 — every one of those hours sits inside
   the deliverable-hours band, so one run serves UTC-10 through UTC+6 on the
   correct local weekday.

   A device outside UTC-10..UTC+6 has no daily run inside the band and
   receives nothing. That is reported as `outsideDailyWindow` in the
   dispatcher's dry run rather than left to look like a bug.

   ---- DELIVERY IS AT-MOST-ONCE, NOT AT-LEAST-ONCE ----

   A trigger fires when the run is inside the deliverable band on its weekday
   and the send ledger has no row for (device, trigger, season, week). Because
   a trigger's weekday is one day and there is one run per day, a trigger gets
   exactly one chance per week; the ledger stops a retry or an overlapping
   manual invocation from double-sending. A push that arrives an hour off is
   useful. A duplicate push is an uninstall.

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

/* The gap between dispatcher invocations. Everything about the cadence below
   follows from this number, so it is declared once and consulted rather than
   assumed. */
const DAILY_RUN_INTERVAL_MS = 24 * HOUR_MS;

const WEEKDAY_INDEX = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };

/* No alert is placed before this local hour or after it. A daily run that
   falls outside it for a given device delivers nothing to that device rather
   than buzzing a phone at 04:00 to say waivers cleared. */
const EARLIEST_LOCAL_HOUR = 6;
const LATEST_LOCAL_HOUR = 22;

/* --------------------------------------------------------------------------
   CADENCE TABLE

   `group` is the preference key the reader toggles in Setup — one switch per
   weekday, so a reader can turn any single day off without reasoning about
   individual triggers. Group keys match the day they fire on, which is what
   the Setup screen labels them as.

   `weekday` is LOCAL to the device's timezone. `fromHour`/`toHour` are the
   inclusive local-hour band in which a daily run may deliver this trigger,
   and `hour` is the ideal hour inside it — the hour the alert would land at
   if the dispatcher could run whenever it liked. With one trigger per weekday
   the band is the whole deliverable window, so every reached zone matches
   exactly one trigger on that trigger's weekday.
-------------------------------------------------------------------------- */
const TRIGGERS = [
  {
    id: 'big_performers',
    group: 'monday',
    weekday: 1,
    hour: 9,
    fromHour: EARLIEST_LOCAL_HOUR,
    toHour: LATEST_LOCAL_HOUR,
    category: 'BIG PERFORMERS',
    /* The morning after Sunday's slate: which starters carried a fantasy team,
       which sat their studs, and where the week's biggest points landed. */
  },
  {
    id: 'game_recap',
    group: 'tuesday',
    weekday: 2,
    hour: 9,
    fromHour: EARLIEST_LOCAL_HOUR,
    toHour: LATEST_LOCAL_HOUR,
    category: 'RECAP',
    /* The post-mortem + power index drop. Monday-Night results are in the
       book, waivers have cleared, and the Desk has re-cut the rankings. */
  },
  {
    id: 'tnf_matchup_preview',
    group: 'friday',
    weekday: 5,
    hour: 9,
    fromHour: EARLIEST_LOCAL_HOUR,
    toHour: LATEST_LOCAL_HOUR,
    category: 'MATCHUP PREVIEW',
    /* The morning after TNF: quick takeaways from Thursday's game and the
       Desk's preview of the weekend's league matchups before the Sunday slate
       goes live. Friday intentionally replaces the old Thursday lineup-lock
       trigger — a preview of the weekend is more useful than a hurried lock
       warning that a once-a-day cadence can only place hours early anyway. */
  },
];

const TRIGGERS_BY_ID = TRIGGERS.reduce((map, t) => { map[t.id] = t; return map; }, {});

/* The three reader-facing switches. Order is the order they render in Setup:
   the three weekdays that carry a send, in calendar order. Any preference key
   that is not in this list is dropped by both cleanPrefs paths on the way in,
   so a stale 'sunday' or 'thursday' from an older client is discarded rather
   than stored as consent to a trigger that no longer exists. */
const PREF_GROUPS = ['monday', 'tuesday', 'friday'];

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

/* Is the run, on this device's clock, inside the hours any alert may be
   delivered at all? Everything narrower is a per-trigger band. */
function withinDeliverableHours(localHour) {
  return localHour >= EARLIEST_LOCAL_HOUR && localHour <= LATEST_LOCAL_HOUR;
}

/* Does this run land inside the trigger's local-hour band on its weekday? */
function inLocalBand(trigger, local) {
  if (local.weekday !== trigger.weekday) return false;
  return local.hour >= trigger.fromHour && local.hour <= trigger.toHour;
}

/* The instant this trigger would ideally have landed on, used for reporting
   how far the daily run sits from the ideal. Never a gate — the band above is
   the gate — so an unusable value here degrades the diagnostic, not the send. */
function idealInstantFor(trigger, device, now) {
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

     device   { timezone, prefs, seasonYear, week }
     now      epoch ms (injected, never read from Date.now here, so a test can
              pin the clock and the dispatcher can evaluate a whole batch
              against one consistent instant)
     sentKeys Set of sendKey() strings already delivered for this device

   Returns the trigger definitions that should fire on THIS daily run, each
   with the resolved ideal instant and ledger key attached.

   The return is an array for the caller's sake — the dispatcher, the dry-run
   plan and the selftest all iterate it — but a daily run yields at most one
   entry. Only one trigger owns any given weekday, so that is already true by
   construction; the explicit trim at the bottom is there so a future cadence
   edit that overlaps cannot quietly start double-buzzing a phone.
-------------------------------------------------------------------------- */
function dueTriggers(device, now, sentKeys) {
  const already = sentKeys instanceof Set ? sentKeys : new Set(sentKeys || []);

  const tz = normalizeTimeZone(device && device.timezone);
  if (!tz) {
    console.warn(
      '[FSNPush] skipping device ' + String(device && device.deviceId) +
      ': no usable timezone (' + String(device && device.timezone) + ')'
    );
    return [];
  }

  let local;
  try {
    local = tzParts(tz, new Date(now));
  } catch (err) {
    console.error(
      '[FSNPush] could not read the local clock for device ' +
      String(device && device.deviceId) + ' in timezone ' + tz, err
    );
    return [];
  }

  /* Outside waking hours on this device's clock nothing is deliverable, and
     that is the single most common reason a device sees no alerts: its zone is
     too far from the cron's UTC hour. The dispatcher reports the count. */
  if (!withinDeliverableHours(local.hour)) return [];

  const due = [];
  for (const trigger of TRIGGERS) {
    if (!groupEnabled(device, trigger)) continue;

    const key = sendKey(trigger.id, device.seasonYear, device.week);
    if (already.has(key)) continue;

    if (!inLocalBand(trigger, local)) continue;

    let ideal;
    try {
      ideal = idealInstantFor(trigger, device, now);
    } catch (err) {
      console.error(
        '[FSNPush] trigger "' + trigger.id + '" could not be placed for device ' +
        String(device && device.deviceId) + ' (timezone ' + tz + ')', err
      );
      ideal = null;
    }

    due.push({
      trigger,
      key,
      target: ideal,
      /* How far this run sits from the hour the alert wanted. Negative means
         the run is early. Null when the ideal instant could not be resolved —
         reporting only, never a gate. */
      offsetMs: ideal == null ? null : now - ideal,
      localHour: local.hour,
    });
  }

  if (due.length <= 1) return due;

  /* Overlapping weekdays would mean two pushes in one run. Keep the trigger
     whose ideal hour is closest to the hour this run actually landed on, and
     say loudly that the cadence table needs fixing. */
  console.error(
    '[FSNPush] ' + due.length + ' triggers matched one run for device ' +
    String(device && device.deviceId) + ' (' + due.map((d) => d.trigger.id).join(', ') +
    '); one trigger per weekday is the contract. Delivering the closest match only.',
    new Error('OVERLAPPING_TRIGGER_WEEKDAYS')
  );
  due.sort((a, b) =>
    Math.abs(a.trigger.hour - local.hour) - Math.abs(b.trigger.hour - local.hour));
  return due.slice(0, 1);
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
  big_performers: {
    title: ['The weekend\'s big performers', 'Who carried Week', 'Standouts are in'],
    body: [
      'The names that lit up the slate, the sits that hurt, and where the biggest points landed.',
      'A fresh breakdown of the weekend\'s standouts is live on the Desk.',
      'Boom scores, busts, and the starters who actually earned their spot this week.',
    ],
  },
  game_recap: {
    title: ['Game recap · Week', 'This week is written', 'Recap and power index'],
    body: [
      'Every league game recapped, the fallout filed, and the power index re-cut.',
      'Your league just got re-ranked. The Post-Mortem desk has the receipts.',
      'Fresh recap, fresh rankings, fresh grievances. Read it on the Desk.',
    ],
  },
  tnf_matchup_preview: {
    title: ['TNF breakdown · matchup preview', 'Friday briefing', 'Weekend matchup preview'],
    body: [
      'Thursday-night takeaways plus what to watch in your league\'s Sunday matchups.',
      'Fast recap of TNF and the Desk\'s preview of every league matchup this weekend.',
      'How Thursday landed, and where your Sunday matchup gets decided.',
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
    'fsn:push:v2',
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

/* --------------------------------------------------------------------------
   migrateLegacyPrefs(prefs)

   Old clients wrote three switches keyed { tuesday, thursday, sunday }. The
   revised cadence uses { monday, tuesday, friday } instead. Map the surviving
   consent forward so a reader who had turned Thursday on still gets the new
   Friday briefing, without silently opting anyone into a NEW moment they
   never saw a switch for.

   Rules, applied in order:
     * `monday`   is a new moment. Preserve if present; otherwise DEFAULT OFF.
       A new push without an in-app choice would violate the opt-in contract.
     * `tuesday`  keeps its meaning (recap). Preserve.
     * `friday`   inherits the legacy `thursday` value when present, because
       the Friday briefing is the closest successor to the retired
       Thursday-night lock warning. A new-shape payload wins if it also names
       `friday`.
     * `sunday` and `thursday` (as raw keys) are dropped: no trigger listens
       for them any more, so keeping them stored would only mislead a later
       reader of the row.

   Returns a plain object with EXACTLY the keys in PREF_GROUPS.
-------------------------------------------------------------------------- */
function migrateLegacyPrefs(prefs) {
  const source = (prefs && typeof prefs === 'object') ? prefs : {};
  const out = {};
  for (const group of PREF_GROUPS) {
    out[group] = source[group] === true;
  }
  /* Friday inherits Thursday only if the incoming payload did not already say
     something about Friday explicitly. Explicit new-shape consent always wins
     over the legacy inference. */
  if (source.friday !== true && source.friday !== false && source.thursday === true) {
    out.friday = true;
  }
  return out;
}

module.exports = {
  TRIGGERS,
  TRIGGERS_BY_ID,
  PREF_GROUPS,
  DAILY_RUN_INTERVAL_MS,
  EARLIEST_LOCAL_HOUR,
  LATEST_LOCAL_HOUR,
  HOUR_MS,
  dueTriggers,
  buildNotification,
  sendKey,
  normalizeTimeZone,
  withinDeliverableHours,
  inLocalBand,
  idealInstantFor,
  tzParts,
  tzOffsetMs,
  wallClockToInstant,
  mostRecentLocalOccurrence,
  migrateLegacyPrefs,
};
