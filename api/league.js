/* ============================================================
   MFFU LEAGUE STORAGE — /api/league

   GET  ?league_id=123&season_year=2026
   POST { league_id, season_year, history_json }

   ESPN cookies arrive through x-espn-s2 / x-espn-swid (or body.cookies),
   are verified by reading the requested league, encrypted with AES-256-GCM,
   and stored in the
   leagues.cookies JSONB column. Raw cookies are never returned to browsers.

   ---- PER-LEAGUE SHARE SECRET (H-1) ----

   The numeric ESPN league id is NOT a secret. It is in every league URL, every
   invite, every screenshot. Before this route held a share token, knowing that
   number was enough to (a) read the whole shared archive out of public.leagues
   and (b) make /api/espn replay a league-mate's encrypted ESPN session on your
   behalf. That is the credential-lending hole H-1 describes.

   A share token closes it. It is 32 random bytes, base64url encoded, minted on
   the first save that ESPN confirms came from a league member, reused by every
   later save for the same league id, and required on every read:

     GET /api/league   league_id + a matching share token, OR the caller's own
                       espn_s2 / SWID verified against the league by ESPN. The
                       second path is what lets a member who has never seen an
                       invite link mint and read one, and what keeps legacy
                       rows (saved before tokens existed) reachable.

     /api/espn         the stored cookie envelope is lent ONLY to a request
                       carrying a matching token — see resolveStoredLeagueAccess
                       below, which is that relay's single entry point.

   The token is returned to a caller who already proved they may have it: a
   verified member, or someone who presented the correct token in the first
   place. It is never in a 404, never in a 401, and never in a record served to
   an unauthenticated reader, because no record is.
============================================================ */

const crypto = require('crypto');
const { sanitizeCookieValue, buildEspnCookieHeader } = require('./espn-cookies');
const { createClient } = require('@supabase/supabase-js');

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_BYTES = 6 * 1024 * 1024;
const MAX_ARCHIVE_SEASONS = 50;
const MAX_ARCHIVE_TEAMS_PER_SEASON = 64;
const MAX_ARCHIVE_GAMES_PER_SEASON = 5000;
const ESPN_HOST = 'https://lm-api-reads.fantasy.espn.com';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

let supabaseClient;

function applyHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-espn-s2, x-espn-swid, x-league-token');
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

/* ------------------------------------------------------------
   SHARE-TOKEN PRIMITIVES

   The token travels in URLs and invite links, so it is base64url — no padding,
   nothing a query string or a copy/paste can mangle. 32 bytes of randomness
   encode to 43 characters; the accepted range is deliberately wider so a token
   minted by an older or newer build is never rejected on length alone.
------------------------------------------------------------ */
const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

function generateShareToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/* '' for anything that is not a well-formed token, so a malformed value can
   never be compared against, stored, or handed back as if it were real. */
function cleanShareToken(value) {
  const token = String(value == null ? '' : value).trim();
  return SHARE_TOKEN_RE.test(token) ? token : '';
}

/* Constant-time comparison. crypto.timingSafeEqual throws on a length
   mismatch, so the lengths are checked first — that leaks only the length of a
   fixed-width token, which is public information. */
