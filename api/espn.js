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

  // Extract the target ESPN URL from req.query.url.
  const raw = Array.isArray(req.query && req.query.url)
    ? req.query.url[0]
    : req.query && req.query.url;
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

  // ESPN auth. ESPN's read API returns AUTH_LEAGUE_NOT_VISIBLE to fully
  // anonymous requests even for leagues flagged "viewable to public", so the
  // relay must carry an ESPN identity. Two sources, in precedence order:
  //   1. Per-request headers (x-espn-s2 / x-espn-swid) — a self-hoster or a
  //      member supplying their own cookies from the browser.
  //   2. Server-side env vars ESPN_S2 / ESPN_SWID — the app owner's one-time
  //      credentials, used for EVERY visitor so end users submit nothing. This
  //      is what makes a deployed, downloadable app "just work" with zero
  //      per-user friction.
  const headerS2 = req.headers['x-espn-s2'];
  const headerSwid = req.headers['x-espn-swid'];
  const espnS2 = (typeof headerS2 === 'string' && headerS2.trim())
    ? headerS2.trim()
    : String(process.env.ESPN_S2 || '').trim();
  let espnSwid = (typeof headerSwid === 'string' && headerSwid.trim())
    ? headerSwid.trim()
    : String(process.env.ESPN_SWID || '').trim();

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
  if (cookieParts.length) upstreamHeaders.Cookie = cookieParts.join('; ');

  try {
    const upstream = await fetch(target.toString(), {
      method: 'GET',
      headers: upstreamHeaders,
      redirect: 'follow',
    });

    const body = await upstream.text();

    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');

    // Parse and return the ESPN JSON payload. The leagueHistory route replies
    // with a top-level array, so we forward whatever JSON shape ESPN sends.
    // If ESPN ever returns a non-JSON body (an outage page, an HTML error),
    // surface it verbatim with the upstream status rather than crashing.
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (parseError) {
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/plain; charset=utf-8');
      return res.status(upstream.status).send(body);
    }

    return res.status(upstream.status).json(payload);
  } catch (error) {
    console.error('[api/espn] upstream request failed', error);
    return res.status(502).json({ error: 'ESPN upstream request failed' });
  }
};
