import {createHash} from 'node:crypto';
import {bytes as b,scalar as s,join as j,fields,string} from './wire.mjs';
import {IMAGE_SLICE_BYTES,imageSliceStates} from './image-slice-hash.mjs';
/** Sequential upload; never retry a POST with an unknown remote result. */
export async function uploadMediaSlices(data,key,applicationId,{check,signal,fetchImpl=fetch}){
 if(![1413,1414,1415,1416].includes(applicationId)||typeof key!=='string'||!key||key.length>4096)throw Error('MEDIA_UPLOAD_ARGUMENT');
 const states=imageSliceStates(data);
 for(let offset=0;offset<data.length;offset+=IMAGE_SLICE_BYTES){
  check();const part=data.subarray(offset,Math.min(offset+IMAGE_SLICE_BYTES,data.length));
  const packet=j(s(1,0),s(2,applicationId),s(3,2),b(107,j(b(1,''),b(2,key),s(3,offset),s(4,offset+part.length-1),b(5,createHash('sha1').update(part).digest()),b(6,j(...states.map(hash=>b(1,hash)))),b(7,part))));
  let response;try{
   response=await fetchImpl('https://multimedia.qfile.qq.com/sliceupload',{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),headers:{'content-type':'application/octet-stream'},body:packet});
   if(!response.ok||Number(response.headers.get('content-length'))>65536)throw Error('MEDIA_UPLOAD_FAILED');
   const parts=[];let length=0;for await(const chunk of response.body){length+=chunk.length;if(length>65536)throw Error('MEDIA_UPLOAD_RESPONSE_LIMIT');parts.push(chunk);}
   if(string(fields(Buffer.concat(parts)),5)!=='success')throw Error('MEDIA_UPLOAD_REJECTED');
  }catch(error){try{await response?.body?.cancel();}catch{}throw error;}check();
 }
}
