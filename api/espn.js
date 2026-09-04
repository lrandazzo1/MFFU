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
const { buildEspnCookieHeader } = require('./espn-cookies');

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

/* ============================================================
   PUBLIC / PRIVATE CREDENTIAL RESOLUTION

   Every ESPN read this relay makes is one of exactly two things, and it has to
   commit to which BEFORE it builds a single header:

     public   No usable credential pair exists for this read. ESPN's league and
              leagueHistory endpoints serve a public league to an anonymous
              request perfectly well — and answer a request carrying a stranger's
              session with the private-league envelope, which this relay
              normalizes to a 401. A public read therefore sends NO Cookie
              header at all: not an empty one, not a partial one, none.

     private  A COMPLETE SWID + espn_s2 pair exists. It is attached sanitized,
              and a refusal from ESPN is a real credential verdict worth
              reporting to the reader as one.

   Two rules keep the two modes from contaminating each other:

   1. A credential pair is resolved atomically from ONE source. The previous
      `header || stored || env` chain resolved each cookie independently, so a
      reader who had pasted only a SWID got that SWID paired with an espn_s2
      belonging to a different ESPN account. ESPN refuses such a pair every
      time, and the caller reads the refusal as "your cookies expired".

   2. Sources are ordered most-specific first, and the least specific one is
      not trusted to be relevant:

        request         x-espn-s2 / x-espn-swid — this reader's own cookies
        league-store    the encrypted envelope stored for THIS league id
        deployment-env  ESPN_S2 / ESPN_SWID — a deployment-wide fallback that
                        is scoped to no league at all. See the anonymous retry
                        in the handler: a read refused with these is retried
                        without them, because a PUBLIC league must never fail
                        merely because the relay volunteered someone else's
                        session for it.
============================================================ */
const CREDENTIAL_SOURCES = {
  request: 'per-request x-espn-* headers',
  'league-store': 'the stored cookie envelope for this league',
  'deployment-env': 'the deployment-wide ESPN_S2 / ESPN_SWID variables',
};

function credentialPair(source, swidRaw, s2Raw) {
  const built = buildEspnCookieHeader(swidRaw, s2Raw);
  return {
    source: source,
    label: CREDENTIAL_SOURCES[source] || source,
    header: built.header,
    swid: built.swid,
    espn_s2: built.espn_s2,
    /* Both halves, or it is not a credential. ESPN authenticates on the pair. */
    complete: !!(built.swid && built.espn_s2),
    faults: built.faults,
    reason: built.reason,
  };
}

/* Returns { mode:'public'|'private', pair, rejected[] }. `rejected` holds every
   source that supplied something unusable, so the handler can name it in the
   logs instead of leaving a silently anonymous read behind. */
async function resolveEspnCredentials(req, target) {
  const rejected = [];

  const consider = (pair) => {
    if (pair.complete) return pair;
    // Something was supplied for this source and did not survive; remember why.
    if (pair.faults.length || pair.swid || pair.espn_s2) rejected.push(pair);
    return null;
  };

  const headers = (req && req.headers) || {};
  const rawHeaderS2 = typeof headers['x-espn-s2'] === 'string' ? headers['x-espn-s2'] : '';
  const rawHeaderSwid = typeof headers['x-espn-swid'] === 'string' ? headers['x-espn-swid'] : '';
  if (rawHeaderS2 || rawHeaderSwid) {
    const pair = consider(credentialPair('request', rawHeaderSwid, rawHeaderS2));
    if (pair) return { mode: 'private', pair: pair, rejected: rejected };
  }

  const context = leagueContextFromTarget(target);
  if (context.leagueId) {
    // getStoredLeagueCookies already swallows its own storage failures and
    // returns null unless BOTH cookies decrypted, so an unconfigured or
    // unreachable Supabase can never turn a public read into an error.
    const stored = await getStoredLeagueCookies(context.leagueId, context.seasonYear);
    if (stored) {
      const pair = consider(credentialPair('league-store', stored.swid, stored.espn_s2));
      if (pair) return { mode: 'private', pair: pair, rejected: rejected };
    }
  }

  if (process.env.ESPN_S2 || process.env.ESPN_SWID) {
    const pair = consider(credentialPair('deployment-env', process.env.ESPN_SWID, process.env.ESPN_S2));
    if (pair) return { mode: 'private', pair: pair, rejected: rejected };
  }

  return { mode: 'public', pair: null, rejected: rejected };
}

