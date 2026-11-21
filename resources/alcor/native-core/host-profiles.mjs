import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {findQQBuildProfile} from './qq-profiles.mjs';

/* 未登记 QQ 版本的「现场推导 + 成对补丁包」：
   - 内建表命中（findQQBuildProfile）直接返回原始随包 loader/DLL 路径，不 staging、不拷贝、不改参数。
   - 未命中时用 qq-profile-scan.mjs 从目标 wrapper.node 复原 14 个 RVA，生成成对补丁包：
     alcor-host.dll' 的一个 profile 槽位写入新 profile；qq-host-loader.exe' 内嵌的宿主 DLL sha256
     指向 DLL'，且 loader 自己的目标哈希槽位同步改成本版本。两者必须成对出现——只改 DLL 会被
     loader 的 artifact_identity 校验挡下（HOST_ARTIFACT_INVALID）。
   - 任何一步失败都抛带码错误并清掉半成品目录；成功后的包按 wrapper sha256 缓存，命中不再扫描。 */

/* F5/F7/F6/F9 修订（polish2 副本，对应部署树 native-core/host-profiles.mjs）：
   - F5 扫描改异步 spawn：现场扫 117MB wrapper 需数秒，spawnSync 会把整个核心事件循环冻住。
   - F7 manifest 记录 scannerSha256（扫描器文件指纹）；读缓存时与当前扫描器指纹比对，扫描器升级即自动失效重建。
   - F6 跨进程互斥：<sha16>.building.json 锁 + 等待消费 + 超时接管；多进程并发同 sha 只产出一个 pack，
     他人新鲜 marker 不删不抢，失败清理不误删他实例的新包（rename 失败先验现存包再决定）。
   - F9 sha 不一致自愈：构建前重读盘上 wrapper 重算一次（发现→连接之间 QQ 自动更新即被吸收）；
     扫描不一致时重读盘 + 重扫一次再判定，仍不一致才抛 PROFILE_SCAN_MISMATCH，文案同时给出两个 sha8。
   - nativeDir 也开放为 options 覆盖项，便于在部署树外跑自检（默认行为不变）。 */
const defaultNativeDir=fileURLToPath(new URL('../artifacts/native/',import.meta.url));
const defaultScannerPath=fileURLToPath(new URL('../tools/qq-profile-scan.mjs',import.meta.url));
const LOADER_NAME='qq-host-loader.exe';
const DLL_NAME='alcor-host.dll';
/* 与 tools/qq-profile-scan.mjs 的 FIELD_ORDER 一致：扫描输出按这个顺序取 14 个 RVA。 */
const FIELD_ORDER=['service_getter','release','string_construct','string_destroy','callback_move','callback_present','callback_destroy','service_global','core_global','service_vtable','core_vtable','account_pair','send','receive'];
const RVA_MAX=0x10000000;
const ENTRY_SIZE=0xA0;        // {char* version; char* sha256; uint8_t digest[32]; uintptr_t rvas[14]}
const ENTRY_DIGEST_OFF=0x10;
const ENTRY_RVAS_OFF=0x30;
const SHA_ASCII_LEN=64;
const KNOWN_CODES=new Set(['PROFILE_SCANNER_MISSING','PROFILE_SCAN_FAILED','PROFILE_SCAN_MISMATCH','PROFILE_WRAPPER_NOT_FOUND','PROFILE_VERSION_UNSUPPORTED','PROFILE_PATCH_FAILED','PROFILE_VERIFY_FAILED','PROFILE_PACK_FAILED']);
const inFlight=new Map();
/* F6：跨进程构建互斥——同一 sha 的补丁包同一时刻只允许一个进程真正构建：
   - 想建包的进程先以 O_EXCL 创建 <sha16>.building.json（记录 pid/host/startedAt）；
   - 他人新鲜 marker 不删不抢，轮询等待，期间包就绪即直接消费（cacheHit 每轮重查）；
   - 只有 marker 超过 ALCOR_PROFILE_BUILD_STALE_MS（默认 360000 = 扫描超时 300s + 余量）没心跳才允许接管：
     先原子改名挪走旧 marker（仅一个进程能成功），再创建自己的；
   - 持锁构建期间每 5s touch 一次 marker 续命；崩溃进程的 marker 因 mtime 停更而过期，被后来者接管。 */
