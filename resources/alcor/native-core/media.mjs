import {createHash} from 'node:crypto';
import {visitProtobufFields} from './protobuf-fields.mjs';
export const MEDIA_DESCRIPTOR=Symbol('Alcor private media');
const utf8=new TextDecoder('utf-8',{fatal:true});
export function fields(bytes){const m=new Map();visitProtobufFields(bytes,(n,w,v)=>{if(!m.has(n))m.set(n,[]);m.get(n).push({w,v});});return m;}
export function one(m,n,w){const a=m.get(n);if(!a)return null;if(a.length!==1||a[0].w!==w)throw new Error('MEDIA_FIELD_INVALID');return a[0].v;}
export function child(m,n){const b=one(m,n,2);return b?fields(b):new Map();}
export function number(m,n){const v=one(m,n,0);if(v===null)return 0;if(v>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('MEDIA_INTEGER_RANGE');return Number(v);}
export function string(m,n,max=4096){const b=one(m,n,2);if(!b)return '';if(b.length>max)throw new Error('MEDIA_STRING_LIMIT');return utf8.decode(b);}
const varint=n=>{n=BigInt(n);const b=[];do{b.push(Number(n&127n)|(n>127n?128:0));n>>=7n;}while(n);return Buffer.from(b);};
const scalar=(n,v)=>Buffer.concat([varint(n*8),varint(v)]);
const bytes=(n,b)=>{b=typeof b==='string'?Buffer.from(b):b;return Buffer.concat([varint(n*8+2),varint(b.length),b]);};
const join=(...b)=>Buffer.concat(b);
function attach(kind,data,descriptor){
 const scope=descriptor.groupId?String(descriptor.groupId):descriptor.peerId?`private:${descriptor.peerId}:`:'';
 const key=createHash('sha256').update(kind).update(descriptor.selfUid||'').update(scope).update(descriptor.index||descriptor.url||'').digest('hex');
 const segment={type:kind,data:{file:'alcor-media-'+key,...data}};
 Object.defineProperty(segment,MEDIA_DESCRIPTOR,{value:{...descriptor,kind,data:segment.data}});return segment;
}
function allowedUrl(value){
 const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||!/(^|\.)(qq\.com|qq\.com\.cn|qpic\.cn|gtimg\.cn)$/.test(u.hostname))throw new Error('MEDIA_URL_INVALID');return u;
}
/** Decode current rich-media bodies. A video thumbnail stays inside its video descriptor. */
export function decodeMediaElement(raw,selfUid,groupId=0,peerId=0){
 const e=fields(raw),common=child(e,53),service=number(common,1),business=number(common,3);
 if(e.has(6)){
  const face=one(e,6,2),f=fields(face),id=one(f,4,2),summary=string(f,1,256)||'[表情]';
  if(id?.length===16){const publicSticker=Buffer.from(id).toString('hex');return attach('image',{name:'表情.gif',summary,sub_type:1,animated:true,emoji_id:publicSticker},{url:`https://gxh.vip.qq.com/club/item/parcel/item/${publicSticker.slice(0,2)}/${publicSticker}/raw300.gif`,publicSticker,selfUid,groupId,peerId,marketFace:face.length<=2048?Buffer.from(face):undefined});}
  return {type:'face',data:{summary,sub_type:1,error:'MEDIA_DESCRIPTOR_UNAVAILABLE'}};
 }
 if(service===48&&[10,11,12,20,21,22].includes(business)){
  const kind=business%10===0?'image':business%10===1?'video':'record';
  try{
  const info=child(common,2),bodies=info.get(1)||[];
  if(bodies.length>16)throw new Error('MEDIA_ITEM_LIMIT');
  for(const b of bodies){
   if(b.w!==2)throw new Error('MEDIA_FIELD_INVALID');const body=fields(b.v),rawIndex=one(body,1,2);if(!rawIndex)continue;
   const index=fields(rawIndex),file=child(index,1),type=number(child(file,5),1);
   if(type!==({image:1,video:2,record:3}[kind])||number(index,6)!==0)continue;
   const uuid=string(index,2,512);if(!uuid||rawIndex.length>2048)throw new Error('MEDIA_INDEX_INVALID');
   const data={name:string(file,4,2048).slice(0,160),file_size:number(file,1),width:number(file,6),height:number(file,7),duration:number(file,8)};
   if(kind==='image'){const pic=child(child(info,2),1),sub=number(pic,1),summary=string(pic,2,256);if(sub)data.sub_type=sub;if(summary)data.summary=summary;}
   if(kind==='image'&&/\.gif$/i.test(data.name))data.animated=true;
   if(!groupId&&!/^u_[\w-]{4,80}$/.test(selfUid||''))data.error='MEDIA_ACCOUNT_UID_MISSING';
   return attach(kind,data,{index:Buffer.from(rawIndex),selfUid,groupId,peerId:kind==='image'&&data.sub_type===1?peerId:0});
  }
  }catch{/* Preserve receipt identity even when one attachment cannot be resolved. */}
  return {type:kind,data:{error:'MEDIA_DESCRIPTOR_UNAVAILABLE'}};
 }
 // Older private-image envelopes may carry an immediately usable public CDN URL.
 for(const field of [4,8])if(e.has(field)){
  const old=child(e,field),candidates=field===4?[string(old,15),string(old,14),string(old,12),string(child(old,29),30)]:[string(old,16),string(old,15),string(old,14)];
  const direct=candidates.find(x=>/^https:\/\//.test(x));
  if(direct){try{return attach('image',{name:string(old,1,512)||'图片'},{url:allowedUrl(direct).href,selfUid});}catch{}}
  return {type:'image',data:{error:'MEDIA_FORMAT_UNAVAILABLE'}};
 }
 if(e.has(19))return {type:'video',data:{error:'MEDIA_FORMAT_UNAVAILABLE'}};
 return null;
}
/** Fixed read-only download request for a resource received by this signed-in account. */
export function encodeMediaDownload(descriptor){
 const {kind,selfUid,index,groupId=0}=descriptor;
 if(!['image','video','record'].includes(kind)||(!groupId&&!/^u_[\w-]{4,80}$/.test(selfUid||''))||!Number.isInteger(groupId)||groupId<0||groupId>0xffffffff||!(index instanceof Uint8Array)||!index.length||index.length>2048)throw new Error('MEDIA_DESCRIPTOR_INVALID');
 const command=mediaCommand(kind,groupId),business={image:1,video:2,record:3}[kind];
 const scene=groupId?bytes(202,scalar(1,groupId)):bytes(201,join(scalar(1,2),bytes(2,selfUid)));
 const head=join(bytes(1,join(scalar(1,kind==='record'&&groupId?4:1),scalar(2,200))),bytes(2,join(scalar(101,kind==='record'?1:2),scalar(102,business),scalar(200,groupId?2:1),scene)),bytes(3,scalar(1,2)));
 const body=join(bytes(1,head),bytes(3,join(bytes(1,index),bytes(2,bytes(2,join(scalar(1,0),scalar(2,0)))))));
 return {operation:(groupId?'group'+kind[0].toUpperCase()+kind.slice(1):kind)+'Download',payload:join(scalar(1,command),scalar(2,200),bytes(4,body),scalar(12,1))};
}
const mediaCommand=(kind,group)=>({image:group?0x11c4:0x11c5,video:group?0x11ea:0x11e9,record:group?0x126e:0x126d}[kind]);
export function decodeMediaDownload(input,kind,groupId=0){
 if(!(input instanceof Uint8Array)||!input.length||input.length>65536)throw new Error('MEDIA_REPLY_SIZE');
 const outer=fields(input),command=mediaCommand(kind,groupId);
 if(number(outer,1)!==command||number(outer,2)!==200||number(outer,3)!==0)throw new Error('MEDIA_DOWNLOAD_REJECTED');
 const response=child(outer,4);if(number(child(response,1),2)!==0)throw new Error('MEDIA_DOWNLOAD_REJECTED');
 const download=child(response,3),info=child(download,3),domain=string(info,1,255),urlPath=string(info,2,4096);
 if(!urlPath.startsWith('/')||urlPath.startsWith('//')||domain.includes('/')||domain.includes('@'))throw new Error('MEDIA_URL_INVALID');
 const url=allowedUrl('https://'+domain+urlPath);
 for(const part of [string(download,1),string(child(info,6),1)]){
  for(const [key,value] of new URLSearchParams(part.replace(/^[?&]/,''))){if(key)url.searchParams.set(key,value);}
 }
 return {url:url.href,ttl:Math.min(3600,number(download,2)||300)};
}