/* ESPN sometimes answers an inaccessible (private / not-visible) league with a
   2xx status and an auth-error envelope in the body — { messages:[...],
   details:[...] } and no team data — rather than a 401. */
function looksLikeEspnAuthEnvelope(payload) {
  return !!(
    payload && !Array.isArray(payload) && !payload.teams &&
    (Array.isArray(payload.messages) || Array.isArray(payload.details)) &&
    JSON.stringify(payload.messages || payload.details || '')
      .toLowerCase()
      .match(/not authorized|not visible|private|forbidden|denied/)
  );
}

/* One upstream read. Returns the response, its raw body, the parsed payload
   (null when ESPN sent a non-JSON body), and whether ESPN refused the identity
   the request carried — by hard status or by the 2xx envelope above. */
async function readEspnUpstream(url, cookieHeader) {
  const upstreamHeaders = {
    Accept: 'application/json',
    'User-Agent': BROWSER_USER_AGENT,
  };
  // A public read carries no Cookie header at all. Never an empty string, and
  // never a half-built "SWID=undefined; espn_s2=null" — ESPN answers those with
  // a 400/401 that reads to every caller as a credential problem.
  if (cookieHeader) upstreamHeaders.Cookie = cookieHeader;

  const upstream = await fetch(url, {
    method: 'GET',
    headers: upstreamHeaders,
    redirect: 'follow',
  });
  const body = await upstream.text();

  let payload = null;
  let parsed = true;
  try {
    payload = JSON.parse(body);
  } catch (parseError) {
    // Not swallowed: `parsed` carries the failure to the caller, which forwards
    // the body verbatim with the upstream status. Log it anyway — a non-JSON
    // reply from ESPN (an outage page, an Akamai challenge) is the one thing
    // that looks identical to "the league is empty" from the browser.
    parsed = false;
    console.warn('[api/espn] ESPN returned a non-JSON body for ' + url +
      ' (HTTP ' + upstream.status + '); forwarding it verbatim.', parseError);
  }

  const hardRefusal = upstream.status === 401 || upstream.status === 403;
  const envelopeRefusal = parsed && looksLikeEspnAuthEnvelope(payload) &&
    upstream.status >= 200 && upstream.status < 400;

  return {
    upstream: upstream,
    body: body,
    payload: payload,
    parsed: parsed,
    refused: hardRefusal || envelopeRefusal,
    envelopeRefusal: envelopeRefusal,
  };
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

  // Commit to public or private BEFORE a header is built. See the credential
  // resolution block above for why the pair is atomic and source-tagged.
  let creds = await resolveEspnCredentials(req, target);

  // A credential that arrived but did not survive resolution is the single most
  // confusing private-league failure there is: the request looks authenticated
  // to the caller and anonymous to ESPN. Name every one of them.
  creds.rejected.forEach(function (pair) {
    const detail = pair.reason
      ? ' — ' + pair.reason
      : ' — only ' + (pair.swid ? 'SWID' : 'espn_s2') + ' was supplied and ESPN authenticates on the pair';
    const message = '[api/espn] Ignoring the credentials from ' + pair.label + detail +
      '. They will NOT be attached to this read.';
    // A value that failed sanitization is a real defect a reader can fix; an
    // incomplete pair from the deployment variables is a deploy-config gap.
    if (pair.faults.length) console.error(message);
    else console.warn(message);
  });

  try {
    let read = await readEspnUpstream(target.toString(), creds.pair ? creds.pair.header : '');

    /* The deployment-wide ESPN_S2 / ESPN_SWID pair is the one credential source
       tied to no particular league — it belongs to whoever configured the
       deployment. ESPN answers a request carrying a session that is not a
       member of the requested league with the same private-league envelope it
       uses for a genuinely private one, so a PUBLIC league would fail here with
       a credential verdict purely because the relay volunteered a stranger's
       cookies. Drop them and read it the way a public league is meant to be
       read: anonymously, with no Cookie header.

       Reader-supplied and league-scoped stored cookies are never retried this
       way. Those are about THIS reader and THIS league, so their refusal is the
       real answer and must reach the caller intact. */
    if (read.refused && creds.mode === 'private' && creds.pair.source === 'deployment-env') {
      console.warn('[api/espn] ESPN refused ' + target.pathname + ' while carrying the deployment-wide ' +
        'ESPN_S2 / ESPN_SWID session (HTTP ' + read.upstream.status + '). Those cookies are not scoped to ' +
        'this league; retrying anonymously so a public league is not blocked behind them.');
      const anonymous = await readEspnUpstream(target.toString(), '');
      if (!anonymous.refused) {
        read = anonymous;
        creds = { mode: 'public', pair: null, rejected: creds.rejected };
      } else {
        console.warn('[api/espn] The anonymous retry of ' + target.pathname + ' was refused too (HTTP ' +
          anonymous.upstream.status + '); this league really does require credentials.');
      }
    }

    const upstream = read.upstream;
    const payload = read.payload;
    // Whether the response ESPN actually returned was authenticated. Every
    // reader-facing message below keys off this, so a public read can never be
    // told its cookies were rejected — it never sent any.
    const authenticated = creds.mode === 'private';

    // This response may have been fetched with per-request, encrypted stored,
    // or deployment-wide ESPN credentials. Never allow an intermediary or the
    // browser to reuse one member's private-league payload for another caller.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    // Parse and return the ESPN JSON payload. The leagueHistory route replies
    // with a top-level array, so we forward whatever JSON shape ESPN sends.
    // If ESPN ever returns a non-JSON body (an outage page, an Akamai
    // challenge, an HTML error), surface it verbatim with the upstream status
    // so the frontend can report the real failure rather than crashing.
    if (!read.parsed) {
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/plain; charset=utf-8');
      return res.status(upstream.status || 502).send(read.body);
    }

    // A 2xx auth envelope is normalized to a 401 so the frontend's
    // private-league branch fires with an actionable message instead of
    // silently treating an inaccessible league as "no data".
    if (read.envelopeRefusal) {
      return res.status(401).json({
        error: authenticated
          ? 'ESPN rejected the private-league cookies. The espn_s2 / SWID values are likely invalid or expired — re-copy them from your logged-in ESPN browser and try again.'
          : 'This ESPN league is private. Supply espn_s2 and SWID cookies (x-espn-s2 / x-espn-swid headers, or ESPN_S2 / ESPN_SWID env vars) so the relay can read it.',
        espn: payload,
        auth: authenticated ? 'private' : 'public',
      });
    }

    // A hard 401/403 from ESPN carries no useful JSON of its own; attach an
    // actionable hint so the frontend (or any consumer) can guide the user to
    // check their private-league cookies rather than see a bare status code.
    if (upstream.status === 401 || upstream.status === 403) {
      return res.status(upstream.status).json({
        error: authenticated
          ? 'ESPN rejected the private-league cookies (HTTP ' + upstream.status + '). The espn_s2 / SWID values are likely invalid or expired — re-copy them from your logged-in ESPN browser and try again.'
          : 'ESPN denied the anonymous request (HTTP ' + upstream.status + '). Either this league is private — supply espn_s2 and SWID cookies so the relay can read it — or this season is not served on this endpoint.',
        espn: payload,
        auth: authenticated ? 'private' : 'public',
      });
    }

    return res.status(upstream.status).json(payload);
  } catch (error) {
    console.error('[api/espn] upstream request failed', error);
    return res.status(502).json({ error: 'ESPN upstream request failed' });
  }
};
