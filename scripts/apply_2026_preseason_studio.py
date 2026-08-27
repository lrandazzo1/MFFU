from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / 'index.html'
text = INDEX.read_text(encoding='utf-8')
original = text


def sub_once(pattern, replacement, label, flags=re.S):
    global text
    new, count = re.subn(pattern, lambda _m: replacement, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f'{label}: expected one match, found {count}')
    text = new


def literal_once(old, new, label):
    global text
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected one literal match, found {count}')
    text = text.replace(old, new, 1)


# ---------------------------------------------------------------------------
# NewsDesk: make Studio availability a season rule, with an explicit 2026
# preseason-special detector shared by the feed and the Studio shell.
# ---------------------------------------------------------------------------
sub_once(
    r"(const TOPICS = \[[\s\S]*?\n\];)",
    r"""\1

const STUDIO_FIRST_SEASON = 2026;
function studioAllowedForSeason(season){
  return Number(season) >= STUDIO_FIRST_SEASON;
}
function is2026PreseasonSpecial(ctx){
  if(Number(viewedSeasonYear()) !== 2026) return false;
  if(!ctx || Number(ctx.week) !== 1) return false;
  const total = Number(ctx.weekTotal || 0);
  const scores = Array.isArray(ctx.allScores) ? ctx.allScores : [];
  return total <= 0 && (scores.length === 0 || scores.every(v=> Number(v || 0) <= 0));
}
function filterStudioForSeason(list, season){
  if(studioAllowedForSeason(season)) return Array.isArray(list) ? list : [];
  return (Array.isArray(list) ? list : []).filter(a=>{
    if(!a || a.custom) return true;
    const id = String(a.id || '');
    return !(a.kind === 'studio' || a.topic === 'studio' || a.stream === 'studio' || id.indexOf('tl-studio-') === 0);
  });
}
""",
    'NewsDesk Studio season helpers',
)

# Replace the Studio timeline card with a historical guard and dedicated 2026
# preseason lead copy. The normal in-season card remains unchanged otherwise.
sub_once(
    r"function tlShowDay\(ctx\)\{[\s\S]*?\n\}\n\n/\* ============================================================\n   SATURDAY",
    r"""function tlShowDay(ctx){
  if(!studioAllowedForSeason(viewedSeasonYear())) return [];

  const table = FSNIntel.powerRankings(ctx.week);
  const top = table[0] || null;
  const seed = 'show' + ctx.week;
  const preseasonSpecial = is2026PreseasonSpecial(ctx);
  const segments = preseasonSpecial
    ? ['State of the League & Defending Champ', 'Draft Report Card & Grades', 'Week 1 Matchup Spotlight', 'Preseason Power Index & Bold Predictions']
    : ['FSN Power Index', 'Waiver Wire Steals', 'Game of the Week', 'Fraud Roast'];

  return [tl({
    id: 'tl-studio-' + ctx.week,
    kind:'studio', topic:'studio', slot:'showday', offset: (hash(seed) % 45),
    at: preseasonSpecial ? Date.now() - (2 * MIN) : undefined,
    metaTag: preseasonSpecial ? '2026 PRESEASON SPECIAL' : 'STUDIO SHOW',
    tag:'FSN STUDIO SHOW', tone:'cyan', priority: preseasonSpecial ? 500 : 200,
    byline:'FSN Broadcast Desk',
    stream:'studio',
    crest: top ? { name: top.team.name, logo: top.team.logo } : null,
    headline: preseasonSpecial
      ? 'FSN STUDIO SHOW: 2026 PRESEASON PREVIEW & DRAFT AUDIT'
      : `FSN STUDIO SHOW · WEEK ${ctx.week} IS ON THE AIR`,
    dek: preseasonSpecial
      ? 'Jim Tolliver & Dee Rawls break down draft grades, reaches, steals, and the state of the league entering 2026.'
      : 'Four segments, two hosts, one league getting dismantled live. Tap to launch the broadcast.',
    paragraphs: preseasonSpecial ? [
      `${datelineTag()} The 2026 season has not kicked off yet, which means the FSN desk gets one clean shot to grade the offseason before the scoreboard starts rewriting every opinion. Jim Tolliver and Dee Rawls are live with the defending champion, the longest title droughts and the league-wide baseline entering Week 1.`,
      `The draft audit goes pick by pick through the biggest reaches and best values, then the desk circles the Week 1 marquee matchup with the all-time series and pregame win probability.`,
      `Tonight's rundown: <b>${segments.join('</b> · <b>')}</b>. Every number comes from the live 2026 league feed and the completed Vault archive; no preseason result is invented.`,
    ] : [
      `${datelineTag()} The Week ${ctx.week} edition of the FSN Studio Show is cued up and ready to run. Your lead anchor takes the rankings, the chief analyst takes the rest, and neither of them is being paid enough to be diplomatic.`,
      `Tonight's rundown: <b>${segments.join('</b> · <b>')}</b>.`,
    ],
    quote: preseasonSpecial
      ? { text:'The draft is over. The receipts start now.', who:'Dee Rawls · FSN Chief Analyst' }
      : null,
  })];
}

/* ============================================================
   SATURDAY""",
    'Studio timeline card',
)

