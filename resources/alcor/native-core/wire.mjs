export {fields,one,child,number,string} from './media.mjs';
export function varint(value){let n=BigInt(value);if(n<0n||n>0xffffffffffffffffn)throw new Error('WIRE_INTEGER');const a=[];do{a.push(Number(n&127n)|(n>127n?128:0));n>>=7n;}while(n);return Buffer.from(a);}
export const scalar=(n,v)=>Buffer.concat([varint(n*8),varint(v)]);
export const bytes=(n,b)=>{b=typeof b==='string'?Buffer.from(b,'utf8'):Buffer.from(b);return Buffer.concat([varint(n*8+2),varint(b.length),b]);};
export const join=(...b)=>Buffer.concat(b);
export function uin(n){if(!Number.isInteger(n)||n<1||n>0xffffffff)throw new Error('QQ_ID_INVALID');return n;}
export function list(m,n,max=2000){const items=m.get(n)||[];if(items.length>max||items.some(r=>r.w!==2))throw new Error('WIRE_LIST_INVALID');return items;}
