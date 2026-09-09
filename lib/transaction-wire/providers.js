'use strict';

// A separate ingestion contract. Never feeds modified data back into LeagueData.
const espn = require('../../api/espn');
const { getYahooAccessToken } = require('../../api/auth/yahoo');
const number = value => value == null || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
const list = value => Array.isArray(value) ? value : [];
const POSITION = { 1:'QB', 2:'RB', 3:'WR', 4:'TE', 5:'K', 16:'DST' };

function scope(input) {
  const provider = String(input.provider || '');
  const league = String(input.league || '');
  const season = Number(input.season);
  const week = Number(input.week);
  if (!['espn', 'sleeper', 'yahoo'].includes(provider) ||
      !(provider === 'yahoo' ? /^\d{1,8}\.l\.\d{1,20}$/ : /^\d{1,20}$/).test(league) ||
      !Number.isInteger(season) || season < 1990 || season > 2100 ||
      !Number.isInteger(week) || week < 1 || week > 18) {
    throw Object.assign(new Error('Invalid transaction wire scope'), { status:400 });
  }
  return { provider, league, season, week, key:`${provider}:${league}:${season}` };
}

async function json(url, headers = {}) {
  const response = await fetch(url, { headers, redirect:'error', signal:AbortSignal.timeout(15000) });
  if (!response.ok) throw Object.assign(new Error('Transaction provider HTTP ' + response.status), { status:response.status === 401 || response.status === 403 ? 401 : 502 });
  return response.json();
}

// Reuse the existing ESPN cookie/share-token boundary, without an HTTP round trip.
async function espnRead(req, url) {
  let status = 200, body;
  const response = {
    setHeader() {}, status(value) { status = value; return this; },
    json(value) { body = value; return this; }, send(value) { body = value; return this; }, end() { return this; },
  };
  await espn({ method:'GET', headers:req.headers || {}, query:{ url }, url:'/api/espn' }, response);
  if (status < 200 || status >= 300 || !body || typeof body !== 'object') {
    throw Object.assign(new Error('ESPN transaction read failed'), { status:status === 401 || status === 403 ? 401 : 502 });
  }
  return body;
}

function espnSnapshot(data, s) {
  if (String(data.id) !== s.league || Number(data.seasonId) !== s.season || !Array.isArray(data.teams)) throw new Error('ESPN league identity/teams missing');
  if (!Array.isArray(data.transactions)) throw new Error('ESPN transaction feed unavailable; refusing an empty success');
  const players = {}, teams = {};
  function player(entry, teamId) {
    const p = entry.playerPoolEntry && entry.playerPoolEntry.player || entry.player || entry;
    if (p.id == null || !p.fullName) return;
    const id = String(p.id);
    const current = players[id] || {};
    players[id] = { ...current, id, name:p.fullName, pos:POSITION[p.defaultPositionId] || '',
      status:p.injuryStatus || (p.injured ? null : 'ACTIVE'),
      teamId:teamId == null ? current.teamId : String(teamId),
      starter:teamId == null ? current.starter : ![20,21].includes(entry.lineupSlotId),
    };
  }
  list(data.players).forEach(p => player(p, null));
  data.teams.forEach(t => {
    const r = t.record && t.record.overall || {};
    teams[String(t.id)] = { id:String(t.id), name:t.name || [t.location,t.nickname].filter(Boolean).join(' ') || 'Team ' + t.id,
      wins:number(r.wins), losses:number(r.losses), ties:number(r.ties), points:number(r.pointsFor) };
    list(t.roster && t.roster.entries).forEach(p => player(p, t.id));
  });
  const events = data.transactions.filter(t => t.status === 'EXECUTED' && ['WAIVER','FREEAGENT','TRADE','DROP'].includes(t.type)).map(t => ({
    id:String(t.id || ''), kind:t.type === 'TRADE' ? 'trade' : t.type === 'WAIVER' ? 'waiver' : 'move',
    at:number(t.processDate), week:number(t.scoringPeriodId), bid:number(t.bidAmount),
    moves:list(t.items).filter(i => ['ADD','DROP','TRADE'].includes(i.type)).map(i => ({
      playerId:String(i.playerId), from:i.type === 'ADD' ? null : String(i.fromTeamId == null ? t.teamId : i.fromTeamId),
      to:i.type === 'DROP' ? null : String(i.toTeamId == null ? t.teamId : i.toTeamId),
    })), assets:[],
  }));
  return { players, teams, events, week:Number(data.status && data.status.currentMatchupPeriod || data.scoringPeriodId) };
}

