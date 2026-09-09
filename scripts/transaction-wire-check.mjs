// Real page + real article renderer, with deterministic provider/cache fixtures.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,extname,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';
const require = createRequire(import.meta.url);
const {generate} = require('../lib/transaction-wire/engine');
const root = resolve(dirname(fileURLToPath(import.meta.url)),'..');
const now = Date.now();
const season = new Date(now).getUTCFullYear();
const article = generate({key:`espn:999999:${season}`,provider:'espn',league:'999999',season,week:2},
  {id:'fixture-claim',kind:'waiver',at:now-1000,week:2,bid:12,moves:[{playerId:'5',from:null,to:'1'}],assets:[]},
  {players:{5:{name:'Wire Test Runner',pos:'RB'}},teams:{1:{id:'1',name:'Alpha',wins:1,losses:1,ties:0,points:220}}},now);
const requests = [];
let blockSecondLeague = false;
let failLiveUpdate = false;
const server = createServer((req,res)=>{
  const url = new URL(req.url,'http://localhost');
  if(url.pathname === '/api/transaction-wire'){
    requests.push({method:req.method,league:url.searchParams.get('league')});
    res.setHeader('Content-Type','application/json');
    if(blockSecondLeague && url.searchParams.get('league') === '888888'){res.writeHead(401);res.end('{}');return;}
    // Reproduce the original failure: GET fails before the live POST is tried.
    if(req.method === 'GET' || failLiveUpdate){res.writeHead(503);res.end('{}');return;}
    const key = `espn:${url.searchParams.get('league')}:${season}`;
    res.end(JSON.stringify({scope:key,mode:'live',storage:'unavailable',articles:key===`espn:999999:${season}`?[article]:[]}));return;
  }
  if(url.pathname.startsWith('/api/')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({configured:false}));return;}
  const path = resolve(root,'.'+(url.pathname === '/' ? '/index.html' : url.pathname));
  if(!path.startsWith(root+'/')){res.writeHead(403);res.end();return;}
  try{res.setHeader('Content-Type',extname(path)==='.js'?'text/javascript':'text/html');res.end(readFileSync(path));}
  catch(err){res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser = await chromium.launch({executablePath:process.env.FSN_CHROMIUM_PATH,headless:true,args:['--no-sandbox']});
const page = await browser.newPage();
const errors = [];
page.on('pageerror',e=>errors.push(String(e)));
page.on('console',m=>{if(m.type()==='error' && /\[(FSN|NewsDesk|TransactionWire)/.test(m.text()))errors.push(m.text());});
await page.route('https://**/*',r=>r.abort());
try{
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.evaluate(({season})=>{
    document.getElementById('leagueIdInput').value='999999';
    document.getElementById('seasonYear').value=String(season);
    const teams=[1,2,3,4].map(id=>({id,location:['','Alpha','Bravo','Charlie','Delta'][id],nickname:'Team',abbrev:'T'+id,owners:['o'+id],record:{overall:{wins:1,losses:1,ties:0,pointsFor:220,pointsAgainst:220}},roster:{entries:[]}}));
    const schedule=[1,2].flatMap(w=>[1,3].map(id=>({id:w*10+id,matchupPeriodId:w,playoffTierType:'NONE',winner:'HOME',home:{teamId:id,totalPoints:110,pointsByScoringPeriod:{[w]:110}},away:{teamId:id+1,totalPoints:100,pointsByScoringPeriod:{[w]:100}}})));
    LeagueData.setEspnData({id:999999,seasonId:season,scoringPeriodId:2,status:{currentMatchupPeriod:2,finalScoringPeriod:17,isActive:true},settings:{name:'Wire Test',size:4,scheduleSettings:{matchupPeriodCount:14,playoffTeamCount:4}},teams,members:teams.map(t=>({id:t.owners[0],displayName:t.location})),schedule});
    window.__fsnRender();
  },{season});
  await page.waitForFunction(()=>FSNTransactionWire.merge([],2).length===1);
  const result = await page.evaluate(()=>{
    const lead={id:'lead',kind:'sotl',at:0};
    return {lead:FSNTransactionWire.merge([lead],2)[0].id,old:FSNTransactionWire.merge([],1).length,current:FSNTransactionWire.merge([],2).length};
  });
  assert.deepEqual(result,{lead:'lead',old:0,current:1});
  assert.ok(requests.some(r=>r.method==='GET'));
  assert.ok(requests.some(r=>r.method==='POST'));
  assert.match(await page.locator('#transactionWireStatus').textContent(),/Live roster updates are shown/);
  if(await page.getAttribute('#profilePicker','data-open')==='true')await page.click('#profileGuest');
  await page.click('[data-tab="news"]');
  await page.waitForTimeout(200);
  // The actual feed opens the backend-created article using the usual reader.
  const row = page.locator('[data-article="'+article.id+'"]:visible').first();
  await row.click({force:true});
  assert.match(await page.locator('body').innerText(),/THE TRANSACTION LEDGER/i);
  assert.match(await page.locator('body').innerText(),/Wire Test Runner/);
  failLiveUpdate=true;
  await page.evaluate(()=>{
    const original=Date.now;
    Date.now=()=>original()+61000;
    FSNTransactionWire.merge([],2);
  });
  await page.waitForFunction(()=>document.getElementById('transactionWireStatus').textContent.includes('Showing saved transactions'));
  assert.equal(await page.evaluate(()=>FSNTransactionWire.merge([],2).length),1,'provider failure retains prior verified article');
  blockSecondLeague=true;
  await page.evaluate(()=>{document.getElementById('leagueIdInput').value='888888'; window.__fsnRender();});
  await page.waitForFunction(()=>document.getElementById('transactionWireStatus').textContent.includes('Reconnect this league'));
  assert.equal(await page.evaluate(()=>FSNTransactionWire.merge([],2).length),0,'no previous-league articles after switching');
  await page.evaluate(()=>LeagueData.setEspnData(null));
  assert.equal(await page.evaluate(()=>FSNTransactionWire.merge([],2).length),0,'disconnect clears wire');
  assert.deepEqual(errors,[]);
  console.log('[transaction-wire-check] failed GET → live POST, feed, reader, stale fallback, week gating, lead priority, league switch, auth failure and disconnect passed');
}finally{
  await browser.close(); await new Promise(r=>server.close(r));
}