# Timeline runner: show the Studio card in the exact 2026 Week 1 unplayed state,
# and strip machine-generated Studio cards from every pre-2026 archive view.
literal_once(
    "  const ctx = weekContext(week);\n  const phase = FSNIntel.seasonPhase(week);\n  const pregameOnly = ctx.active2026PregameGuard || ctx.allScores.length === 0 || ctx.weekTotal <= 0;\n  let events = [];",
    "  const ctx = weekContext(week);\n  const season = Number(viewedSeasonYear());\n  const phase = FSNIntel.seasonPhase(week);\n  const pregameOnly = ctx.active2026PregameGuard || ctx.allScores.length === 0 || ctx.weekTotal <= 0;\n  const preseasonSpecial = is2026PreseasonSpecial(ctx);\n  let events = [];",
    'timeline season and preseason context',
)

literal_once(
    "  const runners = pregameOnly\n    ? [tlPlayoffBracket, tlPrimer, tlInjury]\n    : [tlPlayoffBracket, tlPreseason, tlPlayoffPicture, tlGameDay, tlRecap, tlWaivers, tlPrimer, tlShowDay, tlInjury, tlDraft];",
    "  const runners = pregameOnly\n    ? (preseasonSpecial ? [tlShowDay, tlPlayoffBracket, tlPrimer, tlInjury, tlDraft] : [tlPlayoffBracket, tlPrimer, tlInjury])\n    : [tlPlayoffBracket, tlPreseason, tlPlayoffPicture, tlGameDay, tlRecap, tlWaivers, tlPrimer, tlShowDay, tlInjury, tlDraft];",
    'timeline runners',
)

literal_once(
    "  let list = events.filter(e=>{\n    if(!e || seen[e.id]) return false;\n    seen[e.id] = true;\n    return true;\n  }).sort((a,b)=> b.at - a.at);",
    "  let list = events.filter(e=>{\n    if(!e || seen[e.id]) return false;\n    seen[e.id] = true;\n    return true;\n  }).sort((a,b)=> b.at - a.at);\n\n  list = filterStudioForSeason(list, season);",
    'historical Studio stream filter',
)

# Cached paths are season-keyed already, but filtering there makes the rule
# absolute even if another future code path injects a Studio object.
literal_once(
    "    applyCachedAI(streamCache.list, cachedCtx);\n    scheduleAIHydration(streamCache.list, cachedCtx);\n    return streamCache.list;",
    "    streamCache.list = filterStudioForSeason(streamCache.list, viewedSeasonYear());\n    applyCachedAI(streamCache.list, cachedCtx);\n    scheduleAIHydration(streamCache.list, cachedCtx);\n    return streamCache.list;",
    'cached historical Studio filter',
)

