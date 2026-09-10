import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

function read(path){ return fs.readFileSync(path,'utf8'); }
function write(path,content){ fs.writeFileSync(path,content); }
function replaceOnce(text, pattern, replacement, label){
  const matches = text.match(pattern);
  if(!matches) throw new Error(`PATCH_MISS: ${label}`);
  const next = text.replace(pattern, replacement);
  if(next === text) throw new Error(`PATCH_NOOP: ${label}`);
  return next;
}
function replaceLiteral(text, from, to, label){
  const count = text.split(from).length - 1;
  if(count !== 1) throw new Error(`PATCH_EXPECTED_ONCE: ${label} (${count})`);
  return text.replace(from,to);
}

let index = read('index.html');

// 1) Per-matchup previews: remove small canned pools from the body path and make
// every paragraph derive from matchup identity + verified records/model/history.
const previewBlock = `/* One matchup-specific scouting paragraph for a side. The sentence is composed
   from verified entering-week facts rather than a shared canned paragraph pool,
   so two games on the same board cannot collapse into identical copy. */
function previewSideNarrative(p, week, opponent, probability){
  const name = esc(p.team.name);
  const opp = esc(opponent.name);
  const prob = Number(probability).toFixed(1);
  const facts = [\`<b>\${name}</b> enters Week \${week} at <b>\${esc(p.record)}</b> with a <b>\${prob}%</b> model probability against <b>\${opp}</b>\`];
  if(p.hasModel && p.avg != null){
    facts.push(\`the FSN Power Index has \${name} at <b>No. \${p.rank || '—'}\${p.total ? ' of ' + p.total : ''}</b>, scoring <b>\${n1(p.avg)} PPG</b> on <b>\${n1(p.pf)}</b> points\`);
    if(p.eff != null) facts.push(\`lineup efficiency is <b>\${n1(p.eff)}%</b>\`);
    if(p.streakLabel) facts.push(\`the current form line is <b>\${esc(p.streakLabel)}</b>\`);
    if(p.badge) facts.push(\`the model flag is <b>[\${esc(p.badge)}]</b>\`);
  } else {
    facts.push('there is no scored current-season sample yet, so the desk is leaving scoring pace and lineup-efficiency claims off the page');
  }
  return facts.join('; ') + '. This is a profile of this roster against this opponent, not a league-wide template.';
}

function previewHistoryNarrative(h2h, A, B){
  if(!h2h || !h2h.meetingCount){
    return \`The loaded Record Book has no prior meeting between <b>\${esc(A.name)}</b> and <b>\${esc(B.name)}</b> before this kickoff. Whatever happens here becomes the first verified line in their series.\`;
  }
  const series = \`\${h2h.winsFor}-\${h2h.winsAgainst}\${h2h.ties ? '-' + h2h.ties : ''}\`;
  const leader = h2h.winsFor === h2h.winsAgainst ? null : (h2h.winsFor > h2h.winsAgainst ? A : B);
  const last = h2h.lastMeeting
    ? \` Their most recent verified meeting finished <b>\${n1(h2h.lastMeeting.scoreFor)}–\${n1(h2h.lastMeeting.scoreAgainst)}</b> in \${h2h.lastMeeting.year}, Week \${h2h.lastMeeting.week}.\`
    : '';
  const scoring = Number.isFinite(Number(h2h.diff))
    ? \` Across the series, <b>\${esc(Number(h2h.diff) >= 0 ? A.name : B.name)}</b> owns a <b>\${n1(Math.abs(Number(h2h.diff)))}</b>-point aggregate scoring edge.\`
    : '';
  return \`The Record Book carries <b>\${h2h.meetingCount}</b> prior meeting\${h2h.meetingCount === 1 ? '' : 's'} between these franchises, with the ledger at <b>\${series}</b>\${leader ? ' in <b>' + esc(leader.name) + '</b>\\'s favor' : ', dead even'}.\${last}\${scoring}\`;
}

function genMatchupPreviews(ctx){
  if(ctx.anyScored || !Array.isArray(ctx.games) || !ctx.games.length) return [];
  const priorWeek = Math.max(0, Number(ctx.week) - 1);
  const phase = seasonToneBucket(ctx.week);
  const out = [];
  const seenSignatures = new Set();

  ctx.games.forEach((g, i)=>{
    if(!g || !g.homeTeam || !g.awayTeam) return;
    const A = g.awayTeam, B = g.homeTeam;
    const matchupKey = [String(A.id), String(B.id)].sort().join(':');
    const seed = 'gprev:' + selectedLeagueId() + ':' + viewedSeasonYear() + ':' + ctx.week + ':' + matchupKey;

    let probA = 50;
    try{
      probA = Number(FSNIntel.winProbability(priorWeek, A, B));
      if(!Number.isFinite(probA)) probA = 50;
    }catch(err){
      console.error('[NewsDesk] matchup preview probability failed for ' + A.name + ' vs ' + B.name + ' in Week ' + ctx.week, err);
      probA = 50;
    }
    probA = Math.max(0, Math.min(100, probA));
    const probB = 100 - probA;
    const recordA = String(FSNIntel.getRecordAsOfWeek(A.id, ctx.week) || '0-0');
    const recordB = String(FSNIntel.getRecordAsOfWeek(B.id, ctx.week) || '0-0');
    const profileA = previewSideProfile(A, ctx.week);
    const profileB = previewSideProfile(B, ctx.week);

    let h2h = null;
    try{
      if(LeagueData.hasHistory() && A.ownerId && B.ownerId && typeof window.getH2HAsOf === 'function'){
        h2h = window.getH2HAsOf(A.ownerId, B.ownerId, Number(viewedSeasonYear()) || 0, Number(ctx.week) - 1);
      }
    }catch(err){
      console.error('[NewsDesk] matchup preview head-to-head lookup failed for ' + A.name + ' vs ' + B.name + ' in Week ' + ctx.week, err);
    }

    const fav = probA >= probB ? A : B;
    const dog = fav === A ? B : A;
    const favProb = fav === A ? probA : probB;
    const dogProb = 100 - favProb;
    const gap = profileA.avg != null && profileB.avg != null ? Math.abs(Number(profileA.avg) - Number(profileB.avg)) : null;
    const rankGap = profileA.rank && profileB.rank ? Math.abs(Number(profileA.rank) - Number(profileB.rank)) : null;

    const lead = \`\${datelineTag()} <b>\${esc(A.name)}</b> (\${esc(recordA)}) at <b>\${esc(B.name)}</b> (\${esc(recordB)}). The entering-week model prices it at <b>\${probA.toFixed(1)}%</b> for \${esc(A.name)} and <b>\${probB.toFixed(1)}%</b> for \${esc(B.name)} — a \${Math.abs(probA-probB) < 1 ? 'true model deadlock' : 'matchup-specific lean toward <b>' + esc(fav.name) + '</b>'}.\`;
    const sideA = previewSideNarrative(profileA, ctx.week, B, probA);
    const sideB = previewSideNarrative(profileB, ctx.week, A, probB);
    const history = previewHistoryNarrative(h2h, A, B);
    const projection = gap == null
      ? \`The current-season scoring sample is not deep enough to publish a PPG gap for <b>\${esc(A.name)}</b>–<b>\${esc(B.name)}</b>. The probability above therefore stays the only model claim, with the Record Book carrying the historical context.\`
      : \`The scoring tape separates these rosters by <b>\${n1(gap)} PPG</b> entering Week \${ctx.week}\${rankGap != null ? ', with a <b>' + rankGap + '-spot</b> gap on the FSN Power Index' : ''}. <b>\${esc(fav.name)}</b> still has to convert a <b>\${favProb.toFixed(1)}%</b> lean; <b>\${esc(dog.name)}</b> owns the other <b>\${dogProb.toFixed(1)}%</b>.\`;
    const stakes = ctx.playoffWeek
      ? \`This is a playoff file, so the consequence is binary: <b>\${esc(A.name)}</b> or <b>\${esc(B.name)}</b> advances, and the loser adds a final to the same Record Book that framed the matchup.\`
      : phase === 'stretch'
        ? \`With the bracket approaching, the records — <b>\${esc(recordA)}</b> and <b>\${esc(recordB)}</b> — make this a direct standings lever rather than generic Week \${ctx.week} content.\`
        : phase === 'mid'
          ? \`At midseason, <b>\${esc(A.name)}</b> and <b>\${esc(B.name)}</b> have enough scored evidence that the probability, PPG gap and series ledger can all be audited after the final.\`
          : \`Early-season sample or not, this result belongs specifically to <b>\${esc(A.name)}</b> and <b>\${esc(B.name)}</b>: their records, their model split and their own series history are the only facts this preview is allowed to carry.\`;

    const paragraphs = [lead, sideA, history, sideB, projection, stakes];
    const signature = paragraphs.map(p=> String(p).replace(/<[^>]+>/g,'').replace(/\\s+/g,' ').trim()).join('||');
    if(seenSignatures.has(signature)){
      throw new Error('Duplicate matchup preview signature for Week ' + ctx.week + ': ' + matchupKey);
    }
    seenSignatures.add(signature);

    out.push(article({
      id:'preview-game-' + ctx.week + '-' + A.id + '-' + B.id,
      kind:'preview', tag:ctx.playoffWeek ? 'PLAYOFF PREVIEW' : 'MATCHUP PREVIEW', tone:'cyan', priority:58,
      byline:'FSN Senior League Insider', ageMin:20 + (hash(seed) % 70), crest:{ name:B.name, logo:B.logo },
      headline:esc(upper(A.name)) + ' AT ' + esc(upper(B.name)) + ': ' + probA.toFixed(1) + '%–' + probB.toFixed(1) + '% MODEL FILE',
      dek:\`\${esc(A.name)} (\${esc(recordA)}) at \${esc(B.name)} (\${esc(recordB)}) — verified records, a matchup-specific probability split, and the time-fenced Record Book ledger.\`,
      paragraphs, quote:null,
      numbers:{ title:'Tale of the Tape', rows:[
        {label:esc(A.name) + ' win probability', value:probA.toFixed(1) + '%'},
        {label:esc(B.name) + ' win probability', value:probB.toFixed(1) + '%'},
        {label:esc(A.name) + ' record', value:esc(recordA), note:profileA.streakLabel || ''},
        {label:esc(B.name) + ' record', value:esc(recordB), note:profileB.streakLabel || ''},
        ...(gap != null ? [{label:'Scoring pace gap',value:n1(gap) + ' PPG',note:esc((Number(profileA.avg) >= Number(profileB.avg) ? A : B).name) + ' higher entering Week ' + ctx.week}] : []),
        ...(h2h && h2h.meetingCount ? [{label:'All-time series',value:h2h.winsFor + '-' + h2h.winsAgainst + (h2h.ties ? '-' + h2h.ties : ''),note:h2h.meetingCount + ' verified meeting' + (h2h.meetingCount === 1 ? '' : 's')}] : [{label:'All-time series',value:'First meeting',note:'No prior Record Book matchup before this kickoff.'}]),
      ], note:'Pregame facts are fenced to results available before this matchup. No static narrative override is permitted.'},
      narrativeLocked:true, headlineLocked:true,
    }));
  });
  return out;
}

/* ============================================================================
   FSN POWER INDEX`;
