import { visitProtobufFields } from './protobuf-fields.mjs';
export const PRIVATE_TEXT_COMMAND='MessageSvc.PbSendMsg';
const invalid=code=>{throw new Error(code);};
function uint32(value) {
  if(typeof value!=='number' || !Number.isInteger(value) || value<1 || value>0xffffffff)invalid('TEXT_ARGUMENT');
  return value;
}
function varint(value) {
  const bytes=[];
  do {const part=value%128;value=Math.floor(value/128);bytes.push(part|(value?128:0));}while(value);
  return Buffer.from(bytes);
}
const scalar=(field,value)=>Buffer.concat([varint(field*8),varint(value)]);
const message=(field,bytes)=>Buffer.concat([varint(field*8+2),varint(bytes.length),bytes]);

/** Pure encoding: no account lookup, counter allocation, clock, network or retry.
 * The 32 KiB text cap is our bound, not a claim about QQ's server-side limit. */
export function encodePrivateText({recipientUin,text,clientSequence,random,timestamp}={}) {
  [recipientUin,clientSequence,random,timestamp].forEach(uint32);
  if(typeof text!=='string' || !text.length || !text.isWellFormed())invalid('TEXT_CONTENT');
  if(Buffer.byteLength(text,'utf8')>32768)invalid('TEXT_LENGTH');
  const route=message(1,scalar(1,recipientUin));
  const head=Buffer.concat([scalar(1,1),scalar(3,11)]);
  const element=message(1,message(1,Buffer.from(text,'utf8')));
  const body=message(1,message(2,element));
  return Buffer.concat([message(1,route),message(2,head),message(3,body),scalar(4,clientSequence),scalar(5,random),message(12,scalar(1,timestamp))]);
}
function signed32(value) {
  if(value>0xffffffffn && value<0xffffffff80000000n)invalid('PROTOBUF_OVERFLOW');
  return Number(BigInt.asIntN(32,value));
}
/** Reply confirmation is service-level only. An unconfirmed result must not be
 * automatically resent: the original request may already have been processed. */
export function decodePrivateSendResponse(input) {
  if(!(input instanceof Uint8Array))invalid('RESPONSE_BYTES');
  if(!input.byteLength || input.byteLength>65536)invalid('RESPONSE_LENGTH');
  const bytes=Buffer.from(input.buffer,input.byteOffset,input.byteLength);
  let result=0,reviewResult=0,serverCode=0,errorMessage='',sequence=0,timestamp=0,groupSequence=0;
  visitProtobufFields(bytes,(number,wire,value)=>{
    if([1,3,6,11,14].includes(number)) {
      if(wire!==0)invalid('PROTOBUF_WIRE');
      if(number===1)result=signed32(value);
      else if(number===6)reviewResult=signed32(value);
      else {
        if(value>0xffffffffn)invalid('PROTOBUF_OVERFLOW');
        if(number===3)timestamp=Number(value);
        else if(number===11)groupSequence=Number(value);
        else sequence=Number(value);
      }
    } else if(number===2) {
      if(wire!==2)invalid('PROTOBUF_WIRE');
      try{errorMessage=new TextDecoder('utf-8',{fatal:true}).decode(value);}catch{invalid('RESPONSE_UTF8');}
    } else if(number===7) {
      if(wire!==2)invalid('PROTOBUF_WIRE');
      visitProtobufFields(value,(field,type,code)=>{if(field===2){if(type!==0)invalid('PROTOBUF_WIRE');serverCode=signed32(code);}});
    }
  });
  if(groupSequence)invalid('RESPONSE_IDENTITY');
  if(result || reviewResult || serverCode)return {state:'rejected',acceptedByService:false,result,reviewResult,serverCode,errorMessage};
  if(!sequence || !timestamp)return {state:'unconfirmed',acceptedByService:false};
  return {state:'confirmed',acceptedByService:true,sequence,timestamp};
}
