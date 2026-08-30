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
function espnUrl(season = 2026, league = 57155288) {
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
