import {fields,one,child,number as num,string as str} from './media.mjs';
import {decodeMediaElement} from './media.mjs';
import {REPLY_SOURCE} from './outgoing-segments.mjs';
import {decodeForwardElement} from './message-actions.mjs';
import {decodePrivateFile} from './private-file.mjs';
const unsupportedCard=()=>({type:'json',data:{summary:'[卡片消息]',unsupported:true}});
function atSegment(text){
 const reserve=child(text,12),type=num(reserve,3),uid=str(reserve,9,128),uin=num(reserve,4),legacy=one(text,3,2);
 if(type===1)return {type:'at',data:{qq:'all'}};
 if(type===2)return {type:'at',data:{qq:uin?String(uin):'unknown',uid,text:str(text,1),unresolved:!uin}};
 if(legacy?.length){
  const b=Buffer.from(legacy),valid=b.length===13&&b.readUInt16BE(0)===1&&b[6]<=1&&b.readUInt16BE(11)===0;
  if(!valid)return {type:'at',data:{qq:'unknown',unresolved:true}};
  const qq=b.readUInt32BE(7);if((b[6]===1&&qq)||(b[6]===0&&!qq))return {type:'at',data:{qq:'unknown',unresolved:true}};
  return {type:'at',data:{qq:qq?String(qq):'all'}};
 }
 return null;
}
function fileSegment(e,group){
 const trans=child(e,5);if(num(trans,1)!==24)return null;const raw=one(trans,2,2);
 if(!raw||raw.length<3||raw[0]!==1||Buffer.from(raw).readUInt16BE(1)!==raw.length-3)return {type:'file',data:{error:'GROUP_FILE_DESCRIPTOR_INVALID'}};
 const info=child(child(fields(raw.subarray(3)),7),2);
 return {type:'file',data:{group_id:group,file_id:str(info,2,512),name:str(info,4,2048).slice(0,160),file_size:num(info,3),busid:num(info,1)}};
}
/** Exact field-number contract; independent bounded parser for private text and media. */
export function decodeMessagePush(input,account){
  if(!(input instanceof Uint8Array)||!input.length||input.length>65536)throw new Error('PUSH_SIZE');
  const top=fields(input),message=child(top,1),head=child(message,1),content=child(message,2),body=child(message,3);
  if([528,732].includes(num(content,1)))return null;
  const from=num(head,1),to=num(head,5),self=Number(account),grp=child(head,8),group=num(grp,1);
  if(!from||!self||(!group&&to!==self)||from===self||from>0xffffffff||self>0xffffffff||group>0xffffffff)return null;
  const rich=child(body,1),segments=[],selfUid=str(head,6,128);
  if(!group&&rich.has(3))segments.push(decodePrivateFile(one(rich,3,2),selfUid,from));
  if(!group&&num(content,1)===529&&num(content,3)===4&&body.has(2)){
    try{const file=one(fields(one(body,2,2)),1,2);segments.push(decodePrivateFile(file,selfUid,from));}
    catch{segments.push({type:'file',data:{error:'PRIVATE_FILE_DESCRIPTOR_INVALID'}});}
  }
  if((rich.get(2)?.length||0)>256)throw new Error('PUSH_SEGMENT_LIMIT');
  for(const elem of rich.get(2)??[]){
    if(elem.w!==2)throw new Error('PUSH_FIELD_INVALID');
    const e=fields(elem.v);
    if(e.has(1)){const text=child(e,1),at=atSegment(text),value=str(text,1,65536);if(at)segments.push(at);else if(value)segments.push({type:'text',data:{text:value}});}
    else if(e.has(45)){const r=child(e,45),seq=r.get(1)?.[0];segments.push({type:'reply',data:{id:seq?.w===0?String(seq.v):'unknown',sender_id:num(r,2)||undefined,sender_uid:str(child(r,8),6,128)||undefined}});}
    else if(e.has(2)){segments.push({type:'face',data:{id:String(num(child(e,2),1))}});}
    else if(e.has(6)){const media=decodeMediaElement(elem.v,selfUid,group,from);if(media)segments.push(media);}
    else if(e.has(51)||e.has(12)){const forward=decodeForwardElement(e,selfUid);segments.push(forward||unsupportedCard());}
    else {const file=group?fileSegment(e,group):null;if(file)segments.push(file);else {const media=decodeMediaElement(elem.v,selfUid,group,from);if(media)segments.push(media);}}
  }
  if(rich.has(4)&&!segments.some(s=>s.type==='record'))segments.push({type:'record',data:{duration:num(child(rich,4),19),error:'MEDIA_FORMAT_UNAVAILABLE'}});
  if(!segments.length&&(rich.has(2)||body.has(2)))segments.push(unsupportedCard());
  if(!segments.length)return null;
  const sequence=num(content,5),time=num(content,6);if(!sequence||!time)return null;
  const clientSequence=num(content,11)||num(content,10);
  const event={time,self_id:self,post_type:'message',message_type:group?'group':'private',sub_type:group?'normal':'friend',user_id:from,sequence,message_id:sequence,raw_message:segments.map(s=>s.type==='text'?s.data.text:s.type==='at'?`[CQ:at,qq=${s.data.qq}]`:({image:'[图片]',video:'[视频]',record:'[语音]',file:'[文件]',face:'[表情]',mface:'[表情]',reply:'[引用]',forward:'[合并转发聊天记录]',json:'[卡片消息]'}[s.type]||'')).join(''),message:segments,sender:{user_id:from,nickname:String(from)},font:0};
  if(group){event.group_id=group;event.group_name=str(grp,7);event.sender.card=str(grp,4);event.sender.role='unknown';event.sender.uid=str(head,2,128);}
  else if(clientSequence>1&&clientSequence<=0xffffffff)event.native_client_sequence=clientSequence;
  const source=one(top,1,2),elems=rich.get(2)||[];
  if(source?.length<=3500&&elems.length&&elems.every(elem=>elem.w===2)){
    // A private quote uses the NT message sequence when present, otherwise the received sequence.
    const nt=content.get(10);
    const clientSequence=nt?.length===1&&nt[0].w===0&&nt[0].v>1n&&nt[0].v<=0xffffffffn?Number(nt[0].v):sequence;
    Object.defineProperty(event,REPLY_SOURCE,{value:{body:Buffer.from(source),elements:elems.map(elem=>Buffer.from(elem.v)),clientSequence}});
  }
  return event;
}
export function decodePrivatePush(input,account){const event=decodeMessagePush(input,account);return event?.message_type==='private'?event:null;}
