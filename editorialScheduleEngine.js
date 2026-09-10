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
  function seriesLine(A,B,s){
    if(!s) return 'The Record Book has no verified series edge available for this pairing, so the preview does not invent one.';
    var aw=num(s.winsFor!=null?s.winsFor:s.aWins)||0, bw=num(s.winsAgainst!=null?s.winsAgainst:s.bWins)||0, ties=num(s.ties)||0, meetings=num(s.meetingCount);
    if(meetings==null) meetings=aw+bw+ties;
    if(!meetings) return '<b>'+esc(A.name)+'</b> and <b>'+esc(B.name)+'</b> have no verified prior meeting in the loaded Record Book window.';
    if(aw===bw) return 'The Record Book is level after <b>'+meetings+'</b> meeting'+(meetings===1?'':'s')+': <b>'+aw+'-'+bw+(ties?'-'+ties:'')+'</b>. This matchup arrives without a historical owner.';
    var leader=aw>bw?A:B;
    return '<b>'+esc(leader.name)+'</b> owns the verified series <b>'+Math.max(aw,bw)+'-'+Math.min(aw,bw)+(ties?'-'+ties:'')+'</b> through <b>'+meetings+'</b> meeting'+(meetings===1?'':'s')+'. That history belongs to this matchup only; it is not borrowed from the league-wide marquee game.';
  }
  function scoringLine(A,B,week){
    try{
      var table=window.FSNIntel.standingsThrough(Math.max(0,week-1))||[], ra=table.find(function(r){return r&&r.team&&String(r.team.id)===String(A.id);}), rb=table.find(function(r){return r&&r.team&&String(r.team.id)===String(B.id);});
      if(ra&&rb&&num(ra.avg)!=null&&num(rb.avg)!=null){ var d=Math.abs(Number(ra.avg)-Number(rb.avg)), leader=Number(ra.avg)>=Number(rb.avg)?A:B; return 'The current scoring file gives <b>'+esc(leader.name)+'</b> a <b>'+d.toFixed(1)+'-point</b> per-game production edge entering this week.'; }
    }catch(err){ console.error('[MatchupPreviewGuard] scoring context failed for Week '+week,err); }
    return 'There is not yet a complete prior-week scoring sample for both teams, so this preview stays anchored to verified records, series history, and the model rather than manufacturing a production edge.';
  }
  function repairPreview(article){
    if(!article||article.__dynamicMatchupBound||typeof article.id!=='string'||article.id.indexOf('preview-game-')!==0) return article;
    var pair=pairFor(article);
    if(!pair){ console.error('[MatchupPreviewGuard] could not resolve teams for '+article.id,new Error('MATCHUP_PREVIEW_TEAM_BINDING_FAILED')); return article; }
    var A=pair.A,B=pair.B,week=pair.week,recA=record(A,week),recB=record(B,week),series=h2h(A,B,week),pA=probability(A,B,week,series),fav=pA>=50?A:B,dog=pA>=50?B:A,edge=Math.round(Math.max(pA,100-pA));
    var closers=['This is a two-team file, not a league-wide template: the result will either validate this matchup-specific edge or rewrite it by Sunday night.','The model has picked a side; the Record Book has supplied the history. What remains is the only part no preview can prewrite — the score.','There is enough evidence here to frame the game and not enough to declare it over. That is exactly where a useful preview should stop.','The numbers establish the pressure points. The lineup choices decide whether any of them survive contact with the actual week.'];
    var copy=Object.assign({},article); copy.__dynamicMatchupBound=true; copy.narrativeLocked=true;
    copy.dek=esc(A.name)+' ('+esc(recA)+') at '+esc(B.name)+' ('+esc(recB)+') — '+esc(fav.name)+' carries a '+edge+'% matchup-specific model lean.';
    copy.paragraphs=['Week <b>'+week+'</b> is its own case file: <b>'+esc(A.name)+'</b> enters at <b>'+esc(recA)+'</b> and <b>'+esc(B.name)+'</b> enters at <b>'+esc(recB)+'</b>. The model gives <b>'+esc(fav.name)+'</b> a <b>'+edge+'%</b> edge over <b>'+esc(dog.name)+'</b>; that probability was calculated for these two teams, not copied from another game.',seriesLine(A,B,series),scoringLine(A,B,week),closers[hash(week+':'+A.id+':'+B.id)%closers.length]];
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
  function cleanArticle(article){
    if(financialOnly(article)) return null;
    return scrubValue(repairPreview(article));
  }
  function cleanList(list){ return Array.isArray(list)?list.map(cleanArticle).filter(Boolean):list; }
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
        if(Array.isArray(result)) return result.filter(function(item){return !/FAAB|\$\d+[^<]{0,40}(?:CLAIM|WAIVER)/i.test(String(item));}).map(scrubString);
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