index = replaceOnce(index,
  /\/\* One rich, self-contained form paragraph for a side\.[\s\S]*?\/\* ============================================================================\n   FSN POWER INDEX/,
  previewBlock,
  'matchup preview generator block');

// Remove monetary data from the ESPN transaction normalization itself.
index = replaceOnce(index, /\n\s*bid: typeof t\.bidAmount === 'number' \? t\.bidAmount : 0,/, '', 'index transaction bid field');

const waiverReport = `/* Waiver-wire report for a given week. Claims are ranked only by execution
   recency and roster impact; this league does not track acquisition dollars. */
function waiverReport(week){
  return memo('waivers:' + week, ()=>{
    const all = transactions();
    if(!all.length) return null;
    const claims = all.filter(t=> (t.type === 'WAIVER' || t.type === 'FREEAGENT') && t.executed && t.adds.length);
    const inWeek = claims.filter(t=> !week || t.week === week || t.week === week - 1);
    const pool = (inWeek.length ? inWeek : claims.slice(-40)).slice().sort((a,b)=> Number(b.at || 0) - Number(a.at || 0));
    if(!pool.length) return null;
    return {
      claims:pool,
      featured:pool[0] || null,
      claimCount:pool.length,
      teamCount:new Set(pool.map(t=> String(t.teamId))).size,
      freeAdds:pool.filter(t=> t.type === 'FREEAGENT').length,
    };
  });
}

`;
index = replaceOnce(index,
  /\/\* Waiver-wire report for a given week:[\s\S]*?(?=\/\* A drop nobody makes calmly:)/,
  waiverReport,
  'waiver report function');
