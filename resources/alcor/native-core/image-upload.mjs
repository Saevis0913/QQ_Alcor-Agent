import {createHash,randomBytes} from 'node:crypto';
import {BridgeError} from '../src/backend.mjs';
import {fields,one,child,number,string,bytes as b,scalar as s,join as j} from './wire.mjs';
import {IMAGE_SLICE_BYTES,imageSliceStates} from './image-slice-hash.mjs';
export const MAX_IMAGE_BYTES=16*1024*1024;
const fail=(code,status=400)=>{throw new BridgeError(code,status);};
export function inspectImage(input){
 let data;
 if(typeof input==='string'){
  if(!input.startsWith('base64://')||input.length>9+4*Math.ceil(MAX_IMAGE_BYTES/3))fail('IMAGE_INPUT_INVALID');
  const value=input.slice(9);if(!value||value.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))fail('IMAGE_INPUT_INVALID');
  data=Buffer.from(value,'base64');if(data.toString('base64')!==value)fail('IMAGE_INPUT_INVALID');
 }else if(input instanceof Uint8Array){if(input.byteLength>MAX_IMAGE_BYTES)fail('IMAGE_SIZE_LIMIT',413);data=Buffer.from(input);}else fail('IMAGE_INPUT_INVALID');
 if(!data.length||data.length>MAX_IMAGE_BYTES)fail('IMAGE_SIZE_LIMIT',413);
 let width,height,format,extension;
 if(data.length>=45&&data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&data.toString('ascii',12,16)==='IHDR'&&data.readUInt32BE(8)===13){
  width=data.readUInt32BE(16);height=data.readUInt32BE(20);format=1001;extension='png';let at=8,ended=false,idat=false;
  while(at+12<=data.length){const length=data.readUInt32BE(at);if(length>data.length-at-12)fail('IMAGE_BYTES_INVALID');const type=data.toString('ascii',at+4,at+8);if(type==='IDAT')idat=true;at+=12+length;if(type==='IEND'){ended=length===0&&at===data.length;break;}}
  if(!ended||!idat)fail('IMAGE_BYTES_INVALID');
 }else if(data.length>=14&&/^GIF8[79]a$/.test(data.toString('ascii',0,6))&&data.at(-1)===0x3b){width=data.readUInt16LE(6);height=data.readUInt16LE(8);format=2000;extension='gif';}
 else if(data.length>12&&data[0]===255&&data[1]===216&&data.at(-2)===255&&data.at(-1)===217){
  let at=2;while(at+4<data.length){if(data[at++]!==255)fail('IMAGE_BYTES_INVALID');while(data[at]===255)at++;const marker=data[at++];if(marker===0xda)break;const length=data.readUInt16BE(at);if(length<2||at+length>data.length)fail('IMAGE_BYTES_INVALID');if([0xc0,0xc1,0xc2].includes(marker)&&length>=8){height=data.readUInt16BE(at+3);width=data.readUInt16BE(at+5);}at+=length;}format=1000;extension='jpg';
 }else if(data.length>=30&&data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP'){
  if(data.readUInt32LE(4)!==data.length-8)fail('IMAGE_BYTES_INVALID');
  let at=12,picture=false,canvas=false;
  while(at+8<=data.length){const kind=data.toString('ascii',at,at+4),length=data.readUInt32LE(at+4),start=at+8;if(length>data.length-start)fail('IMAGE_BYTES_INVALID');
   if(kind==='VP8X'){if(length!==10)fail('IMAGE_BYTES_INVALID');width=data.readUIntLE(start+4,3)+1;height=data.readUIntLE(start+7,3)+1;canvas=true;}
   if(kind==='VP8 '){if(length<10||!data.subarray(start+3,start+6).equals(Buffer.from('9d012a','hex')))fail('IMAGE_BYTES_INVALID');if(!canvas){width=data.readUInt16LE(start+6)&0x3fff;height=data.readUInt16LE(start+8)&0x3fff;}picture=true;}
   if(kind==='VP8L'){if(length<5||data[start]!==0x2f)fail('IMAGE_BYTES_INVALID');const bits=data.readUInt32LE(start+1);if(!canvas){width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;}picture=true;}
   if(kind==='ANMF'&&canvas&&length>=24)picture=true;
   at=start+length+(length%2);
  }
  if(at!==data.length||!picture)fail('IMAGE_BYTES_INVALID');format=1002;extension='webp';
 }else fail('IMAGE_FORMAT_UNSUPPORTED');
 if(!width||!height||width>8192||height>8192||width*height>32*1024*1024)fail('IMAGE_DIMENSIONS_INVALID');
 return {data,width,height,format,extension,md5:createHash('md5').update(data).digest('hex'),sha1:createHash('sha1').update(data).digest('hex')};
}
export function encodeImageSlice(image,key,isGroup,offset=0,states){
 if(typeof key!=='string'||!key||key.length>4096)fail('IMAGE_UPLOAD_KEY_INVALID',502);
 if(!Number.isInteger(offset)||offset<0||offset>=image.data.length||offset%IMAGE_SLICE_BYTES)fail('IMAGE_SLICE_RANGE');
 states??=imageSliceStates(image.data);
 const body=image.data.subarray(offset,Math.min(offset+IMAGE_SLICE_BYTES,image.data.length));
 const hash=createHash('sha1').update(body).digest();
 return j(s(1,0),s(2,isGroup?1407:1406),s(3,2),b(107,j(b(1,''),b(2,key),s(3,offset),s(4,offset+body.length-1),b(5,hash),b(6,j(...states.map(hash=>b(1,hash)))),b(7,body))));
}
function negotiation(image,isGroup,recipient,uid){
 const scene=j(s(101,2),s(102,1),s(200,isGroup?2:1),isGroup?b(202,s(1,recipient)):b(201,j(s(1,2),b(2,uid))));
 const file=j(s(1,image.data.length),b(2,image.md5.toUpperCase()),b(3,image.sha1.toUpperCase()),b(4,image.md5+'.'+image.extension),b(5,j(s(1,1),s(2,image.format))),s(6,image.width),s(7,image.height),s(9,1));
 const head=j(b(1,j(s(1,1),s(2,100))),b(2,scene),b(3,s(1,2)));
 const upload=j(b(1,b(1,file)),s(2,1),s(3,0),s(4,randomBytes(4).readUInt32LE()),s(5,isGroup?2:1),b(6,b(1,j(s(1,0),b(2,'[图片]')))),s(7,10),s(8,0));
 return j(s(1,isGroup?0x11c4:0x11c5),s(2,100),b(4,j(b(1,head),b(2,upload))));
}
export async function prepareImage(backend,input,{isGroup,recipient,expectedAccount,fetchImpl=fetch,deadlineAt=Infinity}={}){
 const image=inspectImage(input),account=String(backend.account),generation=backend.receiveGeneration;
 const current=()=>account===backend.account&&account===String(expectedAccount)&&generation===backend.receiveGeneration&&backend.controller.snapshot().connected;
 const check=()=>{if(Date.now()>=deadlineAt)fail('IMAGE_UPLOAD_TIMEOUT',504);if(!current())fail('IMAGE_CONNECTION_CHANGED',409);};check();
 if(!Number.isInteger(recipient)||recipient<1||recipient>0xffffffff)fail('IMAGE_TARGET_INVALID');
 const contacts=await (isGroup?backend.directory.groups():backend.directory.friends());check();
 const target=contacts.find(row=>(isGroup?row.group_id:row.user_id)===recipient);
 if(!target||(!isGroup&&!/^u_[\w-]{4,80}$/.test(target.uid??'')))fail('IMAGE_TARGET_UNRESOLVED',404);
 const reply=await backend.controller.request(isGroup?'groupImageUpload':'imageUpload',{payload:negotiation(image,isGroup,recipient,target.uid),expectedAccount:account,nativeTimeoutMs:8000,timeoutMs:10000});check();
 if(reply.status!==0||reply.received!==true||reply.nativeStatus!==0)fail('IMAGE_NEGOTIATION_UNCONFIRMED',502);
 let info,key;try{
  const envelope=fields(reply.payload);if(number(envelope,1)!==(isGroup?0x11c4:0x11c5)||number(envelope,2)!==100||number(envelope,3))throw new Error();
  const response=child(envelope,4);if(!response.has(1)||number(child(response,1),2))throw new Error();
  const upload=child(response,2);key=string(upload,1);info=one(upload,6,2);if(!info||info.length>3000)throw new Error();
  const bodies=fields(info).get(1);if(bodies?.length!==1||bodies[0].w!==2)throw new Error();
  const index=child(fields(bodies[0].v),1),file=child(index,1);
  if(!string(index,2)||number(file,1)!==image.data.length||string(file,2).toLowerCase()!==image.md5||string(file,3).toLowerCase()!==image.sha1)throw new Error();
 }catch{fail('IMAGE_NEGOTIATION_INVALID',502);}
 if(key){
  const states=imageSliceStates(image.data),overall=AbortSignal.timeout(Math.max(1,Math.min(60000,deadlineAt-Date.now())));
  for(let offset=0;offset<image.data.length;offset+=IMAGE_SLICE_BYTES){
  check();const signal=AbortSignal.any([overall,AbortSignal.timeout(15000)]);let response;
  try{response=await fetchImpl('https://multimedia.qfile.qq.com/sliceupload',{method:'POST',redirect:'error',signal,headers:{'content-type':'application/octet-stream'},body:encodeImageSlice(image,key,isGroup,offset,states)});
   if(!response.ok||Number(response.headers.get('content-length'))>65536)throw new Error();
   const parts=[];let length=0;for await(const part of response.body){length+=part.length;if(length>65536){throw new Error();}parts.push(part);}if(string(fields(Buffer.concat(parts)),5)!=='success')throw new Error();
  }catch{try{await response?.body?.cancel();}catch{}fail('IMAGE_UPLOAD_REJECTED',502);}check();
  }
 }
 // Server-provided MsgInfo is preserved; no received-sticker impersonation or caller URLs.
 return [b(53,j(s(1,48),b(2,info),s(3,isGroup?20:10)))];
}
