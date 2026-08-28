/* ============================================================
   MFFU LEAGUE CLOUD — /api/league-sync

   GET  ?leagueId=123  -> shared settings + historical archive
   POST { leagueId, settings, historicalArchive }

   Supabase's service-role key stays server-side. POST requests are accepted
   only after ESPN confirms that the request's SWID belongs to a league
   manager. The cookie values are used for that one ESPN verification request
   and are never persisted or forwarded to Supabase.
============================================================ */

const crypto = require('crypto');

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_SEASONS = 20;
const ESPN_HOST = 'https://lm-api-reads.fantasy.espn.com';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-espn-s2, x-espn-swid');
  res.setHeader('Cache-Control', 'no-store');
}

function leagueIdFrom(req) {
  let value = req.query && req.query.leagueId;
  if (Array.isArray(value)) value = value[0];
  if (!value && req.url) {
    try { value = new URL(req.url, 'http://localhost').searchParams.get('leagueId'); }
    catch (error) { /* handled by validation below */ }
  }
  value = String(value || '').trim();
  return /^\d{1,20}$/.test(value) ? value : '';
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') {
    if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > MAX_BODY_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
    return req.body;
  }
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body, 'utf8') > MAX_BODY_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
    return JSON.parse(req.body);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function activeFantasySeason() {
  const now = new Date();
  return now.getUTCMonth() < 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
}

function normalizeGuid(value) {
  return String(value || '').trim().replace(/^\{|\}$/g, '').toLowerCase();
}

function requestCredentials(req) {
  const s2 = typeof req.headers['x-espn-s2'] === 'string' ? req.headers['x-espn-s2'].trim() : '';
  let swid = typeof req.headers['x-espn-swid'] === 'string' ? req.headers['x-espn-swid'].trim() : '';
  if (swid && swid[0] !== '{') swid = '{' + swid.replace(/^\{|\}$/g, '') + '}';
  return { s2, swid };
}

async function verifyCommissioner(leagueId, credentials) {
  if (!credentials.s2 || !credentials.swid) {
    return { ok:false, status:401, error:'Both ESPN cookies are required to verify commissioner access.' };
  }
  const cookie = 'espn_s2=' + credentials.s2 + '; SWID=' + credentials.swid;
  const targetSwid = normalizeGuid(credentials.swid);
  const current = activeFantasySeason();
  const seasons = [current, current - 1];
  let lastStatus = 0;

  for (const season of seasons) {
    const url = ESPN_HOST + '/apis/v3/games/ffl/seasons/' + season +
      '/segments/0/leagues/' + leagueId + '?view=mTeam&view=mSettings';
    let response;
    try {
      response = await fetch(url, {
        headers:{ Accept:'application/json', Cookie:cookie, 'User-Agent':USER_AGENT },
        redirect:'follow',
      });
    } catch (error) {
      continue;
    }
    lastStatus = response.status;
    if (!response.ok) continue;
    const payload = await response.json().catch(()=> null);
    const league = Array.isArray(payload) ? payload[0] : payload;
    const members = league && Array.isArray(league.members) ? league.members : [];
    const manager = members.find(member=>
      normalizeGuid(member && member.id) === targetSwid &&
      (member.isLeagueManager === true || member.isLeagueCreator === true)
    );
    if (manager) return { ok:true, season, manager };

    // A valid member who is not marked as a manager is an authoritative denial.
    const member = members.find(row=> normalizeGuid(row && row.id) === targetSwid);
    if (member) return { ok:false, status:403, error:'This ESPN account is a league member, but not a league manager.' };
  }

  return {
    ok:false,
    status:lastStatus === 401 || lastStatus === 403 ? lastStatus : 403,
    error:'ESPN could not verify this SWID as a commissioner for the requested League ID.',
  };
}

function supabaseConfig() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  return url && key ? { url, key } : null;
}