index = replaceOnce(index, /transactions, faabReport, rageDrops,/, 'transactions, waiverReport, rageDrops,', 'FSNIntel waiver export');

const waiverTimelinePrefix = `function tlWaivers(ctx){
  const out = [];
  const report = FSNIntel.waiverReport(ctx.week);

  if(report && report.claims && report.claims.length){
    const featured = report.featured;
    const team = featured ? FSNIntel.teamOf(featured.teamId) : null;
    const target = featured && featured.adds && featured.adds[0];
    const seed = 'waivers:' + ctx.week + ':' + (featured ? featured.id : 'x');
    const rows = report.claims.slice(0, 6).map(claim=>{
      const claimTeam = FSNIntel.teamOf(claim.teamId);
      const player = claim.adds && claim.adds[0];
      return {
        label:esc((claimTeam && claimTeam.name) || 'Team'),
        value:esc((player && player.name) || 'Claim processed'),
        note:claim.type === 'FREEAGENT' ? 'Free-agent add' : 'Waiver claim',
      };
    });
    rows.push({ label:'Successful additions', value:String(report.claimCount), note:report.teamCount + ' team' + (report.teamCount === 1 ? '' : 's') + ' active in the run.' });

    out.push(tl({
      id:'tl-waivers-' + ctx.week,
      kind:'waivers', topic:'waivers', slot:'waivers', offset:(hash(seed) % 70),
      metaTag:'WAIVERS', tag:'WAIVER WIRE', tone:'green', priority:78,
      byline:'FSN Front Office Correspondent',
      crest:team ? {name:team.name, logo:team.logo} : null,
      headline:team && target
        ? \`\${upper(team.name)} CLAIMS \${upper(target.name || 'A NEW ADDITION')} AS THE WEEK \${ctx.week} WIRE MOVES\`
        : \`WAIVER RUN: \${report.claimCount} SUCCESSFUL ADDITION\${report.claimCount === 1 ? '' : 'S'} IN WEEK \${ctx.week}\`,
      dek:\`\${report.claimCount} successful addition\${report.claimCount === 1 ? '' : 's'} across \${report.teamCount} team\${report.teamCount === 1 ? '' : 's'}, tracked as roster movement with no financial field.\`,
      paragraphs:[
        team && target
          ? \`\${datelineTag()} <b>\${esc(team.name)}</b> added <b>\${esc(target.name || 'a player')}</b> in the Week \${ctx.week} transaction run. The wire records the roster change — who was added, who was dropped and when it processed — and nothing else.\`
          : \`\${datelineTag()} The Week \${ctx.week} transaction run produced <b>\${report.claimCount}</b> successful additions across <b>\${report.teamCount}</b> teams.\`,
        \`The activity ledger is ordered by completed roster movement. It does not infer losing claims or attach acquisition-dollar values that this league does not use.\`,
        report.freeAdds ? \`<b>\${report.freeAdds}</b> of the completed moves were recorded as direct free-agent adds; the rest were successful waiver claims.\` : 'All completed additions in this report came through the waiver transaction path.',
      ],
      numbers:{title:'The Waiver Run',rows,note:'Parsed from completed roster transactions only; financial fields are intentionally excluded.'},
      narrativeLocked:true, headlineLocked:true,
    }));
  }

  /* ---- THE RAGE DROP ---- */`;