const BUILD_LOCK_POLL_MS=200;
const BUILD_HEARTBEAT_MS=5000;
function buildStaleMs(){
  const n=Number(process.env.ALCOR_PROFILE_BUILD_STALE_MS);
  return Number.isFinite(n)&&n>0?n:360000;
}
const sleep=(ms)=>new Promise((r)=>{setTimeout(r,ms);});
function buildMarkerPath(actualRoot,sha256){return path.join(actualRoot,sha256.slice(0,16)+'.building.json');}
function writeBuildMarker(marker){
  const fd=fs.openSync(marker,'wx');
  try{fs.writeSync(fd,JSON.stringify({pid:process.pid,host:os.hostname(),startedAt:Date.now()}));}
  finally{fs.closeSync(fd);}
}
function markerAgeMs(marker){try{return Date.now()-fs.statSync(marker).mtimeMs;}catch{return Infinity;}}
function markerOwnedByUs(marker){
  try{const m=JSON.parse(fs.readFileSync(marker,'utf8'));return !!m&&m.pid===process.pid&&m.host===os.hostname();}
  catch{return false;}
}
/** 拿到构建权（owned:true）或等到他人产物就绪（{hit}）。新鲜 marker 永不删除；超时才接管。 */
async function acquireBuildLock({marker,cacheHit}){
  for(;;){
    const hit=cacheHit();
    if(hit)return {owned:false,hit};
    if(markerAgeMs(marker)===Infinity){
      try{writeBuildMarker(marker);return {owned:true,marker};}
      catch(e){
        if(e.code==='EEXIST'){await sleep(BUILD_LOCK_POLL_MS);continue;}
        throw e;
      }
    }
    if(markerAgeMs(marker)>=buildStaleMs()){
      const dead=marker+'.stale-'+process.pid+'-'+Date.now();
      try{fs.renameSync(marker,dead);}catch{}
      try{fs.rmSync(dead,{recursive:true,force:true});}catch{}
      continue;
    }
    await sleep(BUILD_LOCK_POLL_MS);
  }
}
const ASCII_PATH=/^[\x20-\x7e]+$/;
function isAsciiPath(p){return typeof p==='string'&&ASCII_PATH.test(p);}

function fail(code,detail){
  const e=new Error(code);
  e.code=code;
  if(detail)e.detail=String(detail).slice(0,240);
  throw e;
}
function sha256hex(buf){return createHash('sha256').update(buf).digest('hex');}
function scannerFingerprint(scannerPath){
  try{return sha256hex(fs.readFileSync(scannerPath));}catch{return null;}
}
function computeProfileChecksum(profile){
  const canonical=JSON.stringify({version:profile.version,sha256:profile.sha256,rvas:profile.rvas});
  return sha256hex(canonical);
}
function probeWritable(dir){
  fs.mkdirSync(dir,{recursive:true});
  const probe=path.join(dir,'.write-test-'+process.pid);
  fs.writeFileSync(probe,'');
  fs.rmSync(probe);
  return true;
}
function resolvePackRoot(requested){
  if(requested){
    if(!isAsciiPath(requested))fail('PROFILE_PACK_FAILED','packRoot contains non-ASCII characters: '+requested);
    try{probeWritable(requested); return requested;}catch(e){fail('PROFILE_PACK_FAILED','packRoot is not writable: '+requested+' ('+e.message+')');}
  }
  const candidates=[
    defaultPackRoot(),
    path.join(process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir(),'Alcor','host-profiles'),
    path.join(os.tmpdir(),'Alcor','host-profiles'),
  ];
  for(const c of candidates){
    if(!isAsciiPath(c))continue;
    try{probeWritable(c); return c;}catch{}
  }
  fail('PROFILE_PACK_FAILED','no writable ASCII pack root found among default/dataDir/tmpdir');
}
function deriveWrapperPath(qqExePath,sha256){
  if(!qqExePath||typeof qqExePath!=='string')return {wrapperPath:null,tried:[]};
  const base=path.dirname(qqExePath);
  const tried=[path.join(base,'resources','app','wrapper.node')];
  const existing=[];
  if(fs.existsSync(tried[0]))existing.push(tried[0]);
  const versionsDir=path.join(base,'versions');
  if(fs.existsSync(versionsDir)&&fs.statSync(versionsDir).isDirectory()){
    for(const entry of fs.readdirSync(versionsDir,{withFileTypes:true})){
      if(!entry.isDirectory())continue;
      const p=path.join(versionsDir,entry.name,'resources','app','wrapper.node');
      tried.push(p);
      if(fs.existsSync(p))existing.push(p);
    }
  }
  if(sha256){
    for(const p of existing){
      try{const h=sha256hex(fs.readFileSync(p));if(h===sha256)return {wrapperPath:p,tried};}catch{}
    }
  }
  return {wrapperPath:existing[0]||null,tried};
}

