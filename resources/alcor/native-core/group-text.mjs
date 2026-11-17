import {scalar as s,bytes as b,join as j,uin,fields,number as n} from './wire.mjs';
import {decodePrivateSendResponse} from './private-text.mjs';
import {encodeTextElement} from './outgoing-segments.mjs';
export function encodeGroupText({groupUin,text,clientSequence,random,timestamp}={}){
 return encodeGroupElements({groupUin,clientSequence,random,timestamp,elements:[encodeTextElement(text)]});
}
export function encodeGroupElements({groupUin,elements,clientSequence,random,timestamp}){
 [groupUin,clientSequence,random,timestamp].forEach(uin);
 return j(b(1,b(2,s(1,groupUin))),b(2,j(s(1,1),s(3,1))),b(3,b(1,j(...elements.map(element=>b(2,element))))),s(4,clientSequence),s(5,random),s(8,1));
}
export function decodeGroupSendResponse(input){
 const m=fields(input),seq=n(m,11);if(n(m,14))throw new Error('RESPONSE_IDENTITY');
 const transformed=j(...[...m.entries()].filter(([k])=>k!==14).flatMap(([k,values])=>values.map(({w,v})=>w===0?s(k===11?14:k,v):w===2?b(k,v):Buffer.alloc(0))));
 const result=decodePrivateSendResponse(transformed);if(result.state==='confirmed'&&!seq)throw new Error('RESPONSE_IDENTITY');return result;
}
