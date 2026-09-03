/* ============================================================================
   FSN — Editorial Schedule Engine
   ----------------------------------------------------------------------------
   A tiny, dependency-free helper that answers ONE question:

       "For a given fantasy week, when should each editorial desk publish?"

   The existing News Desk anchors every slot to the Tuesday that opens a
   fantasy week (Wed = day 1, Thu = day 2, and so on). That is a good rule of
   thumb but it is wrong the moment the NFL slate shifts — Saturday opener on
   the Week 15/16 slate, Thanksgiving specials, a Friday international kickoff,
   an early-season Monday-only opener. It is also flat: everything within a
   week publishes at exactly the same clock time regardless of when kickoff
   actually is, which is why the app has historically shipped every article as
   one Wednesday-morning dump when the payload arrives.

   This engine re-anchors the release calendar to the league's earliest
   scheduled kickoff for the week (firstGameTimestamp). Offsets and hours are
   expressed relative to that anchor, so the day headers in the timeline
   ("THURSDAY", "SATURDAY", "TUESDAY") appear organically as the kickoff moves.

   The engine is deterministic. It reads only from the loaded ESPN payload —
   no Math.random, no Date.now inside the cadence math. Given the same payload
   for a given week it returns the same timestamps every call.

   Because index.html ships as several independent inline <script> blocks and
   CLAUDE.md forbids cross-block helpers from living inside an IIFE, this file
   loads at global scope BEFORE those blocks and publishes a single API on
   window.EditorialScheduleEngine that any block may consult.
============================================================================ */
(function(){
  'use strict';

  var HOUR = 3600 * 1000;
  var DAY  = 24 * HOUR;

  /* --------------------------------------------------------------------------
     CADENCE MAP

     Keyed by the News Desk's existing slot names so a caller can ask "when
     does the 'primer' slot go to air for week N?" without knowing anything
     about the release model. Every entry declares:

       offsetDays  — calendar-day offset from firstGameTimestamp
       hour        — local hour of day for the release (24-hour)
       hoursBefore — optional; anchor to kickoff-minus-N-hours, floored at hour
       cadence     — the human tag used in schedule readouts
       label       — the desk badge printed on the card
       desks       — the editorial desks that ship under this slot, straight
                     from the task spec so a caller can build a "what publishes
                     when" readout without hand-wiring the mapping

     The offsets deliberately preserve the existing weekday cadence when the
     first game is a Thursday-night kickoff — Wed waivers, Thu previews, Sat
     injury wire, Sun/Mon finals, Tue post-mortem — while allowing the whole
     schedule to shift with the actual kickoff on a non-standard slate.
  -------------------------------------------------------------------------- */
  var CADENCE = {
    /* T-Minus 3 Days — post-mortem of the concluded slate + updated power
       index + historical fallout desks. Anchored to the Tuesday after this
       week's kickoff (Thu + 5 days), which is simultaneously "T-3 before next
       week's Thu opener" — same publication moment either way. */
    recap: {
      offsetDays: 5,
      hour: 9,
      cadence: 'T-3',
      dayHint: 'MONDAY / TUESDAY',
      label: 'POST-MORTEM',
      desks: ['Post-Mortem', 'FSN Power Index', 'Historical Fallout'],
    },

    /* T-Minus 2 Days — the Transaction Wire, waiver audits, roster analysis.
       One calendar day before this week's kickoff, so a Thu opener publishes
       Wed morning and a Sat opener publishes Fri morning. */
    waivers: {
      offsetDays: -1,
      hour: 9,
      cadence: 'T-2',
      dayHint: 'WEDNESDAY',
      label: 'TRANSACTION WIRE',
      desks: ['Transaction Wire', 'Waiver Audits', 'Roster Analysis'],
    },

    /* T-Minus 1 Day — matchup pressures, rivalry spotlights, and preview
       desks. These lock in RIGHT BEFORE the first game of the week; the
       hoursBefore anchor snaps them to kickoff-minus-3h, floored at 09:00
       local so they never fall into the middle of the night. */
    primer: {
      offsetDays: 0,
      hoursBefore: 3,
      hour: 9,
      cadence: 'T-1',
      dayHint: 'THURSDAY / PRE-GAME OPENER',
      label: 'MATCHUP PRESSURES',
      desks: ['Matchup Pressures', 'Rivalry Spotlights', 'Preview Desk'],
    },

    /* Matchupday / Active Window — injury wires and breaking lineup shifts.
       Two calendar days after this week's kickoff (Thu + 2 = Sat) covers the
       standard Sunday-slate week; a Sat opener shifts the injury wire to
       Monday, which is the correct behaviour for that slate. */
    injury: {
      offsetDays: 2,
      hour: 11,
      cadence: 'MATCHUPDAY',
      dayHint: 'SATURDAY / SUNDAY',
      label: 'INJURY WIRE',
      desks: ['Injury Wire', 'Breaking Lineup Shifts'],
    },

    /* Post-slate long-form finals — Sunday night full-slate recap and the
       Monday-nightcap nightcap. Left in the engine so the release calendar is
       one coherent object; the News Desk pipes them through the same
       slotReleaseAt() path. */
    gameday: {
      offsetDays: 3,
      hour: 20,
      cadence: 'SLATE FINAL',
      dayHint: 'SUNDAY NIGHT',
      label: 'FINAL',
      desks: ['Sunday Night Finals'],
    },
    primetime: {
      offsetDays: 4,
      hour: 23,
      cadence: 'SLATE FINAL',
      dayHint: 'MONDAY NIGHT',
      label: 'MONDAY FINAL',
      desks: ['Monday Nightcap'],
    },
  };

  /* Slot-key order used by computeWeeklySchedule() so a rendered timeline is
     stable (chronological within the week). */
  var SLOT_ORDER = ['waivers', 'primer', 'injury', 'gameday', 'primetime', 'recap'];

  var DAY_NAMES = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];

  /* --------------------------------------------------------------------------
     firstGameTimestamp(seasonYear, week, espnData?)

     Returns the epoch-ms timestamp of the earliest scheduled kickoff for the
     given fantasy week, or null when the payload has no schedule data.

     ESPN exposes NFL pro-team kickoff times under two different shapes
     depending on the read (mLiveScoring vs. mSchedule), so this checks both
     top-level and settings-nested variants — the same pattern the News Desk's
     shortWeekProTeams() already uses for TNF detection.

     Loud error visibility per CLAUDE.md: a malformed date entry is warned to
     the console with the subsystem tag, then skipped so the rest of the week
     can still be scanned.
  -------------------------------------------------------------------------- */
  function readLeagueEspnData(){
    try{
      if(typeof window !== 'undefined' && window.LeagueData && window.LeagueData.espnData){
        return window.LeagueData.espnData;
      }
    }catch(err){
      console.warn('[EditorialScheduleEngine] LeagueData read failed', err);
    }
    return null;
  }

  function firstGameTimestamp(seasonYear, week, espnData){
    var wk = parseInt(week, 10);
    if(!(wk > 0)) return null;
    var d = espnData || readLeagueEspnData();
    if(!d) return null;
    var settings = d.settings || {};

    var candidates = [
      d.proGamesByScoringPeriod && d.proGamesByScoringPeriod[wk],
      d.proTeamSchedules && d.proTeamSchedules[wk],
      settings.proGamesByScoringPeriod && settings.proGamesByScoringPeriod[wk],
      settings.proTeamSchedules && settings.proTeamSchedules[wk],
    ].filter(Boolean);

    var earliest = null;
    candidates.forEach(function(bucket){
      var games = Array.isArray(bucket) ? bucket : Object.values(bucket || {});
      games.forEach(function(game){
        if(!game) return;
        var stamp = game.date || game.startDate || game.kickoff || game.startTime;
        if(!stamp) return;
        var ts = (typeof stamp === 'number') ? stamp : new Date(stamp).getTime();
        if(!Number.isFinite(ts)){
          console.warn('[EditorialScheduleEngine] unparseable kickoff stamp for Week ' + wk, stamp);
          return;
        }
        if(earliest == null || ts < earliest) earliest = ts;
      });
    });

    return earliest;
  }

  /* --------------------------------------------------------------------------
     cadenceFor(slotName) — the raw cadence definition, or null.
     releaseLabelFor(slotName) — the human day-tag ("T-3", "MATCHUPDAY").
     desksFor(slotName) — the array of desk names publishing under this slot.
  -------------------------------------------------------------------------- */
  function cadenceFor(slotName){
    return CADENCE[slotName] || null;
  }
  function releaseLabelFor(slotName){
    var c = CADENCE[slotName];
    return c ? c.cadence : null;
  }
  function desksFor(slotName){
    var c = CADENCE[slotName];
    return c && Array.isArray(c.desks) ? c.desks.slice() : [];
  }

  /* --------------------------------------------------------------------------
     releaseAt(slotName, firstKickoff)

     Computes the epoch-ms release time for `slotName` given the week's first
     kickoff. Returns null when either input is missing.

     Two branches:
       - Fixed-hour slots (waivers, injury, gameday, primetime, recap) land at
         `cadence.hour` on the day offset by `cadence.offsetDays` from the
         kickoff's calendar day.
       - Kickoff-anchored slots (primer) release `cadence.hoursBefore` before
         the actual kickoff, floored at `cadence.hour` so an early-game slate
         does not push the primer into overnight.

     The math is done in local time via the Date constructor so a slot's hour
     is honoured in the reader's timezone, exactly like the existing
     slotReleaseAt() in the News Desk.
  -------------------------------------------------------------------------- */
  function releaseAt(slotName, firstKickoff){
    var cad = CADENCE[slotName];
    if(!cad || firstKickoff == null) return null;
    var K = new Date(firstKickoff);
    if(!Number.isFinite(K.getTime())) return null;

    var offsetDays = cad.offsetDays || 0;
    var day = new Date(K.getFullYear(), K.getMonth(), K.getDate() + offsetDays);

    if(cad.hoursBefore != null && offsetDays === 0){
      var anchored = K.getTime() - cad.hoursBefore * HOUR;
      var floor = new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                           cad.hour || 9, 0, 0, 0).getTime();
      return anchored > floor ? anchored : floor;
    }

    var hour = (cad.hour != null) ? cad.hour : 9;
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                    hour, 0, 0, 0).getTime();
  }

  /* --------------------------------------------------------------------------
     computeWeeklySchedule(firstKickoff)

     Full readable timeline: one entry per slot in chronological order, each
     tagged with its cadence label, day name, release timestamp, and the desks
     that publish under it. Consumers can render this directly as the "week at
     a glance" strip or fold it into the mid-week doldrums banner.

     Returns [] when firstKickoff is missing so callers can early-return
     without null checks on each entry.
  -------------------------------------------------------------------------- */
  function computeWeeklySchedule(firstKickoff){
    if(firstKickoff == null) return [];
    var K = new Date(firstKickoff);
    if(!Number.isFinite(K.getTime())) return [];

    var rows = SLOT_ORDER.map(function(slotName){
      var at = releaseAt(slotName, firstKickoff);
      if(at == null) return null;
      var when = new Date(at);
      return {
        slot: slotName,
        cadence: CADENCE[slotName].cadence,
        label: CADENCE[slotName].label,
        desks: desksFor(slotName),
        at: at,
        day: DAY_NAMES[when.getDay()],
        hour: when.getHours(),
      };
    }).filter(Boolean);

    rows.sort(function(a, b){ return a.at - b.at; });
    return rows;
  }

  /* --------------------------------------------------------------------------
     currentCadencePhase(firstKickoff, now?)

     Which cadence phase the week is currently in relative to firstKickoff —
     'T-3', 'T-2', 'T-1', 'MATCHUPDAY', 'POST-SLATE', or 'PRE-WEEK' before the
     T-3 window opens. Useful for surface copy like "The Transaction Wire is
     next, publishing Wed morning."
  -------------------------------------------------------------------------- */
  function currentCadencePhase(firstKickoff, now){
    if(firstKickoff == null) return null;
    var ref = (now instanceof Date) ? now.getTime() : (now || Date.now());
    var delta = ref - firstKickoff;
    var days = Math.floor(delta / DAY);

    if(days < -3) return 'PRE-WEEK';
    if(days < -1) return 'T-3';          // -3, -2
    if(days < 0)  return 'T-2';          // -1
    if(days === 0) return 'T-1';         // kickoff day, pre-game
    if(days <= 2) return 'MATCHUPDAY';   // +1, +2
    return 'POST-SLATE';                 // +3 onwards
  }

  /* --------------------------------------------------------------------------
     Public API — everything above is closed over the CADENCE map by design,
     so a caller cannot accidentally mutate the release schedule from
     application code.
  -------------------------------------------------------------------------- */
  var api = {
    firstGameTimestamp: firstGameTimestamp,
    cadenceFor: cadenceFor,
    releaseLabelFor: releaseLabelFor,
    desksFor: desksFor,
    releaseAt: releaseAt,
    computeWeeklySchedule: computeWeeklySchedule,
    currentCadencePhase: currentCadencePhase,
    slots: SLOT_ORDER.slice(),
  };

  try{
    if(typeof window !== 'undefined'){
      window.EditorialScheduleEngine = api;
    }
  }catch(err){
    console.error('[EditorialScheduleEngine] global publish failed', err);
  }
})();
