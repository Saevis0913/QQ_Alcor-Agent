import {createHash,randomBytes} from 'node:crypto';
import {BridgeError} from '../src/backend.mjs';
import {fields,one,child,number,string,bytes as b,scalar as s,join as j} from './wire.mjs';
import {IMAGE_SLICE_BYTES,imageSliceStates} from './image-slice-hash.mjs';
export const MAX_RECORD_BYTES=8*1024*1024;
const fail=(code,status=400)=>{throw new BridgeError(code,status);};
export function inspectRecord(input){
 let data;
 if(typeof input==='string'){
  if(!input.startsWith('base64://')||input.length>9+4*Math.ceil(MAX_RECORD_BYTES/3))fail('RECORD_INPUT_INVALID');
  const value=input.slice(9);if(!value||value.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))fail('RECORD_INPUT_INVALID');
  data=Buffer.from(value,'base64');if(data.toString('base64')!==value)fail('RECORD_INPUT_INVALID');
 }else if(input instanceof Uint8Array){if(input.length>MAX_RECORD_BYTES)fail('RECORD_SIZE_LIMIT',413);data=Buffer.from(input);}else fail('RECORD_INPUT_INVALID');
 if(data.length>MAX_RECORD_BYTES)fail('RECORD_SIZE_LIMIT',413);
 const ten=data[0]===2,start=ten?10:9;
 if(data.toString('ascii',ten?1:0,start)!=='#!SILK_V3')fail('RECORD_FORMAT_UNSUPPORTED');
 let at=start,frames=0;
 while(at<data.length){
  if(at+2>data.length)fail('RECORD_FRAMING_INVALID');const length=data.readUInt16LE(at);at+=2;
  if(length===65535&&!ten&&at===data.length)break;
  if(!length||length>1024||at+length>data.length)fail('RECORD_FRAMING_INVALID');at+=length;
  if(++frames>30000)fail('RECORD_DURATION_LIMIT',413);
 }
 if(!frames)fail('RECORD_EMPTY');
 return {data,duration:Math.max(1,Math.ceil(frames/50)),md5:createHash('md5').update(data).digest('hex'),sha1:createHash('sha1').update(data).digest('hex')};
}
function negotiation(record,isGroup,recipient,uid){
 const scene=j(s(101,2),s(102,3),s(200,isGroup?2:1),isGroup?b(202,s(1,recipient)):b(201,j(s(1,2),b(2,uid))));
 const file=j(s(1,record.data.length),b(2,record.md5.toUpperCase()),b(3,record.sha1.toUpperCase()),b(4,record.md5+'.silk'),b(5,j(s(1,3),s(4,1))),s(8,record.duration));
 const ptt=j(b(11,isGroup?Buffer.alloc(0):Buffer.from('08003800','hex')),b(12,isGroup?Buffer.from('08003800','hex'):Buffer.alloc(0)),b(13,Buffer.from(isGroup?'9a0107aa030408081200':'9a010baa03080804120400000000','hex')));
 const head=j(b(1,j(s(1,1),s(2,100))),b(2,scene),b(3,s(1,2)));
 const upload=j(b(1,b(1,file)),s(2,1),s(3,0),s(4,randomBytes(4).readUInt32LE()),s(5,isGroup?2:1),b(6,b(3,ptt)),s(7,10),s(8,0));
 return j(s(1,isGroup?0x126e:0x126d),s(2,100),b(4,j(b(1,head),b(2,upload))));
}
export async function prepareRecord(backend,input,{isGroup,recipient,expectedAccount,fetchImpl=fetch}={}){
 const record=inspectRecord(input),account=String(backend.account),generation=backend.receiveGeneration;
 const check=()=>{if(account!==backend.account||account!==String(expectedAccount)||generation!==backend.receiveGeneration||!backend.controller.snapshot().connected)fail('RECORD_CONNECTION_CHANGED',409);};check();
 if(!Number.isInteger(recipient)||recipient<1||recipient>0xffffffff)fail('RECORD_TARGET_INVALID');
 const contacts=await(isGroup?backend.directory.groups():backend.directory.friends());check();
 const target=contacts.find(row=>(isGroup?row.group_id:row.user_id)===recipient);
 if(!target||(!isGroup&&!/^u_[\w-]{4,80}$/.test(target.uid||'')))fail('RECORD_TARGET_UNRESOLVED',404);
 const reply=await backend.controller.request(isGroup?'groupRecordUpload':'recordUpload',{payload:negotiation(record,isGroup,recipient,target.uid),expectedAccount:account,nativeTimeoutMs:8000,timeoutMs:10000});check();
 if(reply.status!==0||reply.received!==true||reply.nativeStatus!==0)fail('RECORD_NEGOTIATION_UNCONFIRMED',502);
 let key,info;try{
  const envelope=fields(reply.payload);if(number(envelope,1)!==(isGroup?0x126e:0x126d)||number(envelope,2)!==100||number(envelope,3))throw Error();
  const response=child(envelope,4);if(!response.has(1)||number(child(response,1),2))throw Error();
  const upload=child(response,2);key=string(upload,1);info=one(upload,6,2);if(!info||info.length>3000)throw Error();
  const bodies=fields(info).get(1);if(bodies?.length!==1||bodies[0].w!==2)throw Error();
  const index=child(fields(bodies[0].v),1),file=child(index,1);
  if(!string(index,2)||number(file,1)!==record.data.length||string(file,2).toLowerCase()!==record.md5||string(file,3).toLowerCase()!==record.sha1)throw Error();
 }catch{fail('RECORD_NEGOTIATION_INVALID',502);}
 if(key){
  const states=imageSliceStates(record.data),overall=AbortSignal.timeout(60000);
  for(let offset=0;offset<record.data.length;offset+=IMAGE_SLICE_BYTES){
   check();const body=record.data.subarray(offset,Math.min(offset+IMAGE_SLICE_BYTES,record.data.length));
   const packet=j(s(1,0),s(2,isGroup?1403:1402),s(3,2),b(107,j(b(1,''),b(2,key),s(3,offset),s(4,offset+body.length-1),b(5,createHash('sha1').update(body).digest()),b(6,j(...states.map(hash=>b(1,hash)))),b(7,body))));
   let response;try{
    response=await fetchImpl('https://multimedia.qfile.qq.com/sliceupload',{method:'POST',redirect:'error',signal:AbortSignal.any([overall,AbortSignal.timeout(15000)]),headers:{'content-type':'application/octet-stream'},body:packet});
    if(!response.ok||Number(response.headers.get('content-length'))>65536)throw Error();
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>65536)throw Error();chunks.push(chunk);}
    if(string(fields(Buffer.concat(chunks)),5)!=='success')throw Error();
   }catch{try{await response?.body?.cancel();}catch{}fail('RECORD_UPLOAD_REJECTED',502);}check();
  }
 }
 return [b(53,j(s(1,48),b(2,info),s(3,isGroup?22:12)))];
}