function shareTokensMatch(supplied, stored) {
  const a = Buffer.from(String(supplied || ''), 'utf8');
  const b = Buffer.from(String(stored || ''), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* Where a share token is allowed to arrive from. The header is what the app
   sends; the query parameter is what an invite link carries when it is pasted
   straight at the API; the body field is for a save that wants to assert a
   token it already holds. */
function requestShareToken(req, body) {
  const headers = (req && req.headers) || {};
  const query = (req && req.query) || {};
  const candidates = [
    headers['x-league-token'],
    body && (body.share_token || body.shareToken),
    query.share_token,
    query.token,
  ];
  for (const candidate of candidates) {
    const raw = Array.isArray(candidate) ? candidate[0] : candidate;
    const token = cleanShareToken(raw);
    if (token) return token;
  }
  return '';
}

/* Cookie ingestion runs through the same sanitizer the relay uses, so a value
   that arrives here as a "SWID={...}" row copy, a quoted string, or a paste the
   DevTools panel line-wrapped is stored (and later replayed to ESPN) in its
   canonical, transmittable form rather than verbatim. A value that cannot be
   repaired becomes '' — which makes verifyLeagueMember refuse the save with a
   real message instead of encrypting an unusable credential. */
function normalizeSwid(value) {
  return sanitizeCookieValue('SWID', value);
}

function cleanCookies(value) {
  const source = value && typeof value === 'object' ? value : {};
  const espnS2 = sanitizeCookieValue('espn_s2', source.espn_s2 || source.s2);
  const swid = normalizeSwid(source.swid || source.SWID);
  return { espn_s2: espnS2, swid };
}

function requestCookies(req, body) {
  const rawS2 = (body && body.cookies && (body.cookies.espn_s2 || body.cookies.s2)) ||
    req.headers['x-espn-s2'];
  const rawSwid = (body && body.cookies && (body.cookies.swid || body.cookies.SWID)) ||
    req.headers['x-espn-swid'];
  const cleaned = cleanCookies({ espn_s2: rawS2, swid: rawSwid });
  /* A credential that arrived but did not survive sanitization is the most
     confusing private-league failure there is — the caller believes it sent
     cookies and ESPN sees an anonymous request. Name it in the logs. */
  if ((rawS2 && !cleaned.espn_s2) || (rawSwid && !cleaned.swid)) {
    console.error('[api/league] A supplied ESPN credential was dropped as unusable ' +
      '(espn_s2 usable: ' + (!rawS2 || !!cleaned.espn_s2) +
      ', SWID usable: ' + (!rawSwid || !!cleaned.swid) + ').');
  }
  return cleaned;
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
    return {
      ok: false,
      status: 401,
      error: 'Both ESPN cookies are required to save league data. If you pasted both, one of them was ' +
        'unusable — paste just the cookie value (a "SWID=" prefix, quotes and stray whitespace are ' +
        'stripped for you, but a truncated or non-ASCII paste cannot be repaired).',
    };
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
          // Shared serializer — SWID first, exactly as a logged-in ESPN
          // browser sends it, with both values already sanitized.
          Cookie: buildEspnCookieHeader(cookies.swid, cookies.espn_s2).header,
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
    const memberIds = new Set();
    const rememberMemberId = function (value) {
      const id = String(value || '').replace(/^\{|\}$/g, '').toLowerCase();
      if (id) memberIds.add(id);
    };
    const members = league && Array.isArray(league.members) ? league.members : [];
    members.forEach(function (row) { rememberMemberId(row && row.id); });
    const teams = league && Array.isArray(league.teams) ? league.teams : [];
    teams.forEach(function (team) {
      rememberMemberId(team && team.primaryOwner);
      (team && Array.isArray(team.owners) ? team.owners : []).forEach(rememberMemberId);
    });
    if (memberIds.has(targetSwid)) return { ok: true };
  }

  return {
    ok: false,
    status: lastStatus === 401 || lastStatus === 403 ? lastStatus : 403,
    error: 'ESPN could not verify these cookies against the requested league. Re-copy your espn_s2 and SWID from a logged-in ESPN browser session and try again.',
  };
}

const RETURNING_COLUMNS = 'league_id,season_year,history_json,cookies,share_token,updated_at';

function archiveRows(historyJson) {
  if (Array.isArray(historyJson)) return historyJson;
  if (!historyJson || typeof historyJson !== 'object') return null;
  const keys = ['yearsData', 'historicalArchive', 'archive'];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(historyJson, key)) {
      return Array.isArray(historyJson[key]) ? historyJson[key] : null;
    }
  }
  return null;
}

