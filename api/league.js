/* ============================================================
   MFFU LEAGUE STORAGE — /api/league

   GET  ?league_id=123&season_year=2026
   POST { league_id, season_year, history_json }

   ESPN cookies arrive through x-espn-s2 / x-espn-swid (or body.cookies),
   are verified by reading the requested league, encrypted with AES-256-GCM,
   and stored in the
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

let warnedAboutFallbackKey = false;

// Deterministic 32-byte fallback so cookie encryption never hard-crashes cloud
// sync when LEAGUE_COOKIE_ENCRYPTION_KEY is missing or malformed. The seed
// prefers other stable per-deployment secrets so the derived key is unique to
// this environment and stays identical across serverless invocations — data
// encrypted with it can therefore always be decrypted again. A fixed suffix
// keeps it valid even when nothing else is configured.
function deriveFallbackEncryptionKey() {
  const seed = [
    String(process.env.LEAGUE_COOKIE_ENCRYPTION_KEY || ''),
    String(process.env.SUPABASE_SERVICE_ROLE_KEY || ''),
    String(process.env.SUPABASE_URL || ''),
    'mffu-league-cookie-fallback-v1',
  ].join('|');
  return crypto.createHash('sha256').update(seed).digest(); // exactly 32 bytes
}

function encryptionKey() {
  const raw = String(process.env.LEAGUE_COOKIE_ENCRYPTION_KEY || '').trim();
  let key = null;
  if (/^[a-f0-9]{64}$/i.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else if (raw) {
    // Buffer.from(..., 'base64') never throws — it silently drops invalid
    // characters — so validate the decoded length rather than relying on a
    // try/catch to reject a malformed value.
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) key = decoded;
  }
  if (!key || key.length !== 32) {
    // Missing or incorrectly formatted key: fall back to a valid derived
    // 32-byte key instead of throwing, so cloud sync keeps working. Warn once
    // so operators still know to set a real key for cross-deployment stability.
    if (!warnedAboutFallbackKey) {
      warnedAboutFallbackKey = true;
      console.warn(
        '[api/league] LEAGUE_COOKIE_ENCRYPTION_KEY is missing or not a valid ' +
        '32-byte base64 / 64-character hex value; using a derived fallback key. ' +
        'Set a proper key for stable cross-deployment cookie encryption.'
      );
    }
    key = deriveFallbackEncryptionKey();
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
  // naturally on the next authenticated-member save. New writes are encrypted.
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

async function verifyLeagueMember(leagueId, seasonYear, cookies) {
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
    if (member) return { ok: true };

    // Democratized cloud saves: any authenticated league member whose cookies
    // can READ the private league may save — there is no commissioner-only
    // gate. ESPN only returns real league content (teams / settings) to
    // authorized members, so a readable league is itself proof of access. We
    // no longer require the SWID to appear in the members array (some ESPN
    // response variants omit it or list it under a differently formatted GUID).
    const readableLeague = league && (
      Array.isArray(league.teams) ||
      (league.settings && typeof league.settings === 'object')
    );
    if (readableLeague) return { ok: true };
  }

  return {
    ok: false,
    status: lastStatus === 401 || lastStatus === 403 ? lastStatus : 403,
    error: 'ESPN could not verify these cookies against the requested league. Re-copy your espn_s2 and SWID from a logged-in ESPN browser session and try again.',
  };
}

const RETURNING_COLUMNS = 'league_id,season_year,history_json,cookies,updated_at';

// Persist a league row without depending on a specific unique/exclusion
// constraint existing on the table. We first try a native upsert (atomic, and
// correct when the (league_id, season_year) primary key from schema.sql is
// present). If the database has no matching constraint — Postgres error 42P10,
// "there is no unique or exclusion constraint matching the ON CONFLICT
// specification" — we fall back to an explicit existence check followed by an
// UPDATE or INSERT. This keeps saves working on tables that were created
// without the composite key.
async function saveLeagueRow(client, row) {
  const upsert = await client
    .from('leagues')
    .upsert(row, { onConflict: 'league_id,season_year' })
    .select(RETURNING_COLUMNS)
    .single();

  if (!upsert.error) return upsert.data;

  const missingConstraint =
    upsert.error.code === '42P10' ||
    /no unique or exclusion constraint matching the on conflict/i.test(String(upsert.error.message || ''));
  if (!missingConstraint) throw upsert.error;

  console.warn('[api/league] ON CONFLICT unsupported (42P10); falling back to check-then-insert/update.');

  // Does a row for this league_id + season_year already exist?
  const existing = await client
    .from('leagues')
    .select('league_id,season_year')
    .eq('league_id', row.league_id)
    .eq('season_year', row.season_year)
    .maybeSingle();
  if (existing.error) throw existing.error;

  if (existing.data) {
    // Update in place, never touching the primary-key columns.
    const patch = {};
    Object.keys(row).forEach(function (key) {
      if (key !== 'league_id' && key !== 'season_year') patch[key] = row[key];
    });
    const updated = await client
      .from('leagues')
      .update(patch)
      .eq('league_id', row.league_id)
      .eq('season_year', row.season_year)
      .select(RETURNING_COLUMNS)
      .single();
    if (updated.error) throw updated.error;
    return updated.data;
  }

  const inserted = await client
    .from('leagues')
    .insert(row)
    .select(RETURNING_COLUMNS)
    .single();
  if (inserted.error) throw inserted.error;
  return inserted.data;
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
  const verification = await verifyLeagueMember(leagueId, seasonYear, cookies);
  if (!verification.ok) return res.status(verification.status || 403).json({ error: verification.error });

  // Encrypt the cookies, but never let an encryption problem halt the save.
  // The key handler already falls back to a derived key, so this should not
  // throw; if it somehow does, we persist the history without the cookie
  // envelope rather than failing the whole request, and report it in the
  // response so it is diagnosable instead of silent.
  let encryptedCookies = null;
  let cookieWarning = null;
  try {
    encryptedCookies = encryptCookies(cookies);
  } catch (cookieError) {
    console.error('[api/league] cookie encryption failed; saving history without cookies', cookieError);
    cookieWarning = 'League history was saved, but private-league cookies could not be encrypted and were not stored: ' +
      String(cookieError && cookieError.message || cookieError);
  }

  try {
    const row = {
      league_id: leagueId,
      season_year: seasonYear,
      history_json: historyJson,
      updated_at: new Date().toISOString(),
    };
    // Only write the cookies column when encryption succeeded, so a failed
    // envelope never overwrites previously stored valid cookies with null.
    if (encryptedCookies) row.cookies = encryptedCookies;

    const saved = await saveLeagueRow(client, row);

    const responseBody = { record: publicRecord(saved) };
    if (cookieWarning) responseBody.warning = cookieWarning;
    return res.status(200).json(responseBody);
  } catch (error) {
    // Surface the EXACT database error (message / code / details / hint) so the
    // real cause — an RLS policy, a missing column, a constraint violation, a
    // connection failure — is visible in the response and server logs instead
    // of a generic "save failed". Supabase/PostgREST errors carry these fields.
    console.error('[api/league] save failed', {
      message: error && error.message,
      code: error && error.code,
      details: error && error.details,
      hint: error && error.hint,
    });
    const parts = [
      error && error.message ? String(error.message) : 'Unknown database error',
      error && error.details ? 'Details: ' + String(error.details) : '',
      error && error.hint ? 'Hint: ' + String(error.hint) : '',
      error && error.code ? 'Code: ' + String(error.code) : '',
    ].filter(Boolean);
    return res.status(502).json({
      error: 'League storage save failed — ' + parts.join(' · '),
      db_error: {
        message: (error && error.message) || null,
        code: (error && error.code) || null,
        details: (error && error.details) || null,
        hint: (error && error.hint) || null,
      },
    });
  }
}

module.exports = handler;
module.exports.getStoredLeagueCookies = getStoredLeagueCookies;
