const path = require('path');
const Module = require('module');
const API = '/home/user/MFFU/api';

// Stub ./league so the route loads without @supabase/supabase-js, and so we
// control whether stored per-league cookies exist.
let STORED = null;
const leaguePath = path.join(API, 'league.js');
require.cache[leaguePath] = {
  id: leaguePath, filename: leaguePath, loaded: true, exports: {
    getStoredLeagueCookies: async () => STORED,
  },
};
const handler = require(path.join(API, 'espn.js'));

function mockRes() {
  const r = { statusCode: 200, headers: {}, body: undefined, sent: false };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.sent = true; return r; };
  r.send = (b) => { r.body = b; r.sent = true; return r; };
  r.end = () => { r.sent = true; return r; };
  return r;
}
function espnUrl(season = 2026, league = 1234567) {
  return `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${league}?view=mTeam&view=mSettings`;
}

let CALLS = [];
function installFetch(responder) {
  global.fetch = async (url, opts) => {
    CALLS.push({ host: new URL(url).hostname, cookie: (opts.headers || {}).Cookie || null,
                 hasTimeout: !!opts.signal, accept: (opts.headers||{}).Accept,
                 ua: !!(opts.headers||{})['User-Agent'] });
    const { status, body } = responder(new URL(url).hostname);
    return {
      status, ok: status >= 200 && status < 300,
      headers: { get: () => 'application/json' },
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
}

const TEAMS = { teams: [{ id: 1 }], settings: { name: 'Merge' } };
const AUTH_ENVELOPE = { messages: ['You are not authorized to view this League.'] };
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + JSON.stringify(extra) : '')); }
}