function validateHistoryJson(historyJson) {
  if (!historyJson || typeof historyJson !== 'object') {
    return 'history_json must be a JSON object or array.';
  }
  const bytes = Buffer.byteLength(JSON.stringify(historyJson), 'utf8');
  if (bytes > MAX_HISTORY_BYTES) return 'history_json exceeds the 6 MB archive limit.';

  const rows = archiveRows(historyJson);
  if (!rows) {
    return 'history_json must contain a yearsData, historicalArchive, or archive array.';
  }
  if (rows.length > MAX_ARCHIVE_SEASONS) return 'history_json contains too many seasons.';

  const seenYears = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return 'Every archive season must be a JSON object.';
    }
    const leagueData = row.leagueData && typeof row.leagueData === 'object'
      ? row.leagueData
      : row;
    const year = Number(row.year || leagueData.seasonId || leagueData.season);
    if (!Number.isInteger(year) || year < 1990 || year > activeFantasySeason() + 1) {
      return 'Every archive season must have a valid season year.';
    }
    if (seenYears.has(year)) return 'history_json contains duplicate season years.';
    seenYears.add(year);
    if (leagueData.teams != null && !Array.isArray(leagueData.teams)) {
      return 'Every archive season teams value must be an array.';
    }
    if (leagueData.schedule != null && !Array.isArray(leagueData.schedule)) {
      return 'Every archive season schedule value must be an array.';
    }
    if (Array.isArray(leagueData.teams) && leagueData.teams.length > MAX_ARCHIVE_TEAMS_PER_SEASON) {
      return 'An archive season contains too many teams.';
    }
    if (Array.isArray(leagueData.schedule) && leagueData.schedule.length > MAX_ARCHIVE_GAMES_PER_SEASON) {
      return 'An archive season contains too many matchups.';
    }
  }
  return '';
}

function storageError(code, message, status, currentUpdatedAt) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.currentUpdatedAt = currentUpdatedAt || null;
  return error;
}

