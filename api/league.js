/* ============================================================
   MFFU LEAGUE STORAGE — /api/league

   GET  ?league_id=123&season_year=2026
   POST { league_id, season_year, history_json }

   ESPN cookies arrive through x-espn-s2 / x-espn-swid (or body.cookies),
   are commissioner-verified, encrypted with AES-256-GCM, and stored in the
   leagues.cookies JSONB column. Raw cookies are never returned to browsers.
============================================================ */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const ESPN_HOST = 'https://lm-api-reads.fantasy.espn.com';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

let supabaseClient;

function applyHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-espn-s2, x-espn-swid');
  res.setHeader('Cache-Control', 'no-store');
}

function getSupabase() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) return null;
  if (!supabaseClient) {
    supabaseClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { 'X-Client-Info': 'mffu-vercel-league-storage' } },
    });
  }
  return supabaseClient;
}

function activeFantasySeason() {
  const now = new Date();
  return now.getUTCMonth() < 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
}

function cleanLeagueId(value) {
  const id = String(value || '').trim();
  return /^\d{1,20}$/.test(id) ? id : '';
}

function cleanSeasonYear(value, fallback) {
  const year = Number(value || fallback);
  return Number.isInteger(year) && year >= 1990 && year <= activeFantasySeason() + 1 ? year : 0;
}

function normalizeSwid(value) {
  const raw = String(value || '').trim();
  return raw ? '{' + raw.replace(/^\{|\}$/g, '') + '}' : '';
}

function cleanCookies(value) {
  const source = value && typeof value === 'object' ? value : {};
  const espnS2 = String(source.espn_s2 || source.s2 || '').trim();
  const swid = normalizeSwid(source.swid || source.SWID);
  return { espn_s2: espnS2, swid };
}

function requestCookies(req, body) {
  const fromBody = cleanCookies(body && body.cookies);
  return cleanCookies({
    espn_s2: fromBody.espn_s2 || req.headers['x-espn-s2'],
    swid: fromBody.swid || req.headers['x-espn-swid'],
  });
}

function encryptionKey() {
  const raw = String(process.env.LEAGUE_COOKIE_ENCRYPTION_KEY || '').trim();
  let key;
  if (/^[a-f0-9]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else {
    try { key = Buffer.from(raw, 'base64'); }
    catch (error) { key = null; }
  }
  if (!key || key.length !== 32) {
    const error = new Error('LEAGUE_COOKIE_ENCRYPTION_KEY must be a 32-byte base64 or 64-character hex value.');
    error.code = 'COOKIE_KEY_INVALID';
    throw error;
  }
  return key;
}

function encryptCookies(cookies) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(cleanCookies(cookies)), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: 1,
    alg: 'A256GCM',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  };
}

function decryptCookies(envelope) {
  if (!envelope || typeof envelope !== 'object') return { espn_s2: '', swid: '' };

  // Read legacy plaintext JSON rows once so existing deployments can migrate
  // naturally on the next commissioner save. New writes are always encrypted.
  if (envelope.espn_s2 || envelope.s2) return cleanCookies(envelope);
  if (envelope.v !== 1 || envelope.alg !== 'A256GCM') return { espn_s2: '', swid: '' };

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(String(envelope.iv || ''), 'base64')
  );
  decipher.setAuthTag(Buffer.from(String(envelope.tag || ''), 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(String(envelope.data || ''), 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return cleanCookies(JSON.parse(plaintext));
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

async function verifyCommissioner(leagueId, seasonYear, cookies) {
  if (!cookies.espn_s2 || !cookies.swid) {
    return { ok: false, status: 401, error: 'Both ESPN cookies are required to save league data.' };
  }

  const targetSwid = cookies.swid.replace(/^\{|\}$/g, '').toLowerCase();
  const seasons = Array.from(new Set([seasonYear, activeFantasySeason(), activeFantasySeason() - 1]));
  let lastStatus = 0;

  for (const season of seasons) {
    const url = ESPN_HOST + '/apis/v3/games/ffl/seasons/' + season +
      '/segments/0/leagues/' + leagueId + '?view=mTeam&view=mSettings';
    let response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          Cookie: 'espn_s2=' + cookies.espn_s2 + '; SWID=' + cookies.swid,
          'User-Agent': USER_AGENT,
        },
        redirect: 'follow',
      });
    } catch (error) {
      continue;
    }

    lastStatus = response.status;
    if (!response.ok) continue;
    const payload = await response.json().catch(function () { return null; });
    const league = Array.isArray(payload) ? payload[0] : payload;
    const members = league && Array.isArray(league.members) ? league.members : [];
    const member = members.find(function (row) {
      return String(row && row.id || '').replace(/^\{|\}$/g, '').toLowerCase() === targetSwid;
    });
    if (member && (member.isLeagueManager === true || member.isLeagueCreator === true)) return { ok: true };
    if (member) return { ok: false, status: 403, error: 'This ESPN account is a league member, but not a league manager.' };
  }

  return {
    ok: false,
    status: lastStatus === 401 || lastStatus === 403 ? lastStatus : 403,
    error: 'ESPN could not verify this SWID as a commissioner for the requested league.',
  };
}

