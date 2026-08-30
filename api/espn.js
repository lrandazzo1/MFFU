/* ============================================================
   VERCEL SERVERLESS ESPN PROXY  —  /api/espn?url=<espnUrl>

   The browser cannot read ESPN's fantasy endpoints directly (no CORS
   headers, cross-origin). This same-origin serverless function fetches the
   requested ESPN URL server-side with a realistic browser User-Agent and
   returns the JSON payload with permissive CORS headers so the static
   front-end can consume both live and historical seasons through one route.

   The target host is restricted to ESPN's fantasy read hosts so the proxy
   cannot be repurposed as an open relay for arbitrary URLs.
============================================================ */

const { getStoredLeagueCookies } = require('./league');

const ALLOWED_ESPN_HOSTS = new Set([
  'lm-api-reads.fantasy.espn.com',
  'fantasy.espn.com',
  'site.api.espn.com',
]);

// A realistic desktop Chrome UA. ESPN's read endpoints return empty or
// error shells to unrecognized clients, so we present as a normal browser.
const UPSTREAM_TIMEOUT_MS = 12000;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function applyCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-espn-s2, x-espn-swid');
}

function leagueContextFromTarget(target) {
  const path = String(target && target.pathname || '');
  const leagueMatch = path.match(/\/(?:leagues|leagueHistory)\/(\d{1,20})(?:\/|$)/);
  const seasonMatch = path.match(/\/seasons\/(\d{4})(?:\/|$)/);
  const queryYear = Number(target && target.searchParams && target.searchParams.get('seasonId'));
  return {
    leagueId: leagueMatch ? leagueMatch[1] : '',
    seasonYear: seasonMatch ? Number(seasonMatch[1]) : (Number.isInteger(queryYear) ? queryYear : 0),
  };
}

let warnedAboutOwnerCredentials = false;

// These env vars are no longer read for upstream auth. If they are still
// present on the deployment, say so once per cold start: a stale personal
// ESPN session sitting in the project environment is worth removing, not
// leaving around for some future code path to pick up again.
function warnIfOwnerCredentialsPresent() {
  if (warnedAboutOwnerCredentials) return;
  if (!process.env.ESPN_S2 && !process.env.ESPN_SWID) return;
  warnedAboutOwnerCredentials = true;
  console.warn(
    '[api/espn] ESPN_S2 / ESPN_SWID are set on this deployment but are ' +
    'intentionally ignored — the relay never authenticates as the deployment ' +
    'owner. Remove them from the project environment.'
  );
}