index = replaceOnce(index,
  /function tlWaivers\(ctx\)\{[\s\S]*?\/\* ---- THE RAGE DROP ---- \*\//,
  waiverTimelinePrefix,
  'waiver timeline financial block');

// Ticker: show the most recent completed claim, never a dollar amount.
const tickerStart = index.indexOf('  /* Waiver movement rides the crawl too');
const tickerPower = index.indexOf('    const power = FSNIntel.powerRankings(week);', tickerStart);
if(tickerStart < 0 || tickerPower < 0) throw new Error('PATCH_MISS: waiver ticker block');
const tickerReplacement = `  /* Completed waiver movement rides the crawl too. */
  try{
    const waiver = FSNIntel.waiverReport(week);
    if(waiver && waiver.featured){
      const t = FSNIntel.teamOf(waiver.featured.teamId);
      const p = waiver.featured.adds && waiver.featured.adds[0];
      items.push(\`<span class="ticker-item"><span class="tk-tag" style="color:var(--green)">WAIVER</span>\` +
        \`<span class="tk-team">\${esc((t && t.abbrev) || 'TM')} · \${esc((p && p.name) || 'CLAIM')}</span>\` +
        \`<span class="tk-score tk-win">ADDED</span></span>\`);
    }
  }catch(err){ console.error('[Timeline] ticker waiver', err); }
  try{
`;
index = index.slice(0, tickerStart) + tickerReplacement + index.slice(tickerPower);

// Analytics: keep the useful "gem" idea but rank by post-add points, not money.
index = replaceOnce(index,
  /      const bid = Math\.max\(0, number\(tx\.bid\)\);[\s\S]*?      \}\);/,
  `      gems.push({
        id:String(tx.id) + ':' + String(add.playerId),
        player:add.name || meta.name || ('Player ' + add.playerId),
        pos,
        team:FSNIntel.teamOf(tx.teamId),
        week:fromWeek,
        points,
      });`,
  'waiver gem financial fields');
