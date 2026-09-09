'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scope, sleeperSnapshot, espnSnapshot, yahooSnapshot } = require('./providers');
const { build, injuryState, teamAudit } = require('./engine');
const { sync } = require('./service');
const now = Date.parse('2026-09-09T12:00:00Z');
const s = scope({provider:'sleeper',league:'123',season:2026,week:2});

function fixture() {
  return sleeperSnapshot({league_id:'123',season:'2026',settings:{leg:2}},[
    {roster_id:1,owner_id:'a',players:['1','2'],starters:['1'],settings:{wins:1,losses:0,ties:0,fpts:125,fpts_decimal:50}},
    {roster_id:2,owner_id:'b',players:['3'],starters:['3'],settings:{wins:0,losses:1,ties:0,fpts:101,fpts_decimal:25}},
  ],[{user_id:'a',display_name:'First & Goal'},{user_id:'b',display_name:'Second Team'}],{
    1:{full_name:'Runner One',position:'RB',status:'Active'},
    2:{full_name:'Runner Two',position:'RB',status:'Active'},
    3:{full_name:'Receiver Three',position:'WR',status:'Active'},
  },[
    {transaction_id:'ok',status:'complete',type:'waiver',status_updated:now-1000,leg:2,adds:{2:1},settings:{waiver_bid:0}},
    {transaction_id:'failed',status:'failed',type:'waiver',status_updated:now-1000,leg:2,adds:{2:2},settings:{waiver_bid:99}},
    {transaction_id:'pending',status:'pending',type:'trade',status_updated:now-1000,leg:2,adds:{3:1},drops:{3:2}},
  ],s);
}

test('provider scopes reject injection, unsupported providers and invalid weeks',()=>{
  for (const change of [{league:'../1'},{provider:'other'},{week:0},{week:19},{season:'2026x'}]) assert.throws(()=>scope({...s,...change}));
  assert.equal(scope({...s,provider:'yahoo',league:'461.l.123'}).key,'yahoo:461.l.123:2026');
});
test('only completed moves publish; zero bid, points decimals and escaping are preserved',()=>{
  const snapshot = fixture(), result = build(s,snapshot,null,now,now-86400000);
  assert.equal(result.articles.length,1);
  const a = result.articles[0];
  assert.match(a.headline,/FOR \$0/);
  assert.match(a.paragraphs.join(' '),/125\.5/);
  assert.match(a.paragraphs.join(' '),/55\.3/);
  assert.ok(!a.paragraphs.join(' ').includes('PPG'),'W/L/T must not be assumed to equal scoring weeks');
  assert.match(a.headline,/FIRST &amp; GOAL/);
  assert.ok(a.paragraphs.length >= 6);
  assert.equal(a.sourceEventId,'ok');
  assert.deepEqual(result,build(s,snapshot,null,now,now-86400000));
  assert.notEqual(a.id,build({...s,key:'espn:123:2026',provider:'espn'},snapshot,null,now,now-86400000).articles[0].id);
});
test('full multi-team trades retain every player, pick and budget movement',()=>{
  const snap = fixture();
  snap.events = [{id:'trade',kind:'trade',at:now-1,week:2,bid:null,moves:[{playerId:'1',from:'1',to:'2'},{playerId:'3',from:'2',to:'1'}],assets:[{type:'pick',season:2027,round:2,original:'1',from:'1',to:'2'},{type:'budget',amount:15,from:'2',to:'1'}]}];
  const a = build(s,snap,null,now,0).articles[0];
  assert.equal(a.numbers.rows.length,4);
  assert.match(a.paragraphs.join(' '),/2027 round 2/);
  assert.match(a.paragraphs.join(' '),/\$15 FAAB/);
  assert.match(a.paragraphs.join(' '),/Receiver Three/);
});
test('injuries require an observed transition; recurrence gets a new identity',()=>{
  const snap = fixture(); snap.events = [];
  const previous = injuryState(snap);
  snap.players['1'].status = 'OUT';
  assert.equal(build(s,snap,null,now,0).articles.length,0);
  const first = build({...s,week:1},snap,previous,now,0,1).articles[0];
  assert.equal(first.week,2,'uses provider current week rather than caller-selected historical week');
  assert.match(first.paragraphs.join(' '),/Runner Two/);
  assert.equal(build(s,snap,injuryState(snap),now+1,0,2).articles.length,0);
  assert.notEqual(first.id,build(s,snap,previous,now+2,0,3).articles[0].id);
  assert.equal(build({...s,season:2025},snap,previous,now,0).articles.length,0);
  const oldTeam = structuredClone(previous); oldTeam['1'].teamId = '2';
  assert.equal(build(s,snap,oldTeam,now,0).articles.length,0);
});
test('missing metrics never become zero PPG; future/stale events stay off the wire',()=>{
  assert.equal(teamAudit({wins:null,losses:null,ties:null,points:null},'seed'),null);
  assert.equal(teamAudit({wins:0,losses:0,ties:0,points:0},'seed'),null);
  const snap = fixture(); snap.events[0].at = now+1;
  assert.equal(build(s,snap,null,now,0).articles.length,0);
  snap.events[0].at = now-10000;
  assert.equal(build(s,snap,null,now,now-100).articles.length,0);
});
test('ESPN execution date takes precedence and proposed transactions never publish',()=>{
  const es = scope({...s,provider:'espn'});
  const snap = espnSnapshot({id:123,seasonId:2026,status:{currentMatchupPeriod:2},teams:[{id:1,name:'One',roster:{entries:[]}}],players:[{player:{id:2,fullName:'Runner Two'}}],transactions:[
    {id:1,type:'FREEAGENT',status:'EXECUTED',teamId:1,processDate:now-1,proposedDate:now-100000,scoringPeriodId:2,items:[{type:'ADD',playerId:2}]},
    {id:2,type:'WAIVER',status:'PENDING',teamId:1,processDate:now-1,items:[]},
  ]},es);
  assert.equal(snap.events.length,1); assert.equal(snap.events[0].at,now-1);
  assert.equal(build(es,snap,null,now,0).articles.length,1);
  const partial = espnSnapshot({id:123,seasonId:2026,teams:[]},es);
  assert.deepEqual(partial.events,[]);
  assert.deepEqual(partial.warnings,['ESPN_TRANSACTIONS_UNAVAILABLE']);
  assert.throws(()=>espnSnapshot({id:123,seasonId:2026,teams:[],transactions:{}},es),/Invalid ESPN/);
});
test('Yahoo fragmented transaction/player records preserve transfer directions',()=>{
  const ys = scope({...s,provider:'yahoo',league:'461.l.123'});
  const metadata = {fantasy_content:{league:[{league_key:ys.league},{season:'2026'},{current_week:'2'}]}};
  const roster = {team:[[{team_key:'461.l.123.t.1'},{name:'Yahoo Team'}],{roster:{players:{0:{player:[[{player_key:'461.p.1'},{name:{full:'Yahoo Player'}},{display_position:'RB'}],{selected_position:[{position:'RB'}]}]}}}}]};
  const moves = {transactions:{0:{transaction:[{transaction_key:'461.l.123.tr.4',type:'add',status:'successful',timestamp:String((now-1000)/1000)},{players:{0:{player:[[{player_key:'461.p.1'},{name:{full:'Yahoo Player'}}],{transaction_data:{type:'add',destination_team_key:'461.l.123.t.1'}}]}}}]}},count:1};
  const snap = yahooSnapshot(metadata,roster,[moves],ys);
  assert.equal(snap.events[0].moves[0].to,'461.l.123.t.1');
  assert.equal(snap.events[0].week,null);
  assert.equal(build(ys,snap,null,now,0).articles.length,1);
});

