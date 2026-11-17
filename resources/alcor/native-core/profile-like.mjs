import {BridgeError} from '../src/backend.mjs';
import {fields,number,bytes,scalar,join} from './wire.mjs';
const qq=x=>/^[1-9]\d{0,9}$/.test(String(x??''))&&Number(x)<=0xffffffff?Number(x):0;
export async function sendProfileLike(backend,params){
 const account=String(backend.account??''),generation=backend.receiveGeneration;
 if(params.expected_self_id==null)throw new BridgeError('PROFILE_LIKE_ACCOUNT_REQUIRED',400);
 if(String(params.expected_self_id)!==account)throw new BridgeError('NATIVE_ACCOUNT_CHANGED',409);
 const target=qq(params.user_id),times=params.times??1;
 if(!target||target===qq(account)||!Number.isInteger(times)||times<1||times>10||params.group_id!=null||params.uid!=null)throw new BridgeError('PROFILE_LIKE_ARGUMENT_INVALID',400);
 const current=()=>backend.account===account&&backend.receiveGeneration===generation&&backend.controller.snapshot().connected;
 if(!current()||!qq(account))throw new BridgeError('NATIVE_NOT_CONNECTED',503);
 let rows;try{rows=await backend.directory.friends();}catch{throw new BridgeError('PROFILE_LIKE_DIRECTORY_UNAVAILABLE',502);}
 if(!current())throw new BridgeError('PROFILE_LIKE_CONNECTION_CHANGED',409);
 // Account-scoped group snapshots may resolve a known group sender without accepting a caller-supplied UID.
 const candidates=rows.filter(r=>r.user_id===target);
 for(const [key,row] of backend.directory.cache??[]){if(key.startsWith('members:')&&backend.directory.current(row.scope))candidates.push(...row.value.filter(r=>r.user_id===target));}
 const uids=new Set(candidates.map(r=>r.uid).filter(x=>typeof x==='string'&&/^u_[\w-]{4,80}$/.test(x)));
 if(uids.size!==1)throw new BridgeError('PROFILE_LIKE_TARGET_UNRESOLVED',404);
 const payload=join(scalar(1,0x7e5),scalar(2,104),bytes(4,join(bytes(11,[...uids][0]),scalar(12,71),scalar(13,times))));
 let reply;try{reply=await backend.controller.request('profileLike',{payload,expectedAccount:account,nativeTimeoutMs:5000,timeoutMs:7000});}catch(error){
  if(['NATIVE_NOT_CONNECTED','HOST_QUEUE_TIMEOUT','HOST_ACCOUNT_CHANGED','HOST_CONNECTION_CHANGED'].includes(error.message))throw new BridgeError(error.message,503);
  throw new BridgeError('PROFILE_LIKE_RESULT_UNKNOWN',502,'unknown');
 }
 if(!current())throw new BridgeError('PROFILE_LIKE_CONNECTION_CHANGED',409,'unknown');
 if(reply.status!==0||reply.received!==true||!Number.isInteger(reply.nativeStatus))throw new BridgeError('PROFILE_LIKE_RESULT_UNKNOWN',502,'unknown');
 if(reply.nativeStatus)throw new BridgeError('PROFILE_LIKE_REJECTED',502);
 let result;try{const m=fields(reply.payload);if(number(m,1)!==0x7e5||number(m,2)!==104)throw new Error();result=number(m,3);}catch{throw new BridgeError('PROFILE_LIKE_RESULT_UNKNOWN',502,'unknown');}
 if(result!==0)throw new BridgeError('PROFILE_LIKE_REJECTED',502);
 return {delivery:'server-confirmed',user_id:target,times};
}
