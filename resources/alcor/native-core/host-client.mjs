import net from 'node:net';
const operations={probe:1,stop:2,arguments:3,callback:4,identity:5,send:6,heartbeat:7,receiveStart:8,poll:9,receiveStop:10,imageDownload:11,videoDownload:12,groups:13,members:14,friends:15,groupImageDownload:16,groupVideoDownload:17,groupRecordDownload:18,recordDownload:19,groupFiles:20,groupFileDownload:21,poke:22,forward:23,profileLike:24,imageUpload:25,groupImageUpload:26,capabilities:27,privateFileDownload:28,privateRecall:29,groupRecall:30,privateHistory:31,recordUpload:32,groupRecordUpload:33,videoUpload:34,groupVideoUpload:35};
/** One bounded operation on an owned host. Send never retries; a socket error
 * after writing may leave delivery unknown. Identity flags are not online proof. */
export async function queryNativeHost({pid,nonce,operation='probe',timeoutMs=4000,expectedAccount,payload,nativeTimeoutMs=3000}={}) {
  if(!Number.isInteger(pid)||pid<1||pid>0xffffffff||typeof nonce!=='string'||!/^[0-9a-f]{32}$/.test(nonce)||
     !Object.hasOwn(operations,operation)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new Error('HOST_ARGUMENT_INVALID');
  let request=Buffer.alloc(8);request.writeUInt32LE(0x3148424c);request.writeUInt32LE(operations[operation],4);
  const hasReply=operations[operation]===6||(operations[operation]>=28&&operations[operation]<=35)||(operations[operation]>=11&&operations[operation]<=26);
  if(hasReply){
    if(typeof expectedAccount!=='string'||!(/^[1-9][0-9]{0,9}$/).test(expectedAccount)||BigInt(expectedAccount)>0xffffffffn||
       !(payload instanceof Uint8Array)||!payload.byteLength||payload.byteLength>4096||!Number.isInteger(nativeTimeoutMs)||nativeTimeoutMs<1||nativeTimeoutMs>10000)throw new Error('HOST_ARGUMENT_INVALID');
    const options=Buffer.alloc(16);options.writeBigUInt64LE(BigInt(expectedAccount));options.writeUInt32LE(payload.byteLength,8);options.writeUInt32LE(nativeTimeoutMs,12);
    request=Buffer.concat([request,options,payload]);
  }
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(`\\\\.\\pipe\\alcor-host-${pid}-${nonce}`);
    const maxBody=hasReply?131088:operation==='identity'?16:operation==='poll'?65816:0;
    const bytes=Buffer.alloc(32+maxBody);let offset=0,total,header,response,settled=false;
    const fail=error=>{if(!settled){settled=true;clearTimeout(timer);reject(error);}socket.destroy();};
    const timer=setTimeout(()=>fail(new Error('HOST_TIMEOUT')),timeoutMs);
    socket.on('connect',()=>socket.write(request));
    socket.on('data',chunk=>{
      if(offset+chunk.length>bytes.length){fail(new Error('HOST_RESPONSE_SIZE'));return;}
      chunk.copy(bytes,offset);offset+=chunk.length;if(offset<32)return;
      if(!header){
        if(bytes.readUInt32LE(0)!==0x3148424c||bytes.readUInt32LE(4)!==1||bytes.readUInt32LE(8)!==pid){fail(new Error('HOST_RESPONSE_IDENTITY'));return;}
        const bodyLength=bytes.readUInt32LE(28);total=32+bodyLength;
        if(bodyLength>maxBody || (operation==='identity'&&bodyLength!==16) || (hasReply&&bodyLength!==0&&bodyLength<16)){fail(new Error('HOST_RESPONSE_SIZE'));return;}
        header={pid,status:bytes.readUInt32LE(12),kind:bytes.readUInt32LE(16),acquired:bytes.readUInt32LE(20),released:bytes.readUInt32LE(24)};
        const validKind=operation==='probe'?[1,2].includes(header.kind):header.kind===(operation==='stop'?0:operations[operation]);
        if(header.acquired!==header.released||(!header.status&&!validKind)){fail(new Error('HOST_RESPONSE_STATE'));return;}
      }
      if(offset>total){fail(new Error('HOST_RESPONSE_SIZE'));return;}if(offset<total)return;
      response=header;
      if(operation==='identity'){
        const account=bytes.readBigUInt64LE(32),flags=bytes.readUInt32LE(40);
        if(account>0xffffffffn||bytes.readUInt32LE(44)!==0||flags>15||(!header.status&&(!account||flags!==15))){fail(new Error('HOST_RESPONSE_STATE'));return;}
        response={...header,account:account.toString(),flags};
      }else if(operation==='poll'){
        if(total<56){fail(new Error('HOST_RESPONSE_SIZE'));return;}
        const commandLength=bytes.readUInt32LE(40),payloadLength=bytes.readUInt32LE(44);
        if(commandLength>255||payloadLength>65536||56+commandLength+payloadLength!==total||bytes.readUInt32LE(52)!==0){fail(new Error('HOST_RESPONSE_SIZE'));return;}
        response={...header,sequence:bytes.readBigUInt64LE(32).toString(),dropped:bytes.readUInt32LE(48),command:bytes.subarray(56,56+commandLength).toString('utf8'),payload:Buffer.from(bytes.subarray(56+commandLength,total))};
      }else if(hasReply){
        if(total===32){if(!header.status){fail(new Error('HOST_RESPONSE_STATE'));return;}response={...header,received:false};}
        else {
          const detailLength=bytes.readUInt32LE(36),payloadLength=bytes.readUInt32LE(40),flags=bytes.readUInt32LE(44);
          if(detailLength>65536||payloadLength>65536||48+detailLength+payloadLength!==total||flags>1||(!header.status&&flags!==1)){fail(new Error('HOST_RESPONSE_STATE'));return;}
          response={...header,nativeStatus:bytes.readInt32LE(32),received:flags===1,detail:Buffer.from(bytes.subarray(48,48+detailLength)),payload:Buffer.from(bytes.subarray(48+detailLength,total))};
        }
      }
      socket.end(Buffer.from([6]));
    });
    socket.on('error',error=>{if(!response||error.code!=='EPIPE')fail(error);});
    socket.on('close',()=>{clearTimeout(timer);if(settled)return;settled=true;if(response)resolve(response);else reject(new Error('HOST_RESPONSE_INCOMPLETE'));});
  });
}