# Add the explicitly requested feed accessor while retaining the existing
# selected-season engine as the canonical data source.
insert_feed_helper = r"""
function getNewsFeedForWeek(season, week){
  const targetSeason = Number(season || viewedSeasonYear());
  return filterStudioForSeason(getTimelineStream(week), targetSeason);
}

"""
literal_once(
    "/* Ticker copy pulled straight off the stream, so the crawl and the feed\n   never disagree about what just happened. */",
    insert_feed_helper + "/* Ticker copy pulled straight off the stream, so the crawl and the feed\n   never disagree about what just happened. */",
    'getNewsFeedForWeek helper',
)

literal_once(
    "  getTimelineStream, tickerHeadlines, restamp, stamp,",
    "  getTimelineStream, getNewsFeedForWeek, tickerHeadlines, restamp, stamp,",
    'NewsDesk feed export',
)

# ---------------------------------------------------------------------------
# 2026 PRESEASON STUDIO: four real-data segments, no invented archive facts.
# ---------------------------------------------------------------------------
preseason_segments = r"""
function studio2026PreseasonSpecial(week){
  const w = Math.max(1, parseInt(week, 10) || 1);
  if(Number(NewsDesk.viewedSeasonYear()) !== 2026 || w !== 1) return false;
  const ctx = safeStudioCall('2026 preseason context', ()=> NewsDesk.weekContext(w), null);
  if(!ctx) return false;
  const scores = Array.isArray(ctx.allScores) ? ctx.allScores : [];
  return Number(ctx.weekTotal || 0) <= 0 && (scores.length === 0 || scores.every(v=> Number(v || 0) <= 0));
}

function preseasonProfileName(profile){
  if(!profile) return 'Franchise';
  return profile.teamName || profile.manager || profile.displayName || profile.ownerId || 'Franchise';
}

function seg2026HonorRoll(week){
  const rep = safeStudioCall('2026 preseason report', ()=> FSNIntel.preseasonReport(), null);
  if(!rep || !rep.champion) return null;
  const champ = rep.champion;
  const drought = rep.droughtLeader;
  const profiles = Object.values(rep.profiles || {});
  const rows = profiles.map(p=>{
    const games = (Number(p.wins)||0) + (Number(p.losses)||0) + (Number(p.ties)||0);
    const pct = games ? (((Number(p.wins)||0) + (Number(p.ties)||0) * 0.5) / games) * 100 : 0;
    const final2025 = (p.finishes || []).find(f=> Number(f.year) === 2025);
    return {
      profile:p,
      pct,
      rank2025: final2025 && Number(final2025.rank) > 0 ? Number(final2025.rank) : null,
    };
  }).sort((a,b)=>{
    const titleGap = (Number(b.profile.titles)||0) - (Number(a.profile.titles)||0);
    if(titleGap) return titleGap;
    if(Math.abs(b.pct - a.pct) > 0.001) return b.pct - a.pct;
    return preseasonProfileName(a.profile).localeCompare(preseasonProfileName(b.profile));
  }).slice(0, 12).map((entry, i)=>({
    idx:i + 1,
    name:preseasonProfileName(entry.profile),
    sub:(Number(entry.profile.titles)||0) + ' TITLE' + ((Number(entry.profile.titles)||0) === 1 ? '' : 'S') + ' · ' + n1(entry.pct) + '% CAREER WIN',
    value:entry.rank2025 ? '2025 #' + entry.rank2025 : '2025 —',
    dir:(Number(entry.profile.titles)||0) > 0 ? 'up' : '',
  }));
  if(!rows.length){
    rows.push({ idx:'—', name:champ.displayName || '2025 champion', sub:'Vault career rows are still loading', value:'2025 CHAMP' });
  }
  const board = {
    title:'All-Time Franchise Honor Roll',
    rows,
    note:'Sorted by championships, then career win percentage. Final-rank labels come from the completed 2025 season only.',
  };
  return seg('preseason-honor-roll', 'State of the League & Defending Champ', [
    cue('host', `Welcome to the 2026 Preseason Special. I'm Jim Tolliver with Dee Rawls, and the first fact on the board belongs to ${champ.displayName}: the 2025 title is theirs until somebody takes it away.`, 'rundown', board, '2026 PRESEASON SPECIAL · STATE OF THE LEAGUE', { sfx:'whoosh' }),
    cue('analyst', drought
      ? `${drought.displayName} owns the longest active championship drought on this board${drought.lastTitleYear ? `, without a ring since ${drought.lastTitleYear}` : ', still waiting on the first one'}. That is the pressure point I am watching before Week 1.`
      : `The Vault has the champion, but the drought table is still resolving. We will keep this to verified history instead of inventing a grievance.`,
      'rundown', board, drought ? 'LONGEST DROUGHT · ' + String(drought.displayName).toUpperCase() : 'HONOR ROLL · VAULT VERIFIED'),
    cue('host', `The honor roll is the expectation setter: titles first, career win percentage next, and the 2025 final rank beside it. Everybody starts 2026 at zero and zero, but nobody starts with the same résumé.`, 'rundown', board, 'ALL-TIME HONOR ROLL · 2026 EXPECTATIONS'),
  ]);
}

function seg2026DraftAudit(){
  const board = safeStudioCall('2026 draft board', ()=> FSNIntel.draft(), null);
  const grades = safeStudioCall('2026 draft grades', ()=> FSNIntel.draftGrades(), []);
  const teams = safeStudioCall('2026 teams', ()=> LeagueData.getTeams(), []);
  let rows = [];
  if(Array.isArray(grades) && grades.length){
    rows = grades.slice(0, 12).map((g, i)=>({
      idx:i + 1,
      name:(g.team && g.team.name) || 'Team',
      sub:'BEST: ' + (g.best && g.best.name ? g.best.name : '—') + ' · WORST: ' + (g.worst && g.worst.name ? g.worst.name : '—'),
      value:g.grade || '—',
      grade:true,
    }));
  } else {
    rows = (teams || []).slice(0, 12).map((t, i)=>({ idx:i + 1, name:t.name, sub:'Draft detail not posted yet', value:'PENDING' }));
  }
  if(!rows.length) rows.push({ idx:'—', name:'2026 Draft Room', sub:'Waiting for ESPN draft detail', value:'PENDING' });

  const reach = board && Array.isArray(board.reaches) ? board.reaches[0] : null;
  const steal = board && Array.isArray(board.steals) ? board.steals[0] : null;
  const gfx = {
    title:'2026 Draft Report Card',
    rows,
    note:'Grades are value-versus-ADP report cards. Best and worst picks are taken from each team’s real 2026 draft room.',
  };
  const reachText = reach
    ? `${(reach.team && reach.team.name) || 'One draft room'} owns the biggest reach on the board: ${reach.name} at pick ${reach.overall}${Number(reach.adp) > 0 ? ` against an ADP of ${n1(reach.adp)}` : ''}. That is the receipt Dee gets to keep all season.`
    : `The reach board is still empty, so nobody gets roasted on invented ADP data. If the draft feed posts, this segment updates from the actual room.`;
  const stealText = steal
    ? `${(steal.team && steal.team.name) || 'One draft room'} gets the value flag for ${steal.name} at pick ${steal.overall}${Number(steal.adp) > 0 ? ` after an ADP of ${n1(steal.adp)}` : ''}. Falling value is only useful if the roster was ready to take it.`
    : `No verified steal is available yet. The grade board stays honest: no ADP delta, no victory lap.`;
  return seg('preseason-draft-audit', 'Draft Report Card & Grades', [
    cue('host', `Segment two is the draft audit. Report cards are on the screen, and the grade is not a season prediction — it is a receipt for how each room used the board it was given.`, 'rundown', gfx, '2026 DRAFT REPORT CARD · GRADES A+ TO F', { sfx:'whoosh' }),
    cue('analyst', reachText, 'rundown', gfx, reach ? 'BIGGEST REACH · ' + String(reach.name).toUpperCase() : 'REACH BOARD · DATA PENDING', { sfx: reach ? 'buzzer' : null }),
    cue('host', stealText, 'rundown', gfx, steal ? 'BEST VALUE · ' + String(steal.name).toUpperCase() : 'VALUE BOARD · DATA PENDING', { sfx:'sting' }),
  ]);
}

function seg2026Week1Spotlight(week){
  const rep = safeStudioCall('2026 matchup history', ()=> FSNIntel.preseasonReport(), null);
  const games = validStudioGames(week);
  const historyMatch = rep && rep.marquee ? rep.marquee : null;
  let game = null;
  if(historyMatch){
    game = games.find(g=> String(g.awayTeam.id) === String(historyMatch.away.id) && String(g.homeTeam.id) === String(historyMatch.home.id)) || null;
  }
  if(!game) game = games[0] || null;

  const away = historyMatch ? historyMatch.away : (game && game.awayTeam);
  const home = historyMatch ? historyMatch.home : (game && game.homeTeam);
  if(!away || !home) return studioStandbySegment('preseason-week1', 'Matchup of the Week 1 Spotlight', 'matchup', week);

  let awayProb = safeStudioCall('2026 week one probability', ()=> Number(FSNIntel.winProbability(week, away, home)), 50);
  if(!Number.isFinite(awayProb)) awayProb = 50;
  awayProb = Math.max(1, Math.min(99, awayProb));
  const series = historyMatch && historyMatch.series ? historyMatch.series : null;
  const meetings = historyMatch ? Number(historyMatch.meetings || 0) : 0;
  const seriesText = series && meetings
    ? `${Number(series.winsFor)||0}-${Number(series.winsAgainst)||0}${Number(series.ties)||0 ? '-' + Number(series.ties) : ''} across ${meetings} meeting${meetings === 1 ? '' : 's'}`
    : 'first meeting in the loaded Vault';
  const qbA = safeStudioCall('week one away starter', ()=> FSNIntel.startingQB(week, away.id), null);
  const qbB = safeStudioCall('week one home starter', ()=> FSNIntel.startingQB(week, home.id), null);
  const tape = {
    title:'Week 1 Tale of the Tape', prob:awayProb,
    a:{ name:away.name, logo:away.logo, record:recordSafe(away.id, week), qb:(qbA && qbA.name) || 'Lineup pending', pf:game ? projectedSafe(game, 'away') : '—', pfLabel:'PROJECTED' },
    b:{ name:home.name, logo:home.logo, record:recordSafe(home.id, week), qb:(qbB && qbB.name) || 'Lineup pending', pf:game ? projectedSafe(game, 'home') : '—', pfLabel:'PROJECTED' },
  };
  const favourite = awayProb >= 50 ? away : home;
  const favProb = awayProb >= 50 ? awayProb : 100 - awayProb;
  return seg('preseason-week1', 'Matchup of the Week 1 Spotlight', [
    cue('host', `Marquee Game: ${away.name} versus ${home.name}. This is the Week 1 matchup we are putting under the studio lights before a single point is scored.`, 'tale_of_the_tape', tape, 'MARQUEE GAME · ' + String(away.name).toUpperCase() + ' VS ' + String(home.name).toUpperCase(), { sfx:'whoosh' }),
    cue('analyst', `The Vault has this series at ${seriesText}. That matters as context, not destiny; these are new 2026 rosters and the scoreboard is still untouched.`, 'tale_of_the_tape', tape, 'ALL-TIME SERIES · ' + seriesText.toUpperCase()),
    cue('host', `The pregame model leans ${favourite.name} at roughly ${Math.round(favProb)} percent. That is a win probability, not a final score, and Week 1 is exactly when preseason certainty gets stress-tested.`, 'tale_of_the_tape', tape, 'WIN PROBABILITY · ' + String(favourite.name).toUpperCase() + ' ' + Math.round(favProb) + '%', { sfx:'sting' }),
  ]);
}

function seg2026PreseasonPower(week){
  const table = safeStudioCall('2026 preseason power index', ()=> FSNIntel.powerRankings(week), []);
  if(!Array.isArray(table) || !table.length) return null;
  const rows = table.slice(0, 12).map(r=>({
    idx:r.rank,
    name:r.team.name,
    sub:(r.indexBadge ? '[' + r.indexBadge + '] · ' : '') + (r.recordLabel || '0-0') + (Number(r.avg) > 0 ? ' · ' + n1(r.avg) + ' PPG' : ' · PRESEASON BASELINE'),
    value:Number.isFinite(Number(r.powerScore)) ? n1(r.powerScore) : (Number.isFinite(Number(r.rating)) ? n1(r.rating) : 'BASE'),
    dir:r.rank <= 3 ? 'up' : (r.rank >= Math.max(10, table.length - 1) ? 'down' : ''),
  }));
  const top = table[0];
  const bottom = table[table.length - 1];
  const gfx = {
    title:'Preseason FSN Power Index (1–12)',
    rows,
    note:'The preseason baseline uses the existing FSN Power Index inputs, including prior-season signal and draft capital when available. It resets as real 2026 results arrive.',
  };
  return seg('preseason-power', 'Preseason Power Index & Bold Predictions', [
    cue('host', `Final segment: this is the baseline, not the verdict. ${top.team.name} opens 2026 at number one on the FSN Power Index, and now the league gets to spend the season trying to make that look stupid.`, 'rundown', gfx, 'PRESEASON FSN POWER INDEX · NO. 1 ' + String(top.team.name).toUpperCase(), { sfx:'whoosh' }),
    cue('analyst', `My breakout watch starts near the top with ${top.team.name}: the model sees enough underlying signal to give that roster the first chair before kickoff. The bold part is asking whether the draft capital turns into weekly points.`, 'rundown', gfx, 'BOLD PREDICTION · BREAKOUT WATCH ' + String(top.team.name).toUpperCase(), { sfx:'sting' }),
    cue('host', `And the preseason fraud watch starts with ${bottom.team.name}. That is not a sentence about what already happened — nothing has happened. It is the roster with the most work to do to beat the baseline once the games become real.`, 'rundown', gfx, 'PRESEASON FRAUD WATCH · ' + String(bottom.team.name).toUpperCase()),
  ]);
}

function build2026PreseasonSpecial(week){
  return [
    safeSegment('2026 honor roll', ()=> seg2026HonorRoll(week)) || studioStandbySegment('preseason-honor-roll', 'State of the League & Defending Champ', 'power', week),
    safeSegment('2026 draft audit', ()=> seg2026DraftAudit()) || studioStandbySegment('preseason-draft-audit', 'Draft Report Card & Grades', 'coaching', week),
    safeSegment('2026 week one spotlight', ()=> seg2026Week1Spotlight(week)) || studioStandbySegment('preseason-week1', 'Matchup of the Week 1 Spotlight', 'matchup', week),
    safeSegment('2026 preseason power', ()=> seg2026PreseasonPower(week)) || studioStandbySegment('preseason-power', 'Preseason Power Index & Bold Predictions', 'power', week),
  ].filter(Boolean);
}

"""
literal_once(
    "function studioHistoricalView(){",
    preseason_segments + "function studioHistoricalView(){",
    '2026 preseason Studio segments',
)

