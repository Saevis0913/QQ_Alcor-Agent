import {createHash} from 'node:crypto';
import {fields,one,child,number as num,string as str} from './media.mjs';

export const NOTICE_SOURCE=Symbol('Alcor notice source');
const validId=n=>Number.isInteger(n)&&n>0&&n<=0xffffffff;
const validUid=s=>/^u_[\w-]{4,80}$/.test(s);
function attach(event,source,key){Object.defineProperty(event,NOTICE_SOURCE,{value:{...source,key}});return event;}
function pokeIds(tip){
 if(num(tip,1)!==12)return null;
 const params=new Map(),list=tip.get(7)||[];if(list.length>32)throw new Error('NOTICE_PARAM_LIMIT');
 for(const row of list){if(row.w!==2)throw new Error('NOTICE_FIELD_INVALID');const entry=fields(row.v),name=str(entry,1,64);if(params.has(name))throw new Error('NOTICE_PARAM_DUPLICATE');params.set(name,str(entry,2,1024));}
 const id=name=>{const text=params.get(name)||'';return /^[1-9]\d{0,9}$/.test(text)?Number(text):0;};
 const user=id('uin_str1'),target=id('uin_str2');return validId(user)&&validId(target)?{user,target}:null;
}
function framedGroup(raw){
 if(!raw||raw.length<7)throw new Error('NOTICE_FRAME_INVALID');
 const b=Buffer.from(raw),group=b.readUInt32BE(0),length=b.readUInt16BE(5);
 if(!validId(group)||length!==b.length-7)throw new Error('NOTICE_FRAME_INVALID');
 const info=fields(b.subarray(7)),inner=num(info,4);if(inner&&inner!==group)throw new Error('NOTICE_GROUP_MISMATCH');
 return {group,info};
}
/** Decode only known notification types; raw body and UID bindings stay internal. */
export function decodeNoticePush(input,account){
 if(!(input instanceof Uint8Array)||!input.length||input.length>65536)throw new Error('PUSH_SIZE');
 const message=child(fields(input),1),head=child(message,1),content=child(message,2),type=num(content,1),sub=num(content,2);
 if(![528,732].includes(type))return null;
 const self=Number(account),to=num(head,5),time=num(content,6);
 if(!validId(self)||to!==self||!time)return [];
 const base={time,self_id:self,post_type:'notice'},raw=one(child(message,3),2,2);
 const key=createHash('sha256').update(String(account)).update(input).digest('hex');
 if(type===732&&[17,20].includes(sub)){
  const {group,info}=framedGroup(raw);
  if(sub===20){
   if(num(info,13)!==19)return [];const ids=pokeIds(child(info,26));if(!ids)return [];const {user,target}=ids;
   return [attach({...base,notice_type:'notify',sub_type:'poke',group_id:group,user_id:user,target_id:target},{},key)];
  }
  const recall=child(info,11),rows=recall.get(3)||[],operator=str(recall,1,128);if(rows.length>32)throw new Error('NOTICE_RECALL_LIMIT');
  return rows.map((row,index)=>{
   if(row.w!==2)throw new Error('NOTICE_FIELD_INVALID');const entry=fields(row.v),sequence=num(entry,1),author=str(entry,6,128);
   if(!sequence||!validUid(author)||(operator&&!validUid(operator)))throw new Error('NOTICE_RECALL_INVALID');
   return attach({...base,notice_type:'group_recall',group_id:group},{sequence,authorUid:author,operatorUid:operator||author},`${key}:${index}`);
  });
 }
 if(type===528&&sub===290){
  if(!raw)throw new Error('NOTICE_FRAME_INVALID');const ids=pokeIds(fields(raw));if(!ids||![ids.user,ids.target].includes(self))return [];
  return [attach({...base,notice_type:'notify',sub_type:'poke',user_id:ids.user,target_id:ids.target},{},key)];
 }
 if(type===528&&[138,139].includes(sub)){
  if(!raw)throw new Error('NOTICE_FRAME_INVALID');const info=child(fields(raw),1),author=str(info,1,128),recipient=str(info,2,128),sequence=num(info,20);
  const selfUid=str(head,6,128),fromUid=str(head,2,128),from=num(head,1);
  if(!validUid(selfUid)||!validUid(author)||!validUid(recipient)||!sequence||![author,recipient].includes(selfUid))return [];
  const known=new Map([[selfUid,self]]);if(validUid(fromUid)&&validId(from)&&fromUid!==selfUid)known.set(fromUid,from);
  return [attach({...base,notice_type:'friend_recall'},{sequence,authorUid:author,peerUid:author===selfUid?recipient:author,known},key)];
 }
 return [];
}

export async function resolveNotice(event,backend){
 const source=event[NOTICE_SOURCE];if(event.notice_type==='notify')return event;
 const account=backend.account,generation=backend.receiveGeneration;
 const known=new Map(source.known||[]);
 const required=event.group_id?[source.authorUid,source.operatorUid]:[source.authorUid,source.peerUid];
 if(required.some(uid=>!known.has(uid))){
  let timer;const lookup=event.group_id?backend.directory.members(event.group_id):backend.directory.friends();
  let rows;try{rows=await Promise.race([lookup,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('NOTICE_DIRECTORY_TIMEOUT')),2000);timer.unref();})]);}finally{clearTimeout(timer);}
  for(const row of rows)if(validUid(row.uid)&&validId(row.user_id))known.set(row.uid,row.user_id);
 }
 if(account!==backend.account||generation!==backend.receiveGeneration)throw new Error('NOTICE_CONNECTION_CHANGED');
 if(required.some(uid=>!known.has(uid)))throw new Error('NOTICE_MEMBER_UNRESOLVED');
 const author=known.get(source.authorUid),peer=event.group_id?null:known.get(source.peerUid);
 event.user_id=event.group_id?author:peer;
 if(event.group_id)event.operator_id=known.get(source.operatorUid);
 else event.operator_id=author;
 const matches=[...backend.messages.values()].filter(row=>row.self_id===Number(account)&&(event.group_id?row.sequence===source.sequence:(row.native_client_sequence||row.sequence)===source.sequence)&&
  (event.group_id?row.message_type==='group'&&row.group_id===event.group_id&&row.user_id===author:
    row.message_type==='private'&&row.user_id===peer&&(row.sender?.user_id??peer)===author));
 if(matches.length===1){event.message_id=matches[0].message_id;matches[0].recalled=true;}
 else {event.unresolved=true;event.sequence=source.sequence;}
 return event;
}
