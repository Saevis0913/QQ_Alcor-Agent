import fs from 'node:fs';
import path from 'node:path';
const LIMIT=2000,MAX_BYTES=8*1024*1024;
export function loadMediaCache(file){
 const rows=new Map();if(!file)return rows;
 try{
  if(fs.statSync(file).size>MAX_BYTES)return rows;
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved.version!==1||!Array.isArray(saved.rows))return rows;
  for(const row of saved.rows.slice(-LIMIT)){
   if(!/^alcor-media-[a-f0-9]{64}$/.test(row.id)||!/^\d{1,10}$/.test(row.account)||!['image','video','record','file'].includes(row.kind)||typeof row.selfUid!=='string'||row.selfUid.length>82||typeof row.index!=='string'||row.index.length>2732)continue;
   const publicSticker=row.kind==='image'&&/^[a-f0-9]{32}$/.test(row.publicSticker||'')?row.publicSticker:null;
   const index=Buffer.from(row.index,'base64');if((!index.length&&!publicSticker)||index.length>2048)continue;
   const data={file:row.id};for(const key of ['name','summary'])if(typeof row.data?.[key]==='string')data[key]=row.data[key].slice(0,160);
   if(row.kind==='file'){
    if(!Number.isInteger(row.peerId)||row.peerId<1||row.peerId>0xffffffff||row.groupId||!/^u_[\w-]{4,80}$/.test(row.selfUid))continue;
    data.file_id=row.id;data.user_id=row.peerId;
   }
   for(const key of ['file_size','width','height','duration','sub_type'])if(Number.isSafeInteger(row.data?.[key])&&row.data[key]>=0)data[key]=row.data[key];
   if(row.data?.animated===true)data.animated=true;
   if(publicSticker)data.emoji_id=publicSticker;
   const marketFace=publicSticker&&typeof row.marketFace==='string'&&row.marketFace.length<=2732&&/^[A-Za-z0-9+/]*={0,2}$/.test(row.marketFace)?Buffer.from(row.marketFace,'base64'):undefined;
   let forwardScope;
   if(row.forwardScope){
    const s=row.forwardScope,chat=s.group_id||s.user_id;
    if(!Number.isSafeInteger(s.message_id)||s.message_id<1||String(s.self_id)!==row.account||!Number.isSafeInteger(chat)||chat<1||chat>0xffffffff||Boolean(s.group_id)===Boolean(s.user_id))continue;
    forwardScope={message_id:s.message_id,self_id:Number(row.account),...(s.group_id?{group_id:s.group_id}:{user_id:s.user_id})};data.forward_scope=forwardScope;
   }
   rows.set(row.id,{account:row.account,descriptor:{kind:row.kind,selfUid:row.selfUid,forwardScope,groupId:Number.isInteger(row.groupId)&&row.groupId>0&&row.groupId<=0xffffffff?row.groupId:0,peerId:Number.isInteger(row.peerId)&&row.peerId>0&&row.peerId<=0xffffffff?row.peerId:0,index:index.length?index:undefined,marketFace:marketFace?.length<=2048?marketFace:undefined,...(publicSticker?{publicSticker,url:`https://gxh.vip.qq.com/club/item/parcel/item/${publicSticker.slice(0,2)}/${publicSticker}/raw300.gif`}:{}),data}});
  }
 }catch{/* Missing/corrupt optional cache must not prevent message receipt. */}
 return rows;
}
export function saveMediaCache(file,rows){
 if(!file)return;
 // Only resource descriptors are persisted, never temporary signed CDN URLs.
 const values=[...rows.entries()].filter(([,r])=>r.descriptor.index||r.descriptor.publicSticker).slice(-LIMIT).map(([id,r])=>({id,account:r.account,kind:r.descriptor.kind,selfUid:r.descriptor.selfUid,forwardScope:r.descriptor.forwardScope,groupId:r.descriptor.groupId||0,peerId:r.descriptor.peerId||0,index:Buffer.from(r.descriptor.index||[]).toString('base64'),marketFace:r.descriptor.marketFace?.length<=2048?Buffer.from(r.descriptor.marketFace).toString('base64'):undefined,publicSticker:r.descriptor.publicSticker,data:r.descriptor.data}));
 const text=JSON.stringify({version:1,rows:values});if(Buffer.byteLength(text)>MAX_BYTES)throw new Error('MEDIA_CACHE_LIMIT');
 fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp';fs.writeFileSync(temp,text);fs.renameSync(temp,file);
}