function memoryDB() {
  let state = null;
  const articles = new Map();
  return {articles,from(table){ return {select(){return this;},eq(){return this;},order(){return this;},async limit(){return {data:[...articles.values()].map(article=>({article}))};},async maybeSingle(){return {data:state && structuredClone(state)};}};},
    async rpc(name,args){
      if ((state ? state.revision : 0) !== args.p_revision) return {data:false};
      args.p_articles.forEach(a=>{if(!articles.has(a.id)) articles.set(a.id,a);});
      state = {revision:args.p_revision+1,injuries:args.p_injuries,observed_at:args.p_observed_at};
      return {data:true};
    }};
}
test('repeated syncs retain original copy; overlapping injury commits reject stale revisions',async()=>{
  const db = memoryDB(); let clock = now;
  const snapshot = fixture();
  const deps = {now:()=>clock,ingest:async()=>snapshot};
  const initial = await sync(db,s,{},deps);
  clock += 61000; snapshot.teams['1'].name = 'Renamed Later';
  const repeated = await sync(db,s,{},deps);
  assert.deepEqual(initial.articles,repeated.articles);
  clock += 61000; snapshot.players['1'].status = 'OUT';
  const results = await Promise.allSettled([sync(db,s,{},deps),sync(db,s,{},deps)]);
  assert.equal(results.filter(r=>r.status === 'fulfilled').length,1);
  assert.equal(results.find(r=>r.status === 'rejected').reason.status,409);
  assert.equal(db.articles.size,2);
});
test('failed database commit does not report a successful sync',async()=>{
  const db = memoryDB(); db.rpc = async()=>({error:new Error('database offline')});
  const result = await sync(db,s,{}, {now:()=>now,ingest:async()=>fixture()});
  assert.equal(result.storage,'unavailable');
  assert.equal(result.mode,'live');
  assert.equal(result.articles.length,1);
  assert.equal(db.articles.size,0);
});

