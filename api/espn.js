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

/* ------------------------------------------------------------
   WHO MAY BORROW ANOTHER MEMBER'S STORED COOKIES

   When a caller supplies no credentials of its own, this relay falls back to
   the encrypted cookies a member of that league saved earlier. That is a real
   product feature — one commissioner pastes their cookies and the rest of the
   league reads the private league without pasting anything — but it makes the
   relay a deputy that acts with somebody else's ESPN session, and the only
   thing the caller has to present is the numeric league id, which league-mates
   share openly.

   This does not close that gap; only a per-league share secret or per-member
   cookies can (see the audit note). What it does remove is the cheapest form
   of abuse: the fallback now runs only for requests that actually came from
   an FSN page. A third-party site can no longer read a private league through
   a plain <img>/fetch to this endpoint, because the browser stamps its own
   Origin and it will not be on this list.

   A scripted caller can forge either header, so this is defence in depth, not
   authentication. Requests carrying their own x-espn-s2 / x-espn-swid are
   unaffected — those are the caller's own credentials, not a borrowed grant.
------------------------------------------------------------ */
const FIRST_PARTY_HOSTS = new Set([
  'fantasysportsnetwork.app',
  'www.fantasysportsnetwork.app',
  'app.fantasysportsnetwork.app',
  'localhost',
  '127.0.0.1',
]);

function hostOf(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase();
  } catch (error) {
    return '';
  }
}

function isFirstPartyRequest(req) {
  const headers = (req && req.headers) || {};
  const origin = String(headers.origin || '');
  const referer = String(headers.referer || headers.referrer || '');
  const self = String(headers.host || '').toLowerCase().split(':')[0];

  // A cross-origin browser request always carries Origin; a same-origin GET
  // usually carries only Referer. Either matching is enough.
  const candidates = [hostOf(origin), hostOf(referer)].filter(Boolean);
  if (!candidates.length) {
    // No Origin and no Referer. A same-origin fetch from the app always sends
    // one of them, so this is a bare script, a curl, or a stripped proxy —
    // exactly the caller this fallback should not lend credentials to.
    return false;
  }
  return candidates.some(function (host) {
    // Match the deployment's own host too, so preview deployments and any
    // future domain work without editing this list.
    return FIRST_PARTY_HOSTS.has(host) || (!!self && host === self);
  });
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

  // Sanitization above collapses an unusable header to '', which then falls
  // through the precedence chain below and looks identical to "no header was
  // sent". Record that a header WAS present here, while we can still tell, so
  // the alarm further down can fire for the case its message describes — a
  // reader who pasted a credential and is about to get an anonymous read.
  const headerS2Present = typeof req.headers['x-espn-s2'] === 'string' && !!String(req.headers['x-espn-s2']).trim();
  const headerSwidPresent = typeof req.headers['x-espn-swid'] === 'string' && !!String(req.headers['x-espn-swid']).trim();

  let stored = null;
  if (!headerS2 || !headerSwid) {
    const context = leagueContextFromTarget(target);
    if (context.leagueId) {
      if (isFirstPartyRequest(req)) {
        stored = await getStoredLeagueCookies(context.leagueId, context.seasonYear);
      } else {
        // Named in the logs rather than silently degraded, because from the
        // caller's side this is indistinguishable from "the league has no
        // saved cookies" — and if it ever fires for a real reader, the host
        // allowlist above is what needs updating.
        console.warn('[api/espn] Declining to replay stored league cookies for a request that did not ' +
          'come from an FSN page (origin: ' + (req.headers.origin || 'none') +
          ', referer host: ' + (hostOf(req.headers.referer || '') || 'none') +
          '). The read continues anonymously.');
      }
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
  // buildEspnCookieHeader returns the sanitized value on `.espn_s2`, not `.s2`.
  // Reading the wrong property made this condition true for EVERY request that
  // carried an espn_s2 — so the one alarm that says "a good-looking credential
  // did not survive sanitization" fired on every successful private-league read
  // instead, which is the fastest way to train an operator to ignore it.
  const s2Usable = !!cookie.espn_s2;
  const swidUsable = !!cookie.swid;
  const s2Supplied = headerS2Present || !!rawS2;
  const swidSupplied = headerSwidPresent || !!rawSwid;
  if ((s2Supplied && !s2Usable) || (swidSupplied && !swidUsable)) {
    console.error('[api/espn] A supplied ESPN credential was dropped as unusable ' +
      '(espn_s2 usable: ' + (!s2Supplied || s2Usable) + ', SWID usable: ' + (!swidSupplied || swidUsable) +
      '). The upstream read will be treated as anonymous.' +
      (cookie.reason ? ' Reason: ' + cookie.reason : ''));
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