module.exports = async function handler(req, res) {
  warnIfOwnerCredentialsPresent();
  applyCorsHeaders(res);

  // Answer CORS preflight immediately.
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Extract the target ESPN URL from req.query.url. Vercel's Node runtime
  // populates req.query, but fall back to parsing req.url directly so the
  // function still works under `vercel dev`, other hosts, or any runtime that
  // hands us a bare request object.
  let raw = Array.isArray(req.query && req.query.url)
    ? req.query.url[0]
    : (req.query && req.query.url);
  if (!raw && req.url) {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      raw = parsed.searchParams.get('url');
    } catch (e) { /* fall through to the missing-param error below */ }
  }
  if (!raw) {
    return res.status(400).json({ error: 'Missing url query parameter' });
  }

  let target;
  try {
    target = new URL(String(raw));
  } catch (error) {
    return res.status(400).json({ error: 'Invalid ESPN URL' });
  }

  if (target.protocol !== 'https:' || !ALLOWED_ESPN_HOSTS.has(target.hostname)) {
    return res.status(400).json({ error: 'Unsupported ESPN host' });
  }

  // ESPN auth precedence:
  //   1. Per-request headers (the caller's own cookies, from their browser)
  //   2. Encrypted cookies from public.leagues, decrypted only on the server,
  //      and only for the league the request is actually addressing
  //
  // There is deliberately NO deployment-wide credential tier. This route is
  // unauthenticated and CORS-open, so an ESPN_S2 / ESPN_SWID fallback made it
  // a confused deputy: any caller who omitted cookies got the request signed
  // with the deployment owner's ESPN session, which reads every league that
  // account belongs to. Requests with no usable credentials now go upstream
  // ANONYMOUSLY — public leagues still resolve, and a private league returns
  // ESPN's 401/403, which the handler below turns into an actionable
  // "supply your espn_s2 / SWID" message instead of silently succeeding on
  // borrowed access.
  const headerS2 = typeof req.headers['x-espn-s2'] === 'string'
    ? req.headers['x-espn-s2'].trim()
    : '';
  const headerSwid = typeof req.headers['x-espn-swid'] === 'string'
    ? req.headers['x-espn-swid'].trim()
    : '';

  let stored = null;
  if (!headerS2 || !headerSwid) {
    const context = leagueContextFromTarget(target);
    if (context.leagueId) {
      stored = await getStoredLeagueCookies(context.leagueId, context.seasonYear);
    }
  }

  const espnS2 = headerS2 || String(stored && stored.espn_s2 || '').trim();
  let espnSwid = headerSwid || String(stored && stored.swid || '').trim();

  const cookieParts = [];
  if (espnS2) cookieParts.push('espn_s2=' + espnS2);
  if (espnSwid) {
    if (espnSwid[0] !== '{') espnSwid = '{' + espnSwid.replace(/^\{|\}$/g, '') + '}';
    cookieParts.push('SWID=' + espnSwid);
  }

  const upstreamHeaders = {
    Accept: 'application/json',
    'User-Agent': BROWSER_USER_AGENT,
  };
  const anonymous = cookieParts.length === 0;
  if (!anonymous) upstreamHeaders.Cookie = cookieParts.join('; ');

  // Anonymous reads get a second host to try. ESPN serves public leagues from
  // both hosts, but lm-api-reads is the "league manager" read host and is the
  // one that can answer an uncredentialed request with 401/403 — or, unhelpfully,
  // a bare 404 that is indistinguishable from "no such league". fantasy.espn.com
  // serves the same /apis/v3 path and has historically answered public leagues
  // without cookies, so it is worth one retry before giving up. Only for
  // anonymous requests: a credentialed request must not have the caller's
  // cookies replayed to a second host.
  const candidates = [target.toString()];
  if (anonymous && target.hostname === 'lm-api-reads.fantasy.espn.com') {
    const mirror = new URL(target.toString());
    mirror.hostname = 'fantasy.espn.com';
    candidates.push(mirror.toString());
  }

  // An access failure is either a hard 401/403/404, or ESPN's habit of
  // answering an inaccessible league with 2xx and an auth-error envelope.
  function isAuthEnvelope(payload) {
    return !!(payload && !Array.isArray(payload) && !payload.teams &&
      (Array.isArray(payload.messages) || Array.isArray(payload.details)) &&
      JSON.stringify(payload.messages || payload.details || '')
        .toLowerCase()
        .match(/not authorized|not visible|private|forbidden|denied/));
  }

  try {
    let upstream = null;
    let body = '';
    let payload;
    let parsed = false;
    let authEnvelope = false;
    const diag = [];

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const response = await fetch(candidate, {
        method: 'GET',
        headers: upstreamHeaders,
        redirect: 'follow',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const text = await response.text();
      let json;
      let ok = true;
      try { json = JSON.parse(text); } catch (e) { ok = false; }

      upstream = response;
      body = text;
      payload = json;
      parsed = ok;
      authEnvelope = ok && isAuthEnvelope(json);

      const denied = response.status === 401 || response.status === 403 ||
        response.status === 404 || authEnvelope;
      diag.push({ host: new URL(candidate).hostname, status: response.status, denied });

      if (!denied) break;                      // usable answer — stop here
      if (i === candidates.length - 1) break;  // out of candidates — keep the last
    }

    const denied = upstream.status === 401 || upstream.status === 403 ||
      upstream.status === 404 || authEnvelope;

    // Never let the edge cache a denial or an error.
    res.setHeader('Cache-Control', denied || !upstream.ok
      ? 'no-store'
      : 's-maxage=15, stale-while-revalidate=30');

    // Non-JSON body (an outage page, an Akamai challenge, an HTML error):
    // forward it verbatim with the upstream status so the frontend can report
    // the real failure rather than a generic "could not be loaded".
    if (!parsed) {
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/plain; charset=utf-8');
      return res.status(upstream.status || 502).send(body);
    }

    // An ANONYMOUS request that every candidate denied. ESPN uses 404 here as
    // often as 401 — it does not distinguish "you may not read this league"
    // from "no such league" for an uncredentialed caller. Answering 404 sent
    // the frontend down its "this season does not exist" branch and told the
    // user their league had not renewed, which hid the real, fixable cause.
    // Normalize to 401 so the private-league branch fires, and say plainly
    // that both readings are possible.
    if (anonymous && denied) {
      return res.status(401).json({
        error: 'ESPN would not serve this league without credentials (HTTP ' +
          upstream.status + '). Either the league is private — paste your espn_s2 ' +
          'and SWID from a logged-in ESPN browser into Private League Access — or ' +
          'this League ID has no such season. Public leagues are served without ' +
          'cookies, so if yours is public, check the League ID and season.',
        espn: payload,
        diag,
      });
    }

    // Credentials were supplied and ESPN still refused them.
    if (upstream.status === 401 || upstream.status === 403 || authEnvelope) {
      return res.status(401).json({
        error: 'ESPN rejected the private-league cookies (HTTP ' + upstream.status +
          '). The espn_s2 / SWID values are likely invalid or expired — re-copy them ' +
          'from your logged-in ESPN browser and try again.',
        espn: payload,
        diag,
      });
    }

    return res.status(upstream.status).json(payload);
  } catch (error) {
    console.error('[api/espn] upstream request failed', error);
    return res.status(502).json({ error: 'ESPN upstream request failed' });
  }
};