// ---------- PE helpers（只读解析，用来把表项里的 VA 指针换算回文件偏移） ----------
function parsePE(buf){
  if(buf.length<0x40)fail('PROFILE_PATCH_FAILED','file too small to be a PE');
  const pe=buf.readUInt32LE(0x3c);
  if(pe+0x18>buf.length||buf.readUInt32LE(pe)!==0x00004550)fail('PROFILE_PATCH_FAILED','missing PE signature');
  const opt=pe+24,magic=buf.readUInt16LE(opt);
  if(magic!==0x20b)fail('PROFILE_PATCH_FAILED','not a PE32+ (x64) image');
  const imageBase=buf.readBigUInt64LE(opt+24);
  const numSec=buf.readUInt16LE(pe+6),optSize=buf.readUInt16LE(pe+20),secTab=opt+optSize;
  const sections=[];
  for(let i=0;i<numSec;i+=1){
    const o=secTab+i*40;
    if(o+40>buf.length)break;
    sections.push({va:buf.readUInt32LE(o+12),vsize:buf.readUInt32LE(o+8),rsize:buf.readUInt32LE(o+16),roff:buf.readUInt32LE(o+20)});
  }
  const rva2off=(rva)=>{
    for(const s of sections){
      const span=Math.max(s.vsize,s.rsize);
      if(rva>=s.va&&rva<s.va+span&&rva-s.va<s.rsize)return s.roff+(rva-s.va);
    }
    if(rva>=0&&rva<sections[0]?.roff)return rva; // 头部区间
    return -1;
  };
  const off2rva=(off)=>{
    for(const s of sections)if(off>=s.roff&&off<s.roff+s.rsize)return s.va+(off-s.roff);
    return off;
  };
  return {imageBase,sections,rva2off,off2rva};
}

// ---------- profile 表定位：按 {version\0 sha256\0} 字符串对 + 指回它们的 0xA0 结构体验证 ----------
function locateProfileTable(buf){
  const pe=parsePE(buf);
  const text=buf.toString('latin1');
  const entries=new Map();
  const re=/([0-9a-f]{64})\x00/g;
  let m;
  while((m=re.exec(text))!==null){
    const shaOff=m.index;
    if(shaOff<2||text.charCodeAt(shaOff-1)!==0)continue;   // 前一个槽位（version）的 NUL 结尾
    // version 槽位最多 13 字节（12 字符 + NUL），向前找回开头
    let vStart=shaOff-1;
    const lo=Math.max(0,shaOff-14);
    while(vStart>lo&&text.charCodeAt(vStart-1)!==0)vStart-=1;
    const version=text.slice(vStart,shaOff-1);
    if(!/^[0-9A-Za-z._-]{2,12}$/.test(version)||!version.includes('.'))continue;
    const sha=m[1];
    const digest=Buffer.from(sha,'hex');
    let dOff=-1;
    while((dOff=buf.indexOf(digest,dOff+1))!==-1){
      const entryOff=dOff-ENTRY_DIGEST_OFF;
      if(entryOff<16)continue;
      if(entries.has(entryOff))continue;
      const versionPtr=buf.readBigUInt64LE(entryOff);
      const shaPtr=buf.readBigUInt64LE(entryOff+8);
      const expectV=pe.imageBase+BigInt(pe.off2rva(vStart));
      const expectS=pe.imageBase+BigInt(pe.off2rva(shaOff));
      if(versionPtr!==expectV||shaPtr!==expectS)continue;
      const rvasOff=entryOff+ENTRY_RVAS_OFF;
      if(rvasOff+112>buf.length)continue;
      const rvas=[];
      let ok=true;
      for(let i=0;i<14;i+=1){
        const v=Number(buf.readBigUInt64LE(rvasOff+i*8));
        if(!Number.isSafeInteger(v)||v<=0||v>=RVA_MAX){ok=false;break;}
        rvas.push(v);
      }
      if(!ok)continue;
      entries.set(entryOff,{entryOff,versionOff:vStart,shaOff,digestOff:dOff,rvasOff,version,sha256:sha,rvas});
    }
  }
  const table=[...entries.values()].sort((a,b)=>a.entryOff-b.entryOff);
  if(table.length<2)fail('PROFILE_PATCH_FAILED','profile table not found or has fewer than 2 slots (found '+table.length+')');
  for(let i=1;i<table.length;i+=1)
    if(table[i].entryOff-table[i-1].entryOff!==ENTRY_SIZE)fail('PROFILE_PATCH_FAILED','profile table stride is not 0xA0 — unknown layout');
  return table;
}

