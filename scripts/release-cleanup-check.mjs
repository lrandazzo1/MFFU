#!/usr/bin/env node
// Run the actual storage/cleanup/notification code with controlled failure paths.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { simple } from 'acorn-walk';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m=> m[1]);
function actual(name, declaration = false){
  const matches = [];
  for(const source of scripts){
    simple(parse(source, { ecmaVersion:'latest', sourceType:'script' }), {
      ...(declaration ? { FunctionDeclaration(node){
        if(node.id?.name === name) matches.push(source.slice(node.start, node.end));
      } } : { AssignmentExpression(node){
        if(node.left.object?.name === 'window' && node.left.property?.name === name) matches.push(source.slice(node.start, node.end));
      } }),
    });
  }
  assert.equal(matches.length, 1, `Expected one real implementation of ${name}`);
  return matches[0];
}
function storage(entries = {}){
  const values = new Map(Object.entries(entries));
  return {
    get length(){ return values.size; },
    key(i){ return [...values.keys()][i] ?? null; },
    getItem(k){ return values.get(k) ?? null; },
    setItem(k,v){ values.set(k,String(v)); },
    removeItem(k){ values.delete(k); },
  };
}
function context(extra = {}){
  const errors = [];
  const c = { TextEncoder, AbortController, setTimeout, clearTimeout, Intl,
    console:{ warn:(...args)=> errors.push(args), error:(...args)=> errors.push(args), info(){} },
    localStorage:storage(), sessionStorage:storage(), navigator:{}, ...extra };
  c.window = c;
  c.__errors = errors;
  return vm.createContext(c);
}
const storeCode = actual('FSNStore');
{
  const c = context({ localStorage:storage({ 'fsn.setup.v1':'saved', fsn_user_role:'member', 'mffu.history':'cache', hasCompletedOnboarding:'true', unrelated:'keep' }), sessionStorage:storage({ 'fsn.session':'private', unrelated:'keep' }) });
  vm.runInContext(storeCode, c);
  c.FSNStore.set('fsn.large', 'held only in memory', { maxBytes:1 });
  assert.equal(c.FSNStore.get('fsn.large'), 'held only in memory');
  const result = c.FSNStore.eraseOwnedData();
  assert.equal(result.failures.length, 0);
  assert.equal(c.localStorage.length, 1);
  assert.equal(c.sessionStorage.length, 1);
  assert.equal(c.localStorage.getItem('unrelated'), 'keep');
  assert.equal(c.FSNStore.get('fsn.large'), null);
  assert.equal(c.FSNStore.set('fsn.late', 'late response').reason, 'erasing');
  assert.equal(c.FSNStore.get('fsn.late'), null);
}
{
  const c = context();
  Object.defineProperty(c, 'sessionStorage', { get(){ throw new Error('Storage getter denied'); } });
  vm.runInContext(storeCode, c);
  assert.deepEqual(Array.from(c.FSNStore.eraseOwnedData().failures), ['sessionStorage']);
  assert(c.__errors.length > 0, 'Denied storage must be reported');
}
{
  const c = context({ localStorage:storage({ 'fsn.private':'secret' }) });
  const remove = c.localStorage.removeItem;
  c.localStorage.removeItem = key=> { if(key === 'fsn.private') throw new Error('Remove denied'); remove(key); };
  vm.runInContext(storeCode,c);
  assert.deepEqual(Array.from(c.FSNStore.eraseOwnedData().failures), ['localStorage']);
}

