import {encodeGroups,decodeGroups,encodeMembers,decodeMembers,encodeFriends,decodeFriends,encodeFiles,decodeFiles,encodeFileDownload,decodeFileDownload} from './directory.mjs';
/** Account-scoped, bounded directory snapshots. Partial pages are never published. */
export class NativeDirectory{
 constructor(backend){this.backend=backend;this.cache=new Map();this.pending=new Map();}
 clear(){this.cache.clear();this.pending.clear();}
 scope(){return {account:this.backend.account,generation:this.backend.receiveGeneration};}
 current(scope){return scope?.account===this.backend.account&&scope?.generation===this.backend.receiveGeneration;}
 async request(operation,payload,decode,scope=this.scope()){
  if(!this.current(scope))throw new Error('DIRECTORY_CONNECTION_CHANGED');
  const r=await this.backend.controller.request(operation,{payload,expectedAccount:scope.account,nativeTimeoutMs:operation==='members'?1500:8000,timeoutMs:operation==='members'?2500:10000});
  if(!this.current(scope))throw new Error('DIRECTORY_CONNECTION_CHANGED');
  if(r.status||!r.received||r.nativeStatus)throw new Error('DIRECTORY_QUERY_UNCONFIRMED');
  const value=decode(r.payload);this.backend.confirmed=true;return value;
 }
 async cached(key,force,fn,ttl=300000){
  const row=this.cache.get(key);if(!force&&row&&this.current(row.scope)&&Date.now()-row.at<ttl)return row.value;
  const pending=this.pending.get(key);if(pending&&this.current(pending.scope))return pending.promise;
  const scope=this.scope();
  const promise=fn(scope).then(value=>{if(!this.current(scope))throw new Error('DIRECTORY_CONNECTION_CHANGED');this.cache.set(key,{at:Date.now(),value,scope});while(this.cache.size>128)this.cache.delete(this.cache.keys().next().value);return value;}).finally(()=>{if(this.pending.get(key)?.promise===promise)this.pending.delete(key);});
  this.pending.set(key,{promise,scope});return promise;
 }
 groups(force=false){return this.cached('groups',force,scope=>this.request('groups',encodeGroups(),decodeGroups,scope));}
 async paged(operation,encode,decode,expectedTotal,scope=this.scope()){
  const result=[],cookies=new Set(),ids=new Set();let cookie;const total=expectedTotal;
  for(let page=0;page<100;page++){
   const r=await this.request(operation,encode(cookie),decode,scope);
   for(const row of r.rows){if(ids.has(row.user_id))throw new Error('DIRECTORY_DUPLICATE_MEMBER');ids.add(row.user_id);result.push(row);}if(result.length>10000)throw new Error('DIRECTORY_LIMIT');
   cookie=r.cookie;if(!cookie?.length){if(total&&result.length!==total)throw new Error('DIRECTORY_INCOMPLETE');return result;}
   const key=Buffer.from(cookie).toString('hex');if(cookies.has(key))throw new Error('DIRECTORY_PAGINATION_STALLED');cookies.add(key);
  }
  throw new Error('DIRECTORY_PAGE_LIMIT');
 }
 friends(force=false){return this.cached('friends',force,scope=>this.paged('friends',encodeFriends,r=>decodeFriends(r,scope.account),undefined,scope));}
 members(group,force=false){return this.cached('members:'+group,force,async scope=>{
  let catalog=await this.groups(force),found=catalog.find(r=>r.group_id===group);
  if(!this.current(scope))throw new Error('DIRECTORY_CONNECTION_CHANGED');
  if(!found&&!force){catalog=await this.groups(true);found=catalog.find(r=>r.group_id===group);}
  if(!found)throw new Error('GROUP_NOT_FOUND');
  return this.paged('members',c=>encodeMembers(group,c),r=>decodeMembers(r,group),found.member_count,scope);
 });}
 async files(group,folder='/'){
  const files=[],folders=[],seen=new Set(),scope=this.scope();let index=0,context;
  for(let page=0;page<40;page++){
   const r=await this.request('groupFiles',encodeFiles(group,folder,index,context),x=>decodeFiles(x,group),scope);files.push(...r.files);folders.push(...r.folders);
   if(r.isEnd)return {files,folders};const next=r.nextIndex||index+r.files.length+r.folders.length;
   if(next<=index||seen.has(next))throw new Error('DIRECTORY_PAGINATION_STALLED');seen.add(next);index=next;context=r.context;
  }
  throw new Error('DIRECTORY_PAGE_LIMIT');
 }
 fileUrl(group,id,busid){return this.request('groupFileDownload',encodeFileDownload(group,id,busid),decodeFileDownload);}
 async enrich(event){
  if(!event.group_id)return event;
  const scope=this.scope();
  let members;try{
   const fail=this.cache.get('failed:'+event.group_id);if(fail&&this.current(fail.scope)&&Date.now()-fail.at<30000)throw new Error('SCAN_COOLDOWN');
   members=await this.members(event.group_id);
  }catch{if(this.current(scope))this.cache.set('failed:'+event.group_id,{at:Date.now(),scope});event.member_scan_error='GROUP_MEMBER_SCAN_FAILED';return event;}
  const byId=new Map(members.map(x=>[x.user_id,x])),byUid=new Map(members.filter(x=>x.uid).map(x=>[x.uid,x]));
  const sender=byId.get(event.user_id);if(sender)event.sender={...event.sender,...sender};
  for(const seg of event.message){
   if(seg.type==='at'&&seg.data.unresolved){const row=byUid.get(seg.data.uid);if(row){seg.data.qq=String(row.user_id);seg.data.unresolved=false;}}
   if(seg.type==='reply'&&!seg.data.sender_id){const row=byUid.get(seg.data.sender_uid);if(row)seg.data.sender_id=row.user_id;}
  }
  return event;
 }
}
