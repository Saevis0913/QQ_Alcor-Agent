import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {MEDIA_DESCRIPTOR} from './media.mjs';
import {fields,child,one,number as num,string as str,scalar as s,bytes as b,join as j} from './wire.mjs';
const uid=value=>/^u_[\w-]{4,80}$/.test(value||'');
function descriptor(raw,selfUid,peerId){
 if(!(raw instanceof Uint8Array)||!raw.length||raw.length>2048||!uid(selfUid)||!Number.isInteger(peerId)||peerId<1||peerId>0xffffffff)throw new Error('PRIVATE_FILE_DESCRIPTOR_INVALID');
 const info=fields(raw),uuid=str(info,3,512),md5=one(info,4,2),name=str(info,5,1024),size=num(info,6),resourceHash=str(info,57,512);
 if(!uuid||/[\x00-\x1f\x7f]/.test(uuid)||md5?.length!==16||!name)throw new Error('PRIVATE_FILE_DESCRIPTOR_INVALID');
 return {uuid,resourceHash,name:name.slice(0,160),size};
}
export function decodePrivateFile(raw,selfUid,peerId){
 let data;try{data=descriptor(raw,selfUid,peerId);}catch{return {type:'file',data:{error:'PRIVATE_FILE_DESCRIPTOR_INVALID'}};}
 const file='alcor-media-'+createHash('sha256').update('file:').update(selfUid).update(String(peerId)).update(raw).digest('hex');
 const segment={type:'file',data:{file,file_id:file,name:data.name,file_size:data.size,user_id:peerId}};
 Object.defineProperty(segment,MEDIA_DESCRIPTOR,{value:{kind:'file',selfUid,peerId,index:Buffer.from(raw),data:segment.data}});return segment;
}
export function encodePrivateFileDownload(info){
 const file=descriptor(info.index,info.selfUid,info.peerId);
 if(!file.resourceHash||/[\x00-\x1f\x7f]/.test(file.resourceHash))throw new Error('PRIVATE_FILE_RESOURCE_HASH_MISSING');
 const body=j(s(1,1200),s(2,1),b(14,j(b(10,info.selfUid),b(20,file.uuid),s(30,2),b(60,file.resourceHash),s(601,0))),s(101,3),s(102,103),s(200,1),b(99999,s(90200,1)));
 return {operation:'privateFileDownload',payload:j(s(1,0xe37),s(2,1200),b(4,body))};
}
function publicIPv4(host){
 if(isIP(host)!==4)return false;const [a,b]=host.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===0||b===168))||(a===198&&(b===18||b===19)));
}
export function decodePrivateFileDownload(input){
 const outer=fields(input);if(num(outer,1)!==0xe37||num(outer,2)!==1200||num(outer,3)!==0)throw new Error('PRIVATE_FILE_DOWNLOAD_REJECTED');
 const body=child(child(outer,4),14);if(num(body,10))throw new Error('PRIVATE_FILE_DOWNLOAD_REJECTED');
 const result=child(body,30),host=str(result,20,255),port=num(result,40)||80,urlPath=str(result,50,4096);
 if(![80,443].includes(port)||!urlPath.startsWith('/')||urlPath.startsWith('//')||/[\x00-\x20\x7f\\]/.test(urlPath)||
  !(/^(?:[a-z0-9-]+\.)*(?:qq\.com|qpic\.cn|qq\.com\.cn)$/i.test(host)||publicIPv4(host)))throw new Error('PRIVATE_FILE_URL_INVALID');
 const url=new URL(`${port===443?'https':'http'}://${host}${urlPath}`);if(url.hostname.toLowerCase()!==host.toLowerCase())throw new Error('PRIVATE_FILE_URL_INVALID');
 url.searchParams.set('isthumb','0');return {url:url.href,ttl:300};
}