// ---------- 槽位补丁（同长度原地写：版本槽补 NUL，sha 槽固定 65 字节，digest 32B，rvas 14×8B） ----------
function patchProfileSlot(buf,entry,profile){
  const verSlotLen=entry.shaOff-entry.versionOff;
  const nv=Buffer.from(profile.version,'latin1');
  if(nv.length+1>verSlotLen)fail('PROFILE_VERSION_UNSUPPORTED','version "'+profile.version+'" does not fit the '+verSlotLen+'-byte slot');
  buf.fill(0,entry.versionOff,entry.versionOff+verSlotLen);
  nv.copy(buf,entry.versionOff);
  buf.fill(0,entry.shaOff,entry.shaOff+SHA_ASCII_LEN+1);
  buf.write(profile.sha256,entry.shaOff,'latin1');
  Buffer.from(profile.sha256,'hex').copy(buf,entry.digestOff);
  for(let i=0;i<14;i+=1)buf.writeBigUInt64LE(BigInt(profile.rvas[i]),entry.rvasOff+i*8);
  return [
    [entry.versionOff,verSlotLen],
    [entry.shaOff,SHA_ASCII_LEN+1],
    [entry.digestOff,32],
    [entry.rvasOff,112],
  ];
}

// ---------- loader 内嵌的宿主 DLL sha256：优先用「当前 DLL 实哈希」定位，退回 lb_qq_host_start_v1 前 65 字节 ----------
function patchLoaderArtifactSha(buf,oldDllSha,newDllSha){
  const needle=Buffer.from(oldDllSha,'latin1');
  const hits=[];
  let h=-1;
  while((h=buf.indexOf(needle,h+1))!==-1)hits.push(h);
  let off;
  if(hits.length===1)off=hits[0];
  else if(hits.length===0){
    const anchor=buf.indexOf(Buffer.from('lb_qq_host_start_v1','latin1'));
    if(anchor<65)fail('PROFILE_PATCH_FAILED','cannot locate the embedded dll sha256 in the loader');
    const cand=anchor-65;
    if(buf[cand+64]!==0||!/^[0-9a-f]{64}$/.test(buf.toString('latin1',cand,cand+64)))
      fail('PROFILE_PATCH_FAILED','embedded dll sha256 slot in the loader is malformed');
    off=cand;
  }else fail('PROFILE_PATCH_FAILED','embedded dll sha256 occurs '+hits.length+' times in the loader');
  buf.write(newDllSha,off,'latin1');
  return [off,SHA_ASCII_LEN];
}

function diffOutsideRegions(a,b,regions,label){
  if(a.length!==b.length)fail('PROFILE_VERIFY_FAILED',label+' size changed: '+a.length+' -> '+b.length);
  const spans=regions.map(([off,len])=>[off,off+len]).sort((x,y)=>x[0]-y[0]);
  let ri=0;
  for(let i=0;i<a.length;i+=1){
    while(ri<spans.length&&i>=spans[ri][1])ri+=1;
    if(ri<spans.length&&i>=spans[ri][0]&&i<spans[ri][1])continue;
    if(a[i]!==b[i])fail('PROFILE_VERIFY_FAILED',label+' changed outside the patch regions at 0x'+i.toString(16));
  }
}