index = replaceOnce(index, /gems\.sort\(\(a,b\)=> \(b\.roi - a\.roi\) \|\| \(b\.points - a\.points\) \|\| a\.player\.localeCompare\(b\.player\)\);/, `gems.sort((a,b)=> (b.points - a.points) || a.player.localeCompare(b.player));`, 'waiver gem sort');
index = replaceOnce(index,
  /<div class=\\"analytics-gem-meta truncate\\">\$\{esc\(gem\.team \? gem\.team\.name : 'Unknown team'\)\} · Week \$\{gem\.week \|\| '—'\} · \$\{gem\.free \? 'Free add' : '\$'\+analyticsValue\(gem\.bid,0\)\+' FAAB'\}<\/div>/,
  `<div class=\"analytics-gem-meta truncate\">\${esc(gem.team ? gem.team.name : 'Unknown team')} · Week \${gem.week || '—'} · completed add</div>`,
  'waiver gem metadata render');
index = replaceOnce(index,
  /<div class=\\"analytics-gem-roi\\">\$\{analyticsValue\(gem\.roi\)\}×<span>\$\{analyticsValue\(gem\.points\)\} PTS \/ \$1<\/span><\/div>/,
  `<div class=\"analytics-gem-roi\">\${analyticsValue(gem.points)}<span>POST-ADD PTS</span></div>`,
  'waiver gem value render');