# Format label drives the Desk launcher subtitle.
literal_once(
    "function studioFormatInfo(week, now){\n  const w = Math.max(1, parseInt(week, 10) || 1);\n  const phase = safeStudioCall('season phase for format', ()=> FSNIntel.seasonPhase(w), 'season');",
    "function studioFormatInfo(week, now){\n  const w = Math.max(1, parseInt(week, 10) || 1);\n  if(studio2026PreseasonSpecial(w)){\n    return { id:'preseason-2026', label:'2026 PRESEASON SPECIAL', subtitle:'2026 Preseason Special · Draft Audit', segments:4 };\n  }\n  const phase = safeStudioCall('season phase for format', ()=> FSNIntel.seasonPhase(w), 'season');",
    '2026 special Studio format',
)

# The 2026 special wins before the generic draft/preseason preview guard.
literal_once(
    "  let segments = [];\n\n  if(phase === 'draft' || phase === 'preseason'){
",
    "  let segments = [];\n\n  if(studio2026PreseasonSpecial(requestedWeek)){\n    segments = build2026PreseasonSpecial(1);\n  } else if(phase === 'draft' || phase === 'preseason'){
",
    'buildShow 2026 special branch',
)

# ---------------------------------------------------------------------------
# UI: hide the Studio topic pill in historical years and label the Desk launcher
# as the 2026 special during the exact Week 1 unplayed state.
# ---------------------------------------------------------------------------
sub_once(
    r"function renderTopicBar\(list\)\{[\s\S]*?\n\}",
    r"""function renderTopicBar(list){
  const historical = Number(NewsDesk.viewedSeasonYear()) < 2026;
  if(historical && ui.topic === 'studio') ui.topic = 'all';
  const counts = { all: list.length };
  list.forEach(a=>{
    if(a.topic) counts[a.topic] = (counts[a.topic] || 0) + 1;
  });
  const topics = historical ? NewsDesk.TOPICS.filter(t=> t.id !== 'studio') : NewsDesk.TOPICS;
  $('topicBar').innerHTML = topics.map(t=>{
    const n = counts[t.id] || 0;
    return `<button class="topic-pill" data-topic="${esc(t.id)}" data-active="${t.id === ui.topic}">
      ${t.icon ? `<span>${t.icon}</span>` : ''}<span>${esc(t.label)}</span><span class="cnt">${n}</span>
    </button>`;
  }).join('');
}""",
    'historical topic bar filter',
)