function sleeperSnapshot(league, rosters, users, playersRaw, transactions, s) {
  if (!league || String(league.league_id) !== s.league || Number(league.season) !== s.season || !Array.isArray(rosters) || !Array.isArray(users)) throw new Error('Sleeper league identity/rosters missing');
  const players = {}, teams = {};
  const names = Object.fromEntries(users.map(u => [u.user_id, u.metadata && u.metadata.team_name || u.display_name]));
  const rosterIds = new Set();
  rosters.forEach(r => {
    const st = r.settings || {}, id = String(r.roster_id);
    rosterIds.add(id);
    teams[id] = { id, name:names[r.owner_id] || 'Roster ' + id,
      wins:number(st.wins), losses:number(st.losses), ties:number(st.ties),
      points:number(st.fpts) == null ? null : Number(st.fpts) + (number(st.fpts_decimal) || 0) / 100 };
    list(r.players).forEach(pid => {
      const p = playersRaw[pid];
      if (!p) return;
      players[pid] = { id:String(pid), name:p.full_name || [p.first_name,p.last_name].filter(Boolean).join(' '), pos:p.position || '',
        status:p.injury_status || (p.status === 'Active' ? 'ACTIVE' : null), teamId:id, starter:list(r.starters).includes(pid) };
    });
  });
  const events = transactions.filter(t => t.status === 'complete' && ['trade','waiver','free_agent'].includes(t.type)).map(t => {
    const ids = [...new Set([...Object.keys(t.adds || {}), ...Object.keys(t.drops || {})])].sort();
    ids.forEach(id => { if (!players[id] && playersRaw[id]) {
      const p = playersRaw[id]; players[id] = { id, name:p.full_name || [p.first_name,p.last_name].filter(Boolean).join(' '), pos:p.position || '', teamId:null, status:null };
    }});
    return { id:String(t.transaction_id || ''), kind:t.type === 'trade' ? 'trade' : t.type === 'waiver' ? 'waiver' : 'move',
      at:number(t.status_updated), week:number(t.leg), bid:number(t.settings && t.settings.waiver_bid),
      moves:ids.map(id => ({ playerId:id, from:t.drops && t.drops[id] != null ? String(t.drops[id]) : null, to:t.adds && t.adds[id] != null ? String(t.adds[id]) : null })),
      assets:list(t.draft_picks).map(p => ({ type:'pick', season:number(p.season), round:number(p.round), from:String(p.previous_owner_id), to:String(p.owner_id), original:String(p.roster_id) }))
        .concat(list(t.waiver_budget).map(b => ({ type:'budget', amount:number(b.amount), from:String(b.sender), to:String(b.receiver) }))),
    };
  });
  return { players, teams, events, week:Number(league.settings && league.settings.leg) };
}

function nodes(root, key) {
  if (!root || typeof root !== 'object') return [];
  return Object.entries(root).flatMap(([k,v]) => k === key ? [v] : nodes(v,key));
}
function fragments(value) {
  if (Array.isArray(value)) return Object.assign({}, ...value.map(fragments));
  if (!value || typeof value !== 'object') return {};
  const result = {};
  Object.entries(value).forEach(([k,v]) => { if (/^\d+$/.test(k)) Object.assign(result,fragments(v)); else if (k !== 'count') result[k] = v; });
  return result;
}
function yahooSnapshot(metadata, rosterData, transactionData, s) {
  const league = fragments(nodes(metadata,'league')[0]);
  if (league.league_key !== s.league || Number(league.season) !== s.season) throw new Error('Yahoo league identity missing');
  const teams = {}, players = {};
  nodes(rosterData,'team').forEach(raw => {
    const t = fragments(raw), id = String(t.team_key || '');
    if (!id) return;
    teams[id] = { id, name:t.name || id, wins:null, losses:null, ties:null, points:null };
    nodes(raw,'player').forEach(pRaw => {
      const p = fragments(pRaw), pid = String(p.player_key || '');
      if (!pid) return;
      const selected = fragments(p.selected_position);
      players[pid] = { id:pid, name:p.name && p.name.full || pid, pos:p.display_position || '', teamId:id,
        status:p.status || 'ACTIVE', starter:!!selected.position && !['BN','IR','IR+'].includes(selected.position) };
    });
  });
  if (!Object.keys(teams).length) throw new Error('Yahoo roster teams missing');
  const events = transactionData.flatMap(d => nodes(d,'transaction')).map(raw => {
    const t = fragments(raw);
    if (t.status !== 'successful' || !['add','drop','add/drop','trade'].includes(t.type)) return null;
    const moves = nodes(raw,'player').map(pRaw => {
      const p = fragments(pRaw), id = String(p.player_key || '');
      const d = fragments(p.transaction_data);
      if (!players[id]) players[id] = { id, name:p.name && p.name.full || id, pos:p.display_position || '', teamId:null, status:null };
      return { playerId:id, from:d.source_team_key || null, to:d.destination_team_key || null };
    });
    return { id:String(t.transaction_key || ''), kind:t.type === 'trade' ? 'trade' : t.faab_bid != null ? 'waiver' : 'move',
      at:number(t.timestamp) == null ? null : Number(t.timestamp)*1000,
      // Yahoo timestamps have no fantasy scoring-period field. Keep the period
      // unknown; the reader gates these by actual time rather than inventing one.
      week:null, bid:number(t.faab_bid), moves, assets:[] };
  }).filter(Boolean);
  return { teams, players, events, week:Number(league.current_week) };
}

