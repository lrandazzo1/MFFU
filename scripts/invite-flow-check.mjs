#!/usr/bin/env node
// Exercise the real invite UI and fetch/hydration flow with authorized API fixtures.
// No private credentials or external services are used.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
// Reuse the repository's structurally real league fixture without running its harness.
const renderCheck = readFileSync(join(root, 'scripts/render-check.mjs'), 'utf8');
const fixtureSource = renderCheck.slice(renderCheck.indexOf('function syntheticLeague()'), renderCheck.indexOf('/* A real VAPID'));
const fixture = Function(fixtureSource + '; return syntheticLeague();')();
const token = 'a'.repeat(43);
const id = String(fixture.id);
const origin = 'http://invite.test';
const browser = await chromium.launch({ executablePath: process.env.FSN_CHROMIUM_PATH || undefined });

async function fresh({ blockedStorage = false, holdUnauthorized = false } = {}) {
  const page = await browser.newPage({ serviceWorkers: 'block' });
  const requests = [], errors = [], held = [];
  await page.addInitScript(({ blockedStorage }) => {
    localStorage.setItem('hasCompletedOnboarding', 'true');
    if (blockedStorage) Storage.prototype.setItem = function () { throw new DOMException('Test storage full', 'QuotaExceededError'); };
  }, { blockedStorage });
  page.on('pageerror', err => errors.push(String(err)));
  page.on('console', msg => {
    if (blockedStorage && msg.text().startsWith('[FSNStore]') && msg.text().includes('FSN_STORE_WRITE_REFUSED')) return; // Expected injected storage failure.
    if (msg.type() === 'error' && /\[(FSN|NewsDesk|Standings|Matchups|Private League Auth|League Share)/.test(msg.text())) errors.push(msg.text());
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/espn' || url.pathname === '/api/league') {
      const headers = route.request().headers();
      requests.push({ path: url.pathname, url: url.href, headers });
      const authorized = headers['x-league-token'] === token || (headers['x-espn-s2'] && headers['x-espn-swid']);
      if (!authorized) {
        if (holdUnauthorized && url.pathname === '/api/league' && !authorized) { held.push(route); return; }
        return json({ error: 'Invite access refused by fixture', code: 'SHARE_TOKEN_REQUIRED', league_id: id }, 401);
      }
      if (url.pathname === '/api/league') return json({ record: {
        league_id: id, season_year: 2026, share_token: token, has_cookies: true,
        updated_at: '2026-09-12T00:00:00Z', history_json: { settings: {}, yearsData: [{ year: 2025, leagueData: { ...fixture, seasonId: 2025 } }] },
      } });
      return json(fixture);
    }
    if (url.pathname.startsWith('/api/')) return json({ configured: false, articles: [], transactions: [] });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    try { return route.fulfill({ body: readFileSync(join(root, url.pathname.slice(1))), contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'image/svg+xml' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto(origin + '/?goto=setup', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__fsnRender === 'function');
  return { page, requests, errors, held };
}
async function paste(page, selector, value) {
  // Model paste -> default value insertion -> input, as the browser emits it.
  await page.locator(selector).evaluate((input, value) => {
    input.dispatchEvent(new Event('paste', { bubbles: true }));
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
async function connected(test) {
  const { page, requests, errors } = test;
  await page.waitForFunction(() => document.getElementById('fetchStatus').textContent.includes('Live Season Connected'));
  await page.waitForFunction(() => document.getElementById('privateLeagueAuthModal').dataset.open === 'false');
  assert.equal(await page.locator('section[data-screen="home"]').getAttribute('data-active'), 'true');
  assert.equal(await page.locator('#leagueIdInput').inputValue(), id);
  assert.equal(await page.evaluate(id => window.getLeagueShareToken(id), id), token);
  assert.equal(await page.locator('#privateLeagueAuthInviteStatus').textContent(), '');
  assert.equal(await page.locator('#privateLeagueAuthInviteStatus').getAttribute('data-tone'), null);
  assert.ok(requests.some(r => r.path === '/api/espn' && r.headers['x-league-token'] === token));
  assert.ok(requests.some(r => r.path === '/api/league' && r.headers['x-league-token'] === token));
  assert.deepEqual(errors, []);
}
try {
  const test = await fresh();
  const forms = [`${origin}/?id=${id}&token=${token}`, `/app?id=${id}&token=${token}`, `?id=${id}&token=${token}`, `id=${id}&token=${token}`, `token=${token}&id=${id}`, `league_id=${id}&share_token=${token}`, `#leagueId=${id}&token=${token}`];
  for (const value of forms) assert.deepEqual(await test.page.evaluate(v => window.parseLeagueInviteInput(v), value), { leagueId: id, token });
  assert.deepEqual(await test.page.evaluate(v => window.parseLeagueInviteInput(v), id), { leagueId: id, token: '' });
  for (const value of [`id=bad&token=${token}`, `id=${id}&token=short`, `id=${id}&token=%ZZ`]) {
    const parsed = await test.page.evaluate(v => window.parseLeagueInviteInput(v), value);
    assert.ok(!parsed.leagueId || !parsed.token);
  }
  await test.page.close();
  console.log('ok: full URLs, relative paths, raw/reversed queries, aliases, manual IDs, invalid parameters');

  for (const [selector, value, options] of [
    ['#leagueIdInput', forms[3], {}],
    ['#privateLeagueAuthInviteInput', forms[0], {}],
    ['#privateLeagueAuthInviteInput', forms[1], {}],
    ['#privateLeagueAuthInviteInput', forms[4], { blockedStorage: true }],
  ]) {
    const test = await fresh(options);
    await test.page.evaluate(() => {
      document.getElementById('fetchStatus').textContent = 'Previous setup error';
      document.getElementById('fetchStatus').style.color = 'var(--red)';
      document.getElementById('privateLeagueAuthInviteStatus').textContent = 'Previous invite error';
      document.getElementById('privateLeagueAuthInviteStatus').dataset.tone = 'error';
      document.getElementById('privateLeagueAuthModal').dataset.open = 'true';
      document.getElementById('providerSleeper').click();
    });
    await paste(test.page, selector, value);
    await connected(test);
    await test.page.close();
  }
  console.log('ok: both paste inputs load and hydrate, select ESPN, clear errors, close modal and open Home; blocked-storage session works');

  {
    const test = await fresh({ holdUnauthorized: true });
    await paste(test.page, '#leagueIdInput', id);
    await test.page.waitForRequest(r => new URL(r.url()).pathname === '/api/league');
    assert.equal(test.requests.filter(r => r.path === '/api/espn').length, 0, 'manual ID must not auto-fetch');
    await paste(test.page, '#privateLeagueAuthInviteInput', forms[3]);
    await connected(test);
    for (const route of test.held) await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
    await test.page.waitForTimeout(100);
    assert.equal(await test.page.evaluate(id => window.getLeagueShareToken(id), id), token, 'late anonymous 401 must not delete accepted token');
    assert.deepEqual(test.errors, []);
    await test.page.close();
  }
  console.log('ok: manual ID does not auto-fetch; stale unauthorized hydration cannot discard new invite');

  {
    const test = await fresh();
    await test.page.evaluate(() => { document.getElementById('privateLeagueAuthModal').dataset.open = 'true'; });
    await test.page.locator('#privateLeagueAuthInviteInput').fill(`id=${id}&token=short`);
    await test.page.locator('#privateLeagueAuthUseInvite').click();
    assert.equal(test.requests.length, 0);
    assert.equal(await test.page.locator('#privateLeagueAuthInviteStatus').getAttribute('data-tone'), 'error');
    await test.page.locator('#privateLeagueAuthInviteInput').fill(forms[2]);
    await test.page.locator('#privateLeagueAuthUseInvite').click();
    await connected(test);
    await test.page.close();
  }
  console.log('ok: invalid invite makes no request; explicit Use Invite retry succeeds');

  {
    const test = await fresh();
    await test.page.evaluate(id => { document.getElementById('leagueIdInput').value = id; document.getElementById('privateLeagueAuthModal').dataset.open = 'true'; }, id);
    await test.page.locator('#privateLeagueAuthS2Input').fill('fixture-cookie');
    await test.page.locator('#privateLeagueAuthSwidInput').fill('{11111111-2222-3333-4444-555555555555}');
    await test.page.locator('#privateLeagueAuthUseCookies').click();
    await test.page.waitForFunction(() => document.getElementById('fetchStatus').textContent.includes('Live Season Connected'));
    assert.ok(test.requests.some(r => r.path === '/api/espn' && r.headers['x-espn-s2'] === 'fixture-cookie'));
    assert.deepEqual(test.errors, []);
    await test.page.close();
  }
  console.log('ok: cookie Save & Retry still loads through existing credentials');
} finally {
  await browser.close();
}