async function supabaseRequest(config, path, options) {
  const response = await fetch(config.url + '/rest/v1/' + path, {
    method:(options && options.method) || 'GET',
    headers:Object.assign({
      apikey:config.key,
      Authorization:'Bearer ' + config.key,
      Accept:'application/json',
    }, (options && options.headers) || {}),
    body:options && options.body,
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; }
  catch (error) { payload = { error:text || 'Invalid Supabase response' }; }
  if (!response.ok) {
    const message = payload && (payload.message || payload.error || payload.hint);
    const err = new Error(message || ('Supabase request failed (HTTP ' + response.status + ').'));
    err.status = response.status;
    throw err;
  }
  return payload;
}

async function getRecord(config, leagueId) {
  const select = 'league_id,settings,historical_archive,archive_summary,version,updated_at';
  const path = 'mffu_leagues?league_id=eq.' + encodeURIComponent(leagueId) +
    '&select=' + encodeURIComponent(select) + '&limit=1';
  const rows = await supabaseRequest(config, path);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

function cleanSettings(value) {
  const settings = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const clean = {
    schemaVersion:Math.max(1, Number(settings.schemaVersion) || 1),
    leagueName:String(settings.leagueName || '').slice(0, 160),
    activeSeason:Number(settings.activeSeason) || activeFantasySeason(),
    defaultWeek:Math.max(1, Math.min(25, Number(settings.defaultWeek) || 1)),
    teamCount:Math.max(0, Math.min(32, Number(settings.teamCount) || 0)),
  };
  return clean;
}

function cleanArchive(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('historicalArchive must be an array.');
  if (value.length > MAX_ARCHIVE_SEASONS) throw new Error('Historical archive exceeds the 20-season cloud limit.');
  return value.map(row=>{
    const year = Number(row && (row.year || (row.leagueData && (row.leagueData.seasonId || row.leagueData.season))));
    const leagueData = row && row.leagueData;
    if (!Number.isInteger(year) || year < 1990 || year > activeFantasySeason() + 1) throw new Error('Historical archive contains an invalid season year.');
    if (!leagueData || !Array.isArray(leagueData.teams) || leagueData.teams.length < 1 || leagueData.teams.length > 32) {
      throw new Error('Historical archive contains a season without a valid teams array.');
    }
    if (Array.isArray(leagueData.schedule) && leagueData.schedule.length > 1000) throw new Error('Historical season schedule is unexpectedly large.');
    return { year, leagueData };
  });
}

function archiveSummary(archive) {
  const ownerIds = new Set();
  let matchups = 0;
  archive.forEach(row=>{
    const data = row.leagueData || {};
    matchups += Array.isArray(data.schedule) ? data.schedule.filter(game=> game && game.home && game.away).length : 0;
    (data.teams || []).forEach(team=>{
      const owner = team.primaryOwner || (Array.isArray(team.owners) && team.owners[0]);
      if (owner) ownerIds.add(String(owner));
    });
  });
  return {
    seasons:archive.length,
    years:archive.map(row=>row.year).sort((a,b)=>a-b),
    matchups,
    managers:ownerIds.size,
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error:'Method not allowed' });
  }

  const config = supabaseConfig();
  if (!config) return res.status(503).json({ error:'League Cloud is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' });

  if (req.method === 'GET') {
    const leagueId = leagueIdFrom(req);
    if (!leagueId) return res.status(400).json({ error:'A valid numeric leagueId is required.' });
    try {
      const record = await getRecord(config, leagueId);
      if (!record) return res.status(404).json({ error:'No shared league record exists yet.' });
      return res.status(200).json({ record });
    } catch (error) {
      console.error('[api/league-sync] read failed', error);
      return res.status(502).json({ error:'League Cloud read failed.' });
    }
  }

  let body;
  try { body = await readBody(req); }
  catch (error) {
    const tooLarge = error && error.message === 'PAYLOAD_TOO_LARGE';
    return res.status(tooLarge ? 413 : 400).json({ error:tooLarge ? 'Cloud payload exceeds 8 MB.' : 'Request body must be valid JSON.' });
  }
  const leagueId = String(body && body.leagueId || '').trim();
  if (!/^\d{1,20}$/.test(leagueId)) return res.status(400).json({ error:'A valid numeric leagueId is required.' });

  const verification = await verifyCommissioner(leagueId, requestCredentials(req));
  if (!verification.ok) return res.status(verification.status || 403).json({ error:verification.error });

  let archive;
  try { archive = cleanArchive(body.historicalArchive); }
  catch (error) { return res.status(400).json({ error:error.message || 'Invalid historical archive.' }); }

  try {
    const existing = await getRecord(config, leagueId);
    const mergedSettings = Object.assign({}, existing && existing.settings || {}, cleanSettings(body.settings));
    const finalArchive = archive.length ? archive : (existing && existing.historical_archive || []);
    const managerHash = crypto.createHash('sha256').update(normalizeGuid(requestCredentials(req).swid)).digest('hex').slice(0, 24);
    const row = {
      league_id:leagueId,
      settings:mergedSettings,
      historical_archive:finalArchive,
      archive_summary:archiveSummary(finalArchive),
      updated_by_hash:managerHash,
      updated_at:new Date().toISOString(),
    };
    const records = await supabaseRequest(config, 'mffu_leagues?on_conflict=league_id', {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        Prefer:'resolution=merge-duplicates,return=representation',
      },
      body:JSON.stringify(row),
    });
    const record = Array.isArray(records) && records.length ? records[0] : row;
    // Never return the audit hash to browsers.
    if (record && typeof record === 'object') delete record.updated_by_hash;
    return res.status(200).json({ record });
  } catch (error) {
    console.error('[api/league-sync] publish failed', error);
    return res.status(502).json({ error:'League Cloud publish failed.' });
  }
};
