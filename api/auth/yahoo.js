/* ============================================================
   MFFU YAHOO OAUTH 2.0 — /api/auth/yahoo

   GET  ?action=start       -> Yahoo authorization redirect
   GET  ?action=callback    -> code exchange + encrypted token storage
   GET  ?action=status      -> browser-session connection status
   POST ?action=disconnect  -> revoke the local MFFU session

   Yahoo access and refresh tokens never reach the browser. The browser keeps
   only a random HttpOnly session secret; Supabase stores its SHA-256 digest.
   Token columns contain AES-256-GCM envelopes, not plaintext credentials.
============================================================ */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const YAHOO_AUTHORIZE_URL = 'https://api.login.yahoo.com/oauth2/request_auth';
const YAHOO_TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token';
const SESSION_COOKIE = 'fsn_yahoo_session';
const STATE_COOKIE = 'fsn_yahoo_oauth_state';
const RETURN_COOKIE = 'fsn_yahoo_oauth_return';
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const TOKEN_REFRESH_SKEW_MS = 90 * 1000;

let supabaseClient;

function applyPrivateHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Vary', 'Cookie');
}

function getSupabase() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) {
    const error = new Error('SUPABASE_NOT_CONFIGURED');
    error.status = 503;
    throw error;
  }
  if (!supabaseClient) {
    supabaseClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { 'X-Client-Info': 'mffu-vercel-yahoo-oauth' } },
    });
  }
  return supabaseClient;
}

function oauthConfig() {
  const config = {
    clientId: String(process.env.YAHOO_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.YAHOO_CLIENT_SECRET || '').trim(),
    redirectUri: String(process.env.YAHOO_REDIRECT_URI || '').trim(),
  };
  if (!config.clientId || !config.clientSecret || !config.redirectUri) {
    const error = new Error('YAHOO_OAUTH_NOT_CONFIGURED');
    error.status = 503;
    throw error;
  }
  let redirect;
  try {
    redirect = new URL(config.redirectUri);
  } catch (parseError) {
    const error = new Error('YAHOO_REDIRECT_URI_INVALID');
    error.status = 503;
    throw error;
  }
  if (redirect.protocol !== 'https:' && redirect.hostname !== 'localhost') {
    const error = new Error('YAHOO_REDIRECT_URI_MUST_USE_HTTPS');
    error.status = 503;
    throw error;
  }
  return config;
}

function tokenEncryptionKey() {
  const raw = String(process.env.YAHOO_TOKEN_ENCRYPTION_KEY || '').trim();
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  if (raw) {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) return decoded;
  }
  const error = new Error('YAHOO_TOKEN_ENCRYPTION_KEY_INVALID');
  error.status = 503;
  throw error;
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tokenEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(String(value || ''), 'utf8')),
    cipher.final(),
  ]);
  return {
    v: 1,
    alg: 'A256GCM',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  };
}

