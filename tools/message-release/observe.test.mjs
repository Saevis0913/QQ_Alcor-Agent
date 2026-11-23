import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connection, health, evidence, eventDelta } from './observe.mjs';

const write = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'alcor-obs-test-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  return dir;
}
async function server(t, handler) {
  const s = http.createServer(handler);
  await new Promise(r => s.listen(0,'127.0.0.1',r));
  t.after(() => new Promise(r => s.close(r)));
  return {hostname:'127.0.0.1',port:s.address().port,token:'unit-secret'};
}
test('配置仅接受本机回环地址，支持 UTF-16 配置', t => {
  const dir=fixture(t), file=path.join(dir,'alcor.config.json');
  for(const host of ['example.com','0.0.0.0','constructor']) {
    write(file,{listen:{host,port:1234}}); assert.equal(connection(dir),null);
  }
  fs.writeFileSync(file,'\uFEFF'+JSON.stringify({listen:{host:'localhost',port:12555,token:'unit-secret'}}),'utf16le');
  assert.deepEqual(connection(dir),{hostname:'127.0.0.1',port:12555,token:'unit-secret'});
  if (process.platform === 'win32') {
    write(path.join(dir,'config.json'),{alcor:{configFile:'\\\\example.invalid\\share\\config.json'}});
    assert.equal(connection(dir),null);
  }
});
test('健康快照仅保留许可字段，保留 false 并区分未报告',async t => {
  let i=0, auth;
  const cfg=await server(t,(req,res) => { auth=req.headers.authorization;
    res.end(JSON.stringify({name:'Alcor',version:'0.4.1',ready:true,uptimeSeconds:22,backend:{
      connected:true,serviceBound:i++===0?false:undefined,events:0,accountLastFour:'hidden-account',lastError:'unit-secret'}}));});
  const first=await health(cfg), second=await health(cfg);
  assert.equal(auth,'Bearer unit-secret'); assert.equal(first.serviceBound,false); assert.equal(first.events,0);
  assert.equal(second.serviceBound,null);assert.doesNotMatch(JSON.stringify(first),/secret|hidden-account/);
});
test('重定向不会传递凭据，401 与错误身份不能作为计数证据',async t => {
  let calls=0, mode=302;
  const other=await server(t,(_req,res)=>{calls++;res.end();});
  const cfg=await server(t,(_req,res)=>{res.writeHead(mode,{location:'http://127.0.0.1:'+other.port});res.end('{"name":"other","version":"0.4.1"}');});
  assert.equal((await health(cfg)).status,'http-302');assert.equal(calls,0);
  mode=401;assert.equal((await health(cfg)).status,'http-401');
  mode=200;assert.equal((await health(cfg)).status,'invalid-response');
});
test('只有连续、同一生命周期的样本才计算事件增量', () => {
  const first={status:'ok',at:'2026-11-23T00:00:00Z',version:'0.4.1',uptimeSeconds:90,events:2};
  const last={...first,at:'2026-11-23T00:00:05Z',uptimeSeconds:95,events:5};
  assert.equal(eventDelta([first,last]),3);
  for(const samples of [[first],[first,{...last,events:1}],[first,{...last,uptimeSeconds:2}],
    [first,{status:'http-401'},last],[first,{...last,events:null}],[first,{...last,version:'0.4.2'}]]) assert.equal(eventDelta(samples),null);
});
test('按方向和唯一文字核对，排除缓存副本及无关聊天', t => {
  const dir=fixture(t), sub=path.join(dir,'messages/accounts/10000');
  fs.mkdirSync(sub,{recursive:true}); const marks={inbound:'Alcor-IN-ABC',outbound:'Alcor-OUT-ABC'};
  const inrow={text:marks.inbound,self:false,mid:'-55'}, outrow={text:marks.outbound,self:true,mid:66};
  write(path.join(sub,'private_1234.json'),{messages:[inrow,outrow,{...outrow,mid:'0'}, {...outrow,mid:'0001'},
    {...outrow,self:false},{text:'PRIVATE-TEXT',mid:9387}],selfMessages:[outrow]});
  write(path.join(dir,'inbox.json'),{messages:[inrow]});
  const r=evidence(dir,marks,Date.now()); assert.deepEqual(r.archive.inbound,{rows:1,withId:1});
  assert.deepEqual(r.archive.outbound,{rows:3,withId:1});assert.equal(r.inbox.inbound.withId,1);
  assert.ok(r.archive.complete && r.inbox.complete);assert.doesNotMatch(JSON.stringify(r),/PRIVATE|9387|1234/);
});
test('缺目录及损坏的近期存档标为不完整', t=>{
  const dir=fixture(t), marks={inbound:'a',outbound:'b'}; fs.mkdirSync(path.join(dir,'messages'));
  fs.writeFileSync(path.join(dir,'messages/private_1.json'),'{');
  const r=evidence(dir,marks,Date.now());assert.equal(r.archive.complete,false);assert.equal(r.inbox.complete,false);
  assert.equal(r.archive.skipped,1);
});
test('命令行现场快照可离线运行，自定义报告不能覆盖既有文件', t=>{
  const dir=fixture(t), file=path.join(dir,'report.json');
  const args=[fileURLToPath(new URL('./observe.mjs',import.meta.url)),dir,'--data',dir,'--seconds','0','--report',file];
  const run=()=>spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true});
  assert.equal(run().status,0); const before=fs.readFileSync(file,'utf8'), r=JSON.parse(before);
  assert.deepEqual(r.samples.map(s=>s.status),['config-unavailable']); assert.equal(r.eventDelta,null);
  assert.match(r.marks.inbound,/^Alcor-IN-[0-9A-F]{16}$/);assert.equal(run().status,1);
  assert.equal(fs.readFileSync(file,'utf8'),before);assert.ok(!before.includes(dir));
});
