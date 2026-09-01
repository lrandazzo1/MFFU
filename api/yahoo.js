/* ============================================================
   MFFU YAHOO FANTASY PROXY — /api/yahoo

   Authenticated, same-origin access to Yahoo Fantasy Sports. The browser never
   receives OAuth tokens and cannot choose an arbitrary upstream URL. Supported
   resources are allowlisted below and always return private, non-cacheable data.

   GET ?resource=leagues
   GET ?resource=league|settings|standings|teams&league_key=449.l.12345
   GET ?resource=scoreboard|matchups&league_key=...&week=1
   GET ?resource=dashboard&league_key=...&through_week=14
============================================================ */

const { getYahooAccessToken } = require('./auth/yahoo');

const YAHOO_FANTASY_BASE = 'https://fantasysports.yahooapis.com/fantasy/v2/';
const MAX_WEEK = 18;
const DASHBOARD_BATCH_SIZE = 4;

function applyPrivateHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Vary', 'Cookie');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function queryValue(req, name) {
  const value = req.query && req.query[name];
  return String(Array.isArray(value) ? value[0] : (value || '')).trim();
}

function cleanLeagueKey(value) {
  const key = String(value || '').trim();
  return /^\d{1,8}\.l\.\d{1,20}$/.test(key) ? key : '';
}

function cleanWeek(value, fallback) {
  const week = Number(value || fallback);
  return Number.isInteger(week) && week >= 1 && week <= MAX_WEEK ? week : 0;
}

function upstreamError(status, detail) {
  const error = new Error('YAHOO_FANTASY_HTTP_' + status + (detail ? ': ' + detail : ''));
  error.status = status === 401 || status === 403 ? 401 : 502;
  error.upstreamStatus = status;
  return error;
}

async function yahooGet(accessToken, path) {
  const target = new URL(String(path || '').replace(/^\/+/, ''), YAHOO_FANTASY_BASE);
  const allowedBase = new URL(YAHOO_FANTASY_BASE);
  if (target.origin !== allowedBase.origin || !target.pathname.startsWith('/fantasy/v2/')) {
    throw new Error('YAHOO_PATH_REJECTED');
  }
  target.searchParams.set('format', 'json');
  const response = await fetch(target.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer ' + accessToken,
      'User-Agent': 'MFFU/1.0 Yahoo Fantasy Connector',
    },
    redirect: 'follow',
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (parseError) {
    console.error('[api/yahoo] upstream returned non-JSON for ' + target.pathname, parseError);
  }
  if (!response.ok || !payload) {
    const detail = payload && payload.error && payload.error.description
      ? String(payload.error.description).slice(0, 240)
      : '';
    throw upstreamError(response.status || 502, detail);
  }
  return payload;
}

async function fetchInBatches(items, batchSize, worker) {
  const results = [];
  for (let start = 0; start < items.length; start += batchSize) {
    const slice = items.slice(start, start + batchSize);
    const batch = await Promise.all(slice.map(worker));
    results.push.apply(results, batch);
  }
  return results;
}

async function yahooDashboard(accessToken, leagueKey, throughWeek) {
  const prefix = 'league/' + encodeURIComponent(leagueKey);
  const required = await Promise.all([
    yahooGet(accessToken, prefix),
    yahooGet(accessToken, prefix + '/standings'),
    yahooGet(accessToken, prefix + '/teams'),
  ]);

  let settings = null;
  try {
    settings = await yahooGet(accessToken, prefix + '/settings');
  } catch (error) {
    console.warn('[api/yahoo] optional settings resource failed for ' + leagueKey, error);
  }

  const weeks = [];
  for (let week = 1; week <= throughWeek; week += 1) weeks.push(week);
  const scoreboardRows = await fetchInBatches(weeks, DASHBOARD_BATCH_SIZE, async function (week) {
    try {
      return {
        week,
        payload: await yahooGet(accessToken, prefix + '/scoreboard;week=' + week),
      };
    } catch (error) {
      console.warn('[api/yahoo] scoreboard unavailable for ' + leagueKey + ' week ' + week, error);
      return { week, payload: null, unavailable: true };
    }
  });

  return {
    provider: 'yahoo',
    resource: 'dashboard',
    league_key: leagueKey,
    through_week: throughWeek,
    responses: {
      league: required[0],
      settings,
      standings: required[1],
      teams: required[2],
      scoreboards: scoreboardRows,
    },
  };
}

module.exports = async function handler(req, res) {
  applyPrivateHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let auth;
  try {
    auth = await getYahooAccessToken(req);
  } catch (error) {
    if (!error || error.status !== 401) console.error('[api/yahoo] Yahoo session lookup failed', error);
    return res.status(error && error.status || 401).json({
      error: error && error.status === 401
        ? 'Yahoo login is required.'
        : 'Yahoo authentication is unavailable.',
      code: error && error.status === 401 ? 'YAHOO_LOGIN_REQUIRED' : 'YAHOO_AUTH_UNAVAILABLE',
    });
  }

  const resource = queryValue(req, 'resource').toLowerCase() || 'leagues';
  const leagueKey = cleanLeagueKey(queryValue(req, 'league_key') || queryValue(req, 'leagueKey'));
  const week = cleanWeek(queryValue(req, 'week'), 0);

  try {
    if (resource === 'leagues' || resource === 'history') {
      const payload = await yahooGet(auth.accessToken, 'users;use_login=1/games;game_codes=nfl/leagues');
      return res.status(200).json({ provider: 'yahoo', resource, payload });
    }

    if (!leagueKey) {
      return res.status(400).json({ error: 'A valid Yahoo league_key (for example 449.l.12345) is required.' });
    }

    const prefix = 'league/' + encodeURIComponent(leagueKey);
    if (resource === 'league') {
      return res.status(200).json({ provider: 'yahoo', resource, league_key: leagueKey,
        payload: await yahooGet(auth.accessToken, prefix) });
    }
    if (resource === 'settings' || resource === 'standings' || resource === 'teams') {
      return res.status(200).json({ provider: 'yahoo', resource, league_key: leagueKey,
        payload: await yahooGet(auth.accessToken, prefix + '/' + resource) });
    }
    if (resource === 'scoreboard' || resource === 'matchups') {
      if (!week) return res.status(400).json({ error: 'A week from 1 through 18 is required.' });
      return res.status(200).json({ provider: 'yahoo', resource, league_key: leagueKey, week,
        payload: await yahooGet(auth.accessToken, prefix + '/scoreboard;week=' + week) });
    }
    if (resource === 'dashboard') {
      const throughWeek = cleanWeek(
        queryValue(req, 'through_week') || queryValue(req, 'throughWeek'),
        week || 1
      );
      if (!throughWeek) return res.status(400).json({ error: 'through_week must be from 1 through 18.' });
      return res.status(200).json(await yahooDashboard(auth.accessToken, leagueKey, throughWeek));
    }

    return res.status(400).json({ error: 'Unsupported Yahoo Fantasy resource.' });
  } catch (error) {
    console.error('[api/yahoo] ' + resource + ' request failed' + (leagueKey ? ' for ' + leagueKey : ''), error);
    if (error && error.status === 401) {
      return res.status(401).json({ error: 'Yahoo authorization expired or was revoked. Log in with Yahoo again.', code: 'YAHOO_REAUTH_REQUIRED' });
    }
    return res.status(error && error.status || 502).json({
      error: 'Yahoo Fantasy data request failed.',
      code: error && String(error.message || '').split(':')[0] || 'YAHOO_FANTASY_FAILED',
    });
  }
};
