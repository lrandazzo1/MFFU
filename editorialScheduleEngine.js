/* ============================================================================
   FSN — Editorial Schedule Engine
   ----------------------------------------------------------------------------
   A tiny, dependency-free helper that answers ONE question:

       "For a given fantasy week, when should each editorial desk publish?"

   This engine re-anchors the release calendar to the league's earliest
   scheduled kickoff for the week. It is deterministic and remains available
   globally because multiple independent index.html blocks consume it.
============================================================================ */
(function(){
  'use strict';

  var HOUR = 3600 * 1000;
  var DAY  = 24 * HOUR;
  var CADENCE = {
    recap: { offsetDays:5, hour:9, cadence:'T-3', dayHint:'MONDAY / TUESDAY', label:'POST-MORTEM', desks:['Post-Mortem','FSN Power Index','Historical Fallout'] },
    waivers: { offsetDays:-1, hour:9, cadence:'T-2', dayHint:'WEDNESDAY', label:'TRANSACTION WIRE', desks:['Transaction Wire','Waiver Audits','Roster Analysis'] },
    primer: { offsetDays:0, hoursBefore:3, hour:9, cadence:'T-1', dayHint:'THURSDAY / PRE-GAME OPENER', label:'MATCHUP PRESSURES', desks:['Matchup Pressures','Rivalry Spotlights','Preview Desk'] },
    injury: { offsetDays:2, hour:11, cadence:'MATCHUPDAY', dayHint:'SATURDAY / SUNDAY', label:'INJURY WIRE', desks:['Injury Wire','Breaking Lineup Shifts'] },
    gameday: { offsetDays:3, hour:20, cadence:'SLATE FINAL', dayHint:'SUNDAY NIGHT', label:'FINAL', desks:['Sunday Night Finals'] },
    primetime: { offsetDays:4, hour:23, cadence:'SLATE FINAL', dayHint:'MONDAY NIGHT', label:'MONDAY FINAL', desks:['Monday Nightcap'] },
  };
  var SLOT_ORDER = ['waivers','primer','injury','gameday','primetime','recap'];
  var DAY_NAMES = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];

  function readLeagueEspnData(){
    try{
      if(typeof window !== 'undefined' && window.LeagueData && window.LeagueData.espnData) return window.LeagueData.espnData;
    }catch(err){ console.warn('[EditorialScheduleEngine] LeagueData read failed', err); }
    return null;
  }

  function firstGameTimestamp(seasonYear, week, espnData){
    var wk = parseInt(week,10);
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
        var ts = typeof stamp === 'number' ? stamp : new Date(stamp).getTime();
        if(!Number.isFinite(ts)){
          console.warn('[EditorialScheduleEngine] unparseable kickoff stamp for Week ' + wk, stamp);
          return;
        }
        if(earliest == null || ts < earliest) earliest = ts;
      });
    });
    return earliest;
  }

  function cadenceFor(slotName){ return CADENCE[slotName] || null; }
  function releaseLabelFor(slotName){ var c = CADENCE[slotName]; return c ? c.cadence : null; }
  function desksFor(slotName){ var c = CADENCE[slotName]; return c && Array.isArray(c.desks) ? c.desks.slice() : []; }

  function releaseAt(slotName, firstKickoff){
    var cad = CADENCE[slotName];
    if(!cad || firstKickoff == null) return null;
    var K = new Date(firstKickoff);
    if(!Number.isFinite(K.getTime())) return null;
    var offsetDays = cad.offsetDays || 0;
    var day = new Date(K.getFullYear(),K.getMonth(),K.getDate()+offsetDays);
    if(cad.hoursBefore != null && offsetDays === 0){
      var anchored = K.getTime() - cad.hoursBefore * HOUR;
      var floor = new Date(day.getFullYear(),day.getMonth(),day.getDate(),cad.hour || 9,0,0,0).getTime();
      return anchored > floor ? anchored : floor;
    }
    var hour = cad.hour != null ? cad.hour : 9;
    return new Date(day.getFullYear(),day.getMonth(),day.getDate(),hour,0,0,0).getTime();
  }

  function computeWeeklySchedule(firstKickoff){
    if(firstKickoff == null) return [];
    var K = new Date(firstKickoff);
    if(!Number.isFinite(K.getTime())) return [];
    var rows = SLOT_ORDER.map(function(slotName){
      var at = releaseAt(slotName,firstKickoff);
      if(at == null) return null;
      var when = new Date(at);
      return { slot:slotName, cadence:CADENCE[slotName].cadence, label:CADENCE[slotName].label, desks:desksFor(slotName), at:at, day:DAY_NAMES[when.getDay()], hour:when.getHours() };
    }).filter(Boolean);
    rows.sort(function(a,b){ return a.at-b.at; });
    return rows;
  }

  function currentCadencePhase(firstKickoff, now){
    if(firstKickoff == null) return null;
    var ref = now instanceof Date ? now.getTime() : (now || Date.now());
    var delta = ref - firstKickoff;
    var days = Math.floor(delta / DAY);
    if(days < -3) return 'PRE-WEEK';
    if(days < -1) return 'T-3';
    if(days < 0) return 'T-2';
    if(days === 0) return 'T-1';
    if(days <= 2) return 'MATCHUPDAY';
    return 'POST-SLATE';
  }

  var api = {
    firstGameTimestamp:firstGameTimestamp,
    cadenceFor:cadenceFor,
    releaseLabelFor:releaseLabelFor,
    desksFor:desksFor,
    releaseAt:releaseAt,
    computeWeeklySchedule:computeWeeklySchedule,
    currentCadencePhase:currentCadencePhase,
    slots:SLOT_ORDER.slice(),
  };
  try{
    if(typeof window !== 'undefined') window.EditorialScheduleEngine = api;
  }catch(err){ console.error('[EditorialScheduleEngine] global publish failed',err); }
})();