async function ingest(s, req, since) {
  if (s.provider === 'espn') {
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${s.season}/segments/0/leagues/${s.league}?view=mTeam&view=mRoster&view=mTransactions2`;
    return espnSnapshot(await espnRead(req,url), s);
  }
  if (s.provider === 'sleeper') {
    const base = `https://api.sleeper.app/v1/league/${s.league}`;
    const [league,rosters,users,players] = await Promise.all([json(base),json(base+'/rosters'),json(base+'/users'),json('https://api.sleeper.app/v1/players/nfl')]);
    const current = Math.max(1,Math.min(18,Number(league && league.settings && league.settings.leg) || s.week));
    const transactions = [];
    for (let week = Math.max(1,current-2); week <= current; week++) {
      const rows = await json(base+'/transactions/'+week);
      if (!Array.isArray(rows)) throw new Error('Sleeper transactions missing');
      transactions.push(...rows);
    }
    return sleeperSnapshot(league,rosters,users,players,transactions,s);
  }
  const auth = await getYahooAccessToken(req);
  const headers = { Authorization:'Bearer '+auth.accessToken, Accept:'application/json' };
  const base = 'https://fantasysports.yahooapis.com/fantasy/v2/league/'+s.league;
  const [metadata,rosters] = await Promise.all([json(base+'?format=json',headers),json(base+'/teams/roster/players?format=json',headers)]);
  const pages = [];
  for (let start = 0; start < 200; start += 25) {
    const page = await json(base+`/transactions;types=add,drop,add%2Fdrop,trade;start=${start};count=25?format=json`,headers);
    if (!nodes(page,'transactions').length) throw new Error('Yahoo transactions collection missing');
    pages.push(page);
    const rows = nodes(page,'transaction').map(fragments);
    if (rows.length < 25 || rows.every(t => number(t.timestamp) != null && Number(t.timestamp)*1000 < since)) break;
    if (start === 175) throw new Error('Yahoo transaction window exceeds 200 events; narrow the polling window');
  }
  return yahooSnapshot(metadata,rosters,pages,s);
}

async function authorize(s, req) {
  if (s.provider === 'espn') {
    const data = await espnRead(req,`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${s.season}/segments/0/leagues/${s.league}?view=mTeam`);
    if (String(data.id) !== s.league || Number(data.seasonId) !== s.season || !Array.isArray(data.teams)) throw new Error('ESPN league identity missing');
  } else if (s.provider === 'sleeper') {
    const data = await json('https://api.sleeper.app/v1/league/'+s.league);
    if (!data || String(data.league_id) !== s.league || Number(data.season) !== s.season) throw Object.assign(new Error('Sleeper league unavailable'),{status:404});
  } else {
    const auth = await getYahooAccessToken(req);
    const data = await json('https://fantasysports.yahooapis.com/fantasy/v2/league/'+s.league+'?format=json',{Authorization:'Bearer '+auth.accessToken});
    const league = fragments(nodes(data,'league')[0]);
    if (league.league_key !== s.league || Number(league.season) !== s.season) throw new Error('Yahoo league identity missing');
  }
}

module.exports = { scope, ingest, authorize, espnSnapshot, sleeperSnapshot, yahooSnapshot, number };