async function findLeagueRow(client, leagueId, seasonYear, includeCookies) {
  const columns = includeCookies
    ? 'league_id,season_year,history_json,cookies,updated_at'
    : 'league_id,season_year,history_json,updated_at';
  let query = client.from('leagues').select(columns).eq('league_id', leagueId);
  if (seasonYear) query = query.eq('season_year', seasonYear);
  else query = query.order('season_year', { ascending: false }).limit(1);
  const result = await query.maybeSingle();
  if (result.error) throw result.error;
  return result.data || null;
}

function publicRecord(row) {
  if (!row) return null;
  return {
    league_id: row.league_id,
    season_year: row.season_year,
    history_json: row.history_json == null ? {} : row.history_json,
    has_cookies: Boolean(row.cookies),
    updated_at: row.updated_at,
  };
}

async function getStoredLeagueCookies(leagueId, seasonYear) {
  const client = getSupabase();
  const id = cleanLeagueId(leagueId);
  const year = cleanSeasonYear(seasonYear, 0);
  if (!client || !id) return null;
  try {
    let row = await findLeagueRow(client, id, year, true);
    if (!row && year) row = await findLeagueRow(client, id, 0, true);
    if (!row || !row.cookies) return null;
    const cookies = decryptCookies(row.cookies);
    return cookies.espn_s2 && cookies.swid ? cookies : null;
  } catch (error) {
    console.warn('[api/league] stored-cookie lookup failed', error && error.message || error);
    return null;
  }
}

async function handler(req, res) {
  applyHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const client = getSupabase();
  if (!client) {
    return res.status(503).json({ error: 'League storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' });
  }

  if (req.method === 'GET') {
    const leagueId = cleanLeagueId(req.query && (req.query.league_id || req.query.leagueId));
    const seasonYear = cleanSeasonYear(req.query && (req.query.season_year || req.query.seasonYear), 0);
    if (!leagueId) return res.status(400).json({ error: 'A valid numeric league_id is required.' });
    try {
      const row = await findLeagueRow(client, leagueId, seasonYear, true);
      if (!row) return res.status(404).json({ error: 'No stored league record exists yet.' });
      return res.status(200).json({ record: publicRecord(row) });
    } catch (error) {
      console.error('[api/league] read failed', error);
      return res.status(502).json({ error: 'League storage read failed.' });
    }
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    const tooLarge = error && error.message === 'PAYLOAD_TOO_LARGE';
    return res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? 'League payload exceeds 8 MB.' : 'Request body must be valid JSON.',
    });
  }

  const leagueId = cleanLeagueId(body.league_id || body.leagueId);
  const seasonYear = cleanSeasonYear(body.season_year || body.seasonYear, activeFantasySeason());
  if (!leagueId || !seasonYear) return res.status(400).json({ error: 'Valid league_id and season_year values are required.' });

  const historyJson = body.history_json !== undefined
    ? body.history_json
    : (body.historicalArchive !== undefined ? body.historicalArchive : {});
  if (historyJson === null || typeof historyJson !== 'object') {
    return res.status(400).json({ error: 'history_json must be a JSON object or array.' });
  }

  const cookies = requestCookies(req, body);
  const verification = await verifyCommissioner(leagueId, seasonYear, cookies);
  if (!verification.ok) return res.status(verification.status || 403).json({ error: verification.error });

  try {
    const row = {
      league_id: leagueId,
      season_year: seasonYear,
      history_json: historyJson,
      cookies: encryptCookies(cookies),
      updated_at: new Date().toISOString(),
    };
    const result = await client
      .from('leagues')
      .upsert(row, { onConflict: 'league_id,season_year' })
      .select('league_id,season_year,history_json,cookies,updated_at')
      .single();
    if (result.error) throw result.error;
    return res.status(200).json({ record: publicRecord(result.data) });
  } catch (error) {
    console.error('[api/league] upsert failed', error);
    const configError = error && error.code === 'COOKIE_KEY_INVALID';
    return res.status(configError ? 503 : 502).json({
      error: configError ? error.message : 'League storage save failed.',
    });
  }
}

module.exports = handler;
module.exports.getStoredLeagueCookies = getStoredLeagueCookies;

