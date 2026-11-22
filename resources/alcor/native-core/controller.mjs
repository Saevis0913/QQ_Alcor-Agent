import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {queryNativeHost} from './host-client.mjs';
import {discoverQQ} from './discovery.mjs';
import {ensureProfilePack} from './host-profiles.mjs';
import {findQQBuildProfile} from './qq-profiles.mjs';
import {readIdentityMemory,pickAccount} from './identity-fallback.mjs';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const run=promisify(execFile);
const nativeDir=fileURLToPath(new URL('../artifacts/native/',import.meta.url));
/* 注入是由目标进程自己去 LoadLibrary 我们的 alcor-host.dll。
   安装路径带中文、或长到逼近 MAX_PATH 时，目标进程里那一步会失败，用户只看到「注入失败」。
   所以路径不干净时，先把加载器和 DLL 搬到纯 ASCII、短路径（ProgramData\Alcor\host\<目录哈希>）再从那里注入。
   路径本来干净就不拷贝，保持原行为。 */
const HOST_FILES=['qq-host-loader.exe','alcor-host.dll'];
const ASCII_PATH=/^[\x20-\x7e]+$/;
function stageDirFor(dir){
  if(ASCII_PATH.test(dir)&&dir.length<=160)return null;
  const base=process.env.ProgramData||process.env.ALLUSERSPROFILE||os.tmpdir();
  const tag=createHash('sha256').update(dir).digest('hex').slice(0,8);
  return path.join(base,'Alcor','host',tag);
}
function hostArtifacts(){
  const stage=stageDirFor(nativeDir);
  if(!stage)return {loader:path.join(nativeDir,'qq-host-loader.exe'),staged:false,dir:nativeDir};
  fs.mkdirSync(stage,{recursive:true});
  for(const name of HOST_FILES){
    const src=path.join(nativeDir,name);const out=path.join(stage,name);
    const from=fs.statSync(src);const to=fs.existsSync(out)?fs.statSync(out):null;
    if(!to||to.size!==from.size||to.mtimeMs<from.mtimeMs)fs.copyFileSync(src,out);
  }
  return {loader:path.join(stage,'qq-host-loader.exe'),staged:true,dir:stage};
}
async function load(pid,nonce,mode,startedAt,loaderOverride){
  const args=[String(pid),String(process.pid),nonce,mode];if(startedAt)args.push(startedAt);
  /* 未登记版本走成对补丁包时由 connect 传入补丁后 loader 的路径；其余情况保持原随包路径。 */
  const loader=loaderOverride||hostArtifacts().loader;
  const r=await run(loader,args,{windowsHide:true,timeout:75000,maxBuffer:8192});
  return JSON.parse(r.stdout);
}
export {hostArtifacts,stageDirFor};
/* 宿主刚装载时服务对象可能还在初始化，identity 会瞬时拿不到账号；
   有界重试把这种瞬时态和「QQ 真的没登录」区分开，避免把两者都报成同一个错误。 */
/* 加载器的 stage 说明注入卡在哪一步：权限/会话、被杀软拦下、还是宿主入口没起来，各对应不同处置。 */
const STAGE_FAILURES={artifact_identity:'HOST_ARTIFACT_INVALID',target_identity:'HOST_TARGET_DENIED',module_already_loaded:'HOST_ALREADY_PRESENT',load_library:'HOST_LOAD_BLOCKED',release_loader_reference:'HOST_REFERENCE_STUCK',start_host:'HOST_ENTRY_FAILED'};
function loaderFailureCode(loaded){
  if(loaded?.pendingThread)return 'HOST_THREAD_PENDING';
  return STAGE_FAILURES[loaded?.stage]||'HOST_START_INCOMPLETE';
}
/* 9.9.37 起 QQ 的 msg service 变成线程局部对象：宿主跑在注入线程上，identity 恒返回 status=6。
   账号 uin 本身仍在 wrapper.node 的 account_pair 单例里，可以只读进程内存拿到。
   这里只做「读一份 uin」，不改 QQ；拿不到就原样返回 null，让上层继续报未登录。 */