(async () => {
  // 1. Public league that lm-api-reads refuses anonymously, mirror serves it.
  CALLS = []; STORED = null;
  installFetch(h => h === 'lm-api-reads.fantasy.espn.com' ? { status: 404, body: {} } : { status: 200, body: TEAMS });
  let res = mockRes();
  await handler({ method: 'GET', headers: {}, query: { url: espnUrl() }, url: '/api/espn' }, res);
  check('1 anon: falls back to fantasy.espn.com and returns 200', res.statusCode === 200, { s: res.statusCode });
  check('1 anon: payload has teams', !!(res.body && res.body.teams));
  check('1 anon: both hosts tried', CALLS.length === 2 && CALLS[1].host === 'fantasy.espn.com', CALLS.map(c=>c.host));
  check('1 anon: NO Cookie header sent', CALLS.every(c => c.cookie === null));
  check('1 anon: Accept + UA present', CALLS.every(c => c.accept === 'application/json' && c.ua));
  check('1 anon: upstream fetch is bounded', CALLS.every(c => c.hasTimeout));

  // 2. Genuinely unreachable anonymously on both hosts.
  CALLS = []; installFetch(() => ({ status: 404, body: {} }));
  res = mockRes();
  await handler({ method: 'GET', headers: {}, query: { url: espnUrl() }, url: '/api/espn' }, res);
  check('2 anon+denied: returns 401 not 404', res.statusCode === 401, { s: res.statusCode });
  check('2 anon+denied: message names both causes',
    /private/i.test(res.body.error) && /no such season/i.test(res.body.error), res.body && res.body.error);
  check('2 anon+denied: diag lists both attempts', res.body.diag && res.body.diag.length === 2);
  check('2 anon+denied: not edge-cached', res.headers['cache-control'] === 'no-store');

  // 3. Public league served on the first host - no pointless second call.
  CALLS = []; installFetch(() => ({ status: 200, body: TEAMS }));
  res = mockRes();
  await handler({ method: 'GET', headers: {}, query: { url: espnUrl() }, url: '/api/espn' }, res);
  check('3 anon+ok: 200 on first host', res.statusCode === 200);
  check('3 anon+ok: only one upstream call', CALLS.length === 1, CALLS.length);
  check('3 anon+ok: edge-cacheable', /s-maxage/.test(res.headers['cache-control'] || ''));

  // 4. Credentialed request that ESPN rejects - cookies must not be replayed.
  CALLS = []; installFetch(() => ({ status: 401, body: {} }));
  res = mockRes();
  await handler({ method: 'GET', headers: { 'x-espn-s2': 'AEBxyz', 'x-espn-swid': '{ABC}' },
                  query: { url: espnUrl() }, url: '/api/espn' }, res);
  check('4 creds+401: returns 401', res.statusCode === 401);
  check('4 creds+401: says cookies rejected', /rejected the private-league cookies/i.test(res.body.error));
  check('4 creds+401: only ONE host tried (no cookie replay)', CALLS.length === 1, CALLS.map(c=>c.host));
  check('4 creds+401: Cookie header was sent', CALLS[0].cookie && CALLS[0].cookie.includes('espn_s2=AEBxyz'));

  // 5. 2xx auth envelope anonymously -> should still fall back and recover.
  CALLS = []; installFetch(h => h === 'lm-api-reads.fantasy.espn.com'
    ? { status: 200, body: AUTH_ENVELOPE } : { status: 200, body: TEAMS });
  res = mockRes();
  await handler({ method: 'GET', headers: {}, query: { url: espnUrl() }, url: '/api/espn' }, res);
  check('5 anon+authEnvelope: recovers via mirror', res.statusCode === 200 && !!res.body.teams, { s: res.statusCode });

  // 6. Owner env credentials must never be used.
  process.env.ESPN_S2 = 'OWNER_SECRET_S2';
  process.env.ESPN_SWID = '{OWNER-SWID}';
  CALLS = []; installFetch(() => ({ status: 200, body: TEAMS }));
  res = mockRes();
  await handler({ method: 'GET', headers: {}, query: { url: espnUrl() }, url: '/api/espn' }, res);
  check('6 env creds set: still NO Cookie header (owner protected)', CALLS.every(c => c.cookie === null), CALLS.map(c=>c.cookie));
  delete process.env.ESPN_S2; delete process.env.ESPN_SWID;

  // 7. Stored per-league cookies still work (the documented feature).
  STORED = { espn_s2: 'STORED_S2', swid: '{STORED}' };
  CALLS = []; installFetch(() => ({ status: 200, body: TEAMS }));
  res = mockRes();
  await handler({ method: 'GET', headers: {}, query: { url: espnUrl() }, url: '/api/espn' }, res);
  check('7 stored cookies are used', CALLS[0].cookie && CALLS[0].cookie.includes('STORED_S2'), CALLS[0].cookie);
  check('7 stored cookies: no mirror fallback (credentialed)', CALLS.length === 1);

  // 8. Public league, season not rolled over yet. Both hosts 404 the requested
  //    season, but the PRIOR season reads publicly -> that is not a private
  //    league and not a bad ID, and the message must say so.
  STORED = null;
  CALLS = [];
  installFetch(() => ({ status: 404, body: {} }));
  global.fetch = (url, opts) => {
    const u = new URL(url);
    CALLS.push({ host: u.hostname, url, cookie: (opts.headers || {}).Cookie || null });
    const priorSeason = /\/seasons\/2025\//.test(u.pathname);
    const status = priorSeason ? 200 : 404;
    const body = priorSeason ? TEAMS : {};
    return Promise.resolve({
      status, ok: status >= 200 && status < 300,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(body),
    });
  };
  res = mockRes();
  await handler({ method: 'GET', headers: {}, query: { url: espnUrl(2026) }, url: '/api/espn' }, res);
  check('8 season-not-rolled-over: 404, not a bogus 401', res.statusCode === 404, { s: res.statusCode });
  check('8 season-not-rolled-over: machine-readable reason',
    res.body.reason === 'season-not-available', res.body && res.body.reason);
  check('8 season-not-rolled-over: names the season and the one that does work',
    res.body.season === 2026 && res.body.priorSeasonAvailable === 2025, res.body);
  check('8 season-not-rolled-over: does NOT blame the user or ask for cookies',
    !/espn_s2|SWID|private/i.test(res.body.error), res.body.error);
  check('8 season-not-rolled-over: probe ran against the prior season',
    CALLS.some(c => /\/seasons\/2025\//.test(c.url)), CALLS.map(c => c.url));
  check('8 season-not-rolled-over: probe stayed anonymous', CALLS.every(c => c.cookie === null));
  check('8 season-not-rolled-over: no raw ESPN payload echoed back',
    res.body.espn === undefined, Object.keys(res.body));

  // 9. Prior season is ALSO unreadable -> genuinely ambiguous, keep the
  //    actionable private-league message rather than guessing.
  CALLS = []; installFetch(() => ({ status: 404, body: {} }));
  res = mockRes();
  await handler({ method: 'GET', headers: {}, query: { url: espnUrl(2026) }, url: '/api/espn' }, res);
  check('9 ambiguous 404: falls back to the 401 private-league message', res.statusCode === 401, { s: res.statusCode });
  check('9 ambiguous 404: still names both causes',
    /private/i.test(res.body.error) && /no such season/i.test(res.body.error), res.body.error);

  // 10. Credentialed 404: access is fine, the season is not there.
  CALLS = []; installFetch(() => ({ status: 404, body: { messages: ['internal detail'] } }));
  res = mockRes();
  await handler({ method: 'GET', headers: { 'x-espn-s2': 'AEBxyz', 'x-espn-swid': '{ABC}' },
                  query: { url: espnUrl(2026) }, url: '/api/espn' }, res);
  check('10 creds+404: 404 with a plain explanation', res.statusCode === 404 && res.body.reason === 'season-not-available',
    { s: res.statusCode, r: res.body.reason });
  check('10 creds+404: no raw upstream payload forwarded',
    res.body.espn === undefined && !/internal detail/.test(JSON.stringify(res.body)), res.body);
  check('10 creds+404: no prior-season probe on a credentialed request',
    CALLS.every(c => !/\/seasons\/2025\//.test(c.url || '')), CALLS.length);

  // 11. Upstream HTML/outage page must never reach the client verbatim.
  CALLS = []; installFetch(() => ({ status: 500, body: '<html><body>Error: at Object.handler (/var/task/index.js:88:11)</body></html>' }));
  res = mockRes();
  await handler({ method: 'GET', headers: {}, query: { url: espnUrl() }, url: '/api/espn' }, res);
  check('11 non-JSON upstream: 502 JSON, not the raw body', res.statusCode === 502 && typeof res.body === 'object',
    { s: res.statusCode, t: typeof res.body });
  check('11 non-JSON upstream: no stack trace leaked',
    !/\/var\/task|<html/i.test(JSON.stringify(res.body)), res.body);

  // 12. Upstream 5xx JSON is summarised, not forwarded.
  CALLS = []; installFetch(() => ({ status: 503, body: { trace: 'espn-internal-abc123' } }));
  res = mockRes();
  await handler({ method: 'GET', headers: {}, query: { url: espnUrl() }, url: '/api/espn' }, res);
  check('12 upstream 5xx: 502 with a friendly message', res.statusCode === 502 && res.body.reason === 'upstream-error',
    { s: res.statusCode, r: res.body.reason });
  check('12 upstream 5xx: internal trace not echoed',
    !/espn-internal-abc123/.test(JSON.stringify(res.body)), res.body);

  // 13. Network failure surfaces as a timeout/unreachable message, no stack.
  CALLS = [];
  global.fetch = async () => { const e = new Error('getaddrinfo ENOTFOUND lm-api-reads.fantasy.espn.com'); e.name = 'TimeoutError'; throw e; };
  res = mockRes();
  await handler({ method: 'GET', headers: {}, query: { url: espnUrl() }, url: '/api/espn' }, res);
  check('13 transport failure: 504 with a timeout reason', res.statusCode === 504 && res.body.reason === 'upstream-timeout',
    { s: res.statusCode, r: res.body.reason });
  check('13 transport failure: no internal error text leaked',
    !/ENOTFOUND|getaddrinfo/.test(JSON.stringify(res.body)), res.body);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
