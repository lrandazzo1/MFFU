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

/* Matchup Preview + no-FAAB runtime guard — additive and output-scoped. */
(function(){
  'use strict';
  function esc(v){ return String(v == null ? '' : v).replace(/[&<>"']/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function num(v){ var n=Number(v); return Number.isFinite(n)?n:null; }
  function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
  function hash(v){ var s=String(v),h=2166136261; for(var i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return h>>>0; }
  function allTeams(){
    try{ var rows=window.LeagueData&&typeof window.LeagueData.getTeams==='function'?window.LeagueData.getTeams():[]; return Array.isArray(rows)?rows.filter(Boolean):[]; }
    catch(err){ console.error('[MatchupPreviewGuard] team lookup failed',err); return []; }
  }
  function pairFor(article){
    var list=allTeams(), week=Number(article.week);
    if(!(week>0)){ var m=String(article.id||'').match(/^preview-game-(\d+)-/); week=m?Number(m[1]):0; }
    for(var i=0;i<list.length;i++) for(var j=0;j<list.length;j++) if(i!==j && week>0 && article.id==='preview-game-'+week+'-'+list[i].id+'-'+list[j].id) return {week:week,A:list[i],B:list[j]};
    return null;
  }
  function record(team,week){
    try{ var v=window.FSNIntel.getRecordAsOfWeek(team.id,week); return v==null||v===''?'0-0':String(v); }
    catch(err){ console.error('[MatchupPreviewGuard] record lookup failed for '+team.id+' Week '+week,err); return 'record unavailable'; }
  }
  function h2h(A,B,week){
    try{
      if(!A.ownerId||!B.ownerId||typeof window.getH2HAsOf!=='function') return null;
      var season=window.NewsDesk&&typeof window.NewsDesk.viewedSeasonYear==='function'?Number(window.NewsDesk.viewedSeasonYear()):0;
      return window.getH2HAsOf(A.ownerId,B.ownerId,season||0,week-1)||null;
    }catch(err){ console.error('[MatchupPreviewGuard] Record Book lookup failed for '+A.id+' vs '+B.id+' Week '+week,err); return null; }
  }
  function probability(A,B,week,series){
    var p=null;
    try{ p=num(window.FSNIntel.winProbability(Math.max(0,week-1),A,B)); }
    catch(err){ console.error('[MatchupPreviewGuard] model probability failed for '+A.id+' vs '+B.id+' Week '+week,err); }
    if(p==null) p=50;
    if(Math.abs(p-50)<0.0001&&series){
      var aw=num(series.winsFor!=null?series.winsFor:series.aWins), bw=num(series.winsAgainst!=null?series.winsAgainst:series.bWins);
      if(aw!=null&&bw!=null&&aw!==bw) p=50+clamp((aw-bw)*1.25,-7.5,7.5);
    }
    return clamp(p,12,88);
  }
  // Private output-layer pools. Each slot has twelve independently written beats.
  // Values are escaped before interpolation; selection never changes model inputs.
  var PREVIEW_COPY = {
    hook: [
      '{A} brings {RA} into Week {W}; {B} answers with {RB}. The pressure falls first on {F}, carrying {E}% win probability into a game {D} can turn with one productive lineup.',
      'Start with the challenger: {D} gets a shot at {F} in Week {W}. {A} stands at {RA}, {B} at {RB}, and the forecast gives {F} {E}%.',
      'A win is the immediate prize for {A} ({RA}) and {B} ({RB}) in Week {W}. At {E}%, {F} has the stronger forecast; {D} has the opportunity to spoil it.',
      'The Week {W} assignment for {A}: get past {B}. Their records read {RA} and {RB}, respectively, with {F} holding a {E}% chance to take this meeting.',
      '{B} draws {A} in Week {W}, bringing a {RB} record against {RA}. The forecast favors {F} at {E}%, putting {D} in position to deliver the upset.',
      'Two records frame this Week {W} contest: {RA} for {A}, {RB} for {B}. {F} gets {E}% from the forecast, but {D} still controls its own lineup.',
      'For {F}, Week {W} comes with an expectation to meet. {A} enters {RA} against {B} at {RB}; the {E}% forecast leaves {D} a route through.',
      '{A} and {B} reach Week {W} from different corners of the schedule, at {RA} and {RB}. This time they settle matters directly, with {F} assigned {E}% win probability.',
      'Circle {A} against {B} on the Week {W} board. The records are {RA} and {RB}, and {F} carries a {E}% forecast into the pairing.',
      'The next entry beside {A}’s {RA} record depends on {B}, which arrives {RB}. Week {W} gives {F} a {E}% chance to win and {D} a clear target.',
      'Week {W} puts {B} ({RB}) across from {A} ({RA}). {F} holds the forecast at {E}%; a strong start from {D} would put that advantage under immediate pressure.',
      '{D} can make this an uncomfortable Week {W} for {F}. {A} carries {RA}, {B} carries {RB}, and the projected favorite starts with {E}% win probability.'
    ],
    pace: [
      '{A} has averaged {PA} points against {B}’s {PB}. The {G}-point separation measures their weekly production, not the margin this game must follow. A repeat of those averages would favor {L}.',
      'Production puts {L} ahead: {PA} per game for {A}, {PB} for {B}. Closing that {G}-point gap is the first scoring task for {T}, before any extra cushion enters the conversation.',
      'Look past the records and {A}’s {PA} meets {B}’s {PB} points per game. {L} owns a {G}-point pace advantage; {T} needs a better relative performance than those averages describe.',
      'The scoring comparison is {PA} for {A}, {PB} for {B}. That leaves {G} points between them each week. {L} can draw confidence from the output, while {T} needs to change the terms.',
      '{T} faces a production test against {L}. Their pace gap is {G} points, built from {A} at {PA} and {B} at {PB}; reducing it would bring the game closer before the late starters finish.',
      'Average output gives this matchup its clearest measuring stick. {A}: {PA}. {B}: {PB}. The {G}-point spread favors {L}, though an average is no ceiling for {T}.',
      '{L} has the stronger scoring baseline. {A} supplies {PA} per game and {B} supplies {PB}, a difference of {G}. For {T}, a win asks for a departure from that balance.',
      'A routine scoring week would help {L}: {A} averages {PA}, with {B} at {PB}. {T} must bridge {G} points relative to that baseline to pull level.',
      'The numbers behind this pairing begin with {PA} points per week from {A} and {PB} from {B}. {L} leads by {G}; {T} can narrow that distance through improved output or an opponent’s shortfall.',
      '{A} and {B} have set the production bar at {PA} and {PB}. The gap is {G}, in {L}’s favor. That is the benchmark {T} must challenge, rather than chase a reputation.',
      'Before kickoff, {L} has a {G}-point edge in scoring pace. {A}’s {PA} and {B}’s {PB} explain the gap; the coming lineup totals will determine whether it holds.',
      'There is a concrete hurdle for {T}: {G} points of average production separate it from {L}. {A} enters at {PA} per game, {B} at {PB}, making relative improvement central to the contest.'
    ],
    setup: [
      '{A}’s lineup and {B}’s lineup will supply the first useful comparison in this contest. Every active slot matters, particularly when a late scratch can leave a manager short of a full week’s opportunities.',
      'For {B}, preparation starts with a complete starting lineup against {A}. Available replacements and kickoff times deserve attention before the first slot locks.',
      '{A} has to make its starting choices with {B} across the board. The practical task is straightforward: protect the active lineup and leave workable replacement options where possible.',
      'The first contest between {A} and {B} this week happens at lineup lock. A manager who waits on an uncertain starter needs an alternative whose game has not already begun.',
      '{B} can give itself a cleaner shot at {A} by settling availability questions before kickoff. An unused replacement cannot recover points once its game locks.',
      '{A} versus {B} puts the attention on selection. The strongest available starters belong in active slots; a name on the bench cannot contribute to this week’s total.',
      'Lineup flexibility is part of {B}’s assignment against {A}. Later kickoff options can preserve a response to changing availability, provided the eligible slot remains open.',
      '{A} needs its choices ready when each game starts against {B}. Waiting for information can help, but waiting beyond a replacement’s kickoff removes that option altogether.',
      'Against {A}, {B} has a week of individual player outcomes to assemble into one total. Getting a full active lineup is the controllable part before those outcomes arrive.',
      '{A} and {B} begin with start-sit decisions, then live with the results. Checking eligibility and availability early keeps an avoidable empty slot from becoming the story.',
      'There is practical work for {B} before it faces {A}: confirm starters, review replacements, and account for kickoff order. Those decisions shape the opportunities the lineup gets.',
      '{A}’s preparation for {B} extends to the last eligible starting slot. A backup plan matters most when news arrives after the early games have already locked.'
    ],
    history: [
      '{A}’s series record against {B} stands at {S} over {M} meetings. Another result adds weight to a rivalry already measured in more than a single week.',
      'The longer view belongs in the conversation: {A} is {S} against {B} through {M} meetings. This week gives both sides another entry to answer for.',
      '{M} meetings have left {A} with a {S} record against {B}. The next one can shift the balance, even if it cannot erase the games behind it.',
      '{B} is a familiar opponent for {A}: {M} meetings, a {S} mark from {A}’s side. That is the history these lineups inherit.',
      'Revisit the series and {A} holds a {S} record against {B}. Across {M} games, the pairing has acquired a ledger that this result will extend.',
      'This matchup reaches beyond the current standings. {A} has gone {S} against {B} in {M} meetings, giving the next final score a place in a longer argument.',
      '{A} and {B} have crossed paths {M} times. Read from {A}’s side, the record is {S}; another week offers the chance to strengthen or repair that line.',
      'A {S} series record follows {A} into the meeting with {B}. The {M} previous contests supply background, while the active lineups decide the next entry.',
      'The rivalry ledger lists {M} meetings between {A} and {B}, with {A} at {S}. Each manager has a reason to care about where that count goes next.',
      '{B} knows this pairing has a past. {A}’s {S} mark over {M} meetings gives the contest a second frame alongside the season records.',
      'Over {M} encounters with {B}, {A} has recorded {S}. The next result joins that total, carrying a little more permanence than one week’s standings position.',
      'The series gives {A} and {B} something tangible to revisit: {S} from {A}’s perspective across {M} meetings. This week adds the next piece.'
    ],
    close: [
      '{A} wants the win; {B} stands in the way. Once the final active player finishes, their Week {W} argument belongs to the scoreboard.',
      'The closing question for Week {W} is whether {D} can make {F} pay for a shortfall. Both lineups will have to earn their totals.',
      '{B} has the same immediate objective as {A}: finish Week {W} with the larger total. Every starting slot contributes to that pursuit.',
      'For {A}, the next step is through {B}. Week {W} will measure the lineup chosen, not the alternatives left unused.',
      '{F} carries the expectation, {D} the chance to overturn it. By the end of Week {W}, one of those positions will look considerably better.',
      'Whatever the early scores suggest, {A} and {B} must account for every remaining starter. The Week {W} result waits for the whole lineup.',
      '{D} does not need to win the forecast against {F}. It needs the higher final total in Week {W}, one starting slot at a time.',
      'The next move belongs to the managers of {A} and {B}. Their Week {W} selections turn the preparation into a result they must own.',
      '{B} can answer {A} only with production. The Week {W} lineup is the place to put that answer together.',
      'Week {W} brings the attention back to {A} and {B} when their starters take the field. From there, the point total becomes the argument.',
      '{F} has a position to justify against {D}. Week {W} offers no credit for the forecast until the lineup delivers.',
      'When Week {W} closes, {A} and {B} will have a fresh result between them. The decisions made before kickoff are the ones they take into it.'
    ]
  };
  PREVIEW_COPY.evenHook = [
    "Week {W} brings {A} ({RA}) against {B} ({RB}) with a {E}% forecast for {F}. There is little separation here; a single strong starter can change the complexion of the contest.",
    "{A} enters {RA}, {B} enters {RB}, and Week {W} offers neither much breathing room. The forecast sits at {E}% for {F}, leaving this pairing finely balanced.",
    "Put {A}’s {RA} beside {B}’s {RB}: those are the records entering Week {W}. A {E}% forecast for {F} points to a close contest rather than a commanding advantage.",
    "{B} meets {A} in Week {W} at {RB} against {RA}. With {F} at {E}%, both managers have reason to expect a competitive afternoon.",
    "The Week {W} pairing of {A} and {B} starts with records of {RA} and {RB}. {F} receives {E}% win probability, a narrow forecast that leaves the game open.",
    "{A} has {RA} on the season; {B} brings {RB} to Week {W}. The forecast is close at {E}% for {F}, making each productive lineup slot particularly welcome.",
    "A tight forecast frames {A} ({RA}) against {B} ({RB}) in Week {W}. {F} stands at {E}%, with little reason for either manager to feel comfortable before kickoff.",
    "For {A} and {B}, Week {W} begins near the middle of the probability board. Their records are {RA} and {RB}, and {F} gets {E}%. The contest remains there to take.",
    "{B}’s {RB} record gets its next test from {A} at {RA}. Week {W} assigns {F} {E}% win probability, keeping the focus on the small advantages either lineup can find.",
    "There is no overwhelming forecast in {A} versus {B}. Week {W} finds them {RA} and {RB}; {F} holds {E}%, close enough for both managers to see an opening.",
    "{A} and {B} arrive at Week {W} with {RA} and {RB} records. At {E}% for {F}, the forecast offers little protection against one poor starting decision.",
    "Watch the individual contributions in {A} ({RA}) against {B} ({RB}). The Week {W} forecast places {F} at {E}%, leaving modest swings room to matter."
];
  PREVIEW_COPY.evenClose = [
    "{A} and {B} have a close Week {W} contest to resolve. A narrow win counts all the same once the last starter finishes.",
    "Neither {A} nor {B} can treat this Week {W} assignment casually. A small contribution may prove as useful as a headline performance.",
    "Week {W} asks {A} and {B} to find separation the forecast barely offers. The active lineups get the final say.",
    "{B} has an opening against {A}, and the reverse is just as true. Week {W} is a chance for either side to take it.",
    "For {A}, beating {B} in Week {W} begins with getting useful output across the lineup. One quiet slot can place the burden on the rest.",
    "{A} and {B} may need every available point in Week {W}. Until the final starter is done, neither has a result to bank.",
    "The Week {W} opportunity belongs equally on both managers’ desks. {A} and {B} now have to turn choices into production.",
    "{B} cannot plan around an easy passage past {A}. This Week {W} pairing asks both sides to stay attentive through lineup lock.",
    "When the Week {W} scores begin to move, {A} and {B} will look for a cushion. The forecast has supplied very little of one.",
    "{A} against {B} gives Week {W} a contest with room for a late turn. Remaining starters matter more than an early lead.",
    "For {B} and {A}, Week {W} comes down to the total their chosen players build. Close forecasts still produce a full result.",
    "{A} and {B} have reached the point where the Week {W} preparation must become points. Neither side has much forecasted margin to waste."
];
  function scoringContext(A,B,week){
    try{
      if(week<=1) return null;
      var table=window.FSNIntel.standingsThrough(week-1)||[];
      var ra=table.find(function(r){return r&&r.team&&String(r.team.id)===String(A.id);});
      var rb=table.find(function(r){return r&&r.team&&String(r.team.id)===String(B.id);});
      if(ra&&rb&&ra.avg!=null&&rb.avg!=null&&num(ra.avg)!=null&&num(rb.avg)!=null) return {a:Number(ra.avg),b:Number(rb.avg)};
    }catch(err){ console.error('[MatchupPreviewGuard] scoring context failed for Week '+week,err); }
    return null;
  }
  function repairPreview(article,draw){
    if(!article||article.__dynamicMatchupBound||typeof article.id!=='string'||article.id.indexOf('preview-game-')!==0) return article;
    var pair=pairFor(article);
    if(!pair){ console.error('[MatchupPreviewGuard] could not resolve teams for '+article.id,new Error('MATCHUP_PREVIEW_TEAM_BINDING_FAILED')); return article; }
    var A=pair.A,B=pair.B,week=pair.week,recA=record(A,week),recB=record(B,week),series=h2h(A,B,week),pA=probability(A,B,week,series),fav=pA>=50?A:B,dog=pA>=50?B:A,edge=Math.round(Math.max(pA,100-pA));
    var pace=scoringContext(A,B,week);
    var values={A:esc(A.name),B:esc(B.name),RA:esc(recA),RB:esc(recB),W:week,F:esc(fav.name),D:esc(dog.name),E:edge};
    var season=typeof window.NewsDesk.viewedSeasonYear==='function'?window.NewsDesk.viewedSeasonYear():0;
    var league=typeof window.selectedLeagueId==='function'?window.selectedLeagueId():allTeams().map(function(t){return t.id;}).sort().join('|');
    var seed=JSON.stringify([league,season,week,A.id,B.id,recA,recB,pA,series&&[series.winsFor,series.winsAgainst,series.aWins,series.bWins,series.ties,series.meetingCount]]);
    function beat(slot){
      var pool=PREVIEW_COPY[slot], key=week+':'+slot;
      if(!draw[key]) draw[key]=new Set();
      var used=draw[key], start=hash(seed+':'+slot)%pool.length, chosen=start;
      for(var n=0;n<pool.length;n++){ var candidate=(start+n)%pool.length; if(!used.has(candidate)){ chosen=candidate; break; } }
      used.add(chosen);
      return pool[chosen].replace(/\{([A-Z]+)\}/g,function(_,k){return '<b>'+values[k]+'</b>';});
    }
    var paragraphs=[beat(edge<=55?'evenHook':'hook')];
    if(pace&&pace.a!==pace.b){
      values.PA=pace.a.toFixed(1); values.PB=pace.b.toFixed(1); values.G=Math.abs(pace.a-pace.b).toFixed(1);
      values.L=esc(pace.a>pace.b?A.name:B.name); values.T=esc(pace.a>pace.b?B.name:A.name);
      paragraphs.push(beat('pace'));
    }else paragraphs.push(beat('setup'));
    if(series&&Number(series.meetingCount)>0){
      values.S=esc((series.winsFor!=null?series.winsFor:series.aWins)+'-'+(series.winsAgainst!=null?series.winsAgainst:series.bWins)+(series.ties?'-'+series.ties:''));
      values.M=esc(series.meetingCount); paragraphs.push(beat('history'));
    }
    paragraphs.push(beat(edge<=55?'evenClose':'close'));
    var copy=Object.assign({},article); copy.__dynamicMatchupBound=true; copy.narrativeLocked=true;
    copy.dek=esc(A.name)+' ('+esc(recA)+') at '+esc(B.name)+' ('+esc(recB)+') — '+esc(fav.name)+' at '+edge+'% win probability.';
    copy.paragraphs=paragraphs;
    return copy;
  }
  function financialOnly(article){
    if(!article) return false;
    return /faab/i.test([article.id,article.kind,article.tag,article.metaTag,article.headline,article.articleType].filter(Boolean).join(' '));
  }
  function scrubString(value){
    return String(value).replace(/\bFAAB\b/gi,'waiver priority').replace(/\bwaiver budget\b/gi,'waiver order').replace(/\bbidding money\b/gi,'waiver position');
  }
  function scrubValue(value){
    if(typeof value==='string') return scrubString(value);
    if(Array.isArray(value)) return value.map(scrubValue);
    if(value&&typeof value==='object'){
      var out={}; Object.keys(value).forEach(function(k){ out[k]=scrubValue(value[k]); }); return out;
    }
    return value;
  }
  function cleanArticle(article,draw){
    if(financialOnly(article)) return null;
    return scrubValue(repairPreview(article,draw));
  }
  function cleanList(list){
    if(!Array.isArray(list)) return list;
    // Allocate in stable ID order, then restore editorial order. No persistent
    // state: refreshes and differently ordered feeds produce the same copy.
    var draw=Object.create(null), cleaned=new Map();
    list.slice().sort(function(a,b){return String(a&&a.id).localeCompare(String(b&&b.id));}).forEach(function(article){cleaned.set(article,cleanArticle(article,draw));});
    return list.map(function(article){return cleaned.get(article);}).filter(Boolean);
  }
  function scrubAnalytics(){
    try{
      document.querySelectorAll('.analytics-model').forEach(function(card){
        var text=card.textContent||'';
        if(/Waiver Wire Gem Finder ROI|FAAB|PTS\s*\/\s*\$1/i.test(text)) card.remove();
      });
    }catch(err){ console.error('[NoFaabGuard] analytics scrub failed',err); }
  }
  function patch(){
    if(!window.NewsDesk||window.NewsDesk.__dynamicMatchupGuard) return false;
    if(window.FSNIntel&&typeof window.FSNIntel.faabReport==='function'){
      window.FSNIntel.faabReport=function(){ return null; };
    }
    ['getTimelineStream','getNewsFeedForWeek','generate'].forEach(function(name){
      var original=window.NewsDesk[name];
      if(typeof original==='function') window.NewsDesk[name]=function(){ return cleanList(original.apply(this,arguments)); };
    });
    if(typeof window.NewsDesk.tickerHeadlines==='function'){
      var originalTicker=window.NewsDesk.tickerHeadlines;
      window.NewsDesk.tickerHeadlines=function(){
        var result=originalTicker.apply(this,arguments);
        if(Array.isArray(result)) return result.filter(function(item){return !/FAAB|\$\d+[^<]{0,40}(?:CLAIM|WAIVER)/i.test(typeof item==='string' ? item : JSON.stringify(item));}).map(scrubValue);
        return scrubString(result);
      };
    }
    try{ Object.defineProperty(window.NewsDesk,'__dynamicMatchupGuard',{value:true,enumerable:false}); }catch(_){ window.NewsDesk.__dynamicMatchupGuard=true; }
    scrubAnalytics();
    if(typeof MutationObserver==='function'){
      new MutationObserver(scrubAnalytics).observe(document.documentElement,{childList:true,subtree:true});
    }
    return true;
  }
  function boot(n){ if(patch()) return; if(n>=120){ console.error('[MatchupPreviewGuard] NewsDesk did not become available; matchup/no-FAAB guards were not installed.',new Error('MATCHUP_PREVIEW_GUARD_UNAVAILABLE')); return; } setTimeout(function(){boot(n+1);},25); }
  if(typeof window!=='undefined') setTimeout(function(){boot(0);},0);
})();