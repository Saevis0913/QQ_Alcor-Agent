// Original bounded wire reader; callers impose a total packet-size limit.
const invalid=code=>{throw new Error(code);};
export function visitProtobufFields(bytes, visit) {
  let at=0;
  function varint() {
    let value=0n;
    for(let i=0;i<10;i++) {
      if(at>=bytes.length)invalid('PROTOBUF_TRUNCATED');
      const byte=bytes[at++];
      if(i===9 && byte>1)invalid('PROTOBUF_OVERFLOW');
      value|=BigInt(byte&127)<<BigInt(7*i);
      if(!(byte&128))return value;
    }
    invalid('PROTOBUF_OVERFLOW');
  }
  function take(length) {
    if(length>BigInt(bytes.length-at))invalid('PROTOBUF_TRUNCATED');
    const start=at;at+=Number(length);return bytes.subarray(start,at);
  }
  while(at<bytes.length) {
    const tag=varint();
    if(tag>0xffffffffn || tag<8n)invalid('PROTOBUF_TAG');
    const number=Number(tag>>3n),wire=Number(tag&7n);
    let value;
    if(wire===0)value=varint();
    else if(wire===1)value=take(8n);
    else if(wire===2)value=take(varint());
    else if(wire===5)value=take(4n);
    else invalid('PROTOBUF_WIRE');
    visit(number,wire,value);
  }
}
