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
/* One sanitizer/serializer shared with api/league.js so the relay and the
   cookie-ingestion handler can never disagree about what a valid credential
   looks like. See api/espn-cookies.js for the paste shapes it repairs. */
const { sanitizeCookieValue, buildEspnCookieHeader } = require('./espn-cookies');

const ALLOWED_ESPN_HOSTS = new Set([
  'lm-api-reads.fantasy.espn.com',
  'fantasy.espn.com',
  'site.api.espn.com',
]);

// A realistic desktop Chrome UA. ESPN's read endpoints return empty or
// error shells to unrecognized clients, so we present as a normal browser.
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

module.exports = async function handler(req, res) {
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
  //   1. Per-request headers (the browser's localStorage fallback)
  //   2. Encrypted cookies from public.leagues, decrypted only on the server
  //   3. Deployment-wide ESPN_S2 / ESPN_SWID environment variables
  const headerS2 = typeof req.headers['x-espn-s2'] === 'string'
    ? sanitizeCookieValue('espn_s2', req.headers['x-espn-s2'])
    : '';
  const headerSwid = typeof req.headers['x-espn-swid'] === 'string'
    ? sanitizeCookieValue('SWID', req.headers['x-espn-swid'])
    : '';

  let stored = null;
  if (!headerS2 || !headerSwid) {
    const context = leagueContextFromTarget(target);
    if (context.leagueId) {
      stored = await getStoredLeagueCookies(context.leagueId, context.seasonYear);
    }
  }

  const rawS2 = headerS2 ||
    String(stored && stored.espn_s2 || '') ||
    String(process.env.ESPN_S2 || '');
  const rawSwid = headerSwid ||
    String(stored && stored.swid || '') ||
    String(process.env.ESPN_SWID || '');

  // One serializer for every credential source, so a cookie that arrives from
  // Supabase or an env var is normalized exactly like one from the browser.
  const cookie = buildEspnCookieHeader(rawSwid, rawS2);
  const cookieParts = cookie.count ? [cookie.header] : [];

  // A credential that arrived but did not survive sanitization is the single
  // most confusing private-league failure there is: the request looks
  // authenticated to the caller and anonymous to ESPN. Name it in the logs.
  if ((rawS2 && !cookie.s2) || (rawSwid && !cookie.swid)) {
    console.error('[api/espn] A supplied ESPN credential was dropped as unusable ' +
      '(espn_s2 usable: ' + (!rawS2 || !!cookie.s2) + ', SWID usable: ' + (!rawSwid || !!cookie.swid) +
      '). The upstream read will be treated as anonymous.');
  }

  const upstreamHeaders = {
    Accept: 'application/json',
    'User-Agent': BROWSER_USER_AGENT,
  };
  if (cookie.header) upstreamHeaders.Cookie = cookie.header;

  try {
    const upstream = await fetch(target.toString(), {
      method: 'GET',
      headers: upstreamHeaders,
      redirect: 'follow',
    });

    const body = await upstream.text();

    // This response may have been fetched with per-request, encrypted stored,
    // or deployment-wide ESPN credentials. Never allow an intermediary or the
    // browser to reuse one member's private-league payload for another caller.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    // Parse and return the ESPN JSON payload. The leagueHistory route replies
    // with a top-level array, so we forward whatever JSON shape ESPN sends.
    // If ESPN ever returns a non-JSON body (an outage page, an HTML error),
    // surface it verbatim with the upstream status rather than crashing.
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (parseError) {
      // ESPN (or an edge/CDN in front of it) returned a non-JSON body — an
      // outage page, an Akamai challenge, an HTML error. Forward it verbatim
      // with the upstream status so the frontend can report the real failure
      // rather than a generic "could not be loaded".
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/plain; charset=utf-8');
      return res.status(upstream.status || 502).send(body);
    }

    // ESPN sometimes answers an inaccessible (private / not-visible) league
    // with a 2xx status but an auth-error envelope in the body
    // ({ messages:[...], details:[...] } and no team data). Normalize that to a
    // 401 so the frontend's private-league branch fires with an actionable
    // message instead of silently treating it as "no data".
    const looksLikeAuthError =
      payload && !Array.isArray(payload) && !payload.teams &&
      (Array.isArray(payload.messages) || Array.isArray(payload.details)) &&
      JSON.stringify(payload.messages || payload.details || '')
        .toLowerCase()
        .match(/not authorized|not visible|private|forbidden|denied/);
    if (looksLikeAuthError && upstream.status >= 200 && upstream.status < 400) {
      return res.status(401).json({
        error: cookieParts.length
          ? 'ESPN rejected the private-league cookies. The espn_s2 / SWID values are likely invalid or expired — re-copy them from your logged-in ESPN browser and try again.'
          : 'This ESPN league is private. Supply espn_s2 and SWID cookies (x-espn-s2 / x-espn-swid headers, or ESPN_S2 / ESPN_SWID env vars) so the relay can read it.',
        espn: payload,
      });
    }

    // A hard 401/403 from ESPN carries no useful JSON of its own; attach an
    // actionable hint so the frontend (or any consumer) can guide the user to
    // check their private-league cookies rather than see a bare status code.
    if (upstream.status === 401 || upstream.status === 403) {
      return res.status(upstream.status).json({
        error: cookieParts.length
          ? 'ESPN rejected the private-league cookies (HTTP ' + upstream.status + '). The espn_s2 / SWID values are likely invalid or expired — re-copy them from your logged-in ESPN browser and try again.'
          : 'ESPN denied the request (HTTP ' + upstream.status + '). This league is private — supply espn_s2 and SWID cookies so the relay can read it.',
        espn: payload,
      });
    }

    return res.status(upstream.status).json(payload);
  } catch (error) {
    console.error('[api/espn] upstream request failed', error);
    return res.status(502).json({ error: 'ESPN upstream request failed' });
  }
};
