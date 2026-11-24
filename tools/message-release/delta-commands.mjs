import assert from 'node:assert/strict';

// Commands copy matching bytes from the installed file. Only changed byte spans are embedded.
export function commands(base, out) {
  if (!out) return '';
  const src=base ?? Buffer.alloc(0), width=16, blocks=new Map();
  for(let j=0;j+width<=src.length;j+=width){
    const k=src.toString('latin1',j,j+width);
    if(!blocks.has(k)) blocks.set(k,[]);
    blocks.get(k).push(j);
  }
  const ops=[], rebuilt=[];
  let pos=0, literal=0;
  const emitLiteral=end=>{
    if(end<=literal) return;
    const data=out.subarray(literal,end); rebuilt.push(data);
    ops.push('<bytes>'+data.toString('base64')+'</bytes>');
  };
  while(pos+width<=out.length){
    const candidates=blocks.get(out.toString('latin1',pos,pos+width)) || [];
    let offset=0, length=0;
    for(const j of candidates){
      let n=width;
      while(j+n<src.length && pos+n<out.length && src[j+n]===out[pos+n]) n++;
      if(n>length){length=n;offset=j;}
    }
    if(!length){pos++;continue;}
    emitLiteral(pos); rebuilt.push(src.subarray(offset,offset+length));
    ops.push('<copy at="'+offset+'" n="'+length+'"/>');
    pos+=length; literal=pos;
  }
  emitLiteral(out.length);
  assert.ok(Buffer.concat(rebuilt).equals(out));
  return ops.join('');
}