const RVA_ACCOUNT_PAIR=11;
const RVA_SERVICE_GLOBAL=7;
// 内建表把 rvas 存成对象（按名字），现场扫出来的是长度 14 的数组，两种都要能取。
function rvaOf(rvas,name,index){
  if(Array.isArray(rvas))return rvas.length===14?rvas[index]:null;
  if(rvas&&typeof rvas==='object')return rvas[name]??null;
  return null;
}
async function readIdentityHint(pid,rvas){
  const accountRva=rvaOf(rvas,'account_pair',RVA_ACCOUNT_PAIR);
  const serviceRva=rvaOf(rvas,'service_global',RVA_SERVICE_GLOBAL);
  if(!Number.isInteger(accountRva)||accountRva<=0)return null;
  const dump=await readIdentityMemory({pid,moduleName:'wrapper.node',rvas:[accountRva,serviceRva]});
  if(!dump.ok)return {account:null,reason:dump.code||'IDENTITY_MEMORY_UNREADABLE'};
  const account=pickAccount(dump.values,accountRva);
  const service=Number.isInteger(serviceRva)?dump.values?.[serviceRva.toString(16)]:null;
  return {account,reason:null,serviceBound:Boolean(service&&service.lo!==0n),base:dump.base};
}
/* 纯决策：宿主 identity 可信就用它；不可信但有内存读到的 uin 就合成；两者都没有才报错。
   拆成纯函数是为了能单测，不依赖真的 QQ 进程。 */
