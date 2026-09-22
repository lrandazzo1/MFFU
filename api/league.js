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
const { sanitizeCookieValue, buildEspnCookieHeader } = require('../lib/espn-cookies');
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

/* Which of the two required environment variables are actually present in this
   deployment. Returned as a structure rather than logged here so a caller can
   name the missing one in a reader-facing diagnostic — "Supabase is not
   configured" is useless on Vercel without saying WHICH variable is absent. */
function supabaseEnvStatus() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return {
    url: url,
    key: key,
    hasUrl: !!url,
    hasKey: !!key,
    ok: !!(url && key),
    missing: [!url ? 'SUPABASE_URL' : '', !key ? 'SUPABASE_SERVICE_ROLE_KEY' : ''].filter(Boolean),
  };
}

function getSupabase() {
  const env = supabaseEnvStatus();
  if (!env.ok) return null;
  if (!supabaseClient) {
    supabaseClient = createClient(env.url, env.key, {
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

/* The single answer to "which league?" being unanswered. One shape for the
   read and the write so the browser has exactly one condition to recognise. */
function noActiveLeagueError() {
  return {
    error: 'No active league specified',
    code: 'NO_ACTIVE_LEAGUE',
    detail: 'Every request must carry a numeric league_id. This endpoint has no sample or demo league ' +
      'and never answers with one.',
  };
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

/* ============================================================
   COOKIE ENCRYPTION KEYS — WRITE ONE, READ MANY

   Envelopes are ALWAYS written with a single active key (encryptionKey()), so
   there is never ambiguity about what a new row holds. They are READ against
   every key this deployment could plausibly have written with, because the
   set of "plausible" keys changes underneath a running deployment in two
   entirely routine ways:

     1. LEAGUE_COOKIE_ENCRYPTION_KEY gets SET for the first time.
        Before it was set, rows were encrypted with the derived fallback, whose
        seed includes that (then-empty) variable. Setting it — exactly what the
        warning below tells an operator to do — changes the active key to the
        configured one AND changes the derived fallback, because the variable
        is part of its seed. Every row written before that moment becomes
        undecryptable, permanently and silently. That is this bug: the relay
        reported COOKIES_UNDECRYPTABLE and told the host to re-save, and a
        re-save is a real fix, but nothing should have broken in the first
        place.

     2. SUPABASE_SERVICE_ROLE_KEY gets rotated. It is also part of the
        fallback seed, so rotating it (routine security hygiene) orphans every
        row written under the old one.

   Trying each candidate is safe: AES-256-GCM is authenticated, so a wrong key
   fails the tag check and throws rather than returning plausible garbage. The
   first key whose tag verifies is, with cryptographic certainty, the key the
   envelope was written with.
============================================================ */

// Parse a 32-byte key from a hex or base64 environment value; null if unusable.
function parseEncryptionKeyValue(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  // Buffer.from(..., 'base64') never throws — it silently drops invalid
  // characters — so validate the decoded length rather than relying on a
  // try/catch to reject a malformed value.
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 ? decoded : null;
}

// Deterministic 32-byte fallback so cookie encryption never hard-crashes cloud
// sync when LEAGUE_COOKIE_ENCRYPTION_KEY is missing or malformed. `overrides`
// lets a caller reconstruct the key this deployment WOULD have derived under a
// different environment — which is how a row written before
// LEAGUE_COOKIE_ENCRYPTION_KEY was set stays readable after it is set.
function deriveFallbackEncryptionKey(overrides) {
  const o = overrides || {};
  const seed = [
    o.leagueKey !== undefined ? String(o.leagueKey) : String(process.env.LEAGUE_COOKIE_ENCRYPTION_KEY || ''),
    o.serviceKey !== undefined ? String(o.serviceKey) : String(process.env.SUPABASE_SERVICE_ROLE_KEY || ''),
    o.supabaseUrl !== undefined ? String(o.supabaseUrl) : String(process.env.SUPABASE_URL || ''),
    'mffu-league-cookie-fallback-v1',
  ].join('|');
  return crypto.createHash('sha256').update(seed).digest(); // exactly 32 bytes
}

// The ONE key every new envelope is written with.
function encryptionKey() {
  const configured = parseEncryptionKeyValue(process.env.LEAGUE_COOKIE_ENCRYPTION_KEY);
  if (configured) return configured;
  if (!warnedAboutFallbackKey) {
    warnedAboutFallbackKey = true;
    console.warn(
      '[api/league] LEAGUE_COOKIE_ENCRYPTION_KEY is missing or not a valid ' +
      '32-byte base64 / 64-character hex value; using a derived fallback key. ' +
      'Set a proper key for stable cross-deployment cookie encryption — rows ' +
      'written under the fallback stay readable afterwards (see decryptCookies).'
    );
  }
  return deriveFallbackEncryptionKey();
}

/* Every key an envelope in this deployment could have been written with,
   most-likely first. Deduplicated, so a deployment with no configured key
   does not try the same derived key three times. */
function encryptionKeyCandidates() {
  const candidates = [];
  const seen = new Set();
  const push = (key, label) => {
    if (!key || key.length !== 32) return;
    const fingerprint = key.toString('base64');
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    candidates.push({ key: key, label: label });
  };

  // 1. The configured key — what this deployment writes with today.
  push(parseEncryptionKeyValue(process.env.LEAGUE_COOKIE_ENCRYPTION_KEY),
    'LEAGUE_COOKIE_ENCRYPTION_KEY');

  // 2. An explicitly retired key, for a deliberate rotation. Set this to the
  //    previous LEAGUE_COOKIE_ENCRYPTION_KEY when rotating and existing rows
  //    keep working until they are next saved.
  push(parseEncryptionKeyValue(process.env.LEAGUE_COOKIE_ENCRYPTION_KEY_PREVIOUS),
    'LEAGUE_COOKIE_ENCRYPTION_KEY_PREVIOUS');

  // 3. The derived fallback under the CURRENT environment.
  push(deriveFallbackEncryptionKey(), 'derived fallback (current environment)');

  // 4. THE FIX FOR THIS BUG: the derived fallback as it was BEFORE
  //    LEAGUE_COOKIE_ENCRYPTION_KEY was set. Identical to (3) on a deployment
  //    that never set the variable, and deduplicated away there.
  push(deriveFallbackEncryptionKey({ leagueKey: '' }),
    'derived fallback (before LEAGUE_COOKIE_ENCRYPTION_KEY was set)');

  // 5. The same, for a deployment that also set the variable to something
  //    unusable (a truncated paste), which parseEncryptionKeyValue rejects but
  //    which still contributed to the seed at write time.
  push(deriveFallbackEncryptionKey({
    leagueKey: String(process.env.LEAGUE_COOKIE_ENCRYPTION_KEY || '').trim(),
  }), 'derived fallback (trimmed LEAGUE_COOKIE_ENCRYPTION_KEY in seed)');

  return candidates;
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

/* Never throws. Returns { espn_s2, swid, ok, reason, keyLabel }:

     ok:false with an empty pair when the envelope is absent, malformed, or
     could not be opened by ANY candidate key. The caller decides what that
     means — it is not this function's job to take a request down, and the
     previous version throwing here is what produced the HTTP 502 the reader
     saw instead of an actionable message.

   AES-256-GCM authenticates, so a wrong key throws on final() rather than
   returning garbage. The first candidate whose tag verifies is certainly the
   key the envelope was written with. */
function decryptCookies(envelope) {
  const empty = { espn_s2: '', swid: '', ok: false, reason: '', keyLabel: '' };
  if (!envelope || typeof envelope !== 'object') {
    return Object.assign({}, empty, { reason: 'no cookie envelope was stored' });
  }

  // Read legacy plaintext JSON rows once so existing deployments can migrate
  // naturally on the next authenticated-member save. New writes are encrypted.
  if (envelope.espn_s2 || envelope.s2) {
    const legacy = cleanCookies(envelope);
    return Object.assign({}, legacy, { ok: true, reason: '', keyLabel: 'legacy plaintext row' });
  }
  if (envelope.v !== 1 || envelope.alg !== 'A256GCM') {
    return Object.assign({}, empty, {
      reason: 'the stored envelope is not in a format this build can read (v=' +
        JSON.stringify(envelope.v) + ', alg=' + JSON.stringify(envelope.alg) + ')',
    });
  }

  const iv = Buffer.from(String(envelope.iv || ''), 'base64');
  const tag = Buffer.from(String(envelope.tag || ''), 'base64');
  const data = Buffer.from(String(envelope.data || ''), 'base64');
  if (!iv.length || !tag.length || !data.length) {
    return Object.assign({}, empty, {
      reason: 'the stored envelope is truncated (iv ' + iv.length + 'B, tag ' +
        tag.length + 'B, data ' + data.length + 'B)',
    });
  }

  const candidates = encryptionKeyCandidates();
  const tried = [];
  for (const candidate of candidates) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', candidate.key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      const cookies = cleanCookies(JSON.parse(plaintext));
      if (candidate.label !== 'LEAGUE_COOKIE_ENCRYPTION_KEY') {
        /* Opened with something other than the key we write with today. The
           row still works, and the next member save re-encrypts it with the
           active key, healing it permanently. Say so once, loudly enough to
           be actionable but not as an error — nothing is broken. */
        console.warn('[api/league] Stored cookies opened with "' + candidate.label + '" rather than the ' +
          'currently-active key. This row predates the current LEAGUE_COOKIE_ENCRYPTION_KEY configuration; ' +
          'it will be re-encrypted with the active key the next time a league member saves this league.');
      }
      return Object.assign({}, cookies, { ok: true, reason: '', keyLabel: candidate.label });
    } catch (error) {
      // Wrong key — the GCM tag check failed. Expected while walking the list.
      tried.push(candidate.label);
    }
  }

  console.error('[api/league] The stored cookie envelope could not be decrypted with any known key. ' +
    'Tried: ' + (tried.join(', ') || '(none available)') + '. The row was written by a deployment whose ' +
    'LEAGUE_COOKIE_ENCRYPTION_KEY (or SUPABASE_SERVICE_ROLE_KEY, which seeds the derived fallback) differs ' +
    'from this one. Set LEAGUE_COOKIE_ENCRYPTION_KEY_PREVIOUS to the retired key to recover these rows, ' +
    'or have a league member re-save the league from Setup to rewrite it with the active key.');
  return Object.assign({}, empty, {
    reason: 'the stored ESPN session was encrypted with a key this deployment no longer has (tried ' +
      tried.length + ' candidate key' + (tried.length === 1 ? '' : 's') + ')',
  });
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

/* The exact stored row for this league+season, or null. Reading it INSIDE the
   handler is what makes an explicit save reliable: the authoritative
   updated_at comes from the database on every attempt, so a version marker a
   browser cached minutes ago is never what decides whether the write runs. */
async function readCurrentLeagueRow(client, leagueId, seasonYear) {
  const existing = await client
    .from('leagues')
    .select(RETURNING_COLUMNS)
    .eq('league_id', leagueId)
    .eq('season_year', seasonYear)
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
  return matches.length === 1 ? matches[0] : null;
}

/* True when the cookies this save carries are not the ones already stored —
   a member pasting a fresh espn_s2/SWID after ESPN expired the old pair. That
   save is by definition newer than the row it replaces (nobody else can have
   written these credentials), so it must never lose to a version marker. A
   row whose envelope cannot be opened at all counts as superseded too: storing
   readable credentials over unreadable ones is strictly an improvement. */
function cookiesSupersedeStored(storedEnvelope, incoming) {
  const fresh = cleanCookies(incoming);
  if (!fresh.espn_s2 || !fresh.swid) return false;
  if (!storedEnvelope) return true;
  const stored = decryptCookies(storedEnvelope);
  if (!stored.ok) return true;
  return stored.espn_s2 !== fresh.espn_s2 || normalizeSwid(stored.swid) !== fresh.swid;
}

// How many times a forced save re-reads the authoritative version and retries
// when a leaguemate committed between our read and our write. Bounded so two
// members saving in a loop cannot turn one request into an unbounded retry.
const FORCED_SAVE_ATTEMPTS = 3;

/* Existing rows use optimistic concurrency: the client presents the exact
   updated_at value it most recently read, and the UPDATE repeats that check in
   its WHERE clause, so a stale background tab cannot overwrite a newer archive.
   That guard is right for automatic saves and wrong for explicit ones.

   `options.force` (the Save League Data Now button) and a save carrying
   credentials the stored row does not have both mean "this human is asking for
   this write, now". Those skip the client's marker entirely: the current
   updated_at is read from the database immediately before the write and used
   as the WHERE-clause guard instead, so the write is still atomic against a
   concurrent commit — it simply can no longer be refused for holding a marker
   that went stale in a browser tab. A commit that lands in that window is
   re-read and retried rather than reported as a conflict. */
async function saveLeagueRow(client, row, expectedUpdatedAt, options) {
  const opts = options || {};
  let forced = !!opts.force;
  let credentialOverride = false;

  for (let attempt = 1; ; attempt += 1) {
    const current = await readCurrentLeagueRow(client, row.league_id, row.season_year);

    if (!current) {
      /* Nothing to overwrite. A marker for a row that does not exist is stale
         by definition, so an explicit save treats this as the first write. */
      if (expectedUpdatedAt && !forced) {
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
      if (!inserted.error) return inserted.data;
      // Someone inserted the same composite key in the window between the read
      // and this insert. Loop: the next pass finds the row and updates it.
      const duplicateKey = inserted.error && String(inserted.error.code || '') === '23505';
      if (duplicateKey && attempt < FORCED_SAVE_ATTEMPTS) {
        console.warn('[api/league] Insert for league ' + row.league_id + '/' + row.season_year +
          ' raced another first write; re-reading the row and saving over it (attempt ' + attempt + ').');
        continue;
      }
      throw inserted.error;
    }

    const currentUpdatedAt = String(current.updated_at || '');

    if (!forced && opts.cookies && cookiesSupersedeStored(current.cookies, opts.cookies)) {
      credentialOverride = true;
      forced = true;
      console.warn('[api/league] The save for league ' + row.league_id + '/' + row.season_year +
        ' carries host credentials that differ from the stored envelope; bypassing the version ' +
        'guard so refreshed espn_s2/SWID values are never rejected as a stale version.');
    }

    if (!forced) {
      if (!expectedUpdatedAt ||
          new Date(expectedUpdatedAt).getTime() !== new Date(currentUpdatedAt).getTime()) {
        throw storageError(
          'VERSION_CONFLICT',
          'The shared league archive changed after this browser loaded it. Reload the latest archive before saving again.',
          409,
          currentUpdatedAt
        );
      }
    }

    // The guard is whatever the DATABASE says right now on a forced save, and
    // the client's marker otherwise. Either way the UPDATE stays conditional,
    // so a commit landing in this window loses the race instead of being lost.
    const guardUpdatedAt = forced ? currentUpdatedAt : expectedUpdatedAt;

    const patch = {};
    Object.keys(row).forEach(function (key) {
      if (key !== 'league_id' && key !== 'season_year') patch[key] = row[key];
    });
    let query = client
      .from('leagues')
      .update(patch)
      .eq('league_id', row.league_id)
      .eq('season_year', row.season_year);
    // A row that somehow stores a null updated_at has no version to match on;
    // the composite key alone is then the guard, rather than a filter that can
    // never be true and would lock the league out of its own archive.
    if (guardUpdatedAt) query = query.eq('updated_at', guardUpdatedAt);
    const updated = await query.select(RETURNING_COLUMNS).maybeSingle();
    if (updated.error) throw updated.error;
    if (updated.data) {
      if (forced) {
        console.warn('[api/league] Saved league ' + row.league_id + '/' + row.season_year +
          ' past the version guard (' + (credentialOverride ? 'refreshed host credentials' : 'explicit user save') +
          '); the authoritative version was read from the database immediately before the write.');
      }
      return updated.data;
    }

    if (forced && attempt < FORCED_SAVE_ATTEMPTS) {
      console.warn('[api/league] A leaguemate committed to league ' + row.league_id + '/' + row.season_year +
        ' between this explicit save’s read and its write; re-reading the authoritative version and ' +
        'retrying (attempt ' + attempt + ' of ' + FORCED_SAVE_ATTEMPTS + ').');
      continue;
    }

    throw storageError(
      'VERSION_CONFLICT',
      'The shared league archive changed while this save was in progress. Reload the latest archive before saving again.',
      409,
      currentUpdatedAt
    );
  }
}

/* Every season stored for ONE league, newest first. Scoped to league_id like
   every other read here: the season list a browser is offered must describe
   the league it is looking at and no other. */
async function leagueStoredSeasons(client, leagueId) {
  const result = await client
    .from('leagues')
    .select('season_year')
    .eq('league_id', leagueId)
    .order('season_year', { ascending: false })
    .limit(MAX_ARCHIVE_SEASONS + 10);
  if (result.error) throw result.error;
  return (Array.isArray(result.data) ? result.data : [])
    .map(function (row) { return Number(row && row.season_year) || 0; })
    .filter(function (year) { return year > 0; });
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
  const id = cleanLeagueId(leagueId);
  const year = cleanSeasonYear(seasonYear, 0);
  const supplied = cleanShareToken(shareToken);
  const rawToken = String(shareToken == null ? '' : shareToken).trim();

  /* ---- DIAGNOSTIC LOG: what this lookup was actually asked for ----
     The token is masked to its first 8 characters. That is enough to
     correlate a Vercel log line with the link a tester pasted, and not
     enough to replay the invite from the log. */
  const maskedToken = supplied
    ? supplied.slice(0, 8) + '…(' + supplied.length + ' chars)'
    : (rawToken ? '(malformed, ' + rawToken.length + ' chars)' : '(none)');
  console.log('[api/league] resolveStoredLeagueAccess league=' + (id || '(invalid)') +
    ' season=' + (year || 'latest') + ' token=' + maskedToken);

  const env = supabaseEnvStatus();
  if (!env.ok) {
    /* The single most likely production cause of "ESPN denied the anonymous
       request" on a link that carries a perfectly good token: the relay could
       never reach Supabase at all, so it had no cookies to attach and fell
       through to an anonymous read. Name the missing variable. */
    console.error('[api/league] Supabase is not configured in this deployment — missing ' +
      env.missing.join(' and ') + '. No stored ESPN session can be looked up for league ' +
      (id || '(invalid)') + '.');
    return {
      status: 'none',
      cookies: null,
      reason: 'league storage is not configured in this deployment (missing ' + env.missing.join(' and ') + ')',
      code: 'SUPABASE_NOT_CONFIGURED',
    };
  }
  const client = getSupabase();
  if (!client) {
    return {
      status: 'none',
      cookies: null,
      reason: 'the Supabase client could not be created',
      code: 'SUPABASE_CLIENT_UNAVAILABLE',
    };
  }
  if (!id) {
    return {
      status: 'none',
      cookies: null,
      reason: 'no valid numeric league id was present in the requested ESPN URL',
      code: 'INVALID_LEAGUE_ID',
    };
  }

  try {
    let row = await findLeagueRow(client, id, year, true);
    if (!row && year) row = await findLeagueRow(client, id, 0, true);
    if (!row) {
      console.warn('[api/league] No stored league row exists for league ' + id + '/' + (year || 'latest') +
        '. Nothing to lend; the read will be anonymous unless the caller supplied their own cookies.');
      return {
        status: 'none',
        cookies: null,
        reason: 'no league record is stored for this league id — a league member must open Setup and save the league once',
        code: 'NO_LEAGUE_ROW',
      };
    }
    if (!row.cookies) {
      console.warn('[api/league] League ' + id + '/' + (row.season_year || year || 'latest') +
        ' has a stored row but an empty cookies column; no ESPN session to lend.');
      return {
        status: 'none',
        cookies: null,
        reason: 'the stored league record holds no ESPN session — the member who saved it did not have both cookies saved at the time',
        code: 'NO_STORED_COOKIES',
      };
    }
    console.log('[api/league] League ' + id + ' row found (season ' + (row.season_year || 'latest') +
      '), cookie envelope present. Checking the share token.');

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
        code: 'SHARE_TOKEN_NOT_MINTED',
      };
    }
    if (!supplied) {
      return {
        status: 'unauthorized',
        cookies: null,
        reason: "this league's stored ESPN session is protected by a share token and the request carried none",
        code: 'SHARE_TOKEN_MISSING',
      };
    }
    if (!shareTokenAccepted(tokens, supplied)) {
      console.warn('[api/league] Rejected a share token for league ' + id +
        '; it does not match any token stored for this league.');
      return {
        status: 'unauthorized',
        cookies: null,
        reason: 'the share token in this link does not match this league',
        code: 'SHARE_TOKEN_INVALID',
      };
    }

    /* decryptCookies never throws: it walks every candidate key and reports
       which one opened the envelope (or that none did). A failure here is a
       deployment-key problem, not a request problem, and must not take the
       request down with a 502. */
    const cookies = decryptCookies(row.cookies);
    if (!cookies.ok) {
      console.error('[api/league] The stored cookie envelope for league ' + id + '/' +
        (row.season_year || year || 'latest') + ' could not be opened — ' + cookies.reason);
      return {
        status: 'none',
        cookies: null,
        reason: cookies.reason ||
          'the stored ESPN session could not be decrypted with this deployment\'s encryption key',
        code: 'COOKIES_UNDECRYPTABLE',
      };
    }
    if (!cookies.espn_s2 || !cookies.swid) {
      console.warn('[api/league] The stored cookie envelope for league ' + id + '/' +
        (row.season_year || year || 'latest') + ' did not decrypt into a complete SWID + espn_s2 pair ' +
        '(espn_s2 present: ' + !!cookies.espn_s2 + ', SWID present: ' + !!cookies.swid + ').');
      return {
        status: 'none',
        cookies: null,
        reason: 'the stored ESPN session is incomplete — it is missing ' +
          (cookies.espn_s2 ? 'the SWID' : 'the espn_s2') + ' half of the pair',
        code: 'COOKIES_INCOMPLETE',
      };
    }
    console.log('[api/league] Share token accepted for league ' + id +
      '; lending the stored ESPN session (SWID and espn_s2 both present).');
    return { status: 'ok', cookies: cookies, reason: '', code: 'OK' };
  } catch (error) {
    console.error('[api/league] stored-cookie lookup failed for league ' + id + '/' + (year || 'latest') +
      '.', error);
    return {
      status: 'none',
      cookies: null,
      reason: 'the league storage lookup failed: ' + String((error && error.message) || error),
      code: 'STORAGE_ERROR',
    };
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
    /* ---- every read is scoped to league_id, and to season_year when one was
       asked for ----
       A season the caller NAMED is part of the key, never a hint. The old
       reading treated an unparseable season as "not supplied" and fell through
       to this league's newest stored row, so a request for 2025 could be
       answered with 2026 and the browser had no way to tell it had been given
       a different season than it asked for. Say 400 instead.

       Omitting season_year entirely still means "this league's newest stored
       season" — that is the invite-link handshake, and it is bounded to the
       one league in the query either way. */
    const rawSeason = req.query && (req.query.season_year !== undefined
      ? req.query.season_year
      : req.query.seasonYear);
    const seasonRequested = rawSeason !== undefined && String(rawSeason).trim() !== '';
    const seasonYear = seasonRequested ? cleanSeasonYear(rawSeason, 0) : 0;
    /* ---- no active league is an ERROR, never a demo ----
       This route has no seed, sample or demo league and must never grow one.
       A request that names no league is answered with a 400 that says exactly
       that, so the browser can show "Select or Connect a League" rather than
       rendering something that looks like a league and is not the reader's. */
    if (!leagueId) return res.status(400).json(noActiveLeagueError());
    if (seasonRequested && !seasonYear) {
      return res.status(400).json({
        error: 'season_year must be a valid season between 1990 and ' + (activeFantasySeason() + 1) + '.',
        code: 'INVALID_SEASON',
        league_id: leagueId,
      });
    }

    const suppliedToken = requestShareToken(req, null);
    let row;
    let tokens;
    try {
      row = await findLeagueRow(client, leagueId, seasonYear, true);
      tokens = await leagueShareTokens(client, leagueId);
      if (!row) {
        /* Nothing stored for this league at this season. The browser needs to
           be able to tell that apart from a storage failure, because the
           correct UI for it is an empty season inside the same league — never
           a fallback to some other league's archive. The seasons this league
           DOES have ride along only for a caller holding its invite token, so
           the 404 cannot become a listing service for anyone with a league id. */
        const authorizedListing = shareTokenAccepted(tokens, suppliedToken);
        const body = {
          error: seasonRequested
            ? 'No stored league record exists for this league and season.'
            : 'No stored league record exists yet.',
          code: seasonRequested ? 'SEASON_NOT_STORED' : 'LEAGUE_NOT_STORED',
          league_id: leagueId,
        };
        if (seasonRequested) body.season_year = seasonYear;
        if (authorizedListing) {
          body.available_seasons = await leagueStoredSeasons(client, leagueId);
        }
        return res.status(404).json(body);
      }
      /* Defence in depth. findLeagueRow filters on league_id (and season_year
         when one was given), so a row that does not match cannot happen — and
         if it ever does, it is a storage fault, not something to render. */
      const rowLeagueId = String(row.league_id || '');
      const rowSeason = Number(row.season_year) || 0;
      if (rowLeagueId !== leagueId || (seasonRequested && rowSeason !== seasonYear)) {
        console.error('[api/league] A read for league ' + leagueId + '/' +
          (seasonRequested ? seasonYear : 'latest') + ' returned ' + rowLeagueId + '/' + rowSeason +
          '; refusing to serve a record the caller did not ask for.',
          new Error('LEAGUE_SCOPE_MISMATCH'));
        return res.status(502).json({ error: 'League storage returned a record for a different league.' });
      }
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
  // Same contract as the read: a write with no league is refused by name, so a
  // browser that lost its active league can never silently save over anything.
  if (!leagueId) return res.status(400).json(noActiveLeagueError());
  if (!seasonYear) {
    return res.status(400).json({
      error: 'A valid season_year is required.',
      code: 'INVALID_SEASON',
      league_id: leagueId,
    });
  }

  const historyJson = body.history_json !== undefined
    ? body.history_json
    : (body.historicalArchive !== undefined ? body.historicalArchive : {});
  const historyValidationError = validateHistoryJson(historyJson);
  if (historyValidationError) {
    return res.status(400).json({ error: historyValidationError });
  }

  /* An explicit save asks the server to write what this browser is holding,
     full stop. The client's cached version marker is advisory on such a save:
     the handler reads the authoritative updated_at from the database instead
     (see saveLeagueRow), so a marker that drifted in localStorage — because a
     background refresh, another device, or an interrupted save moved the row
     on — can no longer refuse the one save the reader actually pressed. */
  const rawForce = body.force !== undefined ? body.force : body.force_save;
  const forceSave = rawForce === true || String(rawForce || '').toLowerCase() === 'true';

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

    const saved = await saveLeagueRow(client, row, expectedUpdatedAt, {
      force: forceSave,
      // Verified above, so a mismatch against the stored envelope means this
      // member is refreshing the league's host credentials — see
      // cookiesSupersedeStored(), which treats that as an explicit save too.
      cookies: cookies,
    });

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
// Exported for scripts/league-save-check.mjs, which exercises the version
// guard (and the explicit-save bypass) against an in-memory client.
module.exports.saveLeagueRow = saveLeagueRow;
module.exports.getStoredLeagueCookies = getStoredLeagueCookies;
module.exports.resolveStoredLeagueAccess = resolveStoredLeagueAccess;
module.exports.cleanShareToken = cleanShareToken;