const notifyCode = readFileSync(new URL('../notificationService.js', import.meta.url), 'utf8');
const DEVICE = 'a'.repeat(64);
function notificationFixture({ entries = {}, config = { configured:true, apns:true, web:false }, request } = {}){
  const callbacks = new Map();
  const calls = { prompts:0, unregister:0, posts:[] };
  const c = context({ localStorage:storage(entries), Capacitor:{ isNativePlatform:()=>true, Plugins:{ PushNotifications:{
    checkPermissions:async()=>({ receive:'granted' }),
    requestPermissions:async()=>{ calls.prompts++; return { receive:'granted' }; },
    addListener:async(name, callback)=>{ callbacks.set(name,callback); return { remove:async()=>callbacks.delete(name) }; },
    register:async()=>{ callbacks.get('registration')({ value:'b'.repeat(64) }); },
    unregister:async()=>{ calls.unregister++; },
  } } }, fetch:async(url, options)=>{
    if(options.method === 'GET') return { ok:true, json:async()=>config };
    const payload = JSON.parse(options.body); calls.posts.push(payload);
    if(request) await request(payload);
    return { ok:true, json:async()=>({ ok:true, deviceId:DEVICE, removed:payload.unsubscribe === true }) };
  } });
  vm.runInContext(notifyCode,c);
  return { service:c.FSNNotifications, c, calls };
}
{
  const f = notificationFixture({ config:{ configured:true, apns:false, web:true, vapidPublicKey:'web-only' } });
  await f.service.boot();
  assert.equal(f.service.state().configured,false);
  await assert.rejects(f.service.enable(), /PUSH_NOT_CONFIGURED/);
  assert.equal(f.calls.prompts,0,'Web-only config must not request native permission');
}
{
  let offline = true;
  const f = notificationFixture({ entries:{ 'fsn.notify.device.v1':DEVICE, 'fsn.notify.optin.v1':'1' }, request:async()=>{ if(offline) throw new Error('Offline'); } });
  await assert.rejects(f.service.disable(), /Offline/);
  assert.equal(f.c.localStorage.getItem('fsn.notify.device.v1'), DEVICE, 'Failed removal must retain the retry receipt');
  assert.equal(f.service.state().registered,true);
  offline = false;
  await f.service.disable();
  assert.equal(f.c.localStorage.getItem('fsn.notify.device.v1'),null);
  assert.equal(f.calls.unregister,1);
  assert.equal(f.calls.posts.length,2);
}
{
  let releaseRegistration;
  let registrationStarted;
  const started = new Promise(resolve=>{ registrationStarted = resolve; });
  const pending = new Promise(resolve=>{ releaseRegistration = resolve; });
  const f = notificationFixture({ request:async payload=>{ if(!payload.unsubscribe){ registrationStarted(); await pending; } } });
  await f.service.boot();
  const enable = f.service.enable();
  await started;
  const disable = f.service.disable();
  releaseRegistration();
  await Promise.all([enable,disable]);
  assert.equal(f.calls.posts.length,2);
  assert.equal(f.calls.posts[1].unsubscribe,true);
  assert.equal(f.calls.posts[1].deviceId,DEVICE);
  assert.equal(f.service.state().optedIn,false);
  assert.equal(f.service.state().registered,false);
}

const eraseCode = actual('eraseLocalDataAndDisconnect',true);
async function eraseFixture({ native = false, disconnectFails = false, pushFails = false } = {}){
  const elements = { eraseLocalDataBtn:{ disabled:false }, eraseLocalDataStatus:{} };
  const calls = { disconnects:0, cleared:0, reloads:[] };
  const c = context({ $:id=>elements[id], confirm:()=>true,
    FSNRelease:{ isIOS:()=>native },
    FSNNet:{ fetch:async()=>{ calls.disconnects++; return { ok:!disconnectFails }; } },
    notifyService:()=>({ disable:async()=>{ if(pushFails) throw new Error('Offline'); } }),
    LEAGUE_RUNTIME_CACHE:{ clear(){ calls.cleared++; } },
    location:{ pathname:'/index.html', search:'?id=123&token=secret', hash:'#private', replace:path=>calls.reloads.push(path) },
  });
  vm.runInContext(storeCode,c);
  c.FSNStore.set('fsn.private','secret');
  vm.runInContext(eraseCode,c);
  await c.eraseLocalDataAndDisconnect();
  return { c, calls, elements };
}
{
  const f = await eraseFixture();
  assert.equal(f.calls.disconnects,1);
  assert.equal(f.c.localStorage.getItem('fsn.private'),null);
  assert.deepEqual(f.calls.reloads,['/index.html']);
  assert.equal(f.calls.cleared,1);
}
{
  const f = await eraseFixture({ native:true });
  assert.equal(f.calls.disconnects,0,'iOS must not call Yahoo cookie endpoints');
  assert.equal(f.c.localStorage.getItem('fsn.private'),null);
}
for(const failure of [{ disconnectFails:true },{ pushFails:true }]){
  const f = await eraseFixture(failure);
  assert.equal(f.c.localStorage.getItem('fsn.private'),'secret');
  assert.equal(f.calls.reloads.length,0);
  assert.equal(f.elements.eraseLocalDataBtn.disabled,false);
  assert.match(f.elements.eraseLocalDataStatus.textContent,/not been erased/);
}

const releaseCode = actual('FSNRelease');
for(const native of [true,false]){
  const c = context({ document:{ documentElement:{ getAttribute:()=>native?'ios':'web' }, querySelectorAll:()=>[] },
    FSNApi:{ isNativeShell:()=>false }, $:()=>null });
  vm.runInContext(releaseCode,c);
  assert.equal(c.FSNRelease.supportsProvider('yahoo'),!native);
  assert.equal(c.FSNRelease.supportsProvider('espn'),true);
  assert.equal(c.FSNRelease.supportsProvider('sleeper'),true);
}
console.log('[release-cleanup] Storage ownership, memory purge, failure/retry, registration race, transport gating and provider restrictions passed.');
