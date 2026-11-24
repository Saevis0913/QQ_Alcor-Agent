import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from '../vendor/ws/wrapper.mjs';

// Exercise the real delivery loop with already decoded OneBot events. No QQ process or native transport.
const modules = {
  '../native-core/message-push.mjs': 'export function decodeMessagePush(data){return JSON.parse(data.toString());}',
  '../native-core/notice-push.mjs': 'export function decodeNoticePush(){return null;}'
};
const hooks = registerHooks({resolve(specifier, context, next) {
  if (specifier === './native-backend.mjs' && context.parentURL?.endsWith('/src/server.mjs?received-event-test')) {
    return {url:new URL('./native-backend.mjs?received-event-test',context.parentURL).href,shortCircuit:true};
  }
  if (!context.parentURL?.endsWith('/src/native-backend.mjs?received-event-test') || !Object.hasOwn(modules, specifier)) {
    return next(specifier, context);
  }
  const real = next(specifier, context).url;
  const code = 'export * from ' + JSON.stringify(real) + ';' + modules[specifier];
  return {url:'data:text/javascript,' + encodeURIComponent(code), shortCircuit:true};
}});
let Backend, createBridge;
try {
  ({ NativeBackend:Backend } = await import('../src/native-backend.mjs?received-event-test'));
  ({ createBridge } = await import('../src/server.mjs?received-event-test'));
}
finally { hooks.deregister(); }

const event = (extra = {}) => ({post_type:'message', message_type:'private', self_id:10001,
  user_id:10002, sequence:7, time:1700000000, message:[{type:'text', data:{text:'test'}}], ...extra});
