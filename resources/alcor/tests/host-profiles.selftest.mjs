/* host-profiles 端到端自检：
   1) 内建命中直通（不 staging、不拷贝、不改 loader 参数）；
   2) 未登记版本现场扫描 + 成对补丁包（loader' 内含 dll' 的 sha256，DLL' 内含新 profile）；
   3) 缓存命中不重复扫描；
   4) 扫描/补丁失败抛带码错误且不留半成品目录；
   5) 内建版本 inspect-qq 实测探测（无内建 QQ 进程时 SKIP）。
   真实产物只读；所有写入都在临时目录里。退出码 0 = 全过。 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ensureProfilePack,_internals} from '../native-core/host-profiles.mjs';
import {findQQBuildProfile} from '../native-core/qq-profiles.mjs';

const sha256hex=(b)=>createHash('sha256').update(b).digest('hex');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'alcor-host-profiles-test-'));
const packRoot=path.join(root,'packs');
const nativeDir=fileURLToPath(new URL('../artifacts/native/',import.meta.url));
const dllPath=path.join(nativeDir,'alcor-host.dll');
const loaderPath=path.join(nativeDir,'qq-host-loader.exe');
const dllBefore=fs.readFileSync(dllPath);
const loaderBefore=fs.readFileSync(loaderPath);
const WRAPPER_9936='D:\\QQ\\versions\\9.9.36-53644\\resources\\app\\wrapper.node';
const BUILTIN_SHA='0d8b94448f4dafe7337b88d6a568b004224c37fcbe2bd1142c1af7624fbd534c';
const leftovers=()=>fs.existsSync(packRoot)?fs.readdirSync(packRoot):[];

let failed=0;
async function test(name,fn){
  try{await fn();console.log('PASS '+name);}
  catch(e){failed+=1;console.error('FAIL '+name+' :: '+(e?.stack||e));}
}

await test('built-in passthrough: no staging, no copy, pristine loader path',async()=>{
  const r=await ensureProfilePack({sha256:BUILTIN_SHA,version:'9.9.36-53644',packRoot});
  assert.equal(r.staged,false);
  assert.equal(r.derived,false);
  assert.equal(r.loader,loaderPath);
  assert.equal(r.dll,dllPath);
  assert.equal(fs.existsSync(packRoot),false,'packRoot must not be created for built-in hits');
});

const copyDir=path.join(root,'fake-qq-9.9.99','resources','app');
fs.mkdirSync(copyDir,{recursive:true});
const copy=path.join(copyDir,'wrapper.node');   // 扫描器要求 basename 恰为 wrapper.node
let unknownSha=null;
let packResult=null;
await test('unregistered build: paired loader+DLL pack with new profile inside',async()=>{
  if(!fs.existsSync(WRAPPER_9936))throw new Error('SKIP-MARK: 9.9.36 wrapper not present at '+WRAPPER_9936);
  fs.copyFileSync(WRAPPER_9936,copy);
  fs.appendFileSync(copy,Buffer.alloc(8));            // 只改 sha，不改 PE 语义
  unknownSha=sha256hex(fs.readFileSync(copy));
  assert.notEqual(unknownSha,BUILTIN_SHA);
  assert.equal(findQQBuildProfile('wrapper.node',unknownSha),null,'test sha must be unregistered');
  packResult=await ensureProfilePack({sha256:unknownSha,version:'9.9.99-00001',wrapperPath:copy,packRoot});
  assert.equal(packResult.staged,true);
  assert.equal(packResult.derived,true);
  assert.equal(packResult.cached,false);
  // 成对产物存在且大小与原件一致
  const dllP=fs.readFileSync(packResult.dll),loaderP=fs.readFileSync(packResult.loader);
  assert.equal(dllP.length,dllBefore.length);
  assert.equal(loaderP.length,loaderBefore.length);
  // loader' 内嵌的 artifact 哈希指向 DLL'
  const dllSha=sha256hex(dllP);
  assert.ok(loaderP.includes(dllSha),"patched loader must embed the patched dll's sha256");
  assert.ok(!loaderP.includes(sha256hex(dllBefore)),'patched loader must not embed the old dll sha256');
  // DLL' 与 loader' 的 profile 表都带新 profile，且 RVA 与 9.9.36 真值一致
  const builtin=findQQBuildProfile('wrapper.node',BUILTIN_SHA);
  for(const[label,buf]of[['dll',dllP],['loader',loaderP]]){
    const table=_internals.locateProfileTable(buf);
    const entry=table.find((e)=>e.sha256===unknownSha);
    assert.ok(entry,label+' must contain the new profile slot');
    assert.equal(entry.version,'9.9.99-00001');
    for(let i=0;i<14;i+=1){
      const f=_internals.FIELD_ORDER[i];
      assert.equal(entry.rvas[i],builtin.rvas[f],label+' rva mismatch at '+f);
    }
    // 另一个槽位逐字节保持原样
    const other=table.find((e)=>e.sha256!==unknownSha);
    assert.equal(other.sha256,BUILTIN_SHA,label+' slot0 must stay the built-in 9.9.36');
    const orig=_internals.locateProfileTable(label==='dll'?dllBefore:loaderBefore)[0];
    const a=(label==='dll'?dllBefore:loaderBefore).subarray(orig.entryOff,orig.entryOff+0xA0);
    const b=buf.subarray(other.entryOff,other.entryOff+0xA0);
    assert.ok(a.equals(b),label+' untouched slot must be byte-identical');
  }
  // manifest 与盘上 DLL 哈希一致
  const manifest=JSON.parse(fs.readFileSync(path.join(packResult.packDir,'profile.json'),'utf8'));
  assert.equal(manifest.dllSha256,dllSha);
  assert.equal(manifest.sha256,unknownSha);
  // 原件未被改动
  assert.equal(sha256hex(fs.readFileSync(dllPath)),sha256hex(dllBefore),'pristine dll must be untouched');
  assert.equal(sha256hex(fs.readFileSync(loaderPath)),sha256hex(loaderBefore),'pristine loader must be untouched');
});

await test('cache hit: second call reuses the pack without rescanning',async()=>{
  assert.ok(unknownSha,'depends on pack test');
  let calls=0;
  const scanNow=async()=>{calls+=1;throw new Error('scanner must not run on cache hit');};
  const r=await ensureProfilePack({sha256:unknownSha,version:'9.9.99-00001',wrapperPath:copy,packRoot,scanNow});
  assert.equal(calls,0,'scanner ran despite a valid cache');
  assert.equal(r.cached,true);
  assert.equal(r.packDir,packResult.packDir);
  assert.equal(r.loader,packResult.loader);
  assert.equal(r.dll,packResult.dll);
});

await test('failure: missing wrapper -> PROFILE_WRAPPER_NOT_FOUND, no leftover dirs',async()=>{
  const badSha='ab'.repeat(32);
  await assert.rejects(
    ensureProfilePack({sha256:badSha,version:'9.9.99-00002',wrapperPath:path.join(root,'no-such-wrapper.node'),packRoot}),
    (e)=>e.code==='PROFILE_WRAPPER_NOT_FOUND');
  assert.deepEqual(leftovers().filter((d)=>d.startsWith(badSha.slice(0,16))||d.startsWith('.pack-')),[],'no half-built pack dirs');
});

await test('failure: missing scanner -> PROFILE_SCANNER_MISSING, no leftover dirs',async()=>{
  // F9 自愈会把请求 sha 采信为盘上真实 sha：用真实 sha 才能走到扫描阶段
  const missSha=sha256hex(fs.readFileSync(copy));
  await assert.rejects(
    ensureProfilePack({sha256:missSha,version:'9.9.99-00003',wrapperPath:copy,packRoot:path.join(root,'packs-noscanner'),scannerPath:path.join(root,'no-scanner-here.mjs')}),
    (e)=>e.code==='PROFILE_SCANNER_MISSING');
  const empty=path.join(root,'packs-noscanner');
  const left=fs.existsSync(empty)?fs.readdirSync(empty):[];
  assert.deepEqual(left,[],'no half-built pack dirs');
});

await test('failure: garbage wrapper -> PROFILE_SCAN_FAILED, no leftover dirs',async()=>{
  const junk=path.join(root,'junk-wrapper.node');
  fs.writeFileSync(junk,Buffer.alloc(4096,7));
  const junkSha=sha256hex(fs.readFileSync(junk));
  await assert.rejects(
    ensureProfilePack({sha256:junkSha,version:'9.9.99-00004',wrapperPath:junk,packRoot}),
    (e)=>e.code==='PROFILE_SCAN_FAILED');
  assert.deepEqual(leftovers().filter((d)=>d.startsWith(junkSha.slice(0,16))||d.startsWith('.pack-')),[],'no half-built pack dirs');
});

await test('live: built-in version inspect-qq probe still works via the pristine loader',async()=>{
  const ps=spawnSync('powershell',['-NoProfile','-Command',
    "$t='"+BUILTIN_SHA+"';Get-Process -Name QQ -ErrorAction SilentlyContinue|ForEach-Object{try{$m=$_.Modules|Where-Object{$_.ModuleName -eq 'wrapper.node'}|Select-Object -First 1;if($m){$h=(Get-FileHash $m.FileName -Algorithm SHA256).Hash.ToLower();if($h -eq $t){\"$($_.Id) $($_.StartTime.ToFileTimeUtc())\"}}}catch{}}"],
    {encoding:'utf8',timeout:120000});
  const line=(ps.stdout||'').trim().split(/\r?\n/).find((l)=>/^\d+ \d+$/.test(l.trim()));
  if(!line){console.log('  SKIP: no live QQ process with the built-in wrapper');return;}
  const[pidText,ft]=line.trim().split(/\s+/);
  const nonce=createHash('sha256').update(String(Date.now())).digest('hex').slice(0,32);
  const r=spawnSync(loaderPath,[pidText,String(process.pid),nonce,'inspect-qq',ft],{encoding:'utf8',timeout:75000,windowsHide:true});
  assert.equal(r.status,0,'loader exited '+r.status+': '+(r.stderr||'').slice(0,200));
  const out=JSON.parse(r.stdout);
  assert.equal(out.status,0,'inspect-qq status!=0: '+r.stdout);
  assert.equal(out.stage,'inspected');
  console.log('  probe: pid='+pidText+' stage='+out.stage+' loaded='+out.loaded);
});

if(failed){console.error(failed+' test(s) failed');process.exit(1);}
console.log('ALL PASS');
fs.rmSync(root,{recursive:true,force:true});