function validateProfile(profile){
  if(!profile||typeof profile!=='object')fail('PROFILE_SCAN_FAILED','scanner returned no profile object');
  if(!/^[0-9A-Za-z._-]{1,12}$/.test(profile.version||''))fail('PROFILE_VERSION_UNSUPPORTED','bad version "'+profile.version+'"');
  if(!/^[0-9a-f]{64}$/.test(profile.sha256||''))fail('PROFILE_SCAN_FAILED','bad sha256 in scanned profile');
  if(!Array.isArray(profile.rvas)||profile.rvas.length!==14)fail('PROFILE_SCAN_FAILED','scanner returned '+(profile.rvas?.length??0)+'/14 RVAs');
  for(const v of profile.rvas)if(!Number.isInteger(v)||v<=0||v>=RVA_MAX)fail('PROFILE_SCAN_FAILED','RVA out of range: '+v);
}

function pickSlot(table,sha256){
  const same=table.findIndex(e=>e.sha256===sha256);
  if(same>=0)return same;            // 幂等：重打同一版本时写回同一槽
  return 1;                          // 约定：保留 0 号槽，改写 1 号槽
}

function buildPairedArtifacts(dllBuf,loaderBuf,profile){
  const dllTable=locateProfileTable(dllBuf);
  const loaderTable=locateProfileTable(loaderBuf);
  const dllSlot=pickSlot(dllTable,profile.sha256);
  const loaderSlot=pickSlot(loaderTable,profile.sha256);
  const oldDllSha=sha256hex(dllBuf);
  const newDll=Buffer.from(dllBuf);
  const dllRegions=patchProfileSlot(newDll,dllTable[dllSlot],profile);
  const newDllSha=sha256hex(newDll);
  const newLoader=Buffer.from(loaderBuf);
  const loaderRegions=patchProfileSlot(newLoader,loaderTable[loaderSlot],profile);
  loaderRegions.push(patchLoaderArtifactSha(newLoader,oldDllSha,newDllSha));
  // 自检 1：只允许落在补丁区间内的差异
  diffOutsideRegions(dllBuf,newDll,dllRegions,'dll');
  diffOutsideRegions(loaderBuf,newLoader,loaderRegions,'loader');
  // 自检 2：补丁后的表能被重新解析，且目标槽内容与新 profile 完全一致
  const reDll=locateProfileTable(newDll);
  const reEntry=reDll.find(e=>e.sha256===profile.sha256);
  if(!reEntry||reEntry.version!==profile.version||reEntry.rvas.join(',')!==profile.rvas.join(','))
    fail('PROFILE_VERIFY_FAILED','patched dll profile slot failed re-parse verification');
  const reLoader=locateProfileTable(newLoader);
  const reLoaderEntry=reLoader.find(e=>e.sha256===profile.sha256);
  if(!reLoaderEntry||reLoaderEntry.rvas.join(',')!==profile.rvas.join(','))
    fail('PROFILE_VERIFY_FAILED','patched loader target slot failed re-parse verification');
  // 自检 3：loader 内嵌的 dll 哈希必须指向新 DLL，旧哈希必须消失
  if(!newLoader.includes(newDllSha))fail('PROFILE_VERIFY_FAILED','patched loader does not embed the new dll sha256');
  if(oldDllSha!==newDllSha&&newLoader.includes(oldDllSha))fail('PROFILE_VERIFY_FAILED','patched loader still embeds the old dll sha256');
  return {newDll,newLoader,newDllSha};
}

function defaultPackRoot(){
  const base=process.env.ALCOR_PROFILE_PACK_DIR||process.env.ProgramData||process.env.ALLUSERSPROFILE||os.tmpdir();
  return path.join(base,'Alcor','host-profiles');
}