// Existing rows use optimistic concurrency: the client must present the exact
// updated_at value it most recently read, and the UPDATE repeats that check in
// its WHERE clause. A stale tab therefore cannot overwrite a newer archive.
async function saveLeagueRow(client, row, expectedUpdatedAt) {
  const existing = await client
    .from('leagues')
    .select(RETURNING_COLUMNS)
    .eq('league_id', row.league_id)
    .eq('season_year', row.season_year)
    .limit(2);
  if (existing.error) throw existing.error;

  const matches = Array.isArray(existing.data) ? existing.data : [];
  if (matches.length > 1) {
    throw storageError(
      'DUPLICATE_LEAGUE_ROWS',
      'League storage contains duplicate rows for this league and season; repair the composite key before saving.',
      503
    );
  }

  if (matches.length === 1) {
    const current = matches[0];
    const currentUpdatedAt = String(current.updated_at || '');
    if (!expectedUpdatedAt ||
        new Date(expectedUpdatedAt).getTime() !== new Date(currentUpdatedAt).getTime()) {
      throw storageError(
        'VERSION_CONFLICT',
        'The shared league archive changed after this browser loaded it. Reload the latest archive before saving again.',
        409,
        currentUpdatedAt
      );
    }

    const patch = {};
    Object.keys(row).forEach(function (key) {
      if (key !== 'league_id' && key !== 'season_year') patch[key] = row[key];
    });
    const updated = await client
      .from('leagues')
      .update(patch)
      .eq('league_id', row.league_id)
      .eq('season_year', row.season_year)
      .eq('updated_at', expectedUpdatedAt)
      .select(RETURNING_COLUMNS)
      .maybeSingle();
    if (updated.error) throw updated.error;
    if (!updated.data) {
      throw storageError(
        'VERSION_CONFLICT',
        'The shared league archive changed while this save was in progress. Reload the latest archive before saving again.',
        409,
        currentUpdatedAt
      );
    }
    return updated.data;
  }

  if (expectedUpdatedAt) {
    throw storageError(
      'VERSION_CONFLICT',
      'The shared league archive no longer matches the version loaded by this browser. Reload before saving again.',
      409
    );
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
    ? 'league_id,season_year,history_json,cookies,share_token,updated_at'
    : 'league_id,season_year,history_json,share_token,updated_at';
  let query = client.from('leagues').select(columns).eq('league_id', leagueId);
  if (seasonYear) query = query.eq('season_year', seasonYear);
  else query = query.order('season_year', { ascending: false }).limit(1);
  const result = await query.maybeSingle();
  if (result.error) throw result.error;
  return result.data || null;
}

/* The browser-facing shape of a row. Raw cookies never appear here; the share
   token appears only when the caller has already proved they may hold it
   (options.includeShareToken), so this function can never be the thing that
   leaks the secret it exists to protect. */
function publicRecord(row, options) {
  if (!row) return null;
  const opts = options || {};
  const token = cleanShareToken(row.share_token);
  const record = {
    league_id: row.league_id,
    season_year: row.season_year,
    history_json: row.history_json == null ? {} : row.history_json,
    has_cookies: Boolean(row.cookies),
    has_share_token: Boolean(token),
    updated_at: row.updated_at,
  };
  if (opts.includeShareToken && token) record.share_token = token;
  return record;
}

/* Every well-formed share token stored against this league id, newest season
   first. The secret is per-LEAGUE, not per-season row: a league whose 2026 row
   was saved by this build and whose 2019 row predates the token must still
   answer to one invite link. Duplicates are collapsed so a league that somehow
   minted twice (a lookup that failed mid-save, below) accepts both rather than
   locking half its members out.

   Throws on a storage failure. Callers decide whether that is fatal — a read
   that cannot confirm the token must NOT fall open. */
async function leagueShareTokens(client, leagueId) {
  const result = await client
    .from('leagues')
    .select('season_year,share_token')
    .eq('league_id', leagueId)
    .not('share_token', 'is', null)
    .order('season_year', { ascending: false })
    .limit(MAX_ARCHIVE_SEASONS + 10);
  if (result.error) throw result.error;
  const tokens = [];
  (Array.isArray(result.data) ? result.data : []).forEach(function (row) {
    const token = cleanShareToken(row && row.share_token);
    if (token && tokens.indexOf(token) === -1) tokens.push(token);
  });
  return tokens;
}

function shareTokenAccepted(tokens, supplied) {
  if (!supplied || !tokens.length) return false;
  return tokens.some(function (token) { return shareTokensMatch(supplied, token); });
}

/* THE credential-lending gate (H-1). /api/espn calls nothing else to reach a
   stored ESPN session, so this is the one place that decides whether one
   member's cookies may be replayed for another caller.

   Returns { status, cookies, reason }:

     'none'          there is nothing to lend — no row, no cookie envelope, or
                     an envelope that did not decrypt into a complete pair. The
                     relay reads the league anonymously, exactly as before.
     'unauthorized'  a cookie envelope EXISTS and this caller may not use it.
                     The relay must not attach it; see api/espn.js, which still
                     tries the read anonymously first so a PUBLIC league whose
                     archive happens to be saved is never blocked behind a token.
     'ok'            the share token matched. Lend the pair.

   A storage failure resolves to 'none', never 'ok': an unreachable Supabase
   may leave a public league reading anonymously, but it can never be talked
   into handing out credentials. */
async function resolveStoredLeagueAccess(leagueId, seasonYear, shareToken) {
  const client = getSupabase();
  const id = cleanLeagueId(leagueId);
  const year = cleanSeasonYear(seasonYear, 0);
  const supplied = cleanShareToken(shareToken);
  if (!client || !id) return { status: 'none', cookies: null, reason: '' };

  try {
    let row = await findLeagueRow(client, id, year, true);
    if (!row && year) row = await findLeagueRow(client, id, 0, true);
    if (!row || !row.cookies) return { status: 'none', cookies: null, reason: '' };

    const tokens = await leagueShareTokens(client, id);

    if (!tokens.length) {
      /* A legacy row: cookies stored before share tokens existed, so there is
         no secret anyone could present. Refusing is the whole point of H-1 —
         the league id alone used to be enough. The next member save mints the
         token and the league heals itself. */
      console.warn('[api/league] League ' + id + ' holds a stored ESPN cookie envelope but no share ' +
        'token (a row saved before H-1). Refusing to lend it; a league member must save the league ' +
        'again from Setup to mint an invite link.');
      return {
        status: 'unauthorized',
        cookies: null,
        reason: 'this league has no invite link yet — a league member must open Setup and save the league once to mint one',
      };
    }
    if (!supplied) {
      return {
        status: 'unauthorized',
        cookies: null,
        reason: "this league's stored ESPN session is protected by a share token and the request carried none",
      };
    }
    if (!shareTokenAccepted(tokens, supplied)) {
      console.warn('[api/league] Rejected a share token for league ' + id +
        '; it does not match any token stored for this league.');
      return {
        status: 'unauthorized',
        cookies: null,
        reason: 'the share token in this link does not match this league',
      };
    }

    const cookies = decryptCookies(row.cookies);
    if (!cookies.espn_s2 || !cookies.swid) {
      console.warn('[api/league] The stored cookie envelope for league ' + id + '/' +
        (row.season_year || year || 'latest') + ' did not decrypt into a complete SWID + espn_s2 pair; ' +
        'treating this league as having no stored session.');
      return { status: 'none', cookies: null, reason: '' };
    }
    return { status: 'ok', cookies: cookies, reason: '' };
  } catch (error) {
    console.error('[api/league] stored-cookie lookup failed for league ' + id + '/' + (year || 'latest') +
      '; treating this league as having no stored session (it will be read anonymously).', error);
    return { status: 'none', cookies: null, reason: '' };
  }
}

/* Backwards-compatible thin wrapper. The share token is now REQUIRED — calling
   this without one can only ever return null for a token-protected league. */
async function getStoredLeagueCookies(leagueId, seasonYear, shareToken) {
  const access = await resolveStoredLeagueAccess(leagueId, seasonYear, shareToken);
  return access.status === 'ok' ? access.cookies : null;
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

    const suppliedToken = requestShareToken(req, null);
    let row;
    let tokens;
    try {
      row = await findLeagueRow(client, leagueId, seasonYear, true);
      if (!row) return res.status(404).json({ error: 'No stored league record exists yet.' });
      tokens = await leagueShareTokens(client, leagueId);
    } catch (error) {
      console.error('[api/league] read failed for league ' + leagueId + '/' + (seasonYear || 'latest'), error);
      return res.status(502).json({ error: 'League storage read failed.' });
    }

    /* ---- H-1: the league id alone authorises nothing ----
       Two ways in, and only two. Either the caller presents the league's share
       token, or the caller presents their own ESPN cookies and ESPN itself
       confirms they are a member of this league. The second path is not a
       convenience: it is what mints the first invite link (a member reads the
       record, gets the token back, and can then share it) and what keeps a
       legacy row — saved before tokens existed, so no token can possibly
       match — reachable by the people it belongs to. */
    let authorized = shareTokenAccepted(tokens, suppliedToken);
    if (!authorized && suppliedToken) {
      console.warn('[api/league] Rejected a share token on a read of league ' + leagueId +
        '; it does not match any token stored for this league.');
    }

    if (!authorized) {
      const cookies = requestCookies(req, null);
      if (cookies.espn_s2 && cookies.swid) {
        const verifySeason = cleanSeasonYear(row.season_year, 0) || seasonYear || activeFantasySeason();
        try {
          const verification = await verifyLeagueMember(leagueId, verifySeason, cookies);
          if (verification.ok) authorized = true;
          else {
            console.warn('[api/league] A read of league ' + leagueId + ' carried ESPN cookies that ESPN ' +
              'would not confirm as a member of it (HTTP ' + (verification.status || 403) + '); ' +
              'falling through to the share-token requirement.');
          }
        } catch (verifyError) {
          console.error('[api/league] Member verification threw while reading league ' + leagueId +
            '; treating this reader as unauthenticated.', verifyError);
        }
      }
    }

    if (!authorized) {
      return res.status(401).json({
        error: 'This league is protected by a per-league invite link. Open the full link a league-mate ' +
          'sent you — it carries both the League ID and the share token — or paste your own ESPN ' +
          'espn_s2 and SWID cookies in Setup so ESPN can confirm you are a member of this league.',
        code: 'SHARE_TOKEN_REQUIRED',
        league_id: leagueId,
      });
    }

    /* The token rides back only to a caller who just proved they may hold it,
       so the Share button has something to copy. */
    return res.status(200).json({ record: publicRecord(row, { includeShareToken: true }) });
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
  const historyValidationError = validateHistoryJson(historyJson);
  if (historyValidationError) {
    return res.status(400).json({ error: historyValidationError });
  }

  const rawExpectedUpdatedAt = body.expected_updated_at !== undefined
    ? body.expected_updated_at
    : body.expectedUpdatedAt;
  let expectedUpdatedAt = '';
  if (rawExpectedUpdatedAt != null && String(rawExpectedUpdatedAt).trim()) {
    const parsedExpected = new Date(String(rawExpectedUpdatedAt));
    if (!Number.isFinite(parsedExpected.getTime())) {
      return res.status(400).json({ error: 'expected_updated_at must be a valid timestamp or null.' });
    }
    expectedUpdatedAt = parsedExpected.toISOString();
  }

  const cookies = requestCookies(req, body);
  const verification = await verifyLeagueMember(leagueId, seasonYear, cookies);
  if (!verification.ok) return res.status(verification.status || 403).json({ error: verification.error });

  /* ---- H-1: mint the per-league share secret ----
     Reached only after ESPN confirmed this caller is a member of this league,
     so the writer is exactly the person entitled to hold and hand out the
     league's invite link. Reuse an existing token whenever the league has one:
     rotating it on every save would silently invalidate every link already
     sitting in a league group chat.

     A lookup failure does NOT abort the save. Losing an archive over a token
     read is a far worse outcome than a league briefly holding two valid
     tokens, and leagueShareTokens() accepts every token stored for the league,
     so both keep working. */
  let shareToken = '';
  try {
    const existingTokens = await leagueShareTokens(client, leagueId);
    shareToken = existingTokens.length ? existingTokens[0] : '';
  } catch (tokenLookupError) {
    console.error('[api/league] The share-token lookup for league ' + leagueId + ' failed; minting a new ' +
      'token for this save. Any invite link already issued for this league stays valid.', tokenLookupError);
  }
  if (!shareToken) {
    shareToken = generateShareToken();
    console.warn('[api/league] Minted a new share token for league ' + leagueId +
      ' (no usable token was stored for it yet).');
  }

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
      // Written on every member save, so a season row that predates H-1 picks
      // up the league's token the first time anyone saves it.
      share_token: shareToken,
      updated_at: new Date().toISOString(),
    };
    // Only write the cookies column when encryption succeeded, so a failed
    // envelope never overwrites previously stored valid cookies with null.
    if (encryptedCookies) row.cookies = encryptedCookies;

    const saved = await saveLeagueRow(client, row, expectedUpdatedAt);

    /* The saver is an ESPN-verified member, so they may hold the token — this
       is what the Share button copies into the invite link. */
    const responseBody = { record: publicRecord(saved, { includeShareToken: true }) };
    if (cookieWarning) responseBody.warning = cookieWarning;
    return res.status(200).json(responseBody);
  } catch (error) {
    if (error && (error.status === 409 || error.status === 503)) {
      console.warn('[api/league] guarded save rejected', {
        code: error.code,
        message: error.message,
        current_updated_at: error.currentUpdatedAt,
      });
      return res.status(error.status).json({
        error: error.message,
        code: error.code,
        current_updated_at: error.currentUpdatedAt,
      });
    }
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
module.exports.resolveStoredLeagueAccess = resolveStoredLeagueAccess;
module.exports.cleanShareToken = cleanShareToken;
