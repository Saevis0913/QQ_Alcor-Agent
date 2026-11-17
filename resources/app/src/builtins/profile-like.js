import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DATA_DIR} from '../config.js';
const qq=value=>/^[1-9]\d{0,9}$/.test(String(value??''))&&Number(value)<=0xffffffff;
const failure=(code,message,delivery)=>Object.assign(new Error(message),{code,nonretryable:true,...(delivery&&{delivery})});
const dayAt=time=>{const d=new Date(time);if(!Number.isFinite(d.getTime()))throw failure('PROFILE_LIKE_CLOCK_INVALID','本地日期无效。');return [d.getFullYear(),d.getMonth()+1,d.getDate()].map(x=>String(x).padStart(2,'0')).join('-');};
// Full-message matching excludes quotations, forwarded instructions and requests for third parties.
const requestPattern=/^(?:请|麻烦你?|拜托你?|能|可以|能不能|可不可以)?(?:(?:给|帮)我(?:的)?(?:QQ)?(?:个人)?(?:资料卡|名片)?(?:点(?:个|一下|一个|(?:10|[1-9]|[一二三四五六七八九十])个?)?赞|点赞)|赞我)(?:吧|呀|啊|呗|吗|好吗|可以吗|谢谢)?[！!。.?？]*$/iu;
function requestEntries(ctx){
 const account=String(ctx?.selfId??''),chat=String(ctx?.chatKey??'');
 if(!qq(account)||! /^(?:private|group):[1-9]\d{0,9}$/.test(chat)||!qq(chat.split(':')[1])||!Array.isArray(ctx?.session?.trigger)||ctx.session.trigger.length>1000)return [];
 if(ctx.session.selfId!=null&&String(ctx.session.selfId)!==account||ctx.session.chatKey!=null&&ctx.session.chatKey!==chat)return [];
 return ctx.session.trigger.filter(entry=>{
  if(entry?.self!==false||entry.isPoke||!qq(entry.senderId)||String(entry.senderId)===account||String(entry.selfId)!==account||entry.forwardVersion||!Number.isFinite(entry.ts))return false;
  if(chat.startsWith('private:')&&String(entry.senderId)!==chat.split(':')[1])return false;
  if(!entry.receiptId&&!entry.mid&&!(Number.isSafeInteger(entry.id)&&entry.id>0))return false;
  if(typeof entry.text!=='string'||entry.text.length>300)return false;
  let text=entry.text.trim();for(const name of Array.isArray(entry.atNames)?entry.atNames:[]){if(typeof name==='string'&&name.startsWith('@')&&text.startsWith(name))text=text.slice(name.length).trim();}
  text=text.replace(/\s+/g,'');return requestPattern.test(text);
 });
}
export function eligibleRequesters(ctx){return [...new Set(requestEntries(ctx).map(e=>String(e.senderId)))];}
function transaction(file,account,peer,mutate){
 fs.mkdirSync(path.dirname(file),{recursive:true});let lock;
 try{lock=fs.openSync(file+'.lock','wx');}catch{throw failure('PROFILE_LIKE_LEDGER_BUSY','点赞记录正在更新，请稍后通过新的请求再试。');}
 try{
  let ledger={version:1,account,peer,requests:[]};
  try{const stat=fs.statSync(file);if(stat.size>512*1024)throw new Error();ledger=JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw failure('PROFILE_LIKE_LEDGER_INVALID','点赞记录无法读取，已停止发送。');}
  if(ledger.version!==1||ledger.account!==account||ledger.peer!==peer||!Array.isArray(ledger.requests)||ledger.requests.length>1024||ledger.requests.some(r=>!r||! /^[a-f0-9]{64}$/.test(r.key)||!/^\d{4}-\d{2}-\d{2}$/.test(r.day)||!Number.isInteger(r.times)||r.times<1||r.times>10||!['pending','unknown','confirmed','rejected'].includes(r.state))||new Set(ledger.requests.map(r=>r.key)).size!==ledger.requests.length)throw failure('PROFILE_LIKE_LEDGER_INVALID','点赞记录格式错误，已停止发送。');
  const result=mutate(ledger);
  const temporary=file+'.'+randomUUID()+'.tmp';let fd;
  try{fd=fs.openSync(temporary,'wx');fs.writeFileSync(fd,JSON.stringify(ledger));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,file);}finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch{}}
  return result;
 }finally{fs.closeSync(lock);fs.unlinkSync(file+'.lock');}
}
const definitelyRejected=new Set(['PROFILE_LIKE_REJECTED','PROFILE_LIKE_ARGUMENT_INVALID','PROFILE_LIKE_ACCOUNT_REQUIRED','PROFILE_LIKE_TARGET_UNRESOLVED','PROFILE_LIKE_DIRECTORY_UNAVAILABLE','PROFILE_LIKE_CONNECTION_CHANGED','NATIVE_ACCOUNT_CHANGED','HOST_ACCOUNT_CHANGED','HOST_CONNECTION_CHANGED','HOST_QUEUE_TIMEOUT','NATIVE_NOT_CONNECTED','NATIVE_ACTION_NOT_IMPLEMENTED']);
export function createProfileLike({runtime,dataDir=DATA_DIR,isActive=()=>true,now=()=>runtime.now?.()??Date.now()}={}){
 return {async execute(ctx,args={}, {signal}={}){
  const account=String(ctx?.selfId??'');let dispatched=false;
  const check=()=>{signal?.throwIfAborted();if(!qq(account)||!runtime?.isCurrent(account)||String(runtime.account())!==account||!isActive(ctx))throw failure('PROFILE_LIKE_CANCELLED','账号已变化或资料卡点赞技能已停用。');};
  try{
   check();if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['targetUserId','times'].includes(k)))throw failure('PROFILE_LIKE_ARGUMENT_INVALID','点赞参数无效。');
   const times=args.times===undefined?1:args.times;if(!Number.isInteger(times)||times<1||times>10)throw failure('PROFILE_LIKE_ARGUMENT_INVALID','点赞次数必须是1至10的整数。');
   if(args.targetUserId!==undefined&&(typeof args.targetUserId!=='string'||!qq(args.targetUserId)))throw failure('PROFILE_LIKE_ARGUMENT_INVALID','请求者QQ号必须是有效的字符串。');
   const eligible=eligibleRequesters(ctx);let peer=args.targetUserId??'';
   if(!peer){if(eligible.length>1)throw failure('PROFILE_LIKE_TARGET_AMBIGUOUS','本轮有多位请求者，请选择其中一位的QQ号。');peer=eligible[0]??'';}
   if(!qq(peer)||!eligible.includes(peer))throw failure('PROFILE_LIKE_REQUEST_REQUIRED','只能给本轮明确要求为自己资料卡点赞的发言者点赞；不支持空间说说或代他人请求。');
   const entry=requestEntries(ctx).filter(e=>String(e.senderId)===peer).at(-1);
   const identity=entry.receiptId?['receipt',entry.receiptId]:entry.mid?['message',entry.mid]:['local',entry.id,entry.ts];
   const key=createHash('sha256').update(JSON.stringify([ctx.chatKey,peer,...identity])).digest('hex');
   const day=dayAt(now()),file=path.join(dataDir,'builtins','profile-like',account,peer+'.json');
   const status=await runtime.status?.();check();if(status?.paused||status?.connected===false)throw failure('PROFILE_LIKE_CANCELLED','服务已暂停或离线，未发送点赞。');
   transaction(file,account,peer,ledger=>{
    const old=ledger.requests.find(r=>r.key===key);
    if(old)throw failure('PROFILE_LIKE_ALREADY_ATTEMPTED',old.state==='unknown'||old.state==='pending'?'这条请求已有未确认结果，不能再次点赞。':'这条请求已经处理，不重复点赞。',['pending','unknown'].includes(old.state)?'unknown':undefined);
    if(ledger.requests.length>=1024)throw failure('PROFILE_LIKE_LEDGER_LIMIT','点赞记录已达上限，请先检查记录。');
    if(ledger.requests.filter(r=>r.day===day&&r.state!=='rejected').reduce((n,r)=>n+r.times,0)+times>10)throw failure('PROFILE_LIKE_DAILY_LIMIT','这个账号今天已达到该用户10次点赞上限（含未确认请求）。');
    ledger.requests.push({key,day,times,state:'pending'});
   });
   // No asynchronous gap between reservation and dispatch: lifecycle checks cannot be overtaken here.
   check();dispatched=true;let result;
   try{result=await runtime.onebot.call('send_like',{user_id:Number(peer),times,expected_self_id:account},12000);check();
    if(result?.delivery!=='server-confirmed'||Number(result.user_id)!==Number(peer)||result.times!==times)throw failure('PROFILE_LIKE_ACK_INVALID','资料卡点赞未获得有效确认。','unknown');
   }catch(error){
    const known=error.delivery!=='unknown'&&definitelyRejected.has(error.code);
    if(!known){ctx.session.deliveryUnknown=true;error=failure('PROFILE_LIKE_RESULT_UNKNOWN','点赞结果未知，请核对资料卡；不会自动重试。','unknown');}
    // On lifecycle invalidation the already-persisted pending record remains a replay barrier.
    if(!signal?.aborted&&runtime.isCurrent(account)&&isActive(ctx)){try{transaction(file,account,peer,ledger=>{const row=ledger.requests.find(r=>r.key===key);if(!row)throw Error();row.state=known?'rejected':'unknown';});}catch{ctx.session.deliveryUnknown=true;throw failure('PROFILE_LIKE_LEDGER_WRITE_FAILED','点赞记录更新失败，保留未确认状态以防重复。','unknown');}}
    throw error;
   }
   try{transaction(file,account,peer,ledger=>{const row=ledger.requests.find(r=>r.key===key);if(!row)throw Error();row.state='confirmed';});}catch{throw failure('PROFILE_LIKE_LEDGER_WRITE_FAILED','已提交点赞，但本地记录更新失败；不能重试。','unknown');}
   (ctx.session.sideEffects??=[]).push({type:'profile_like',targetUserId:Number(peer),times,delivery:'server-confirmed',at:new Date(now()).toLocaleTimeString('zh-CN',{hour12:false})});
   try{ctx.emit?.('session-update',ctx.session.id);}catch{(ctx.session.localErrors??=[]).push({code:'PROFILE_LIKE_UI_NOTIFY_FAILED',message:'点赞已获确认，界面通知失败。'});}
   return {delivery:'server-confirmed',user_id:Number(peer),times,qqTextSent:false,message:'服务已确认资料卡点赞请求；未独立测量资料卡计数变化。'};
  }catch(error){if(error.delivery==='unknown'||dispatched&&!error.code){ctx.session.deliveryUnknown=true;if(!error.delivery)error=failure('PROFILE_LIKE_RESULT_UNKNOWN','点赞结果或本地记录未确认，不能重试。','unknown');}if(error.nonretryable&&ctx.session)ctx.session.nonretryable=true;throw error;}
 }};
}