index = replaceLiteral(index,
  "${analyticsModel('06','Waiver Wire Gem Finder ROI','Points scored after an executed add divided by FAAB cost (free adds use a $1 floor). Skill positions only; K and D/ST excluded.','var(--cyan)',gemBody,true,'Which pickups paid off most per dollar of FAAB spent. Higher = a bigger bargain off the wire.')}",
  "${analyticsModel('06','Waiver Wire Impact','Points scored after an executed add. Skill positions only; K and D/ST excluded.','var(--cyan)',gemBody,true,'Which pickups produced the most points after joining the roster. Higher = more post-add production.')}",
  'waiver analytics model copy');

// Remaining user-facing and comment references in the monolith.
const literalReplacements = new Map([
  ['mTransactions2 feeds the waiver-wire desk (FAAB bids, adds, drops)', 'mTransactions2 feeds the waiver-wire desk (claims, adds, drops)'],
  ["the transaction log (FAAB bids, adds, drops)", "the transaction log (claims, adds, drops)"],
  ['Now the season turns into a depth test: FAAB discipline, bye-week planning and the second starting lineup matter as much as draft night.', 'Now the season turns into a depth test: waiver decisions, bye-week planning and the second starting lineup matter as much as draft night.'],
  ['The waiver budget and the bye-week map are becoming part of the standings, whether managers admit it or not.', 'The waiver wire and the bye-week map are becoming part of the standings, whether managers admit it or not.'],
  ['Wednesday morning for the FAAB fallout', 'Wednesday morning for the waiver fallout'],
  ["'No trade, no FAAB, no cost. Just waiting.'", "'No trade, no extra cost. Just waiting.'"],
  ["if(/WAIVER|FAAB|RAGE DROP|TRADE/.test(tag))", "if(/WAIVER|RAGE DROP|TRADE/.test(tag))"],
  ["{ id:'waivers',  label:'Waivers',        icon:'💰' }", "{ id:'waivers',  label:'Waivers',        icon:'↻' }"],
]);
for(const [from,to] of literalReplacements){
  if(index.includes(from)) index = index.replaceAll(from,to);
}

// These identifiers should be entirely gone from the runtime monolith.
if(/faab/i.test(index)){
  const lines = index.split(/\n/).map((line,i)=>({line,i:i+1})).filter(x=>/faab/i.test(x.line)).slice(0,30);
  throw new Error('RESIDUAL_FAAB_INDEX:\n' + lines.map(x=>x.i+': '+x.line).join('\n'));
}
if(/bidAmount|waiver_budget|waiver_bid|faab_bid/.test(index)){
  throw new Error('RESIDUAL_FINANCIAL_TRANSACTION_FIELD_IN_INDEX');
}
write('index.html', index);

// Provider normalization: do not ingest or carry bid/budget fields at all.
let providers = read('lib/transaction-wire/providers.js');
providers = providers.replace(/,\s*bid:number\(t\.bidAmount\)/g,'');
providers = providers.replace(/,\s*bid:number\(t\.settings && t\.settings\.waiver_bid\)/g,'');
providers = providers.replace(/\.concat\(list\(t\.waiver_budget\)[\s\S]*?\)\)/g,'');
providers = providers.replace(/kind:t\.type === 'trade' \? 'trade' : t\.faab_bid != null \? 'waiver' : 'move'/g, "kind:t.type === 'trade' ? 'trade' : 'move'");
providers = providers.replace(/,\s*bid:number\(t\.faab_bid\)/g,'');
if(/faab|waiver_budget|waiver_bid|bidAmount/i.test(providers)) throw new Error('RESIDUAL_FINANCIAL_FIELD_PROVIDERS');
write('lib/transaction-wire/providers.js',providers);