function readValidPack(packDir,sha256,scannerSha){
  try{
    const manifestPath=path.join(packDir,'profile.json');
    const dllPath=path.join(packDir,DLL_NAME);
    const loaderPath=path.join(packDir,LOADER_NAME);
    if(!fs.existsSync(manifestPath)||!fs.existsSync(dllPath)||!fs.existsSync(loaderPath))return null;
    const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
    if(manifest?.sha256!==sha256||!Array.isArray(manifest?.rvas)||manifest.rvas.length!==14)return null;
    // F7：扫描器换版本（或旧 manifest 没有指纹字段）→ 缓存失效，整体重建
    if(scannerSha&&manifest.scannerSha256!==scannerSha)return null;
    if(computeProfileChecksum({version:manifest.version,sha256:manifest.sha256,rvas:manifest.rvas})!==manifest.checksum)return null;
    const dll=fs.readFileSync(dllPath);
    if(sha256hex(dll)!==manifest.dllSha256)return null;
    const dllTable=locateProfileTable(dll);
    const dllSlot=dllTable.find(e=>e.sha256===sha256);
    if(!dllSlot||dllSlot.version!==manifest.version||dllSlot.rvas.join(',')!==manifest.rvas.join(','))return null;
    const loaderBuf=fs.readFileSync(loaderPath);
    if(!loaderBuf.includes(manifest.dllSha256))return null;
    const loaderTable=locateProfileTable(loaderBuf);
    const loaderSlot=loaderTable.find(e=>e.sha256===sha256);
    if(!loaderSlot||loaderSlot.rvas.join(',')!==manifest.rvas.join(','))return null;
    return {manifest,loaderPath,dllPath};
  }catch{return null;}
}

/* F5：异步扫描。与 spawnSync 版语义一致（超时 300s、stdout 上限 16MB、失败带 stderr 尾），
   但不占事件循环——扫描期间管理面、心跳、面板探测照常响应。 */
