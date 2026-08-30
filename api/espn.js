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

// ESPN answers an uncredentialed read of a league it will not serve with a
// bare 404 — the same status it uses for "this league has no such season". The
// two need very different advice, so when an anonymous read 404s we ask ESPN
// one cheap follow-up question: can this same league be read publicly for the
// PREVIOUS season? If yes, the League ID is right and public, and the only
// thing missing is the season itself (ESPN has not rolled the league over yet).
// One lightweight view is all the probe needs.
function priorSeasonProbeUrl(target) {
  const url = new URL(target.toString());
  const inPath = url.pathname.match(/\/seasons\/(\d{4})\//);
  let season;
  if (inPath) {
    season = Number(inPath[1]);
    url.pathname = url.pathname.replace(/\/seasons\/\d{4}\//, '/seasons/' + (season - 1) + '/');
  } else {
    season = Number(url.searchParams.get('seasonId'));
    if (!Number.isInteger(season)) return null;
    url.searchParams.set('seasonId', String(season - 1));
  }
  if (!Number.isInteger(season) || season < 1900) return null;
  url.searchParams.delete('view');
  url.searchParams.append('view', 'mTeam');
  url.searchParams.delete('scoringPeriodId');
  url.searchParams.delete('matchupPeriodId');
  return { url: url.toString(), season, priorSeason: season - 1 };
}

function payloadHasTeams(payload) {
  if (Array.isArray(payload)) return payload.some(payloadHasTeams);
  return !!(payload && Array.isArray(payload.teams) && payload.teams.length);
}

// Is this league publicly readable for the season before the one asked for?
// Never throws: an inconclusive probe just means we fall back to the ambiguous
// (and still actionable) private-league message.
async function priorSeasonIsPublic(probe, headers) {
  try {
    const response = await fetch(probe.url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    return payloadHasTeams(JSON.parse(await response.text()));
  } catch (error) {
    return false;
  }
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

    // Non-JSON body (an outage page, an Akamai challenge, an HTML error, a
    // stack trace from something in front of ESPN). This used to be forwarded
    // verbatim, which put raw upstream markup straight into the app's status
    // line. Report what happened and keep the body in the server log.
    if (!parsed) {
      console.warn('[api/espn] non-JSON upstream body', {
        status: upstream.status,
        contentType: upstream.headers.get('content-type') || null,
        preview: String(body || '').slice(0, 500),
      });
      return res.status(502).json({
        error: 'ESPN returned a non-JSON response (HTTP ' + upstream.status + '). ' +
          'That is usually a temporary ESPN outage or a block page rather than a problem ' +
          'with your League ID — wait a moment and try again.',
        reason: 'upstream-not-json',
        upstreamStatus: upstream.status,
        diag,
      });
    }

    // An ANONYMOUS request that every candidate denied. ESPN uses 404 here as
    // often as 401 — it does not distinguish "you may not read this league"
    // from "no such league" for an uncredentialed caller. Answering 404 sent
    // the frontend down its "this season does not exist" branch and told the
    // user their league had not renewed, which hid the real, fixable cause.
    // Normalize to 401 so the private-league branch fires, and say plainly
    // that both readings are possible.
    if (anonymous && denied) {
      // A 404 is the ambiguous one. Ask ESPN whether the SAME league reads
      // publicly for the previous season: if it does, the ID is right and
      // public, and the only thing missing is this season itself. That turns a
      // dead end into "your league has not rolled over yet".
      if (upstream.status === 404) {
        const probe = priorSeasonProbeUrl(target);
        if (probe && await priorSeasonIsPublic(probe, upstreamHeaders)) {
          const context = leagueContextFromTarget(target);
          const label = context.leagueId ? 'League ID ' + context.leagueId : 'this league';
          return res.status(404).json({
            error: 'ESPN has no ' + probe.season + ' season for ' + label + ' yet. The ID is ' +
              'correct and the league is public — ESPN served its ' + probe.priorSeason + ' season ' +
              'fine — so there is nothing to fix here. ESPN simply has not created the ' +
              probe.season + ' season for this league. It appears once your league renews for ' +
              probe.season + '; until then you can still load ' + probe.priorSeason + ' and earlier.',
            reason: 'season-not-available',
            season: probe.season,
            priorSeasonAvailable: probe.priorSeason,
            diag,
          });
        }
      }
      return res.status(401).json({
        error: 'ESPN would not serve this league without credentials (HTTP ' +
          upstream.status + '). Either the league is private — paste your espn_s2 ' +
          'and SWID from a logged-in ESPN browser into Private League Access — or ' +
          'this League ID has no such season. Public leagues are served without ' +
          'cookies, so if yours is public, check the League ID and season.',
        reason: 'league-unreadable-anonymously',
        diag,
      });
    }

    // Credentials were supplied and ESPN still refused them.
    if (upstream.status === 401 || upstream.status === 403 || authEnvelope) {
      return res.status(401).json({
        error: 'ESPN rejected the private-league cookies (HTTP ' + upstream.status +
          '). The espn_s2 / SWID values are likely invalid or expired — re-copy them ' +
          'from your logged-in ESPN browser and try again.',
        reason: 'cookies-rejected',
        diag,
      });
    }

    // Credentials were accepted but the season itself is not there. With valid
    // cookies a 404 is unambiguous, so say so plainly instead of handing the
    // frontend ESPN's raw error payload to render.
    if (upstream.status === 404) {
      const context = leagueContextFromTarget(target);
      const season = context.seasonYear;
      return res.status(404).json({
        error: season
          ? 'ESPN has no ' + season + ' season for this league. Your access is fine — the ' +
            'season just does not exist on ESPN yet. It shows up once the league renews for ' +
            season + '; earlier seasons still load normally.'
          : 'ESPN has no data at that address for this league (HTTP 404). Check the League ID and season.',
        reason: 'season-not-available',
        season: season || undefined,
        diag,
      });
    }

    if (!upstream.ok) {
      console.warn('[api/espn] upstream error status', upstream.status);
      return res.status(502).json({
        error: 'ESPN returned HTTP ' + upstream.status + ' for this league. That is an ESPN-side ' +
          'error rather than a problem with your League ID — try again in a moment.',
        reason: 'upstream-error',
        upstreamStatus: upstream.status,
        diag,
      });
    }

    return res.status(upstream.status).json(payload);
  } catch (error) {
    // The message and stack stay in the server log; the client gets a sentence
    // it can act on and nothing about our internals.
    console.error('[api/espn] upstream request failed', error);
    const timedOut = !!(error && (error.name === 'TimeoutError' || error.name === 'AbortError'));
    return res.status(504).json({
      error: timedOut
        ? 'ESPN did not answer within ' + Math.round(UPSTREAM_TIMEOUT_MS / 1000) + ' seconds. ' +
          'ESPN is slow or unreachable right now — try again in a moment.'
        : 'Could not reach ESPN. This is an ESPN or network problem, not a problem with your ' +
          'League ID — try again in a moment.',
      reason: timedOut ? 'upstream-timeout' : 'upstream-unreachable',
    });
  }
};
