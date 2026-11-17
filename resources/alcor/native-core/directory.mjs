import {fields,child,one,number as n,string as str,scalar as s,bytes as b,join as j,uin,list} from './wire.mjs';
export const envelope=(command,sub,body,reserved=1)=>j(s(1,command),s(2,sub),b(4,body),s(12,reserved));
function response(input,command,sub){
 if(!(input instanceof Uint8Array)||!input.length||input.length>65536)throw new Error('DIRECTORY_REPLY_SIZE');
 const m=fields(input);if(n(m,1)!==command||n(m,2)!==sub||n(m,3)!==0||!m.has(4))throw new Error('DIRECTORY_REPLY_REJECTED');return child(m,4);
}
const flags=keys=>j(...keys.map(x=>s(x,1)));
const cookieBytes=(field,cookie)=>cookie?.length?b(field,cookie):Buffer.alloc(0);
export function encodeGroups(){return envelope(0xfe5,2,b(1,b(1,flags([1,3,4,5]))));}
export function decodeGroups(input){return list(response(input,0xfe5,2),2).map(x=>{const r=fields(x.v),i=child(r,4);return {group_id:uin(n(r,3)),group_name:str(i,5),member_count:n(i,4),max_member_count:n(i,3),owner_uid:str(child(i,1),2)};});}
export function encodeMembers(group,cookie){uin(group);if(cookie?.length>1024)throw new Error('DIRECTORY_COOKIE_SIZE');return envelope(0xfe7,3,j(s(1,group),s(2,5),s(3,2),b(4,flags([10,11,12,17,100,101,102,107])),cookieBytes(15,cookie)));}
export function decodeMembers(input,group){
 const m=response(input,0xfe7,3);if(n(m,1)!==group)throw new Error('DIRECTORY_GROUP_MISMATCH');
 const rows=list(m,2).map(x=>{const r=fields(x.v),id=child(r,1),p=n(r,107);return {group_id:group,user_id:uin(n(id,4)),uid:str(id,2),nickname:str(r,10),card:str(child(r,11),2),role:!r.has(107)?'member':({0:'member',1:'owner',2:'admin'}[p]||'unknown'),title:str(r,17),join_time:n(r,100),last_sent_time:n(r,101),level:String(n(child(r,12),2)),shut_up_timestamp:n(r,102)};});
 // Field 3 is 5 for a verified three-member QQ 9.9.36 roster: do not treat it as a count.
 return {rows,cookie:one(m,15,2)};
}
// Friend UID replies require outer OIDB field 12=0; body Flag stays 1.
export function encodeFriends(cookie){if(cookie?.length>1024)throw new Error('DIRECTORY_COOKIE_SIZE');return envelope(0xfd4,1,j(s(2,100),s(4,13),cookieBytes(5,cookie),s(6,1),s(7,2147483647),b(10001,j(s(1,1),b(2,j(s(1,103),s(1,20002)))))),0);}
export function decodeFriends(input,account){
 const m=response(input,0xfd4,1);if(n(m,7)&&n(m,7)!==Number(account))throw new Error('DIRECTORY_ACCOUNT_MISMATCH');
 const rows=list(m,101).map(x=>{const r=fields(x.v),data=new Map();for(const entry of list(r,10001,64)){const e=fields(entry.v);if(n(e,1)!==1)continue;for(const value of list(child(e,2),2,128)){const kv=fields(value.v);data.set(n(kv,1),str(kv,2));}}
 return {user_id:uin(n(r,3)),uid:r.get(1)?.[0]?.w===2?str(r,1):'',nickname:data.get(20002)||String(n(r,3)),remark:data.get(103)||''};});
 return {rows,cookie:n(m,3)?null:one(m,2,2)};
}
function fileId(id){if(typeof id!=='string'||!id||id.length>512||/[\x00-\x1f]/.test(id))throw new Error('GROUP_FILE_ID_INVALID');return id;}
export function encodeFiles(group,folder='/',index=0,context){uin(group);fileId(folder);if(!Number.isSafeInteger(index)||index<0||index>10000||context?.length>1024)throw new Error('GROUP_FILE_PAGE_INVALID');return envelope(0x6d8,1,b(2,j(s(1,group),s(2,7),b(3,folder),s(5,50),s(9,1),s(12,0xffffff),s(13,index),cookieBytes(14,context),s(17,2))));}
export function decodeFiles(input,group){
 const m=child(response(input,0x6d8,1),2);if(n(m,1)!==0)throw new Error('GROUP_FILES_REJECTED');const files=[],folders=[];
 for(const row of list(m,5)){const r=fields(row.v);if(n(r,1)===1){const f=child(r,3);files.push({group_id:group,file_id:fileId(str(f,1)),file_name:str(f,2),file_size:n(f,3),busid:n(f,4),upload_time:n(f,6),uploader:n(f,15),uploader_name:str(f,14),parent_id:str(f,16)});}else if(n(r,1)===2){const f=child(r,2);folders.push({group_id:group,folder_id:fileId(str(f,1)),folder_name:str(f,3),creator:n(f,6),total_file_count:n(f,8)});}}
 return {files,folders,isEnd:!!n(m,4),nextIndex:n(m,13),context:one(m,14,2)};
}
export function encodeFileDownload(group,id,busid=102){uin(group);fileId(id);if(!Number.isInteger(busid)||busid<0||busid>0xffff)throw new Error('GROUP_FILE_BUS_INVALID');return envelope(0x6d6,2,b(3,j(s(1,group),s(2,7),s(3,busid),b(4,id))));}
export function decodeFileDownload(input){
 const m=child(response(input,0x6d6,2),3);if(n(m,1)!==0)throw new Error('GROUP_FILE_DOWNLOAD_REJECTED');
 const host=str(m,5,255)||str(m,4,255),key=one(m,6,2);if(!/^[a-z0-9.-]+$/i.test(host)||!key?.length||key.length>1024)throw new Error('GROUP_FILE_DOWNLOAD_INVALID');
 // The file ticket is opaque bytes; never expose it in logs or persist it.
 const domain=/(^|\.)(qq\.com|qq\.com\.cn|qpic\.cn|gtimg\.cn)$/.test(host);
 const octets=host.split('.').map(Number),ipv4=/^\d+\.\d+\.\d+\.\d+$/.test(host)&&octets.every(x=>x>=0&&x<=255);
 const [a,c]=octets,publicIp=ipv4&&a>0&&a<224&&![10,127].includes(a)&&!(a===100&&c>=64&&c<=127)&&!(a===169&&c===254)&&!(a===172&&c>=16&&c<=31)&&!(a===192&&(c===168||c===0))&&!(a===198&&(c===18||c===19));
 if(!domain&&!publicIp)throw new Error('GROUP_FILE_CDN_UNSUPPORTED');
 return {url:(domain?'https://':'http://')+host+'/ftn_handler/'+Buffer.from(key).toString('hex')+'/?fname=',ttl:300};
}