# Extend the existing availability sync without changing its historical-hide
# behavior. The main label and subtitle return to normal outside the special.
literal_once(
    "        const sub = launcher.querySelector('.min-w-0 span');\n        if(sub && !historical && window.FSNStudio && typeof FSNStudio.formatInfo === 'function'){\n          const info = FSNStudio.formatInfo(effectiveWeek());\n          if(info && info.subtitle) sub.textContent = info.subtitle;\n        }",
    "        const labelWrap = launcher.querySelector('.min-w-0');\n        const sub = launcher.querySelector('.min-w-0 span');\n        if(!historical && window.FSNStudio && typeof FSNStudio.formatInfo === 'function'){\n          const info = FSNStudio.formatInfo(effectiveWeek());\n          if(labelWrap && labelWrap.firstChild) labelWrap.firstChild.nodeValue = (info && info.id === 'preseason-2026') ? '2026 PRESEASON SPECIAL ' : 'FSN Studio Show ';\n          if(sub && info && info.subtitle) sub.textContent = info.subtitle;\n        }",
    'Desk launcher preseason label',
)

# ---------------------------------------------------------------------------
# Integrity / exact-behavior checks before writing.
# ---------------------------------------------------------------------------
required = [
    'FSN STUDIO SHOW: 2026 PRESEASON PREVIEW & DRAFT AUDIT',
    'Jim Tolliver & Dee Rawls break down draft grades, reaches, steals, and the state of the league entering 2026.',
    "return Number(season) >= STUDIO_FIRST_SEASON;",
    "NewsDesk.TOPICS.filter(t=> t.id !== 'studio')",
    "function getNewsFeedForWeek(season, week)",
    "function build2026PreseasonSpecial(week)",
    "title:'All-Time Franchise Honor Roll'",
    "title:'2026 Draft Report Card'",
    "title:'Week 1 Tale of the Tape'",
    "title:'Preseason FSN Power Index (1–12)'",
    'playoffTierType',
    'function renderVault',
    'id="writeStoryBtn"',
    'story-rail',
    'composeCommunity',
]
for marker in required:
    if marker not in text:
        raise RuntimeError(f'missing integrity marker: {marker}')

if text.count('function getNewsFeedForWeek(season, week)') != 1:
    raise RuntimeError('getNewsFeedForWeek was duplicated')
if text.count('function build2026PreseasonSpecial(week)') != 1:
    raise RuntimeError('2026 preseason Studio builder was duplicated')
if text == original:
    raise RuntimeError('no index.html changes produced')

INDEX.write_text(text, encoding='utf-8')
print('Applied 2026 preseason Studio + historical NewsDesk gating')