test('missing transaction tables and unconfigured storage still produce live articles',async()=>{
  const missing = {from(){return {select(){return this;},eq(){return this;},order(){return this;},async limit(){return {error:{code:'PGRST205',message:'table missing'}};}};}};
  for(const db of [null,missing]){
    const result = await sync(db,s,{}, {now:()=>now,ingest:async()=>fixture()});
    assert.equal(result.mode,'live');
    assert.equal(result.storage,'unavailable');
    assert.equal(result.articles.length,1);
  }
});
test('malformed cached articles fall back to verified live payloads',async()=>{
  const db={from(){return {select(){return this;},eq(){return this;},order(){return this;},async limit(){return {data:[{article:null}]};}};}};
  const result=await sync(db,s,{}, {now:()=>now,ingest:async()=>fixture()});
  assert.equal(result.mode,'live');
  assert.equal(result.storage,'unavailable');
  assert.equal(result.articles.length,1);
});
test('missing injury table does not fabricate first-observation injury stories',async()=>{
  const db = memoryDB(), original = db.from;
  db.from = table => table === 'fsn_transaction_state'
    ? {select(){return this;},eq(){return this;},async maybeSingle(){return {error:{code:'42P01',message:'baseline missing'}};}}
    : original(table);
  const snapshot = fixture(); snapshot.players['1'].status='OUT';
  const result = await sync(db,s,{}, {now:()=>now,ingest:async()=>snapshot});
  assert.equal(result.storage,'unavailable');
  assert.equal(result.articles.length,1);
  assert.equal(result.articles[0].sourceEventId,'ok');
});
test('provider timeout returns an authorized cache; revoked sessions never do',async()=>{
  const db=memoryDB();
  const first=await sync(db,s,{}, {now:()=>now,ingest:async()=>fixture()});
  const result=await sync(db,s,{}, {now:()=>now+61000,ingest:async()=>{throw new Error('provider timeout');}});
  assert.equal(result.mode,'stale');
  assert.deepEqual(result.articles,first.articles);
  for(const status of [401,403]) await assert.rejects(sync(db,s,{}, {now:()=>now+61000,ingest:async()=>{throw Object.assign(new Error('revoked'),{status});}}),e=>e.status===status);
  await assert.rejects(sync(null,s,{}, {now:()=>now,ingest:async()=>{throw new Error('offline');}}),/offline/);
});
test('failed archive write retains original published copy and reports live new events',async()=>{
  const db=memoryDB();
  const first=await sync(db,s,{}, {now:()=>now,ingest:async()=>fixture()});
  const snapshot=fixture(); snapshot.teams['1'].name='Renamed';
  snapshot.events.push({...snapshot.events[0],id:'new-event'});
  db.rpc=async()=>({error:{code:'PGRST202',message:'RPC missing'}});
  const result=await sync(db,s,{}, {now:()=>now+61000,ingest:async()=>snapshot});
  assert.equal(result.storage,'unavailable');
  assert.equal(result.articles.length,2);
  assert.deepEqual(result.articles.find(a=>a.id===first.articles[0].id),first.articles[0]);
});

test('HTTP cache reads require provider authorization even with a known league ID',async()=>{
  const providers = require('./providers'), service = require('./service');
  const originalAuth = providers.authorize, originalDB = service.database;
  let touched = false;
  providers.authorize = async()=>{throw Object.assign(new Error('expired session'),{status:401});};
  service.database = ()=>{touched = true; return memoryDB();};
  const route = require.resolve('../../api/transaction-wire');
  delete require.cache[route];
  const handler = require(route);
  const response = {code:0,body:null,setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  const errorLog = console.error; console.error = ()=>{};
  try {
    await handler({method:'GET',headers:{},query:s},response);
    assert.equal(response.code,401);
    assert.equal(touched,false,'database must not be read before authorization');
    assert.ok(!JSON.stringify(response.body).includes('expired session'));
  } finally {
    console.error = errorLog;
    providers.authorize = originalAuth; service.database = originalDB; delete require.cache[route];
  }
});
test('cron rejects missing credentials and wrong HTTP methods',async()=>{
  const handler = require('../../api/transaction-wire-dispatch');
  const response = ()=>({code:0,setHeader(){},status(code){this.code=code;return this;},json(){return this;}});
  let res = response(); await handler({method:'GET',headers:{}},res); assert.equal(res.code,401);
  res = response(); await handler({method:'POST',headers:{}},res); assert.equal(res.code,405);
});

test('HTTP GET and POST succeed in live-only mode when Supabase configuration is missing',async()=>{
  const providers=require('./providers'), service=require('./service');
  const originals={authorize:providers.authorize,ingest:providers.ingest,database:service.database};
  providers.authorize=async()=>{};
  providers.ingest=async()=>fixture();
  service.database=()=>{throw Object.assign(new Error('not configured'),{status:503});};
  const route=require.resolve('../../api/transaction-wire'); delete require.cache[route];
  const handler=require(route);
  try{
    for(const method of ['GET','POST']){
      const res={code:0,body:null,setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
      await handler({method,query:s,headers:{}},res);
      assert.equal(res.code,200);
      assert.equal(res.body.scope,s.key);
      assert.equal(res.body.storage,'unavailable');
      assert.equal(res.body.mode,method==='GET'?'cache-unavailable':'live');
      assert.equal(res.body.articles.length,method==='GET'?0:1);
    }
  }finally{
    Object.assign(providers,{authorize:originals.authorize,ingest:originals.ingest});
    service.database=originals.database; delete require.cache[route];
  }
});