function setup() {
  const queue=[], published=[];
  const controller = { snapshot:()=>({connected:true, serviceBound:true}),
    request:async()=>({status:0, payload:queue.shift() ?? Buffer.alloc(0)}), disconnect:async()=>{} };
  const backend=new Backend({}, {controller});
  backend.account='10001'; backend.receiving=true;
  backend.onEvent=e=>published.push(e);
  const add=value=>queue.push(Buffer.from(JSON.stringify(value)));
  return {backend, controller, queue, published, add};
}
function scheduleRolloverOnInput(b,controller) {
  const read=controller.request;
  controller.request=async()=>{
    controller.request=read;
    const packet=await read();
    let scheduled=false;
    return {...packet,get payload(){
      if(!scheduled) {
        scheduled=true;
        queueMicrotask(()=>{b.stopReceiving();b.receiving=true;});
      }
      return packet.payload;
    }};
  };
}
test('private text at a session rollover and its replay produce exactly one event',async()=>{
  const {backend:b,controller,published,add}=setup();
  scheduleRolloverOnInput(b,controller);
  add(event());await b.poll();
  assert.equal(published.length,1,'the first private input was published before any replay');
  add(event());add(event());await b.poll();
  assert.equal(published.length,1);assert.equal(b.snapshot().events,1);
});
test('private text is published without waiting for directory metadata',async()=>{
  const {backend:b,published,add}=setup();
  let lookups=0;
  b.directory.enrich=async()=>{lookups++;throw Error('unexpected directory lookup');};
  add(event());await b.poll();
  assert.equal(lookups,0);assert.equal(published.length,1);assert.equal(b.receiving,true);
});
test('a replay after an old group metadata lookup ended in a superseded session is delivered once',async()=>{
  const {backend:b, published,add}=setup();
  const started=Promise.withResolvers(), finish=Promise.withResolvers();
  b.directory.enrich=async e=>{started.resolve(); await finish.promise; return e;};
  const e=event({message_type:'group',group_id:123});
  add(e); const first=b.poll(); await started.promise;
  b.stopReceiving(); b.receiving=true; finish.resolve(); await first;
  assert.equal(published.length,0);
  add(e); add(e); await b.poll();
  assert.equal(published.length,1);
  assert.equal(b.snapshot().events,1); assert.equal(published[0].self_id,10001);
  assert.equal(b.messages.get(published[0].message_id),published[0]);
});
test('a failure in optional sender metadata does not stop this or the following message',async()=>{
  const {backend:b,published,add}=setup();
  b.directory.enrich=async e=>{ if(e.group_id)throw Error('optional metadata unavailable'); return e; };
  add(event({message_type:'group',group_id:123})); add(event({sequence:8}));
  await b.poll();
  assert.equal(published.length,2);assert.equal(b.receiving,true);
  assert.equal(b.snapshot().receiveProgress.metadataErrors,1);
});
test('a delayed optional lookup cannot mutate the already published event',async t=>{
  const {backend:b,published,add}=setup(), started=Promise.withResolvers(), late=Promise.withResolvers();
  t.mock.timers.enable({apis:['setTimeout']});
  b.directory.enrich=async e=>{started.resolve();await late.promise;e.sender.nickname='late';return e;};
  add(event({message_type:'group',group_id:123,sender:{nickname:'original'}}));
  const pending=b.poll();await started.promise;t.mock.timers.tick(1600);await pending;
  assert.equal(published.length,1);late.resolve();await Promise.resolve();
  assert.equal(published[0].sender.nickname,'original');
  assert.equal(b.messages.get(published[0].message_id).sender.nickname,'original');
});
test('a successful metadata lookup preserves the enriched sender and bounded duplicate history',async()=>{
  const {backend:b,published,add}=setup();
  for(let i=0;i<2048;i++)b.seen.add('older-'+i);
  b.directory.enrich=async e=>{ e.sender.nickname='group name';e.member_scan_error='fixture';return e; };
  const e=event({message_type:'group',group_id:123,sender:{nickname:'original'}});
  add(e);add(e);await b.poll();
  assert.equal(published.length,1);assert.equal(published[0].sender.nickname,'group name');
  assert.equal(published[0].member_scan_error,'fixture');assert.equal(b.snapshot().receiveProgress.duplicates,1);
  assert.equal(b.seen.size,2048);assert.equal(b.seen.has('older-0'),false);
});
test('health distinguishes idle, pending and completed receive cycles without exposing payloads',async()=>{
  const {backend:b,controller,add,published}=setup();
  await b.poll();const idle=b.snapshot().receiveProgress;
  assert.ok(idle,'receive progress is present');
  assert.equal(idle.cyclesCompleted,1);assert.equal(idle.inputs,0);assert.equal(idle.pendingMs,null);
  const read=controller.request, waiting=Promise.withResolvers();
  controller.request=()=>waiting.promise;
  const poll=b.poll();await b.poll();
  const pending=b.snapshot().receiveProgress;
  assert.equal(pending.cyclesStarted,2); assert.equal(pending.cyclesCompleted,1); assert.ok(pending.pendingMs>=0);
  waiting.resolve({status:0,payload:Buffer.alloc(0)});await poll;controller.request=read;
  add(null); add(event());add(event());await b.poll();
  const final=b.snapshot().receiveProgress;
  assert.equal(final.cyclesStarted,3);assert.equal(final.cyclesCompleted,3);
  assert.equal(final.inputs,3);assert.equal(final.unrecognized,1);assert.equal(final.duplicates,1);
  assert.equal(final.messagesPublished,1);assert.equal(published.length,1);assert.equal(final.pendingMs,null);
  assert.ok(final.lastFinishedAt);assert.doesNotMatch(JSON.stringify(final),/10001|10002|nickname|fixture|test"/);
});
test('parse failures and ordinary idle waits leave distinct receive evidence',async()=>{
  const {backend:b,controller,queue}=setup();
  queue.push(Buffer.from('{')); await b.poll();controller.request=async()=>{throw Error('HOST_QUEUE_TIMEOUT');};
  await b.poll();const p=b.snapshot().receiveProgress;
  assert.ok(p,'receive progress is present');
  assert.equal(p.inputs,1);assert.equal(p.parseErrors,1);assert.equal(p.idleTimeouts,1);
  assert.equal(p.cyclesCompleted,2);assert.equal(b.events,0);
});
test('after a session change one replay reaches an authenticated event subscriber and public health', {timeout:6000},async()=>{
  const {controller,add}=setup();
  controller.close=async()=>{};
  const token='received-event-fixture';
  const bridge=createBridge({listen:{host:'127.0.0.1',port:0,token},backend:{type:'native'}},{native:{controller}});
  let client;
  try {
    const {httpUrl,wsUrl}=await bridge.listen();
    const headers={authorization:'Bearer '+token};
    client=new WebSocket(wsUrl,{headers});
    await once(client,'open');
    const b=bridge.backend;
    b.receiving=true;b.account='10001';
    const message=once(client,'message',{signal:AbortSignal.timeout(2000)});
    const delivered=message.then(([frame])=>JSON.parse(frame));
    delivered.catch(()=>{});
    scheduleRolloverOnInput(b,controller);
    add(event());await b.poll();add(event());await b.poll();
    assert.equal((await delivered).post_type,'message');
    const h=await fetch(httpUrl+'/health',{headers,signal:AbortSignal.timeout(1500)}).then(r=>r.json());
    assert.equal(h.backend.events,1);assert.equal(h.backend.receiveProgress.duplicates,1);
    assert.equal(h.backend.receiveProgress.messagesPublished,1);
  } finally {client?.terminate();await bridge.close();}
});
