// Run with: node --test scripts/yahoo-callback-check.cjs
// Exercise both real route modules with Yahoo and Supabase isolated at the boundary.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const redirectUri = 'https://app.fantasysportsnetwork.app/api/auth/yahoo/callback';

function harness({ rejectToken = false, failStorage = false } = {}) {
  const calls = [], rows = [], logs = [];
  const env = {
    YAHOO_CLIENT_ID: 'test-client', YAHOO_CLIENT_SECRET: 'test-secret',
    YAHOO_REDIRECT_URI: redirectUri, YAHOO_TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
    SUPABASE_URL: 'https://database.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test-service',
  };
  const client = { from(table) { return {
    upsert(row) { rows.push({ table, row }); return { select() { return { async single() {
      return { data: { yahoo_user_id: 'test-user' }, error: failStorage ? new Error('storage unavailable') : null };
    } }; } }; },
    async insert(row) { rows.push({ table, row }); return { error: null }; },
  }; } };
  function load(file, requireFn) {
    const module = { exports: {} };
    vm.runInNewContext(readFileSync(path.join(root, file), 'utf8'), {
      module, exports: module.exports, require: requireFn, process: { env },
      Buffer, URL, URLSearchParams,
      console: { error: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
      fetch: async (url, options) => {
        calls.push({ url, options });
        return { ok: !rejectToken, status: rejectToken ? 400 : 200, text: async () => JSON.stringify(
          rejectToken ? { error: 'invalid_grant' } : {
            access_token: 'test-access', refresh_token: 'test-refresh',
            xoauth_yahoo_guid: 'test-user', expires_in: 3600,
          }) };
      },
    }, { filename: file });
    return module.exports;
  }
  const auth = load('api/auth/yahoo.js', name => name === '@supabase/supabase-js' ? { createClient: () => client } : require(name));
  const callback = load('api/auth/yahoo/callback.js', name => {
    assert.equal(name, '../yahoo.js'); return auth;
  });
  async function invoke(handler, query, cookie = '', method = 'GET') {
    const res = {
      headers: {}, statusCode: 200,
      setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
      status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; },
      redirect(code, url) { this.statusCode = code; this.headers.Location = url; return this; },
    };
    await handler({ method, query, headers: { host: 'app.fantasysportsnetwork.app', cookie } }, res);
    return res;
  }
  return { auth, callback, invoke, calls, rows, logs, env };
}
const cookie = 'fsn_yahoo_oauth_state=valid-state; fsn_yahoo_oauth_return=%2F%3Fgoto%3Dsetup%26platform%3Dyahoo';

test('start redirects to dedicated callback; redirect exchanges code and stores only encrypted tokens', async () => {
  const h = harness();
  const start = await h.invoke(h.auth, { action: 'start' });
  const authorize = new URL(start.headers.Location);
  assert.equal(authorize.searchParams.get('redirect_uri'), redirectUri);
  const state = authorize.searchParams.get('state');
  const cookies = start.headers['Set-Cookie'].map(line => line.split(';')[0]).join('; ');
  const res = await h.invoke(h.callback, { code: 'code+with/special=value', state, action: 'start' }, cookies);
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.Location, /yahoo=connected/);
  assert.equal(h.calls.length, 1);
  const { url, options } = h.calls[0];
  assert.equal(url, 'https://api.login.yahoo.com/oauth2/get_token');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from('test-client:test-secret').toString('base64'));
  assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(options.body);
  assert.equal(form.get('code'), 'code+with/special=value');
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('redirect_uri'), redirectUri);
  const tokens = h.rows.find(r => r.table === 'yahoo_oauth_tokens').row;
  for (const [field, expected] of [['access_token', 'test-access'], ['refresh_token', 'test-refresh']]) {
    const e = tokens[field];
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(h.env.YAHOO_TOKEN_ENCRYPTION_KEY, 'hex'), Buffer.from(e.iv, 'base64'));
    d.setAuthTag(Buffer.from(e.tag, 'base64'));
    assert.equal(Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString(), expected);
  }
  const session = res.headers['Set-Cookie'].find(line => line.startsWith('fsn_yahoo_session='));
  assert.match(session, /HttpOnly; SameSite=Lax;.*Secure/);
  const secret = session.split(';')[0].split('=')[1];
  assert.equal(h.rows[1].row.session_hash, crypto.createHash('sha256').update(secret).digest('hex'));
  assert.match(res.headers['Cache-Control'], /no-store/);
  for (const secret of ['test-secret', 'test-access', 'test-refresh', 'code+with/special=value']) {
    assert.ok(!JSON.stringify(res).includes(secret));
  }
});

for (const [label, query, cookies, error] of [
  ['missing state', { code: 'code' }, '', 'state_mismatch'],
  ['wrong state', { code: 'code', state: 'wrong' }, cookie, 'state_mismatch'],
  ['missing code', { state: 'valid-state' }, cookie, 'code_missing'],
  ['empty callback', undefined, '', 'state_mismatch'],
  ['denied consent', { error: 'access_denied', state: 'valid-state' }, cookie, 'authorization_denied'],
]) test(label + ' returns safely without token exchange', async () => {
  const h = harness();
  const res = await h.invoke(h.callback, query, cookies);
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.Location, new RegExp('yahoo_error=' + error));
  assert.equal(h.calls.length, 0);
  assert.equal(h.rows.length, 0);
  assert.ok(res.headers['Set-Cookie'].every(line => line.includes('Max-Age=0')));
});

for (const options of [{ rejectToken: true }, { failStorage: true }]) test('exchange/storage failure never establishes session: ' + JSON.stringify(options), async () => {
  const h = harness(options);
  const res = await h.invoke(h.callback, { code: 'code', state: 'valid-state' }, cookie);
  assert.match(res.headers.Location, /yahoo_error=exchange_failed/);
  assert.ok(!res.headers['Set-Cookie'].some(line => line.startsWith('fsn_yahoo_session=')));
  assert.ok(h.logs.length > 0);
});

test('callback cannot be switched to disconnect and rejects POST', async () => {
  const h = harness();
  const res = await h.invoke(h.callback, { action: 'disconnect' }, cookie, 'POST');
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'GET');
  assert.equal(h.calls.length, 0);
});

test('legacy query callback remains supported', async () => {
  const h = harness();
  const res = await h.invoke(h.auth, { action: 'callback', code: 'code', state: 'valid-state' }, cookie);
  assert.match(res.headers.Location, /yahoo=connected/);
});