/* ============================================================================
   MATCHUP PREVIEW CONTEXT GUARD
   ----------------------------------------------------------------------------
   index.html's all-game preview generator is intentionally left structurally
   untouched. This guard runs after the News Desk has published its API and
   repairs only `preview-game-*` articles. Each preview is rebound to its own
   two teams, records, Record Book series, and model probability. That prevents
   a stale/global marquee context or a flat fallback from leaking one game's
   prose into every card while preserving every unrelated article generator.
============================================================================ */
(function(){
  'use strict';

  function esc(value){
    return String(value == null ? '' : value).replace(/[&<>"']/g,function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function num(value){ var n = Number(value); return Number.isFinite(n) ? n : null; }
  function clamp(value,min,max){ return Math.max(min,Math.min(max,value)); }
  function stableHash(value){
    var s = String(value), h = 2166136261;
    for(var i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h,16777619); }
    return h >>> 0;
  }
  function teams(){
    try{
      var rows = window.LeagueData && typeof window.LeagueData.getTeams === 'function' ? window.LeagueData.getTeams() : [];
      return Array.isArray(rows) ? rows.filter(Boolean) : [];
    }catch(err){
      console.error('[MatchupPreviewGuard] team lookup failed',err);
      return [];
    }
  }
  function resolvePair(article, allTeams){
    if(!article || typeof article.id !== 'string' || article.id.indexOf('preview-game-') !== 0) return null;
    for(var i=0;i<allTeams.length;i++){
      for(var j=0;j<allTeams.length;j++){
        if(i === j) continue;
        var a = allTeams[i], b = allTeams[j];
        var week = Number(article.week);
        if(!(week > 0)){
          var m = article.id.match(/^preview-game-(\d+)-/);
          week = m ? Number(m[1]) : 0;
        }
        if(week > 0 && article.id === 'preview-game-' + week + '-' + a.id + '-' + b.id) return { week:week, A:a, B:b };
      }
    }
    return null;
  }
  function record(team, week){
    try{
      var value = window.FSNIntel.getRecordAsOfWeek(team.id,week);
      return value == null || value === '' ? '0-0' : String(value);
    }catch(err){
      console.error('[MatchupPreviewGuard] record lookup failed for team ' + team.id + ' Week ' + week,err);
      return 'record unavailable';
    }
  }
  function recordBook(A,B,week){
    try{
      if(!A.ownerId || !B.ownerId || typeof window.getH2HAsOf !== 'function') return null;
      var season = window.NewsDesk && typeof window.NewsDesk.viewedSeasonYear === 'function' ? Number(window.NewsDesk.viewedSeasonYear()) : 0;
      return window.getH2HAsOf(A.ownerId,B.ownerId,season || 0,week-1) || null;
    }catch(err){
      console.error('[MatchupPreviewGuard] Record Book lookup failed for ' + A.id + ' vs ' + B.id + ' Week ' + week,err);
      return null;
    }
  }
  function probability(A,B,week,h2h){
    var priorWeek = Math.max(0,week-1), p = null;
    try{ p = num(window.FSNIntel.winProbability(priorWeek,A,B)); }
    catch(err){ console.error('[MatchupPreviewGuard] model probability failed for ' + A.id + ' vs ' + B.id + ' Week ' + week,err); }
    if(p == null) p = 50;

    /* The core model already uses current scoring and historical context. If it
       returns an exact coin flip despite a non-even Record Book series, retain
       the model's scale but let the verified series break only that deadlock. */
    if(Math.abs(p-50) < 0.0001 && h2h){
      var aw = num(h2h.winsFor != null ? h2h.winsFor : h2h.aWins);
      var bw = num(h2h.winsAgainst != null ? h2h.winsAgainst : h2h.bWins);
      if(aw != null && bw != null && aw !== bw) p = 50 + clamp((aw-bw)*1.25,-7.5,7.5);
    }
    return clamp(p,12,88);
  }
  function seriesSentence(A,B,h2h){
    if(!h2h) return 'The Record Book has no verified series edge available for this pairing, so the preview does not invent one.';
    var aw = num(h2h.winsFor != null ? h2h.winsFor : h2h.aWins) || 0;
    var bw = num(h2h.winsAgainst != null ? h2h.winsAgainst : h2h.bWins) || 0;
    var ties = num(h2h.ties) || 0;
    var meetings = num(h2h.meetingCount);
    if(meetings == null) meetings = aw + bw + ties;
    if(!meetings) return '<b>' + esc(A.name) + '</b> and <b>' + esc(B.name) + '</b> have no verified prior meeting in the loaded Record Book window.';
    if(aw === bw) return 'The Record Book is level after <b>' + meetings + '</b> meeting' + (meetings===1?'':'s') + ': <b>' + aw + '-' + bw + (ties ? '-' + ties : '') + '</b>. This matchup arrives without a historical owner.';
    var leader = aw > bw ? A : B, leadWins = Math.max(aw,bw), trailWins = Math.min(aw,bw);
    return '<b>' + esc(leader.name) + '</b> owns the verified series <b>' + leadWins + '-' + trailWins + (ties ? '-' + ties : '') + '</b> through <b>' + meetings + '</b> meeting' + (meetings===1?'':'s') + '. That history belongs to this matchup only; it is not borrowed from the league-wide marquee game.';
  }
  function scoringSentence(A,B,week){
    try{
      var table = window.FSNIntel.standingsThrough(Math.max(0,week-1)) || [];
      var ra = table.find(function(r){ return r && r.team && String(r.team.id) === String(A.id); });
      var rb = table.find(function(r){ return r && r.team && String(r.team.id) === String(B.id); });
      if(ra && rb && num(ra.avg) != null && num(rb.avg) != null){
        var diff = Math.abs(Number(ra.avg)-Number(rb.avg));
        var leader = Number(ra.avg) >= Number(rb.avg) ? A : B;
        return 'The current scoring file gives <b>' + esc(leader.name) + '</b> a <b>' + diff.toFixed(1) + '-point</b> per-game production edge entering this week.';
      }
    }catch(err){ console.error('[MatchupPreviewGuard] scoring context failed for Week ' + week,err); }
    return 'There is not yet a complete prior-week scoring sample for both teams, so this preview stays anchored to verified records, series history, and the model rather than manufacturing a production edge.';
  }
  function repair(article){
    if(!article || article.__dynamicMatchupBound || typeof article.id !== 'string' || article.id.indexOf('preview-game-') !== 0) return article;
    var pair = resolvePair(article,teams());
    if(!pair){
      console.error('[MatchupPreviewGuard] could not resolve teams for ' + article.id,new Error('MATCHUP_PREVIEW_TEAM_BINDING_FAILED'));
      return article;
    }
    var A = pair.A, B = pair.B, week = pair.week;
    var recA = record(A,week), recB = record(B,week);
    var h2h = recordBook(A,B,week);
    var pA = probability(A,B,week,h2h);
    var fav = pA >= 50 ? A : B, dog = pA >= 50 ? B : A;
    var edge = Math.round(Math.max(pA,100-pA));
    var seed = stableHash(String(week) + ':' + A.id + ':' + B.id);
    var closers = [
      'This is a two-team file, not a league-wide template: the result will either validate this matchup-specific edge or rewrite it by Sunday night.',
      'The model has picked a side; the Record Book has supplied the history. What remains is the only part no preview can prewrite — the score.',
      'There is enough evidence here to frame the game and not enough to declare it over. That is exactly where a useful preview should stop.',
      'The numbers establish the pressure points. The lineup choices decide whether any of them survive contact with the actual week.'
    ];
    var copy = Object.assign({},article);
    copy.__dynamicMatchupBound = true;
    copy.narrativeLocked = true;
    copy.dek = esc(A.name) + ' (' + esc(recA) + ') at ' + esc(B.name) + ' (' + esc(recB) + ') — ' + esc(fav.name) + ' carries a ' + edge + '% matchup-specific model lean.';
    copy.paragraphs = [
      'Week <b>' + week + '</b> is its own case file: <b>' + esc(A.name) + '</b> enters at <b>' + esc(recA) + '</b> and <b>' + esc(B.name) + '</b> enters at <b>' + esc(recB) + '</b>. The model gives <b>' + esc(fav.name) + '</b> a <b>' + edge + '%</b> edge over <b>' + esc(dog.name) + '</b>; that probability was calculated for these two teams, not copied from another game.',
      seriesSentence(A,B,h2h),
      scoringSentence(A,B,week),
      closers[seed % closers.length]
    ];
    return copy;
  }
  function repairList(list){ return Array.isArray(list) ? list.map(repair) : list; }
  function patch(){
    if(!window.NewsDesk || window.NewsDesk.__dynamicMatchupGuard) return false;
    ['getTimelineStream','getNewsFeedForWeek','generate'].forEach(function(name){
      var original = window.NewsDesk[name];
      if(typeof original !== 'function') return;
      window.NewsDesk[name] = function(){ return repairList(original.apply(this,arguments)); };
    });
    try{ Object.defineProperty(window.NewsDesk,'__dynamicMatchupGuard',{ value:true, enumerable:false }); }
    catch(_){ window.NewsDesk.__dynamicMatchupGuard = true; }
    return true;
  }
  function boot(attempt){
    if(patch()) return;
    if(attempt >= 120){
      console.error('[MatchupPreviewGuard] NewsDesk did not become available; matchup previews were not rebound.',new Error('MATCHUP_PREVIEW_GUARD_UNAVAILABLE'));
      return;
    }
    setTimeout(function(){ boot(attempt+1); },25);
  }
  if(typeof window !== 'undefined') setTimeout(function(){ boot(0); },0);
})();