// Transaction article engine: keep claims and pick trades, remove auctions/bids/budget assets.
let engine = read('lib/transaction-wire/engine.js');
engine = engine.replace(/\$\{event\.bid != null && event\.kind === 'waiver' \? ' FOR \\$'\+event\.bid : ''\}/g,'');
engine = engine.replace(/event\.assets\.forEach\(a => \{\n\s*const label = a\.type === 'pick' \? `\$\{a\.season\} round \$\{a\.round\} pick \(original roster \$\{a\.original\}\)` : `\$\$\{a\.amount\} FAAB`;\n\s*if \(a\.type === 'pick' && !\(a\.season > 0 && a\.round > 0\) \|\| a\.type === 'budget' && !\(number\(a\.amount\) != null && a\.amount >= 0\)\) throw new Error\('Invalid trade asset'\);/,
  "event.assets.filter(a => a && a.type === 'pick').forEach(a => {\n      const label = `${a.season} round ${a.round} pick (original roster ${a.original})`;\n      if (!(a.season > 0 && a.round > 0)) throw new Error('Invalid trade asset');");
engine = engine.replace(/\n\s*if \(event\.kind === 'waiver' && event\.bid != null\) \{[\s\S]*?\n\s*\}/g,'');
engine = engine.replace(/spending record/gi,'claim record').replace(/winning the auction/gi,'winning the claim').replace(/auction/gi,'claim');
engine = engine.replace(/future or budget assets/gi,'future draft assets');
if(/faab|event\.bid|budget asset|waiver bid/i.test(engine)) throw new Error('RESIDUAL_FINANCIAL_FIELD_ENGINE');
write('lib/transaction-wire/engine.js',engine);

// Tests: raw provider fixtures may still contain provider money fields specifically to
// prove they are discarded, but assertions and expected rendered output must not.
let selftest = read('lib/transaction-wire/selftest.js');
selftest = selftest.replace(/assert\.match\(a\.headline,\/FOR \\$0\/\);/g, "assert.doesNotMatch(a.headline,/\\$|FAAB|bid/i);");
selftest = selftest.replace(/test\('only completed moves publish; zero bid, points decimals and escaping are preserved'/, "test('only completed moves publish; provider bid metadata is ignored and points decimals/escaping are preserved'");
selftest = selftest.replace(/\{type:'budget',amount:15,from:'1',to:'2'\},?/g,'');
selftest = selftest.replace(/full multi-team trades retain every player, pick and budget movement/g,'full multi-team trades retain every player and draft-pick movement');
selftest = selftest.replace(/assert\.equal\(rows\.length,4\);/g,'assert.equal(rows.length,3);');
selftest = selftest.replace(/\n\s*assert\.match\([^\n]*\\\$15 FAAB[^\n]*\);/g,'');
write('lib/transaction-wire/selftest.js',selftest);

// Static regression guard: user-facing/runtime sources must not reintroduce financial waiver fields.
const runtimeFiles = ['index.html','lib/transaction-wire/providers.js','lib/transaction-wire/engine.js'];
for(const file of runtimeFiles){
  const text = read(file);
  if(/faab|waiver_budget|waiver_bid|faab_bid|bidAmount/i.test(text)) throw new Error('RUNTIME_FINANCIAL_REFERENCE: '+file);
}
if(index.includes('Sunday is where theory goes to get audited')) throw new Error('CANNED_PREVIEW_PHRASE_SURVIVED');
if(!index.includes('narrativeLocked:true, headlineLocked:true')) throw new Error('PREVIEW_LOCK_GUARD_MISSING');
if(!index.includes('seenSignatures')) throw new Error('PREVIEW_DUPLICATE_GUARD_MISSING');

// Syntax/tests that are available in-repo and directly touch these surfaces.
execFileSync(process.execPath,['--test','lib/transaction-wire/selftest.js'],{stdio:'inherit'});
execFileSync(process.execPath,['scripts/transaction-wire-check.mjs'],{stdio:'inherit'});
execFileSync(process.execPath,['scripts/news-library-check.mjs'],{stdio:'inherit'});
execFileSync(process.execPath,['scripts/scope-scan.mjs'],{stdio:'inherit'});
execFileSync(process.execPath,['scripts/render-check.mjs'],{stdio:'inherit'});

console.log('Targeted matchup/waiver patch complete and verification passed.');
