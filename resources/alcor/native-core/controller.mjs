import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {queryNativeHost} from './host-client.mjs';
import {discoverQQ} from './discovery.mjs';
const run=promisify(execFile);
const loaderPath=fileURLToPath(new URL('../artifacts/native/qq-host-loader.exe',import.meta.url));
async function load(pid,nonce,mode,startedAt){
  const args=[String(pid),String(process.pid),nonce,mode];if(startedAt)args.push(startedAt);
  const r=await run(loaderPath,args,{windowsHide:true,timeout:75000,maxBuffer:8192});
  return JSON.parse(r.stdout);
}
/* 宿主刚装载时服务对象可能还在初始化，identity 会瞬时拿不到账号；
   有界重试把这种瞬时态和「QQ 真的没登录」区分开，避免把两者都报成同一个错误。 */
/* 加载器的 stage 说明注入卡在哪一步：权限/会话、被杀软拦下、还是宿主入口没起来，各对应不同处置。 */
const STAGE_FAILURES={artifact_identity:'HOST_ARTIFACT_INVALID',target_identity:'HOST_TARGET_DENIED',module_already_loaded:'HOST_ALREADY_PRESENT',load_library:'HOST_LOAD_BLOCKED',release_loader_reference:'HOST_REFERENCE_STUCK',start_host:'HOST_ENTRY_FAILED'};
function loaderFailureCode(loaded){
  if(loaded?.pendingThread)return 'HOST_THREAD_PENDING';
  return STAGE_FAILURES[loaded?.stage]||'HOST_START_INCOMPLETE';
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
  snapshot(){return {connected:!!this.owner,pid:this.owner?.pid??null,accountLastFour:this.owner?.account?.slice(-4)??null,receiveReady:false,lastError:this.lastError,lastFailure:this.lastFailure};}
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
      if(!row.supported){
        // 兼容模式：只有用户明确同意、而且只是「构建未适配」（进程本身可读）时才继续。
        // 其他原因（外来模块、宿主已在、进程读不到）继续拒绝，那些试了只会更糟。
        const relaxable=allowUnverified===true&&(row.reason==='UNSUPPORTED_BUILD'||row.reason==='FAMILY_UNVERIFIED')&&typeof row.path==='string'&&/[\\/]QQ\.exe$/i.test(row.path);
        if(!relaxable)throw new Error('UNSUPPORTED_QQ');
        this.lastError='UNVERIFIED_BUILD_ATTEMPT';
      this.lastUnverified = { version: row.version || '', sha256: row.sha256 || '', at: Date.now() };
      }
      const creation=/^[1-9]\d{16,18}$/.test(row.creationTime||'')?row.creationTime:null;
      if(startedAt&&creation!==startedAt)throw new Error('NATIVE_PROCESS_CHANGED');
      const owner={pid,nonce:randomBytes(16).toString('hex'),account:null,startedAt:creation};
      if(this.closed||this.disconnecting)throw new Error('NATIVE_CONNECT_CANCELLED');
      const inspect=await runLoader(this.loader,pid,owner.nonce,'inspect-qq',creation);if(inspect.loaded)throw new Error('HOST_ALREADY_PRESENT');
      if(this.closed||this.disconnecting)throw new Error('NATIVE_CONNECT_CANCELLED');
      const loaded=await runLoader(this.loader,pid,owner.nonce,'qq',creation);
      if(loaded.status!==0||!loaded.loaderReferenceReleased||loaded.pendingThread){
        const failure=loaderFailureCode(loaded);
        this.lastFailure={code:failure,stage:loaded.stage||null,status:typeof loaded.status==='number'?loaded.status:null,at:new Date().toISOString()};
        throw new Error(failure);
      }
      this.owner=owner;
      try {
        const id=await readIdentity(this.query.bind(this),owner);
        if(id.status!==0||id.flags!==15||!id.account||id.account==='0')throw new Error('QQ_LOGIN_NOT_CONFIRMED');
        if(account&&id.account!==account)throw new Error('NATIVE_ACCOUNT_CHANGED');
        if(this.closed||this.disconnecting)throw new Error('NATIVE_CONNECT_CANCELLED');
        owner.account=id.account;this.lastError=null;this.lastFailure=null;
        this.timer=setInterval(()=>{if(this.heartbeatPending)return;this.heartbeatPending=true;this.enqueue(async()=>{
          if(this.owner!==owner||this.disconnecting||this.closed)return;
          try{const r=await this.query({...owner,operation:'heartbeat'});if(r.status!==0)throw new Error('HOST_HEARTBEAT_FAILED');const id=await this.query({...owner,operation:'identity'});if(id.status!==0||id.flags!==15||id.account!==owner.account)throw new Error('HOST_ACCOUNT_CHANGED');}
          catch{this.lastError='HOST_CONNECTION_LOST';clearInterval(this.timer);try{await this.query({...owner,operation:'stop'});}catch{}this.owner=null;}
        }).finally(()=>{this.heartbeatPending=false;});},this.heartbeatMs);this.timer.unref();
        return this.snapshot();
      }catch(error){await this.stopOwned();throw error;}
    }).catch(error=>{this.lastError=/^[A-Z_]+$/.test(error.message)?error.message:'NATIVE_CONNECT_FAILED';this.lastFailure={code:this.lastError,stage:error?.stage??this.lastFailure?.stage??null,status:error?.status??this.lastFailure?.status??null,detail:error?.detail??null,at:new Date().toISOString()};throw new Error(this.lastError);});
    this.pending={pid,startedAt,account,promise};promise.finally(()=>{if(this.pending?.promise===promise)this.pending=null;}).catch(()=>{});return promise;
  }
  request(operation, options = {}) {
    const { expectedAccount, timeoutMs = 4000, nativeTimeoutMs = 3000, ...requestOptions } = options;
    const owner = this.owner, account = owner?.account, generation = this.ownerGeneration;
    if (!account || this.disconnecting || this.closed) return Promise.reject(new Error('NATIVE_NOT_CONNECTED'));
    if (expectedAccount != null && account !== expectedAccount) return Promise.reject(new Error('HOST_ACCOUNT_CHANGED'));
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
