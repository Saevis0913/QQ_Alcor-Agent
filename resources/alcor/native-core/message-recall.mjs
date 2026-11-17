import {scalar as s,bytes as b,join as j,uin,fields,child,number as n,string as str,one,list} from './wire.mjs';
import {BridgeError} from '../src/backend.mjs';

// Only metadata from this core's confirmed sends may authorize a recall.
// A symbol keeps request identifiers and in-flight promises out of get_msg JSON.
export const SENT_SOURCE=Symbol('Alcor confirmed outgoing message');
export function rememberSent(row,options){
 Object.defineProperty(row,SENT_SOURCE,{value:{...options}});return row;
}
export function encodePrivateRecall({uid,sequence,random,timestamp,clientSequence,messageId}){
 if(!/^u_[\w-]{4,80}$/.test(uid))throw new Error('RECALL_PEER_UNRESOLVED');
 [sequence,random,timestamp,clientSequence].forEach(uin);
 if(typeof messageId!=='bigint'||(messageId&0xffffffffn)!==BigInt(random))throw new Error('RECALL_MESSAGE_ID_INVALID');
 return j(s(1,1),b(3,uid),b(4,j(s(1,sequence),s(2,random),s(3,messageId),s(4,timestamp),s(5,0),s(6,clientSequence))),b(5,j(s(1,0),s(2,0))),s(6,0));
}
export function resolvePrivateRecallSource(payload,{account,peer,uid,sequence,random,timestamp}){
 const root=fields(payload);if(n(root,1))throw new BridgeError('RECALL_HISTORY_REJECTED',502);
 const found=[];
 for(const entry of list(root,7,20)){
  const message=fields(entry.v),head=child(message,1),content=child(message,2);
  if(n(head,1)!==Number(account)||n(head,5)!==peer||str(head,6)!==uid||n(content,11)!==sequence||n(content,4)!==random||n(content,6)!==timestamp)continue;
  const result={uid,sequence:n(content,5),random,timestamp,clientSequence:n(content,11),messageId:one(content,12,0)};
  encodePrivateRecall(result);found.push(result);
 }
 if(found.length!==1)throw new BridgeError('RECALL_SOURCE_NOT_FOUND',404);
 return found[0];
}
export function encodeGroupRecall(group,sequence){
 [group,sequence].forEach(uin);return j(s(1,1),s(2,group),b(3,j(s(1,sequence),s(3,0))),b(4,s(1,0)));
}
export async function recallMessage(backend,params){
 if(params.expected_self_id==null)throw new BridgeError('RECALL_ACCOUNT_REQUIRED',400);
 const account=backend.account,generation=backend.receiveGeneration;
 const row=backend.messages.get(Number(params.message_id)),source=row?.[SENT_SOURCE];
 if(!source||String(row.self_id)!==account||String(row.sender?.user_id)!==account)throw new BridgeError('RECALL_OWN_MESSAGE_REQUIRED',404);
 const check=()=>{if(account!==backend.account||generation!==backend.receiveGeneration||!backend.controller.snapshot().connected)throw new BridgeError('RECALL_CONNECTION_CHANGED',409,source.attempted?'unknown':undefined);};
 check();if(row.recalled)return {message_id:row.message_id,delivery:'notice-confirmed',already_recalled:true};
 if(source.pending)return source.pending;
 if(source.attempted)throw new BridgeError('RECALL_RESULT_UNKNOWN',502,'unknown');
 source.pending=(async()=>{
  let payload;const group=row.message_type==='group';
  if(group)payload=encodeGroupRecall(row.group_id,row.sequence);
  else{
   const friends=await backend.directory.friends();check();
   const friend=friends.find(friend=>friend.user_id===row.user_id);
   if(!/^u_[\w-]{4,80}$/.test(friend?.uid||''))throw new BridgeError('RECALL_PEER_UNRESOLVED',404);
   const history=await backend.controller.request('privateHistory',{payload:j(b(2,friend.uid),s(3,row.sequence),s(4,row.sequence)),expectedAccount:account,nativeTimeoutMs:5000,timeoutMs:6500});check();
   if(history.status!==0||!history.received||history.nativeStatus!==0)throw new BridgeError('RECALL_HISTORY_UNCONFIRMED',502);
   let original;try{original=resolvePrivateRecallSource(history.payload,{account,peer:row.user_id,uid:friend.uid,sequence:row.sequence,random:source.random,timestamp:row.time});}
   catch(error){if(error instanceof BridgeError)throw error;throw new BridgeError('RECALL_HISTORY_INVALID',502);}
   payload=encodePrivateRecall(original);
   row.native_client_sequence=original.clientSequence;
  }
  check();source.attempted=true;
  let reply;try{reply=await backend.controller.request(group?'groupRecall':'privateRecall',{payload,expectedAccount:account,nativeTimeoutMs:5000,timeoutMs:6500});}
  catch{throw new BridgeError('RECALL_RESULT_UNKNOWN',502,'unknown');}
  check();
  if(reply.status!==0||!reply.received||reply.nativeStatus!==0)throw new BridgeError('RECALL_RESULT_UNKNOWN',502,'unknown');
  // An empty native callback does not prove the server removed the message.
  const deadline=Date.now()+5000;
  while(!row.recalled&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,50));check();}
  if(!row.recalled)throw new BridgeError('RECALL_NOTICE_NOT_CONFIRMED',502,'unknown');
  return {message_id:row.message_id,delivery:'notice-confirmed'};
 })();
 try{return await source.pending;}finally{source.pending=null;}
}
