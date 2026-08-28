/* ============================================================
   VERCEL SERVERLESS SLEEPER PROXY  —  /api/sleeper?url=<sleeperUrl>

   Sleeper's public v1 API (https://api.sleeper.app/v1/...) is read-only and
   already returns permissive CORS headers, so the front-end fetches it
   directly in the common case. This same-origin relay exists only as a
   resilience fallback: some corporate networks, content filters, or ad
   blockers drop requests to api.sleeper.app, and a same-origin route sails
   through those while also letting the edge cache the (immutable) player
   index and completed-season payloads.

   Like the ESPN relay, the target host is restricted to Sleeper's read hosts
   so the proxy can never be repurposed as an open relay for arbitrary URLs.
   No credentials are ever attached — every Sleeper read endpoint is public.
============================================================ */

const ALLOWED_SLEEPER_HOSTS = new Set([
  'api.sleeper.app',
  'sleepercdn.com',
]);

// A realistic desktop Chrome UA, consistent with the ESPN relay.
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function applyCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/* The player index (/v1/players/nfl) is a multi-megabyte, effectively
   immutable blob; completed-season league data never changes either. Cache
   those aggressively at the edge. Live in-season endpoints (matchups for the
   current week, rosters) get a short cache so scores stay fresh. */
function cacheControlFor(target) {
  const path = String(target && target.pathname || '');
  if (/\/players\/nfl$/.test(path)) return 's-maxage=86400, stale-while-revalidate=604800';
  if (/\/state\/nfl$/.test(path)) return 's-maxage=300, stale-while-revalidate=600';
  return 's-maxage=20, stale-while-revalidate=60';
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

  // Extract the target Sleeper URL from req.query.url, falling back to parsing
  // req.url directly so the function still works under `vercel dev`, other
  // hosts, or any runtime that hands us a bare request object.
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
    return res.status(400).json({ error: 'Invalid Sleeper URL' });
  }

  if (target.protocol !== 'https:' || !ALLOWED_SLEEPER_HOSTS.has(target.hostname)) {
    return res.status(400).json({ error: 'Unsupported Sleeper host' });
  }

  try {
    const upstream = await fetch(target.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': BROWSER_USER_AGENT },
      redirect: 'follow',
    });

    const body = await upstream.text();
    res.setHeader('Cache-Control', cacheControlFor(target));

    // Sleeper answers unknown league/roster ids with `null` (HTTP 200) rather
    // than a 404; forward whatever JSON shape it sends. A non-JSON body (an
    // outage page, an edge challenge) is forwarded verbatim with the upstream
    // status so the frontend reports the real failure.
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (parseError) {
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/plain; charset=utf-8');
      return res.status(upstream.status || 502).send(body);
    }

    return res.status(upstream.status).json(payload);
  } catch (error) {
    console.error('[api/sleeper] upstream request failed', error);
    return res.status(502).json({ error: 'Sleeper upstream request failed' });
  }
};
