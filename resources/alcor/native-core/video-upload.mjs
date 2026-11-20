import {createHash,randomBytes} from 'node:crypto';
import {BridgeError} from '../src/backend.mjs';
import {fields,one,child,number as n,string as str,list,bytes as b,scalar as s,join as j} from './wire.mjs';
import {inspectImage} from './image-upload.mjs';
import {uploadMediaSlices} from './media-upload-transport.mjs';
export const MAX_VIDEO_BYTES=16*1024*1024;
const fail=(code,status=400)=>{throw new BridgeError(code,status);};
function boxes(bytes){
 const out=[];let at=0;
 while(at<bytes.length){
  if(at+8>bytes.length||out.length>=1024)fail('VIDEO_BOX_INVALID');let size=bytes.readUInt32BE(at),head=8;
  if(size===1){if(at+16>bytes.length)fail('VIDEO_BOX_INVALID');const wide=bytes.readBigUInt64BE(at+8);if(wide>BigInt(bytes.length))fail('VIDEO_BOX_INVALID');size=Number(wide);head=16;}
  if(!size)size=bytes.length-at;
  if(size<head||size>bytes.length-at)fail('VIDEO_BOX_INVALID');
  out.push({type:bytes.toString('ascii',at+4,at+8),body:bytes.subarray(at+head,at+size)});at+=size;
 }return out;
}
const unique=(items,type)=>{const matches=items.filter(item=>item.type===type);if(matches.length!==1)fail('VIDEO_STRUCTURE_INVALID');return matches[0].body;};
export function inspectVideo(input){
 let data;if(typeof input==='string'){
  if(!input.startsWith('base64://')||input.length>9+4*Math.ceil(MAX_VIDEO_BYTES/3))fail('VIDEO_INPUT_INVALID');const value=input.slice(9);
  if(!value||value.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))fail('VIDEO_INPUT_INVALID');data=Buffer.from(value,'base64');if(data.toString('base64')!==value)fail('VIDEO_INPUT_INVALID');
 }else if(input instanceof Uint8Array){if(input.length>MAX_VIDEO_BYTES)fail('VIDEO_SIZE_LIMIT',413);data=Buffer.from(input);}else fail('VIDEO_INPUT_INVALID');
 if(!data.length||data.length>MAX_VIDEO_BYTES)fail('VIDEO_SIZE_LIMIT',413);
 const top=boxes(data),ftyp=unique(top,'ftyp');if(ftyp.length<8||!top.some(row=>row.type==='mdat'&&row.body.length))fail('VIDEO_STRUCTURE_INVALID');
 const movie=boxes(unique(top,'moov')),header=unique(movie,'mvhd');let timescale,duration;
 if(header[0]===0&&header.length>=20){timescale=header.readUInt32BE(12);duration=header.readUInt32BE(16);}
 else if(header[0]===1&&header.length>=32){timescale=header.readUInt32BE(20);const wide=header.readBigUInt64BE(24);if(wide>BigInt(Number.MAX_SAFE_INTEGER))fail('VIDEO_DURATION_INVALID');duration=Number(wide);}
 if(!timescale||!duration||duration/timescale>600)fail('VIDEO_DURATION_INVALID');
 const dimensions=[];
 for(const track of movie.filter(row=>row.type==='trak')){
  const parts=boxes(track.body),media=boxes(unique(parts,'mdia')),handler=unique(media,'hdlr');if(handler.toString('ascii',8,12)!=='vide')continue;
  const tkhd=unique(parts,'tkhd');if(tkhd.length<84||![0,1].includes(tkhd[0]))fail('VIDEO_TRACK_INVALID');
  const width=tkhd.readUInt32BE(tkhd.length-8)/65536,height=tkhd.readUInt32BE(tkhd.length-4)/65536;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>4096||height>4096||width*height>8388608)fail('VIDEO_DIMENSIONS_INVALID');dimensions.push({width,height});
 }
 if(dimensions.length!==1)fail('VIDEO_TRACK_INVALID');
 return {data,...dimensions[0],duration:Math.ceil(duration/timescale),md5:createHash('md5').update(data).digest('hex'),sha1:createHash('sha1').update(data).digest('hex')};
}
function fileInfo(file,video){return j(s(1,file.data.length),b(2,file.md5.toUpperCase()),b(3,file.sha1.toUpperCase()),b(4,file.md5+(video?'.mp4':'.'+file.extension)),b(5,video?s(1,2):j(s(1,1),s(2,file.format))),s(6,file.width),s(7,file.height),s(8,video?file.duration:0),s(9,video?0:1));}
export async function prepareVideo(backend,input,coverInput,{isGroup,recipient,expectedAccount,fetchImpl=fetch}={}){
 // 宿主对视频协商的实现并不稳定：一旦某次协商把管道打断，后续重试只会继续折腾 QQ。
 // 记住这个结论，之后直接给出可解释的失败码，而不是二十次 EPIPE。
 if(backend.videoUnsupported===true)fail('VIDEO_NATIVE_UNSUPPORTED',503);
 const video=inspectVideo(input);
 // 缺封面时以前落到 inspectImage 的 IMAGE_INPUT_INVALID，名字误导；先单独判封面。
 if(coverInput===undefined||coverInput===null||coverInput==='')fail('VIDEO_COVER_REQUIRED',400);
 let cover;try{cover=inspectImage(coverInput);}catch{fail('VIDEO_COVER_INVALID',400);}
 if(cover.data.length>1024*1024||!['jpg','png'].includes(cover.extension))fail('VIDEO_COVER_INVALID',400);
 const account=String(backend.account),generation=backend.receiveGeneration;
 const check=()=>{if(account!==backend.account||account!==String(expectedAccount)||generation!==backend.receiveGeneration||!backend.controller.snapshot().connected)fail('VIDEO_CONNECTION_CHANGED',409);};check();
 if(!Number.isInteger(recipient)||recipient<1||recipient>0xffffffff)fail('VIDEO_TARGET_INVALID');
 const contacts=await(isGroup?backend.directory.groups():backend.directory.friends());check();const target=contacts.find(row=>(isGroup?row.group_id:row.user_id)===recipient);
 if(!target||(!isGroup&&!/^u_[\w-]{4,80}$/.test(target.uid||'')))fail('VIDEO_TARGET_UNRESOLVED',404);
 const scene=j(s(101,2),s(102,2),s(200,isGroup?2:1),isGroup?b(202,s(1,recipient)):b(201,j(s(1,2),b(2,target.uid))));
 const head=j(b(1,j(s(1,1),s(2,100))),b(2,scene),b(3,s(1,2)));
 const upload=j(b(1,b(1,fileInfo(video,true))),b(1,j(b(1,fileInfo(cover,false)),s(2,100))),s(2,1),s(3,0),s(4,randomBytes(4).readUInt32LE()),s(5,isGroup?2:1),b(6,b(2,b(3,Buffer.from('800100','hex')))),s(7,10),s(8,0));
 const command=isGroup?0x11ea:0x11e9;
 let reply;
 try{
  reply=await backend.controller.request(isGroup?'groupVideoUpload':'videoUpload',{payload:j(s(1,command),s(2,100),b(4,j(b(1,head),b(2,upload)))),expectedAccount:account,nativeTimeoutMs:8000,timeoutMs:10000});
 }catch(error){
  const text=String(error?.message||error);
  if(/EPIPE|ECONNRESET|ECONNABORTED|socket/i.test(text)){backend.videoUnsupported=true;fail('VIDEO_NATIVE_UNSUPPORTED',503);}
  throw error;
 }
 check();
 if(reply.status!==0||!reply.received||reply.nativeStatus!==0)fail('VIDEO_NEGOTIATION_UNCONFIRMED',502);
 let info,key,coverKey;try{
  const envelope=fields(reply.payload);if(n(envelope,1)!==command||n(envelope,2)!==100||n(envelope,3))throw Error();const response=child(envelope,4);if(!response.has(1)||n(child(response,1),2))throw Error();
  const upload=child(response,2);key=str(upload,1);info=one(upload,6,2);if(!info||info.length>3000)throw Error();
  const bodies=list(fields(info),1,2);if(bodies.length!==2)throw Error();
  for(let i=0;i<2;i++){const index=child(fields(bodies[i].v),1),file=child(index,1),expected=i?cover:video;if(!str(index,2)||n(file,1)!==expected.data.length||str(file,2).toLowerCase()!==expected.md5||str(file,3).toLowerCase()!==expected.sha1)throw Error();}
  const sub=list(upload,10,4).map(row=>fields(row.v)).filter(row=>n(row,1)===100);if(sub.length!==1)throw Error();coverKey=str(sub[0],2);
 }catch{fail('VIDEO_NEGOTIATION_INVALID',502);}
 const signal=AbortSignal.timeout(90000);
 try{if(key)await uploadMediaSlices(video.data,key,isGroup?1415:1413,{check,signal,fetchImpl});if(coverKey)await uploadMediaSlices(cover.data,coverKey,isGroup?1416:1414,{check,signal,fetchImpl});}
 catch(error){if(error instanceof BridgeError)throw error;fail('VIDEO_UPLOAD_REJECTED',502);}check();
 return [b(53,j(s(1,48),b(2,info),s(3,isGroup?21:11)))];
}
