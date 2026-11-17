import {prepareImage,MAX_IMAGE_BYTES} from '../native-core/image-upload.mjs';
import {prepareRecord} from '../native-core/record-upload.mjs';
import {prepareVideo} from '../native-core/video-upload.mjs';
import {planMixedImageMessage} from '../native-core/mixed-image-message.mjs';
import {sendProfileLike} from '../native-core/profile-like.mjs';
import {randomBytes} from 'node:crypto';
import {NativeController} from '../native-core/controller.mjs';
import {encodePrivateText,decodePrivateSendResponse} from '../native-core/private-text.mjs';
import {BridgeError} from './backend.mjs';
import {decodeMessagePush} from '../native-core/message-push.mjs';
import {decodeNoticePush,resolveNotice,NOTICE_SOURCE} from '../native-core/notice-push.mjs';
import {encodePrivateFileDownload,decodePrivateFileDownload} from '../native-core/private-file.mjs';
import {encodeGroupText,encodeGroupElements,decodeGroupSendResponse} from '../native-core/group-text.mjs';
import {NativeDirectory} from '../native-core/directory-cache.mjs';
import {REPLY_SOURCE,encodeMentionElement,encodePrivateElements,encodeReplyElement,encodeTextElement} from '../native-core/outgoing-segments.mjs';
import {MEDIA_DESCRIPTOR,encodeMediaDownload,decodeMediaDownload} from '../native-core/media.mjs';
import {loadMediaCache,saveMediaCache} from '../native-core/media-cache.mjs';
import {readForward,sendPoke} from '../native-core/message-actions.mjs';
import {encodeReceivedSticker} from '../native-core/received-sticker.mjs';
import {recallMessage,rememberSent} from '../native-core/message-recall.mjs';
const ok=data=>({status:'ok',retcode:0,data});
export const NATIVE_ACTIONS=Object.freeze([
  'get_status','get_login_info','get_version_info','get_msg','send_private_msg','send_group_msg','send_msg',
  'get_friend_list','get_group_list','get_group_info','get_group_member_info','get_group_member_list',
  'get_group_root_files','get_group_files_by_folder','get_group_file_url','get_image','get_video','get_record',
  'get_forward_msg','can_send_image','send_like','send_poke','friend_poke','group_poke','get_private_file_url','delete_msg'
]);
const supportedActions=new Set(NATIVE_ACTIONS);
export class NativeBackend{
  constructor(config,{controller=new NativeController(),mediaFile}={}){this.config=config;this.controller=controller;this.mediaFile=mediaFile;this.events=0;this.receiving=false;this.confirmed=false;this.receiveGeneration=0;this.messages=new Map();this.media=loadMediaCache(mediaFile);this.seen=new Set();this.messageCounter=randomBytes(4).readUInt32LE()&0x3fffffff;this.lastReceivedAt=null;this.lastError=null;this.directory=new NativeDirectory(this);}
  start(onEvent){this.onEvent=onEvent;this.metaTimer=setInterval(()=>{if(this.receiving&&this.controller.snapshot().connected)this.onEvent?.({time:Math.floor(Date.now()/1000),self_id:Number(this.account),post_type:'meta_event',meta_event_type:'heartbeat',status:{online:this.snapshot().qqOnline,good:this.snapshot().qqOnline},interval:15000});},15000);this.metaTimer.unref();}
  snapshot(){const s=this.controller.snapshot();return {...s,type:'native',http:s.connected?'reachable':'idle',ws:this.receiving&&s.connected?'open':'unavailable',qqOnline:!!(s.connected&&this.receiving&&this.confirmed),receiveReady:!!(s.connected&&this.receiving),events:this.events,reconnects:this.recoveries??0,lastReceivedAt:this.lastReceivedAt,lastError:s.lastError??this.lastError,capabilityScope:'private-group-text-and-media-receive',onlineBasis:'local identity plus observed send/receive confirmation'};}
  recordRecovery(){this.recoveries=(this.recoveries??0)+1;}
  stopReceiving(){clearInterval(this.timer);this.receiving=false;this.confirmed=false;this.receiveGeneration++;this.messages.clear();}
  connect(pid,expected={}){
    if(this.closing)return Promise.reject(new BridgeError('NATIVE_NOT_CONNECTED',503));
    if(this.connecting)return this.connecting.pid===pid&&this.connecting.account===expected.account&&this.connecting.startedAt===expected.startedAt?this.connecting.promise:Promise.reject(new BridgeError('CONNECTION_BUSY',409));
    const promise=this.openConnection(pid,expected);this.connecting={pid,promise,account:expected.account,startedAt:expected.startedAt};
    promise.finally(()=>{if(this.connecting?.promise===promise)this.connecting=null;}).catch(()=>{});return promise;
  }
  async openConnection(pid,expected={}){
    if(!this.controller.snapshot().connected){this.stopReceiving();this.lastError=null;}
    const generation=this.receiveGeneration;const s=await this.controller.connect(pid,expected);
    try{
      if(generation!==this.receiveGeneration)throw new BridgeError('NATIVE_CONNECT_CANCELLED',409);
      const id=await this.controller.request('identity');
      if(id.status!==0||id.flags!==15||!id.account||id.account==='0')throw new BridgeError('QQ_LOGIN_NOT_CONFIRMED',503);
      if(expected.account&&id.account!==expected.account)throw new BridgeError('HOST_ACCOUNT_CHANGED',409);
      if(this.account!==id.account){this.messages.clear();this.seen.clear();this.confirmed=false;this.directory.clear();}this.account=id.account;
      if(!this.receiving){
        const r=await this.controller.request('receiveStart');if(r.status!==0)throw new BridgeError('NATIVE_RECEIVE_START_FAILED',503);
        if(generation!==this.receiveGeneration)throw new BridgeError('NATIVE_CONNECT_CANCELLED',409);
        this.receiving=true;this.lastError=null;this.timer=setInterval(()=>this.poll().catch(()=>{}),350);this.timer.unref();
      }
      return {...s,receiveReady:true};
    }catch(error){this.stopReceiving();try{await this.controller.disconnect();}catch{}throw error;}
  }
  async poll(){
    if(this.polling||!this.receiving)return;this.polling=true;const generation=this.receiveGeneration;
    try{for(let i=0;i<32&&this.receiving;i++){
      const packet=await this.controller.request('poll');if(generation!==this.receiveGeneration||!this.receiving)return;if(packet.status!==0)throw new Error('NATIVE_RECEIVE_FAILED');this.dropped=packet.dropped;
      if(!packet.payload?.length)break;
      let notices;try{notices=decodeNoticePush(packet.payload,this.account);}catch{this.lastError='NATIVE_NOTICE_PARSE_FAILED';continue;}
      if(notices!==null){
        for(const notice of notices){
          const key='notice:'+notice[NOTICE_SOURCE].key;if(this.seen.has(key))continue;
          try{await resolveNotice(notice,this);}catch(error){this.lastError=/^NOTICE_[A-Z_]+$/.test(error.message)?error.message:'NATIVE_NOTICE_RESOLVE_FAILED';continue;}
          if(generation!==this.receiveGeneration||!this.receiving)return;
          this.seen.add(key);if(this.seen.size>2048)this.seen.delete(this.seen.values().next().value);
          this.confirmed=true;this.events++;this.lastReceivedAt=new Date().toISOString();this.onEvent?.(notice);
        }
        continue;
      }
      let event;try{event=decodeMessagePush(packet.payload,this.account);}catch{this.lastError='NATIVE_PUSH_PARSE_FAILED';continue;}
      if(!event)continue;const key=event.self_id+':'+(event.group_id||'private')+':'+event.user_id+':'+event.sequence+':'+event.time;if(this.seen.has(key))continue;this.seen.add(key);if(this.seen.size>2048)this.seen.delete(this.seen.values().next().value);
      await Promise.race([this.directory.enrich(event),new Promise(resolve=>{const timeout=setTimeout(resolve,1500);timeout.unref();})]);if(generation!==this.receiveGeneration||!this.receiving)return;
      event.message_id=this.messageCounter++;this.rememberMedia(event);this.messages.set(event.message_id,event);if(this.messages.size>1000)this.messages.delete(this.messages.keys().next().value);
      this.confirmed=true;this.events++;this.lastReceivedAt=new Date().toISOString();this.onEvent?.(event);
    }}catch(error){if(error?.message==='HOST_QUEUE_TIMEOUT')return;if(generation===this.receiveGeneration){this.lastError='NATIVE_RECEIVE_CONNECTION_LOST';this.stopReceiving();try{await this.controller.disconnect();}catch{}}}finally{this.polling=false;}
  }
  async disconnect(){this.stopReceiving();await this.controller.disconnect();}
  rememberMedia(event){
    let changed=false;
    for(const segment of event.message||[]){const descriptor=segment[MEDIA_DESCRIPTOR];if(!descriptor||!segment.data?.file)continue;
      changed=true;
      this.media.set(segment.data.file,{descriptor,account:this.account});while(this.media.size>2000)this.media.delete(this.media.keys().next().value);
    }
    if(changed)this.mediaDirty=true;
    if(changed&&this.mediaFile&&!this.mediaSaveTimer){this.mediaSaveTimer=setTimeout(()=>this.flushMedia(),100);this.mediaSaveTimer.unref();}
  }
  flushMedia(){clearTimeout(this.mediaSaveTimer);this.mediaSaveTimer=null;if(!this.mediaDirty)return;try{saveMediaCache(this.mediaFile,this.media);this.mediaDirty=false;}catch{this.lastError='NATIVE_MEDIA_CACHE_WRITE_FAILED';}}
  async readMedia(file,kind,params={}){
    const row=this.media.get(file);if(!row||row.account!==this.account)throw new BridgeError('NATIVE_MEDIA_NOT_IN_SESSION_CACHE',404);
    const scope=row.descriptor.forwardScope;
    if(kind==='file'&&String(params.user_id)!==String(row.descriptor.peerId))throw new BridgeError('PRIVATE_FILE_SCOPE_MISMATCH',404);
    if(scope && (String(params.message_id)!==String(scope.message_id)||String(params.self_id)!==String(scope.self_id)||
      String(params.group_id||0)!==String(scope.group_id||0)||String(params.user_id||0)!==String(scope.user_id||0)))throw new BridgeError('NATIVE_MEDIA_SCOPE_MISMATCH',404);
    if(row.descriptor.kind!==kind)throw new BridgeError('NATIVE_MEDIA_KIND_MISMATCH',400);
    if(!this.controller.snapshot().connected)throw new BridgeError('NATIVE_NOT_CONNECTED',503);
    const result=url=>ok({...row.descriptor.data,url});
    if(row.url&&row.expires>Date.now())return result(row.url);
    if(!row.pending){
      const account=this.account,generation=this.receiveGeneration;
      row.pending=(async()=>{
        if(row.descriptor.url)return {url:row.descriptor.url,ttl:300};
        let request;try{request=kind==='file'?encodePrivateFileDownload(row.descriptor):encodeMediaDownload(row.descriptor);}catch{throw new BridgeError('NATIVE_MEDIA_DESCRIPTOR_INVALID',400);}
        const reply=await this.controller.request(request.operation,{payload:request.payload,nativeTimeoutMs:8000,timeoutMs:10000,expectedAccount:account});
        if(account!==this.account||generation!==this.receiveGeneration)throw new BridgeError('NATIVE_MEDIA_CONNECTION_CHANGED',409);
        if(reply.status!==0||!reply.received||reply.nativeStatus!==0)throw new BridgeError('NATIVE_MEDIA_DOWNLOAD_UNCONFIRMED',502);
        try{const resource=kind==='file'?decodePrivateFileDownload(reply.payload):decodeMediaDownload(reply.payload,kind,row.descriptor.groupId||0);this.confirmed=true;return resource;}catch(e){throw new BridgeError(e.message,502);}
      })().then(r=>{row.url=r.url;row.expires=Date.now()+Math.max(0,r.ttl-Math.min(15,r.ttl/10))*1000;return r.url;}).finally(()=>{row.pending=null;});
    }
    return result(await row.pending);
  }
  async resolveOutgoingAddress(address,isGroup,recipient,account){
    if(address.type==='at'){
      const qq=String(address.data?.qq??'');
      if(!isGroup||!/^\d{1,10}$/.test(qq)||Number(qq)<1||Number(qq)>0xffffffff)throw new BridgeError('NATIVE_MESSAGE_SEGMENT_UNSUPPORTED',400);
      let members;
      try{members=await this.directory.members(recipient,true);}catch{throw new BridgeError('NATIVE_MENTION_DIRECTORY_UNAVAILABLE',502);}
      const member=members.find(row=>row.user_id===Number(qq));
      try{return encodeMentionElement(member);}catch{throw new BridgeError('NATIVE_MENTION_MEMBER_UNRESOLVED',404);}
    }
    const id=String(address.data?.id??'');
    const event=/^[1-9]\d{0,15}$/.test(id)?this.messages.get(Number(id)):null;
    const source=event?.[REPLY_SOURCE];
    if(!source||!account||String(event.self_id)!==account||
       event.message_type!==(isGroup?'group':'private')||(isGroup?event.group_id:event.user_id)!==recipient){
      throw new BridgeError('NATIVE_REPLY_NOT_IN_CONVERSATION_CACHE',404);
    }
    try{return encodeReplyElement(event,source,isGroup);}catch{throw new BridgeError('NATIVE_REPLY_SOURCE_INVALID',400);}
  }
  prepareOutgoingImage(input,options){return prepareImage(this,input,options);}
  prepareOutgoingRecord(input,options){return prepareRecord(this,input,options);}
  prepareOutgoingVideo(input,cover,options){return prepareVideo(this,input,cover,options);}
  async call(action,params={}){
    if(params.expected_self_id!=null&&(!/^[1-9]\d{0,9}$/.test(String(params.expected_self_id))||String(params.expected_self_id)!==String(this.account)))throw new BridgeError('NATIVE_ACCOUNT_CHANGED',409);
    if(!supportedActions.has(action))throw new BridgeError('NATIVE_ACTION_NOT_IMPLEMENTED',501);
    if(action==='can_send_image'){
      const account=this.account,generation=this.receiveGeneration;let supported=false;
      if(this.controller.snapshot().connected){try{const r=await this.controller.request('capabilities',{timeoutMs:2000});supported=r.status===0&&r.kind===27&&account===this.account&&generation===this.receiveGeneration&&this.controller.snapshot().connected;}catch{}}
      return ok({yes:supported,max_bytes:MAX_IMAGE_BYTES,formats:['png','jpeg','gif','webp'],account_required:true});
    }
    if(action==='send_like')return ok(await sendProfileLike(this,params));
    if(action==='delete_msg')return ok(await recallMessage(this,params));
    if(['send_poke','friend_poke','group_poke'].includes(action))return ok(await sendPoke(this,action,params));
    if(action==='get_forward_msg'){const {expected_self_id,...scoped}=params;return ok(await readForward(this,scoped));}
    if(action==='get_private_file_url'){
      if(params.expected_self_id==null)throw new BridgeError('PRIVATE_FILE_ACCOUNT_REQUIRED',400);
      return this.readMedia(String(params.file_id||''),'file',params);
    }
    if(action==='send_msg'&&((params.message_type==='private'&&params.group_id)||(params.message_type==='group'&&params.user_id)))throw new BridgeError('CONFLICTING_MESSAGE_TARGET',400);
    if(['get_image','get_video','get_record'].includes(action))return this.readMedia(String(params.file||params.file_id||''),action.slice(4),params);
    if(['get_group_list','get_friend_list','get_group_member_list','get_group_member_info','get_group_info','get_group_root_files','get_group_files_by_folder','get_group_file_url'].includes(action)){
      try{
        const group=Number(params.group_id),force=params.no_cache===true;
        if(action==='get_group_list')return ok(await this.directory.groups(force));
        if(action==='get_friend_list')return ok(await this.directory.friends(force));
        if(action==='get_group_member_list')return ok(await this.directory.members(group,force));
        if(action==='get_group_member_info'){const r=(await this.directory.members(group,force)).find(r=>r.user_id===Number(params.user_id));if(!r)throw new BridgeError('GROUP_MEMBER_NOT_FOUND',404);return ok(r);}
        if(action==='get_group_info'){const r=(await this.directory.groups(force)).find(r=>r.group_id===group);if(!r)throw new BridgeError('GROUP_NOT_FOUND',404);return ok(r);}
        if(action==='get_group_file_url')return ok(await this.directory.fileUrl(group,String(params.file_id||''),Number(params.busid??102)));
        return ok(await this.directory.files(group,action==='get_group_root_files'?'/':String(params.folder_id||'/')));
      }catch(e){if(e instanceof BridgeError)throw e;throw new BridgeError(/^[A-Z_]+$/.test(e.message)?e.message:'DIRECTORY_QUERY_FAILED',502);}
    }
    if(action==='get_version_info')return ok({app_name:'Alcor Native',app_version:'0.1.0',protocol_version:'v11'});
    if(action==='get_status'){const s=this.snapshot();return ok({online:s.qqOnline,good:s.receiveReady&&s.qqOnline,native:s,reason:s.qqOnline?null:s.receiveReady?'AWAITING_REMOTE_CONFIRMATION':'NATIVE_RECEIVE_NOT_READY'});}
    if(action==='get_msg'){const e=this.messages.get(Number(params.message_id));if(!e)throw new BridgeError('NATIVE_MESSAGE_NOT_IN_SESSION_CACHE',404);return ok({...e,real_id:e.sequence});}
    if(action==='get_login_info'){
      const r=await this.controller.request('identity');if(r.status!==0)throw new BridgeError('QQ_LOGIN_NOT_CONFIRMED',503);
      return ok({user_id:Number(r.account),nickname:'QQ '+r.account.slice(-4)});
    }
    if(action==='send_private_msg'||action==='send_group_msg'||(action==='send_msg'&&(params.message_type==='private'||params.group_id||(params.message_type===undefined&&params.user_id&&!params.group_id)))){
      const isGroup=action==='send_group_msg'||(action==='send_msg'&&(params.message_type==='group'||params.group_id));
      let text=params.message,address,sticker,record,video,cover,mixed;
      if(Array.isArray(text)){
        const segments=text;
        if(['reply','at'].includes(segments[0]?.type))address=segments[0];
        const body=address?segments.slice(1):segments;
        if(!address&&body.length===1&&body[0]?.type==='image'){sticker=body[0].data?.file??body[0].data?.bytes;if(!(typeof sticker==='string'&&sticker.length)&&!(sticker instanceof Uint8Array))throw new BridgeError('IMAGE_INPUT_INVALID',400); text='[图片]';}
        else if(!address&&body.length===1&&body[0]?.type==='record'){record=body[0].data?.file??body[0].data?.bytes;if(!(typeof record==='string'&&record.length)&&!(record instanceof Uint8Array))throw new BridgeError('RECORD_INPUT_INVALID',400);text='[语音]';}
        else if(!address&&body.length===1&&body[0]?.type==='video'){video=body[0].data?.file??body[0].data?.bytes;cover=body[0].data?.thumb;if(!(typeof video==='string'&&video.length)&&!(video instanceof Uint8Array))throw new BridgeError('VIDEO_INPUT_INVALID',400);text='[视频]';}
        else if(body.some(segment=>segment?.type==='image')){if(params.expected_self_id==null)throw new BridgeError('IMAGE_ACCOUNT_REQUIRED',400);mixed=planMixedImageMessage(body);text=mixed.summary;}
        else {if(body.some(s=>s?.type!=='text'||typeof s.data?.text!=='string'))throw new BridgeError('NATIVE_MESSAGE_SEGMENT_UNSUPPORTED',400);
        text=body.map(s=>s.data.text).join('');}
      }
      if(typeof text!=='string'||text.includes('[CQ:'))throw new BridgeError('NATIVE_TEXT_ONLY',400);
      const recipient=Number(isGroup?params.group_id:params.user_id);const positive=()=>randomBytes(4).readUInt32LE()||1;let payload;
      const account=this.account,generation=this.receiveGeneration;
      const options={groupUin:recipient,recipientUin:recipient,text,clientSequence:positive(),random:positive(),timestamp:Math.floor(Date.now()/1000)};
      try{payload=(isGroup?encodeGroupText:encodePrivateText)(options);}catch{throw new BridgeError('INVALID_NATIVE_TEXT',400);}
      if(mixed){
        const elements=[],deadlineAt=Date.now()+75000;
        if(address)elements.push(await this.resolveOutgoingAddress(address,isGroup,recipient,account));
        for(const part of mixed.parts){
          if(account!==this.account||generation!==this.receiveGeneration)throw new BridgeError('NATIVE_SEND_CONNECTION_CHANGED',409);
          if(Date.now()>=deadlineAt)throw new BridgeError('IMAGE_UPLOAD_TIMEOUT',504);
          elements.push(...(part.element?[part.element]:await this.prepareOutgoingImage(part.input,{isGroup,recipient,expectedAccount:account,deadlineAt})));
          payload=(isGroup?encodeGroupElements:encodePrivateElements)({...options,elements});
          if(payload.length>4096)throw new BridgeError('NATIVE_TEXT_TOO_LONG',413);
        }
      }
      if(sticker){let elements;if(typeof sticker==='string'&&sticker.startsWith('alcor-media-')){
        try{elements=[encodeReceivedSticker(this.media.get(sticker),{file:sticker,account,isGroup,recipient})];}
        catch(e){
          // 收到的图/表情并不总能原样重发：私聊里 QQ 没带市场表情来源，普通图片也缺表情索引。
          // 这类情况不再直接失败，而是把缓存里那张图当普通图片上传发出（视觉与用户预期一致）。
          if(!['NATIVE_STICKER_SOURCE_UNAVAILABLE','NATIVE_STICKER_SOURCE_INVALID','NATIVE_STICKER_NOT_IN_CACHE'].includes(e.message))throw new BridgeError(e.message,400);
          let bytes;
          try{
            const media=await this.readMedia(sticker,'image',{});
            const target=media?.data?.url??media?.url;
            if(!target)throw new Error('NO_MEDIA_URL');
            const response=await fetch(target);
            if(!response.ok)throw new Error('HTTP '+response.status);
            bytes=new Uint8Array(await response.arrayBuffer());
          }catch{throw new BridgeError(e.message,400);}
          elements=await this.prepareOutgoingImage(bytes,{isGroup,recipient,expectedAccount:account});
        }
      }else{if(params.expected_self_id==null)throw new BridgeError('IMAGE_ACCOUNT_REQUIRED',400);elements=await this.prepareOutgoingImage(sticker,{isGroup,recipient,expectedAccount:account});}payload=(isGroup?encodeGroupElements:encodePrivateElements)({...options,elements});}
      if(record){if(params.expected_self_id==null)throw new BridgeError('RECORD_ACCOUNT_REQUIRED',400);const elements=await this.prepareOutgoingRecord(record,{isGroup,recipient,expectedAccount:account});payload=(isGroup?encodeGroupElements:encodePrivateElements)({...options,elements});}
      if(video){if(params.expected_self_id==null)throw new BridgeError('VIDEO_ACCOUNT_REQUIRED',400);const elements=await this.prepareOutgoingVideo(video,cover,{isGroup,recipient,expectedAccount:account});payload=(isGroup?encodeGroupElements:encodePrivateElements)({...options,elements});}
      if(address&&!mixed){
        const prefix=await this.resolveOutgoingAddress(address,isGroup,recipient,account);
        if(account!==this.account||generation!==this.receiveGeneration)throw new BridgeError('NATIVE_SEND_CONNECTION_CHANGED',409);
        payload=(isGroup?encodeGroupElements:encodePrivateElements)({...options,elements:[prefix,encodeTextElement(text)]});
      }
      if(payload.length>4096)throw new BridgeError('NATIVE_TEXT_TOO_LONG',413);
      if(account!==this.account||generation!==this.receiveGeneration)throw new BridgeError('NATIVE_SEND_CONNECTION_CHANGED',409);
      let r;try{r=await this.controller.request('send',{payload,nativeTimeoutMs:8000,timeoutMs:10000,expectedAccount:account});}catch(e){const unsent=['NATIVE_NOT_CONNECTED','HOST_QUEUE_TIMEOUT','HOST_ACCOUNT_CHANGED','HOST_CONNECTION_CHANGED'].includes(e.message);throw new BridgeError(unsent?e.message:'NATIVE_SEND_RESULT_UNKNOWN',503,unsent?undefined:'unknown');}
      if(r.status!==0||!r.received||r.nativeStatus!==0)throw new BridgeError('NATIVE_SEND_UNCONFIRMED',502,'unknown');
      let decoded;try{decoded=(isGroup?decodeGroupSendResponse:decodePrivateSendResponse)(r.payload);}catch{throw new BridgeError('NATIVE_REPLY_INVALID',502,'unknown');}
      if(decoded.state!=='confirmed')throw new BridgeError(decoded.state==='rejected'?'NATIVE_SEND_REJECTED':'NATIVE_SEND_UNCONFIRMED',502,decoded.state==='rejected'?undefined:'unknown');
      if(account!==this.account||generation!==this.receiveGeneration)throw new BridgeError('NATIVE_SEND_CONNECTION_CHANGED',409,'unknown');
      this.confirmed=true;const message_id=this.messageCounter++;this.messages.set(message_id,rememberSent({message_id,self_id:Number(account),real_id:decoded.sequence,sequence:decoded.sequence,native_client_sequence:options.clientSequence,time:decoded.timestamp,message_type:isGroup?'group':'private',...(isGroup?{group_id:recipient,user_id:Number(this.account??0)}:{user_id:recipient}),message:[{type:'text',data:{text}}],raw_message:text,sender:{user_id:Number(this.account??0)}},options));if(this.messages.size>1000)this.messages.delete(this.messages.keys().next().value);
      return ok({message_id,delivery:'server-confirmed'});
    }
    throw new BridgeError('NATIVE_ACTION_NOT_IMPLEMENTED',501);
  }
  async close(){this.closing=true;this.stopReceiving();clearInterval(this.metaTimer);this.flushMedia();await this.controller.close();}
}