function decryptSecret(envelope) {
  if (!envelope || envelope.v !== 1 || envelope.alg !== 'A256GCM') {
    const error = new Error('YAHOO_TOKEN_ENVELOPE_INVALID');
    error.status = 503;
    throw error;
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    tokenEncryptionKey(),
    Buffer.from(String(envelope.iv || ''), 'base64')
  );
  decipher.setAuthTag(Buffer.from(String(envelope.tag || ''), 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(String(envelope.data || ''), 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function parseCookies(req) {
  const result = {};
  String(req.headers && req.headers.cookie || '').split(';').forEach(function (part) {
    const divider = part.indexOf('=');
    if (divider < 1) return;
    const name = part.slice(0, divider).trim();
    const value = part.slice(divider + 1).trim();
    try {
      result[name] = decodeURIComponent(value);
    } catch (error) {
      console.warn('[Yahoo OAuth] ignored malformed cookie ' + name, error);
    }
  });
  return result;
}

function requestUsesHttps(req) {
  const proto = String(req.headers && req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const host = String(req.headers && req.headers.host || '').toLowerCase();
  return proto === 'https' || (!host.startsWith('localhost') && !host.startsWith('127.0.0.1'));
}

function cookieLine(req, name, value, maxAge) {
  const parts = [
    name + '=' + encodeURIComponent(value || ''),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + Math.max(0, Number(maxAge || 0)),
  ];
  if (requestUsesHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

function appendCookies(res, lines) {
  const current = res.getHeader('Set-Cookie');
  const existing = !current ? [] : (Array.isArray(current) ? current : [current]);
  res.setHeader('Set-Cookie', existing.concat(lines));
}

function clearOauthCookies(req, res) {
  appendCookies(res, [
    cookieLine(req, STATE_COOKIE, '', 0),
    cookieLine(req, RETURN_COOKIE, '', 0),
  ]);
}

function safeReturnPath(value) {
  const path = String(value || '').trim();
  if (!path || path[0] !== '/' || path.startsWith('//') || /[\r\n]/.test(path) || path.length > 1024) {
    return '/?goto=setup&platform=yahoo';
  }
  return path;
}

function withResult(path, key, value) {
  const parsed = new URL(safeReturnPath(path), 'https://mffu.invalid');
  parsed.searchParams.set(key, String(value || ''));
  return parsed.pathname + parsed.search + parsed.hash;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function sessionHash(secret) {
  return crypto.createHash('sha256').update(String(secret || ''), 'utf8').digest('hex');
}

async function requestYahooToken(form) {
  const config = oauthConfig();
  const response = await fetch(YAHOO_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: 'Basic ' + Buffer.from(config.clientId + ':' + config.clientSecret).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
    redirect: 'follow',
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (parseError) {
    console.error('[Yahoo OAuth] token endpoint returned non-JSON HTTP ' + response.status, parseError);
  }
  if (!response.ok || !payload.access_token) {
    const detail = String(payload.error_description || payload.error || 'token exchange failed').slice(0, 300);
    const error = new Error('YAHOO_TOKEN_HTTP_' + response.status + ': ' + detail);
    error.status = 502;
    throw error;
  }
  return payload;
}

async function persistAuthorization(tokenPayload) {
  const client = getSupabase();
  const yahooUserId = String(tokenPayload.xoauth_yahoo_guid || '').trim();
  const refreshToken = String(tokenPayload.refresh_token || '').trim();
  if (!yahooUserId || !refreshToken) {
    const error = new Error('YAHOO_TOKEN_RESPONSE_INCOMPLETE');
    error.status = 502;
    throw error;
  }
  const expiresIn = Math.max(60, Number(tokenPayload.expires_in || 3600));
  const tokenExpiry = new Date(Date.now() + expiresIn * 1000).toISOString();
  const upserted = await client.from('yahoo_oauth_tokens').upsert({
    yahoo_user_id: yahooUserId,
    access_token: encryptSecret(tokenPayload.access_token),
    refresh_token: encryptSecret(refreshToken),
    token_expiry: tokenExpiry,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'yahoo_user_id' }).select('yahoo_user_id').single();
  if (upserted.error) throw upserted.error;
  return yahooUserId;
}

async function createBrowserSession(req, res, yahooUserId) {
  const client = getSupabase();
  const secret = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  const inserted = await client.from('yahoo_oauth_sessions').insert({
    session_hash: sessionHash(secret),
    yahoo_user_id: yahooUserId,
    expires_at: expiresAt,
  });
  if (inserted.error) throw inserted.error;
  appendCookies(res, [cookieLine(req, SESSION_COOKIE, secret, SESSION_TTL_SECONDS)]);
}

async function readSession(req) {
  const secret = parseCookies(req)[SESSION_COOKIE] || '';
  if (!secret) return null;
  const hash = sessionHash(secret);
  const client = getSupabase();
  const found = await client.from('yahoo_oauth_sessions')
    .select('session_hash,yahoo_user_id,expires_at')
    .eq('session_hash', hash)
    .maybeSingle();
  if (found.error) throw found.error;
  if (!found.data) return null;
  if (new Date(found.data.expires_at).getTime() <= Date.now()) {
    const removed = await client.from('yahoo_oauth_sessions').delete().eq('session_hash', hash);
    if (removed.error) console.warn('[Yahoo OAuth] expired session cleanup failed', removed.error);
    return null;
  }
  return found.data;
}

async function refreshStoredToken(client, row) {
  const refreshToken = decryptSecret(row.refresh_token);
  const config = oauthConfig();
  const payload = await requestYahooToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    redirect_uri: config.redirectUri,
  });
  const expiresIn = Math.max(60, Number(payload.expires_in || 3600));
  const patch = {
    access_token: encryptSecret(payload.access_token),
    token_expiry: new Date(Date.now() + expiresIn * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (payload.refresh_token) patch.refresh_token = encryptSecret(payload.refresh_token);
  const updated = await client.from('yahoo_oauth_tokens')
    .update(patch)
    .eq('yahoo_user_id', row.yahoo_user_id)
    .select('yahoo_user_id,access_token,refresh_token,token_expiry')
    .single();
  if (updated.error) throw updated.error;
  return updated.data;
}

async function getYahooAccessToken(req) {
  const session = await readSession(req);
  if (!session) {
    const error = new Error('YAHOO_SESSION_REQUIRED');
    error.status = 401;
    throw error;
  }
  const client = getSupabase();
  const found = await client.from('yahoo_oauth_tokens')
    .select('yahoo_user_id,access_token,refresh_token,token_expiry')
    .eq('yahoo_user_id', session.yahoo_user_id)
    .maybeSingle();
  if (found.error) throw found.error;
  if (!found.data) {
    const error = new Error('YAHOO_AUTH_RECORD_MISSING');
    error.status = 401;
    throw error;
  }
  let row = found.data;
  const expiry = new Date(row.token_expiry).getTime();
  if (!Number.isFinite(expiry) || expiry <= Date.now() + TOKEN_REFRESH_SKEW_MS) {
    try {
      row = await refreshStoredToken(client, row);
    } catch (error) {
      console.error('[Yahoo OAuth] access-token refresh failed for Yahoo user ' + session.yahoo_user_id, error);
      error.status = error.status || 401;
      throw error;
    }
  }
  return {
    accessToken: decryptSecret(row.access_token),
    yahooUserId: session.yahoo_user_id,
    tokenExpiry: row.token_expiry,
  };
}

async function startAuthorization(req, res) {
  const config = oauthConfig();
  tokenEncryptionKey();
  getSupabase();
  const state = crypto.randomBytes(32).toString('base64url');
  const returnTo = safeReturnPath(req.query && (req.query.return_to || req.query.returnTo));
  appendCookies(res, [
    cookieLine(req, STATE_COOKIE, state, OAUTH_STATE_TTL_SECONDS),
    cookieLine(req, RETURN_COOKIE, returnTo, OAUTH_STATE_TTL_SECONDS),
  ]);
  const authorize = new URL(YAHOO_AUTHORIZE_URL);
  authorize.searchParams.set('client_id', config.clientId);
  authorize.searchParams.set('redirect_uri', config.redirectUri);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('language', 'en-us');
  return res.redirect(302, authorize.toString());
}

async function finishAuthorization(req, res) {
  const cookies = parseCookies(req);
  const returnTo = safeReturnPath(cookies[RETURN_COOKIE]);
  const expectedState = cookies[STATE_COOKIE] || '';
  const receivedState = String(req.query && req.query.state || '');
  clearOauthCookies(req, res);

  if (req.query && req.query.error) {
    console.warn('[Yahoo OAuth] Yahoo denied authorization', new Error(String(req.query.error)));
    return res.redirect(302, withResult(returnTo, 'yahoo_error', 'authorization_denied'));
  }
  if (!safeEqual(expectedState, receivedState)) {
    console.error('[Yahoo OAuth] state validation failed', new Error('OAUTH_STATE_MISMATCH'));
    return res.redirect(302, withResult(returnTo, 'yahoo_error', 'state_mismatch'));
  }
  const code = String(req.query && req.query.code || '').trim();
  if (!code) {
    console.error('[Yahoo OAuth] callback did not include an authorization code', new Error('OAUTH_CODE_MISSING'));
    return res.redirect(302, withResult(returnTo, 'yahoo_error', 'code_missing'));
  }

  try {
    const config = oauthConfig();
    const tokenPayload = await requestYahooToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
    });
    const yahooUserId = await persistAuthorization(tokenPayload);
    await createBrowserSession(req, res, yahooUserId);
    return res.redirect(302, withResult(returnTo, 'yahoo', 'connected'));
  } catch (error) {
    console.error('[Yahoo OAuth] authorization-code exchange failed', error);
    return res.redirect(302, withResult(returnTo, 'yahoo_error', 'exchange_failed'));
  }
}

async function connectionStatus(req, res) {
  try {
    const token = await getYahooAccessToken(req);
    return res.status(200).json({
      connected: true,
      provider: 'yahoo',
      token_expiry: token.tokenExpiry,
    });
  } catch (error) {
    if (error && error.status === 401) return res.status(200).json({ connected: false, provider: 'yahoo' });
    console.error('[Yahoo OAuth] status check failed', error);
    return res.status(error.status || 503).json({ error: 'Yahoo connection status is unavailable.' });
  }
}

/* Disconnecting deletes the credential, not just the browser's view of it.

   This previously removed only the yahoo_oauth_sessions row, so a user who
   pressed "Log Out" was signed out while their encrypted access AND refresh
   tokens stayed in yahoo_oauth_tokens indefinitely. A refresh token is a
   long-lived grant: retaining one after the user has withdrawn consent is both
   the thing App Store Guideline 5.1.1 asks about ("delete the account", not
   "hide it") and a standing risk with no remaining purpose.

   Order matters. The session goes first so the browser is signed out even if
   the token delete then fails, and the caller is told when the credential
   itself could not be removed rather than being shown a clean "disconnected".
   yahoo_oauth_sessions.yahoo_user_id cascades on delete, so removing the token
   row also clears any other session bound to the same Yahoo account — which is
   the correct reading of "disconnect this account". */
async function disconnect(req, res) {
  const secret = parseCookies(req)[SESSION_COOKIE] || '';
  appendCookies(res, [cookieLine(req, SESSION_COOKIE, '', 0)]);
  if (!secret) return res.status(200).json({ connected: false, provider: 'yahoo' });

  const client = getSupabase();
  let yahooUserId = '';

  try {
    // Read the owning account before deleting the session that identifies it.
    const found = await client.from('yahoo_oauth_sessions')
      .select('yahoo_user_id')
      .eq('session_hash', sessionHash(secret))
      .maybeSingle();
    if (found.error) throw found.error;
    yahooUserId = String((found.data && found.data.yahoo_user_id) || '');

    const removed = await client.from('yahoo_oauth_sessions')
      .delete()
      .eq('session_hash', sessionHash(secret));
    if (removed.error) throw removed.error;
  } catch (error) {
    console.error('[Yahoo OAuth] session disconnect cleanup failed', error);
    return res.status(502).json({ error: 'Yahoo session could not be disconnected cleanly.' });
  }

  if (!yahooUserId) {
    // An expired or already-deleted session: the cookie is cleared and there is
    // no token row this request can prove ownership of.
    return res.status(200).json({ connected: false, provider: 'yahoo', tokens_deleted: false });
  }

  try {
    const purged = await client.from('yahoo_oauth_tokens')
      .delete()
      .eq('yahoo_user_id', yahooUserId);
    if (purged.error) throw purged.error;
  } catch (error) {
    console.error('[Yahoo OAuth] stored token deletion failed for Yahoo user ' + yahooUserId, error);
    return res.status(502).json({
      error: 'You are signed out, but the stored Yahoo authorization could not be deleted. ' +
        'Revoke FSN from your Yahoo account settings, or contact support.',
      code: 'YAHOO_TOKEN_DELETE_FAILED',
      connected: false,
    });
  }

  return res.status(200).json({ connected: false, provider: 'yahoo', tokens_deleted: true });
}

async function handler(req, res) {
  applyPrivateHeaders(res);
  const action = String(req.query && req.query.action || '').toLowerCase()
    || ((req.query && (req.query.code || req.query.state || req.query.error)) ? 'callback' : 'start');

  if (action === 'disconnect') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    return disconnect(req, res);
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (action === 'start') return await startAuthorization(req, res);
    if (action === 'callback') return await finishAuthorization(req, res);
    if (action === 'status') return await connectionStatus(req, res);
    return res.status(400).json({ error: 'Unsupported Yahoo OAuth action.' });
  } catch (error) {
    console.error('[Yahoo OAuth] request failed for action ' + action, error);
    return res.status(error.status || 500).json({
      error: error.message === 'YAHOO_OAUTH_NOT_CONFIGURED'
        ? 'Yahoo OAuth is not configured on this deployment.'
        : 'Yahoo OAuth request failed.',
    });
  }
}

module.exports = handler;
module.exports.getYahooAccessToken = getYahooAccessToken;
