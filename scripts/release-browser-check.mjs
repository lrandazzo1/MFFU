#!/usr/bin/env node
// iOS release payload: stale preferences/links, visible providers and actual erase navigation.
// This runs in CI with Playwright, alongside the six-screen render regression gate.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = createServer((req,res)=>{
  const url = new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
    res.writeHead(200,{ 'Content-Type':'application/json' });
    return res.end(JSON.stringify({ configured:false, apns:false, web:false }));
  }
  const file = join(root,'www',url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  if(!existsSync(file)){ res.writeHead(404); return res.end(); }
  res.writeHead(200,{ 'Content-Type':file.endsWith('.js')?'text/javascript':'text/html' });
  res.end(readFileSync(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ executablePath:process.env.FSN_CHROMIUM_PATH || chromium.executablePath() });
try{
  const cases = [
    { route:'', provider:'espn', leagueId:'', yahooPanelHidden:true },
    { route:'?goto=setup&platform=yahoo&id=449.l.12345', provider:'yahoo', leagueId:'', yahooPanelHidden:false },
    { route:'?goto=setup&platform=yahoo&id=123456', provider:'yahoo', leagueId:'123456', yahooPanelHidden:false },
  ];
  for(const releaseCase of cases){
    const { route, provider, leagueId, yahooPanelHidden } = releaseCase;
    const page = await browser.newPage({ viewport:{ width:390, height:844 } });
    const calls = [], errors = [];
    page.on('request',req=>{ if(/\/api\/(?:auth\/yahoo|yahoo|espn)/.test(req.url())) calls.push(req.url()); });
    page.on('pageerror',err=>errors.push(String(err)));
    await page.addInitScript(()=>{
      if(sessionStorage.getItem('release-seeded')) return;
      sessionStorage.setItem('release-seeded','1');
      localStorage.setItem('hasCompletedOnboarding','true');
      localStorage.setItem('fsn.setup.v1',JSON.stringify({ provider:'yahoo',leagueId:'449.l.12345' }));
      localStorage.setItem('fsn_saved_league_id','449.l.12345');
      localStorage.setItem('mffu.saved.leagues.v1',JSON.stringify([{ provider:'yahoo',id:'449.l.12345',name:'Old Yahoo' }]));
    });
    await page.goto(base + '/' + route,{ waitUntil:'load' });
    await page.waitForSelector('.screen[data-screen="setup"][data-active="true"]');
    assert.equal(await page.locator('#providerYahoo').count(),1);
    assert.equal(await page.locator('#yahooAuthPanel').count(),1);
    assert.equal(await page.locator('#providerYahoo').getAttribute('aria-selected'),provider === 'yahoo' ? 'true' : 'false');
    assert.equal(await page.locator('#yahooAuthPanel').evaluate(el=>el.classList.contains('hidden')),yahooPanelHidden);
    assert.equal(await page.locator('#leagueIdInput').inputValue(),leagueId);
    assert.equal(await page.locator('#homeLeagueName').textContent(),'THE DESK');
    assert.equal(await page.locator('#homeSeasonLabel').textContent(),'');
    assert.match(await page.locator('#leagueSwitcher').textContent(),/Old Yahoo · YAHOO/);
    assert.equal(await page.locator('#ftuProviders').textContent(),'ESPN, Sleeper or Yahoo');
    if(provider === 'yahoo'){
      assert.match(await page.locator('#yahooAuthStatus').textContent(),/Yahoo login opens in Safari/);
    }
    assert.equal(calls.length,0,'iOS boot/link must not probe Yahoo or reinterpret its ID as ESPN');
    assert.deepEqual(errors,[]);
    await page.evaluate(()=>{
      localStorage.setItem('fsn.private','secret');
      localStorage.setItem('mffu.history','cache');
      localStorage.setItem('unrelated','keep');
      sessionStorage.setItem('fsn.session','private');
    });
    page.once('dialog',dialog=>dialog.accept());
    await page.click('#eraseLocalDataBtn');
    await page.waitForFunction(()=>document.getElementById('ftuModal')?.dataset.open === 'true');
    const after = await page.evaluate(()=>({
      private:localStorage.getItem('fsn.private'),
      history:localStorage.getItem('mffu.history'),
      onboarding:localStorage.getItem('hasCompletedOnboarding'),
      session:sessionStorage.getItem('fsn.session'),
      unrelated:localStorage.getItem('unrelated'),
      search:location.search,
    }));
    assert.deepEqual(after,{ private:null,history:null,onboarding:null,session:null,unrelated:'keep',search:'' });
    assert.equal(calls.length,0,'Native erase must never call Yahoo');
    assert.deepEqual(errors,[]);
    await page.close();
  }
  console.log('[release-browser] Native Yahoo UI, stale preferences/links, safe Safari handoff and complete erase/reload passed.');
}finally{
  await browser.close();
  server.close();
}
