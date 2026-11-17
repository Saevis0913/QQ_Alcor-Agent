import {inspectImage,MAX_IMAGE_BYTES} from './image-upload.mjs';
import {encodeTextElement} from './outgoing-segments.mjs';
import {BridgeError} from '../src/backend.mjs';

// Validate every segment before uploading any image. The native send frame is
// bounded separately after negotiation; raw image bytes never enter that frame.
export function planMixedImageMessage(segments){
 if(!Array.isArray(segments)||segments.length>16)throw new BridgeError('NATIVE_MESSAGE_SEGMENT_LIMIT',400);
 let images=0,bytes=0;
 const parts=segments.map(segment=>{
  if(segment?.type==='text'){
   const text=segment.data?.text;
   if(typeof text!=='string'||text.includes('[CQ:'))throw new BridgeError('INVALID_NATIVE_TEXT',400);
   let element;try{element=encodeTextElement(text);}catch{throw new BridgeError('INVALID_NATIVE_TEXT',400);}
   return {element,summary:text};
  }
  if(segment?.type!=='image')throw new BridgeError('NATIVE_MESSAGE_SEGMENT_UNSUPPORTED',400);
  if(++images>4)throw new BridgeError('NATIVE_MESSAGE_IMAGE_LIMIT',400);
  const image=inspectImage(segment.data?.file??segment.data?.bytes);
  bytes+=image.data.length;
  if(bytes>MAX_IMAGE_BYTES)throw new BridgeError('IMAGE_SIZE_LIMIT',413);
  return {input:image.data,summary:'[图片]'};
 });
 return {parts,summary:parts.map(part=>part.summary).join('')};
}