// §5.4：identity 失败要能分辨是哪一段坏了，而不是一律说「读不到」。
export function identityFailureCode(id){
  if(!id)return 'IDENTITY_CALL_FAILED';
  if(id.status===6)return 'IDENTITY_SERVICE_NULL';
  if(id.status===0&&(!id.account||id.account==='0'))return 'IDENTITY_ACCOUNT_ZERO';
  if(id.status!==0)return 'IDENTITY_CALL_FAILED';
  return 'QQ_LOGIN_NOT_CONFIRMED';
}
export function identityDecision(id,hint){
  const bad=!id||id.status!==0||id.flags!==15||!id.account||id.account==='0';
  if(!bad)return {identity:id,source:'host',error:null};
  if(hint&&hint.account)return {identity:{...(id||{}),status:0,account:hint.account,flags:15},source:'memory',error:null,hint};
  return {identity:id||null,source:'host',error:identityFailureCode(id),hint:hint||null};
}
async function readIdentity(query,owner,attempts=3){
  let last=null;
  for(let i=0;i<attempts;i+=1){
    last=await query({...owner,operation:'identity'});
    if(last&&last.status===0&&last.flags===15&&last.account&&last.account!=='0')return last;
    if(i+1<attempts)await new Promise(resolve=>{const timer=setTimeout(resolve,200);timer.unref?.();});
  }
  return last;
}
async function runLoader(loader,pid,nonce,mode,startedAt){
  try{return await loader(pid,nonce,mode,startedAt);}
  catch(error){
    const code=error?.code==='ENOENT'?'HOST_LOADER_MISSING':(error?.killed||error?.signal)?'HOST_LOADER_TIMEOUT':'HOST_LOADER_FAILED';
    const wrapped=new Error(code);wrapped.stage=null;wrapped.status=null;wrapped.detail=String(error?.message||'').slice(0,160);throw wrapped;
  }
}
export class NativeController {
  constructor({inventory=discoverQQ,loader=load,query=queryNativeHost,heartbeatMs=5000}={}){
    this.inventory=inventory;this.loader=loader;this.query=query;this.heartbeatMs=heartbeatMs;
    this.owner=null;this.ownerGeneration=0;this.pending=null;this.disconnecting=null;this.tail=Promise.resolve();this.lastError=null;this.lastFailure=null;this.closed=false;
  }
  snapshot(){return {connected:!!this.owner,pid:this.owner?.pid??null,accountLastFour:this.owner?.account?.slice(-4)??null,receiveReady:false,identitySource:this.owner?.identitySource??null,serviceBound:this.owner?.serviceBound??null,lastError:this.lastError,lastFailure:this.lastFailure};}
  enqueue(fn){const next=this.tail.then(fn);this.tail=next.catch(()=>{});return next;}
  resumeSelection(){
    const owner=this.owner;
    return owner?.startedAt&&owner.account ? {pid:owner.pid,startedAt:owner.startedAt,account:owner.account} : null;
  }
  connect(pid, {startedAt,account,allowUnverified} = {}){
    if(!Number.isInteger(pid)||pid<1||pid>0xffffffff)return Promise.reject(new Error('INVALID_QQ_PID'));
    if((startedAt!==undefined||account!==undefined)&&(!/^[1-9]\d{16,18}$/.test(startedAt||'')||!/^[1-9]\d{0,9}$/.test(account||'')||Number(account)>0xffffffff))return Promise.reject(new Error('INVALID_QQ_SELECTION'));
    if(this.closed)return Promise.reject(new Error('CONTROLLER_CLOSED'));
    if(this.pending)return this.pending.pid===pid&&this.pending.startedAt===startedAt&&this.pending.account===account?this.pending.promise:Promise.reject(new Error('CONNECTION_BUSY'));
    const promise=this.enqueue(async()=>{
      if(this.closed||this.disconnecting)throw new Error('NATIVE_CONNECT_CANCELLED');
      if(this.owner){
        if(this.owner.pid===pid&&(!startedAt||(this.owner.startedAt===startedAt&&this.owner.account===account)))return this.snapshot();
        throw new Error('DISCONNECT_CURRENT_ACCOUNT_FIRST');
      }
      const row=(await this.inventory()).find(r=>r.pid===pid);
      if(!row)throw new Error('QQ_PROCESS_NOT_FOUND');
      let packLoaderPath=null;
      let packProfile=null;
      if(!row.supported){
        // 兼容模式：只有用户明确同意、而且只是「构建未适配」（进程本身可读）时才继续。
        // 其他原因（外来模块、宿主已在、进程读不到）继续拒绝，那些试了只会更糟。
        const relaxable=allowUnverified===true&&(row.reason==='UNSUPPORTED_BUILD'||row.reason==='FAMILY_UNVERIFIED')&&typeof row.path==='string'&&/[\\/]QQ\.exe$/i.test(row.path);
        if(!relaxable)throw new Error('UNSUPPORTED_QQ');
        this.lastError='UNVERIFIED_BUILD_ATTEMPT';
      this.lastUnverified = { version: row.version || '', sha256: row.sha256 || '', at: Date.now() };
      /* 未登记构建：现场推导 profile 并生成成对补丁包（loader' + DLL'），用它代替随包 loader。
         扫描/补丁失败会抛 PROFILE_* 带码错误，由外层 catch 记入 lastFailure。 */
      const pack=await ensureProfilePack({moduleName:row.moduleName||'wrapper.node',sha256:row.sha256,version:row.version||'',wrapperPath: row.modulePath,qqExePath:row.path});
      packLoaderPath=pack.loader;
      packProfile=pack.profile||null;
      }
      const creation=/^[1-9]\d{16,18}$/.test(row.creationTime||'')?row.creationTime:null;
      if(startedAt&&creation!==startedAt)throw new Error('NATIVE_PROCESS_CHANGED');
      const owner={pid,nonce:randomBytes(16).toString('hex'),account:null,startedAt:creation};
      if(this.closed||this.disconnecting)throw new Error('NATIVE_CONNECT_CANCELLED');
      const loaderFn=packLoaderPath?((p,n,m,s)=>this.loader(p,n,m,s,packLoaderPath)):this.loader;
      const inspect=await runLoader(loaderFn,pid,owner.nonce,'inspect-qq',creation);if(inspect.loaded)throw new Error('HOST_ALREADY_PRESENT');
      if(this.closed||this.disconnecting)throw new Error('NATIVE_CONNECT_CANCELLED');
      const loaded=await runLoader(loaderFn,pid,owner.nonce,'qq',creation);
      if(loaded.status!==0||!loaded.loaderReferenceReleased||loaded.pendingThread){
        const failure=loaderFailureCode(loaded);
        this.lastFailure={code:failure,pid,stage:loaded.stage||null,status:typeof loaded.status==='number'?loaded.status:null,at:new Date().toISOString()};
        throw new Error(failure);
      }
      this.owner=owner;
      try {
        const hostId=await readIdentity(this.query.bind(this),owner);
        let identity=hostId, identitySource='host';
        if(!hostId||hostId.status!==0||hostId.flags!==15||!hostId.account||hostId.account==='0'){
          // 宿主取不到 service 时不代表没登录：换只读内存把 uin 取回来，并记下 service 是否为空。
          const hint=await readIdentityHint(pid,packProfile?.rvas||findQQBuildProfile(row.moduleName||'wrapper.node',row.sha256)?.rvas);
          const decision=identityDecision(hostId,hint);
          this.lastIdentityHint={account:decision.identity?.account??null,serviceBound:hint?.serviceBound??null,hostStatus:hostId?.status??null,reason:decision.error||hint?.reason||null,at:new Date().toISOString()};
          if(decision.error)throw new Error(decision.error);
          identity=decision.identity;
          identitySource=decision.source;
          owner.identitySource='memory';
          owner.serviceBound=hint?.serviceBound===true;
        }
        const id=identity;
        if(account&&id.account!==account)throw new Error('NATIVE_ACCOUNT_CHANGED');
        if(this.closed||this.disconnecting)throw new Error('NATIVE_CONNECT_CANCELLED');
        owner.account=id.account;owner.identitySource=identitySource;this.lastError=null;this.lastFailure=null;
        this.timer=setInterval(()=>{if(this.heartbeatPending)return;this.heartbeatPending=true;this.enqueue(async()=>{
          if(this.owner!==owner||this.disconnecting||this.closed)return;
          try{const r=await this.query({...owner,operation:'heartbeat'});if(r.status!==0)throw new Error('HOST_HEARTBEAT_FAILED');const id=await this.query({...owner,operation:'identity'});if(owner.identitySource!=='memory'&&(id.status!==0||id.flags!==15||id.account!==owner.account))throw new Error('HOST_ACCOUNT_CHANGED');}
          catch{this.lastError='HOST_CONNECTION_LOST';clearInterval(this.timer);try{await this.query({...owner,operation:'stop'});}catch{}this.owner=null;}
        }).finally(()=>{this.heartbeatPending=false;});},this.heartbeatMs);this.timer.unref();
        return this.snapshot();
      }catch(error){await this.stopOwned();throw error;}
    }).catch(error=>{this.lastError=/^[A-Z_]+$/.test(error.message)?error.message:'NATIVE_CONNECT_FAILED';this.lastFailure={code:this.lastError,pid,stage:error?.stage??this.lastFailure?.stage??null,status:error?.status??this.lastFailure?.status??null,detail:error?.detail??null,at:new Date().toISOString()};throw new Error(this.lastError);});
    this.pending={pid,startedAt,account,promise};promise.finally(()=>{if(this.pending?.promise===promise)this.pending=null;}).catch(()=>{});return promise;
  }
  request(operation, options = {}) {
    const { expectedAccount, timeoutMs = 4000, nativeTimeoutMs = 3000, ...requestOptions } = options;
    const owner = this.owner, account = owner?.account, generation = this.ownerGeneration;
    if (!account || this.disconnecting || this.closed) return Promise.reject(new Error('NATIVE_NOT_CONNECTED'));
    if (expectedAccount != null && account !== expectedAccount) return Promise.reject(new Error('HOST_ACCOUNT_CHANGED'));
    // 内存兜底确认过账号时，identity 直接给合成结果：宿主那条线程局部路径拿不到 service，问了也是 6。
    if (operation === 'identity' && owner?.identitySource === 'memory') {
      return Promise.resolve({ status: 0, account: owner.account, flags: 15, source: 'memory', serviceBound: owner.serviceBound === true });
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 ||
        !Number.isInteger(nativeTimeoutMs) || nativeTimeoutMs < 1 || nativeTimeoutMs > 10000) {
      return Promise.reject(new Error('HOST_ARGUMENT_INVALID'));
    }

    const deadline = performance.now() + timeoutMs;
    let queueTimer;
    const queuedTimeout = new Promise((_, reject) => {
      queueTimer = setTimeout(() => reject(new Error('HOST_QUEUE_TIMEOUT')), timeoutMs);
    });
    const request = this.enqueue(() => {
      clearTimeout(queueTimer);
      if (!this.owner || this.disconnecting || this.closed) throw new Error('NATIVE_NOT_CONNECTED');
      if (this.owner !== owner || this.owner.account !== account || this.ownerGeneration !== generation) throw new Error('HOST_ACCOUNT_CHANGED');
      const remaining = Math.floor(deadline - performance.now());
      if (remaining < 1) throw new Error('HOST_QUEUE_TIMEOUT');

      // Keep the native wait shorter than the pipe deadline. The pipe timeout starts only at dispatch.
      const pipeOverhead = requestOptions.payload ? Math.min(1000, Math.max(50, timeoutMs - nativeTimeoutMs)) : 0;
      if (remaining <= pipeOverhead) throw new Error('HOST_QUEUE_TIMEOUT');
      return this.query({ ...requestOptions, ...owner, operation, expectedAccount: account,
        timeoutMs: remaining, nativeTimeoutMs: Math.min(nativeTimeoutMs, remaining - pipeOverhead) });
    });
    return Promise.race([request, queuedTimeout]);
  }
  async stopOwned(){
    clearInterval(this.timer);const owner=this.owner;if(!owner)return;
    try{const r=await this.query({...owner,operation:'stop'});if(r.status!==0)throw new Error('HOST_STOP_FAILED');}
    finally{this.owner=null;}
  }
  disconnect() {
    if (this.disconnecting) return this.disconnecting;
    this.ownerGeneration++;
    const stop = this.enqueue(() => this.stopOwned());
    this.disconnecting = stop;
    stop.finally(() => { if (this.disconnecting === stop) this.disconnecting = null; }).catch(() => {});
    return stop;
  }
  async close(){this.closed=true;await this.disconnect();}
}
export {readIdentityHint};