function runScannerProcess(scannerPath,wrapperPath,timeoutMs){
  return new Promise((resolve)=>{
    let stdout='',stderr='',timedOut=false,overflow=false,spawnError=null;
    const child=spawn(process.execPath,[scannerPath,wrapperPath,'--json'],{windowsHide:true});
    const timer=setTimeout(()=>{timedOut=true;child.kill();},timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data',(c)=>{stdout+=c;if(stdout.length>16*1024*1024){overflow=true;child.kill();}});
    child.stderr.on('data',(c)=>{stderr=(stderr+c).slice(-65536);});
    child.on('error',(e)=>{spawnError=e;});
    child.on('close',(code)=>{clearTimeout(timer);resolve({code,stdout,stderr,timedOut,overflow,spawnError});});
  });
}
async function defaultScanNow({scannerPath,wrapperPath}){
  if(!fs.existsSync(scannerPath))fail('PROFILE_SCANNER_MISSING',scannerPath);
  const r=await runScannerProcess(scannerPath,wrapperPath,300000);
  if(r.spawnError)fail('PROFILE_SCAN_FAILED',String(r.spawnError.message||r.spawnError));
  if(r.timedOut)fail('PROFILE_SCAN_FAILED','scanner timed out after 300s');
  if(r.overflow)fail('PROFILE_SCAN_FAILED','scanner output exceeded 16MB');
  if(r.code!==0)fail('PROFILE_SCAN_FAILED',(r.stderr||r.stdout||'exit '+r.code).trim());
  let data;
  try{data=JSON.parse(r.stdout);}catch{fail('PROFILE_SCAN_FAILED','scanner did not emit JSON');}
  return data;
}

/** 内建命中 → 原路径直通；未登记 → 现场扫描 + 成对补丁包（带缓存）。 */
export async function ensureProfilePack({
  moduleName='wrapper.node',
  sha256='',
  version='',
  wrapperPath=null,
  qqExePath=null,
  packRoot=null,
  nativeDir=defaultNativeDir,
  scannerPath=defaultScannerPath,
  scanNow=defaultScanNow,
}={}){
  sha256=String(sha256||'').toLowerCase();
  const known=sha256?findQQBuildProfile(moduleName,sha256):null;
  if(known){
    return {
      staged:false,derived:false,cached:true,packDir:null,profile:known,
      loader:path.join(nativeDir,LOADER_NAME),
      dll:path.join(nativeDir,DLL_NAME),
    };
  }
  const actualRoot=resolvePackRoot(packRoot);
  let pending=inFlight.get(sha256);
  if(pending)return pending;
  const build=(async()=>{
    if(!/^[0-9a-f]{64}$/.test(sha256))fail('PROFILE_SCAN_MISMATCH','inventory row carries no valid wrapper sha256');
    let wp=wrapperPath;
    const tried=[];
    if(wp){
      tried.push(wp);
    }else if(qqExePath){
      const derived=deriveWrapperPath(qqExePath,sha256);
      wp=derived.wrapperPath;
      tried.push(...derived.tried);
    }
    if(!wp||!fs.existsSync(wp))fail('PROFILE_WRAPPER_NOT_FOUND','tried paths: '+(tried.length?tried.join('; '):'(none)'));
    fs.mkdirSync(actualRoot,{recursive:true});
    const scannerSha=scannerFingerprint(scannerPath);
    const readDiskSha=()=>{try{return sha256hex(fs.readFileSync(wp)).toLowerCase();}catch{return '';}};
    const doScan=async()=>{
      try{return await scanNow({scannerPath,wrapperPath:wp});}
      catch(e){if(e&&KNOWN_CODES.has(e.code))throw e;fail('PROFILE_SCAN_FAILED',e?.message||e);}
    };
    let sha=sha256;                    // 本轮权威 sha：以盘上实际字节为准，随自愈更新
    let healedFromStale=null;          // F9：调用方登记 sha 过期时记录原值
    let pendingScan=null;              // 换 sha 重来时保留的扫描结果，避免重复扫
    for(let round=0;round<3;round+=1){
      // F9 预检：发现→连接之间 wrapper 可能被 QQ 更新——重读盘重算一次，不一致就以实际文件为准
      const diskSha=readDiskSha();
      if(diskSha&&diskSha!==sha){
        if(sha===sha256)healedFromStale=sha256;
        sha=diskSha;
        pendingScan=null;              // 文件已换，旧扫描结果作废
      }
      const known2=findQQBuildProfile(moduleName,sha);
      if(known2){
        return {staged:false,derived:false,cached:true,packDir:null,profile:known2,
          loader:path.join(nativeDir,LOADER_NAME),dll:path.join(nativeDir,DLL_NAME),
          ...(healedFromStale?{healedFromStale}:{})};
      }
      const packDir=path.join(actualRoot,sha.slice(0,16));
      const cacheHit=()=>readValidPack(packDir,sha,scannerSha);
      const hit=cacheHit();
      if(hit){
        return {staged:true,derived:true,cached:true,waitedForLock:false,builtByUs:false,packRoot:actualRoot,packDir,loader:hit.loaderPath,dll:hit.dllPath,
          profile:{version:hit.manifest.version,sha256:sha,rvas:hit.manifest.rvas},...(healedFromStale?{healedFromStale}:{})};
      }
      // F6：跨进程互斥——同一 sha 只有一个进程真正构建，其余等产物就绪
      const marker=buildMarkerPath(actualRoot,sha);
      const lock=await acquireBuildLock({marker,cacheHit});
      if(!lock.owned){
        return {staged:true,derived:true,cached:true,waitedForLock:true,builtByUs:false,packRoot:actualRoot,packDir,loader:lock.hit.loaderPath,dll:lock.hit.dllPath,
          profile:{version:lock.hit.manifest.version,sha256:sha,rvas:lock.hit.manifest.rvas},...(healedFromStale?{healedFromStale}:{})};
      }
      let heartbeat=null;
      try{
        const hit2=cacheHit();         // 等锁期间对方可能已建好
        if(hit2){
          return {staged:true,derived:true,cached:true,waitedForLock:true,builtByUs:false,packRoot:actualRoot,packDir,loader:hit2.loaderPath,dll:hit2.dllPath,
            profile:{version:hit2.manifest.version,sha256:sha,rvas:hit2.manifest.rvas},...(healedFromStale?{healedFromStale}:{})};
        }
        heartbeat=setInterval(()=>{try{const now=new Date();fs.utimesSync(marker,now,now);}catch{}},BUILD_HEARTBEAT_MS);
        if(heartbeat.unref)heartbeat.unref();
        let scan=pendingScan;
        pendingScan=null;
        if(!scan||String(scan.sha256||'').toLowerCase()!==sha)scan=await doScan();
        const scannedSha=String(scan?.sha256||'').toLowerCase();
        if(!scannedSha||scannedSha!==sha){
          // F9：不一致先自愈——重读盘重算一次 + 重扫一次再判定；仍不一致才抛，文案同时给出两个 sha8
          const reDisk=readDiskSha();
          const scan2=await doScan();
          const scanned2=String(scan2?.sha256||'').toLowerCase();
          if(reDisk&&scanned2===reDisk&&reDisk===sha){
            scan=scan2;                // 首扫是偶发错读，重扫已与盘上一致 → 继续
          }else if(reDisk&&scanned2===reDisk&&reDisk!==sha){
            pendingScan=scan2;         // 盘上文件又更新了 → 换新 sha 重来一轮（复用本次扫描）
            continue;
          }else{
            const scanned=(scanned2||scannedSha||'');
            fail('PROFILE_SCAN_MISMATCH','wrapper sha256 mismatch (re-read and rescanned once): expected '+sha.slice(0,8)+' ('+sha+'), scanned '+scanned.slice(0,8)+' ('+scanned+')');
          }
        }
        const profile={version:String(version||scan.selfCheck?.version||''),sha256:sha,rvas:FIELD_ORDER.map(f=>{
          const raw=scan.rvas?.[f];
          const v=typeof raw==='string'&&raw.startsWith('0x')?Number.parseInt(raw,16):raw;
          return v;
        })};
        validateProfile(profile);
        const tmp=fs.mkdtempSync(path.join(actualRoot,'.pack-'));
        try{
          const dllBuf=fs.readFileSync(path.join(nativeDir,DLL_NAME));
          const loaderBuf=fs.readFileSync(path.join(nativeDir,LOADER_NAME));
          const {newDll,newLoader,newDllSha}=buildPairedArtifacts(dllBuf,loaderBuf,profile);
          fs.writeFileSync(path.join(tmp,DLL_NAME),newDll);
          fs.writeFileSync(path.join(tmp,LOADER_NAME),newLoader);
          const manifest={version:profile.version,sha256:profile.sha256,rvas:profile.rvas,dllSha256:newDllSha,checksum:computeProfileChecksum(profile),builtAt:new Date().toISOString(),scanner:path.basename(scannerPath),scannerSha256:scannerSha};
          fs.writeFileSync(path.join(tmp,'profile.json'),JSON.stringify(manifest,null,2));
          // 落盘回读校验：成对性以盘上字节为准
          if(sha256hex(fs.readFileSync(path.join(tmp,DLL_NAME)))!==newDllSha)fail('PROFILE_VERIFY_FAILED','dll hash drift after write');
          if(!fs.readFileSync(path.join(tmp,LOADER_NAME)).includes(newDllSha))fail('PROFILE_VERIFY_FAILED','loader on disk does not embed the new dll sha256');
          // F6：rename 失败先验现存包——他人可用的新包不覆盖、不误删，直接采用
          try{
            fs.rmSync(packDir,{recursive:true,force:true});
            fs.renameSync(tmp,packDir);
          }catch(e){
            const existing=cacheHit();
            if(existing){
              try{fs.rmSync(tmp,{recursive:true,force:true});}catch{}
              return {staged:true,derived:true,cached:true,adopted:true,waitedForLock:false,builtByUs:false,packRoot:actualRoot,packDir,loader:existing.loaderPath,dll:existing.dllPath,
                profile:{version:existing.manifest.version,sha256:sha,rvas:existing.manifest.rvas},...(healedFromStale?{healedFromStale}:{})};
            }
            throw e;
          }
          return {staged:true,derived:true,cached:false,waitedForLock:false,builtByUs:true,packRoot:actualRoot,packDir,
            loader:path.join(packDir,LOADER_NAME),dll:path.join(packDir,DLL_NAME),profile,...(healedFromStale?{healedFromStale}:{})};
        }catch(e){
          try{fs.rmSync(tmp,{recursive:true,force:true});}catch{}
          // F6：失败清理只清自己的 tmp 残留；packDir 仅在不是他人可用包时才清
          if(!cacheHit()){try{fs.rmSync(packDir,{recursive:true,force:true});}catch{}}
          if(e&&KNOWN_CODES.has(e.code))throw e;
          fail('PROFILE_PACK_FAILED',e?.message||e);
        }
      }finally{
        if(heartbeat)clearInterval(heartbeat);
        try{if(markerOwnedByUs(marker))fs.rmSync(marker,{force:true});}catch{}
      }
    }
    fail('PROFILE_SCAN_MISMATCH','wrapper file kept changing during pack build (3 rounds)');
  })();
  inFlight.set(sha256,build);
  build.finally(()=>inFlight.delete(sha256)).catch(()=>{});
  return build;
}

export const _internals={parsePE,locateProfileTable,patchProfileSlot,patchLoaderArtifactSha,buildPairedArtifacts,sha256hex,validateProfile,FIELD_ORDER,RVA_MAX,inFlight,deriveWrapperPath,readValidPack,scannerFingerprint};
