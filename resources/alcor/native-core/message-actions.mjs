import { gunzipSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { decodeMediaElement, MEDIA_DESCRIPTOR } from './media.mjs';
import { BridgeError } from '../src/backend.mjs';
import { withinJsonDepth } from '../src/json.mjs';
import { fields, child, one, number, string, scalar, bytes, join, list } from './wire.mjs';

export const FORWARD_DESCRIPTOR = Symbol('Alcor received forward reference');
const RESOURCE_ID = /^[\w+/=-]{1,512}$/;
const QQ_UID = /^u_[\w-]{4,80}$/;
const MAX_EXPANDED = 1024 * 1024;
const MAX_NODES = 100;
const MAX_DEPTH = 3;

function qq(value) {
  const raw = String(value ?? '');
  return /^[1-9]\d{0,9}$/.test(raw) && Number(raw) <= 0xffffffff ? Number(raw) : 0;
}

function receivedAccount(backend) {
  const account = qq(backend.account);
  if (!account || !backend.controller.snapshot().connected) throw new BridgeError('NATIVE_NOT_CONNECTED', 503);
  return account;
}

function sameConnection(backend, account, generation) {
  return qq(backend.account) === account && backend.receiveGeneration === generation && backend.controller.snapshot().connected;
}

export async function sendPoke(backend, action, params) {
  if (!['send_poke', 'friend_poke', 'group_poke'].includes(action)) throw new BridgeError('POKE_ARGUMENT_INVALID', 400);
  const account = receivedAccount(backend);
  const generation = backend.receiveGeneration;
  const groupId = qq(params.group_id);
  const target = qq(params.user_id ?? params.target_id);
  if (!target || target === account || (params.target_id != null && qq(params.target_id) !== target) ||
    (params.group_id != null && !groupId) || (action === 'friend_poke' && groupId) || (action === 'group_poke' && !groupId)) {
    throw new BridgeError('POKE_TARGET_INVALID', 400);
  }
  let contacts;
  try {
    contacts = groupId ? await backend.directory.members(groupId, true) : await backend.directory.friends(true);
  } catch (error) {
    if (error.message === 'GROUP_NOT_FOUND') throw new BridgeError('POKE_TARGET_NOT_FOUND', 404);
    throw new BridgeError('POKE_DIRECTORY_UNAVAILABLE', 502);
  }
  if (!sameConnection(backend, account, generation)) throw new BridgeError('POKE_CONNECTION_CHANGED', 409);
  if (!contacts.some(row => row.user_id === target)) throw new BridgeError('POKE_TARGET_NOT_FOUND', 404);

  const body = join(scalar(1, target), scalar(groupId ? 2 : 5, groupId || target));
  const payload = join(scalar(1, 0xed3), scalar(2, 1), bytes(4, body));
  let reply;
  try {
    reply = await backend.controller.request('poke', { payload, nativeTimeoutMs: 5000, timeoutMs: 7000, expectedAccount: String(account) });
  } catch (error) {
    if (error.message === 'HOST_ACCOUNT_CHANGED') throw new BridgeError('POKE_CONNECTION_CHANGED', 409);
    if (error.message === 'NATIVE_NOT_CONNECTED') throw new BridgeError('NATIVE_NOT_CONNECTED', 503);
    throw new BridgeError('POKE_RESULT_UNKNOWN', 502, 'unknown');
  }
  if (!sameConnection(backend, account, generation)) throw new BridgeError('POKE_CONNECTION_CHANGED', 409, 'unknown');
  if (reply.status || !reply.received) throw new BridgeError('POKE_RESULT_UNKNOWN', 502, 'unknown');
  if (reply.nativeStatus) throw new BridgeError('POKE_REJECTED', 502);
  let status;
  try {
    const response = fields(reply.payload);
    if (number(response, 1) !== 0xed3 || number(response, 2) !== 1) throw new Error('POKE_REPLY_INVALID');
    status = number(response, 3);
  } catch {
    throw new BridgeError('POKE_RESULT_UNKNOWN', 502, 'unknown');
  }
  if (status) throw new BridgeError('POKE_REJECTED', 502);
  return { delivery: 'server-confirmed' };
}

function cardText(raw, budget) {
  if (!raw?.length || ![0, 1].includes(raw[0])) return null;
  const limit = Math.min(budget.remaining, 32_768, budget.shared?2*MAX_EXPANDED-budget.shared.expanded:Infinity);
  if (limit <= 0) throw new Error('FORWARD_PAYLOAD_LIMIT');
  if (raw.length > 32_768) return null;
  let data;
  try{data = raw[0] === 1 ? inflateSync(raw.subarray(1), { maxOutputLength: limit }) : raw.subarray(1);}
  catch(error){if(error.code==='ERR_BUFFER_TOO_LARGE')throw new Error('FORWARD_PAYLOAD_LIMIT');throw error;}
  if(data.length>limit)throw new Error('FORWARD_PAYLOAD_LIMIT');
  budget.remaining -= data.length;
  if (budget.remaining < 0) throw new Error('FORWARD_PAYLOAD_LIMIT');
  if(budget.shared){budget.shared.expanded+=data.length;if(budget.shared.expanded>2*MAX_EXPANDED)throw new Error('FORWARD_PAYLOAD_LIMIT');}
  return new TextDecoder('utf-8', { fatal: true }).decode(data);
}

function forwardReference(resId, ...itemNames) {
  if (typeof resId !== 'string' || !RESOURCE_ID.test(resId)) return null;
  return { resId, item: itemNames.find(value => typeof value === 'string' && /^[\w.-]{1,160}$/.test(value)) };
}

function readLegacyForward(element, budget) {
  const rich = child(element, 12);
  if (number(rich, 2) !== 35) return null;
  const xml = cardText(one(rich, 1, 2), budget)?.trim();
  if (!xml || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) return null;
  // Read only the outer message attributes. Never interpret child markup or resolve entities.
  const document = xml.replace(/^<\?xml\s[^?]*\?>\s*/, '');
  const root = /^<msg(?=[\s/>])/.exec(document);
  if (!root) return null;
  const attribute = /\s+([\w:.-]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
  const values = new Map();
  let end = root[0].length;
  for (;;) {
    attribute.lastIndex = end;
    const match = attribute.exec(document);
    if (!match) break;
    if (values.size >= 32 || values.has(match[1])) return null;
    values.set(match[1], match[2] ?? match[3]);
    end = attribute.lastIndex;
  }
  const rest = document.slice(end).trimStart();
  if (rest !== '/>' && !(rest.startsWith('>') && /<\/msg\s*>$/.test(rest))) return null;
  if (values.get('action') !== 'viewMultiMsg') return null;
  return forwardReference(values.get('m_resid'), values.get('m_fileName'));
}

function readCard(element, budget) {
  if (element.has(12)) return readLegacyForward(element, budget);
  const text = cardText(one(child(element, 51), 1, 2), budget);
  if (!text) return null;
  const parsed = JSON.parse(text);
  if (!withinJsonDepth(parsed, 12) || parsed?.app !== 'com.tencent.multimsg') return null;
  const { resid, uniseq, filename } = parsed.meta?.detail || {};
  return forwardReference(resid, uniseq, filename);
}

export function decodeForwardElement(element, selfUid) {
  let card;
  try { card = readCard(element instanceof Uint8Array ? fields(element) : element, { remaining: 32_768 }); } catch { return null; }
  if (!card) return null;
  const segment = { type: 'forward', data: {} };
  Object.defineProperty(segment, FORWARD_DESCRIPTOR, { value: Object.freeze({ ...card, selfUid: QQ_UID.test(selfUid || '') ? selfUid : '' }) });
  return segment;
}

// Keep forwarded text as data. Resource URL fields and embedded cards are never returned.
function publicText(text) {
  return text.replace(/(?:https?:\/\/|\/\/)[^\s<>"'，。；]+/gi, '[链接]')
    .replace(/(?:^|\n)\s*(?:set-cookie|cookie|authorization)\s*[:：][^\r\n]*/gi, '\n[凭据已省略]')
    .replace(/\b(?:p_skey|skey|pt4_token|access_token)\s*=\s*[^\s;]+/gi, '[凭据已省略]');
}

const textSegment = text => ({ type: 'text', data: { text } });

export function decodeForwardReply(payload, resId, scope = {}) {
  if (!(payload instanceof Uint8Array) || payload.length > 65_536) throw new Error('FORWARD_REPLY_INVALID');
  const result = child(fields(payload), 1);
  const responseId = string(result, 3, 512);
  const compressed = one(result, 4, 2);
  if ((responseId && responseId !== resId) || !compressed?.length) throw new Error('FORWARD_REPLY_INVALID');
  let data;
  const remaining = scope.budget ? 2*MAX_EXPANDED-scope.budget.expanded : MAX_EXPANDED;
  if(remaining<=0)throw new Error('FORWARD_PAYLOAD_LIMIT');
  try { data = gunzipSync(compressed, { maxOutputLength: Math.min(MAX_EXPANDED,remaining) }); }
  catch (error) { throw new Error(error.code === 'ERR_BUFFER_TOO_LARGE' ? 'FORWARD_PAYLOAD_LIMIT' : 'FORWARD_PAYLOAD_INVALID'); }
  if(scope.budget){scope.budget.expanded+=data.length;if(scope.budget.expanded>2*MAX_EXPANDED)throw new Error('FORWARD_PAYLOAD_LIMIT');}
  const transmit = fields(data);
  const items = new Map();
  for (const { v } of list(transmit, 2, MAX_NODES)) {
    const entry = fields(v), name = string(entry, 1, 160);
    if (!name || items.has(name)) throw new Error('FORWARD_ITEM_INVALID');
    items.set(name, child(entry, 2));
  }

  const budget = { remaining: MAX_EXPANDED - data.length, shared:scope.budget };
  let nodes = 0, mediaCount = 0;
  function parseNodes(record, depth, visited, path = '') {
    const entries = record.get(1) || [];
    if (entries.length + nodes > MAX_NODES) throw new Error('FORWARD_NODE_LIMIT');
    nodes += entries.length;
    return list(record, 1, MAX_NODES).map(({ v }, nodeIndex) => {
      const nodePath = path ? `${path}.${nodeIndex + 1}` : String(nodeIndex + 1);
      const node = fields(v), head = child(node, 1), content = child(node, 2), rich = child(child(node, 3), 1);
      const userId = qq(number(head, 1));
      const nickname = publicText((string(child(head, 8), 4, 512) || string(child(head, 7), 6, 512)).slice(0, 120));
      const message = [];
      for (const { v: element } of list(rich, 2, 64)) {
        const elem = fields(element);
        if (elem.has(1)) {
          const text = publicText(string(child(elem, 1), 1, 16_384)).slice(0, 2048);
          if (text) message.push(textSegment(text));
        } else if (elem.has(51) || elem.has(12)) {
          let card;
          try { card = readCard(elem, budget); } catch(error) { if(error.message==='FORWARD_PAYLOAD_LIMIT')throw error; /* Omit malformed embedded cards. */ }
          const nested = card && [card.item, card.resId].find(key => items.has(key));
          if (nested && depth < MAX_DEPTH && !visited.has(nested)) {
            message.push({ type: 'node', data: { content: parseNodes(items.get(nested), depth + 1, new Set([...visited, nested]), nodePath) } });
          } else {
            const segment=textSegment(card ? '[嵌套转发]' : '[卡片消息]');
            // Only a reference decoded from a received card can trigger another bounded read.
            if(card&&!nested&&depth<MAX_DEPTH)Object.defineProperty(segment,FORWARD_DESCRIPTOR,{value:card});
            message.push(segment);
          }
        } else if (elem.has(2)) message.push({type:'face',data:{id:String(number(child(elem,2),1))}});
        else {
          let media;
          try { media = decodeMediaElement(element, scope.selfUid || '', scope.group_id || 0, scope.user_id || 0); }
          catch { media = {type:elem.has(19)?'video':'image',data:{error:'MEDIA_DESCRIPTOR_UNAVAILABLE'}}; }
          if (media) {
            if (++mediaCount > 100) throw new Error('FORWARD_MEDIA_LIMIT');
            const descriptor = media[MEDIA_DESCRIPTOR];
            if (descriptor && scope.message_id && scope.self_id) {
              const forward_scope = {message_id:Number(scope.message_id),self_id:Number(scope.self_id),...(scope.group_id?{group_id:Number(scope.group_id)}:{user_id:Number(scope.user_id)})};
              const file = 'alcor-media-' + createHash('sha256').update(JSON.stringify(forward_scope)).update(nodePath).update(String(message.length)).update(media.data.file).digest('hex');
              const data = {...media.data,file,forward_scope};
              for(const key of ['name','summary'])if(typeof data[key]==='string')data[key]=publicText(data[key]);
              media = {type:media.type,data};
              Object.defineProperty(media,MEDIA_DESCRIPTOR,{value:{...descriptor,data,forwardScope:forward_scope}});
            }
            message.push(media);
          }
        }
      }
      if (rich.has(4)) message.push(textSegment('[语音]'));
      return { time: number(content, 6), sender: { user_id: userId, nickname: nickname || String(userId || '未知') }, message };
    });
  }
  const messages = parseNodes(items.get('MultiMsg') || transmit, scope.depth||1, new Set(['MultiMsg']), scope.nodePrefix||'');
  if (!messages.length) throw new Error('FORWARD_MESSAGES_EMPTY');
  return messages;
}

export async function readForward(backend, params) {
  const account = receivedAccount(backend);
  const generation = backend.receiveGeneration;
  if (Object.keys(params).some(key => !['message_id', 'group_id', 'user_id'].includes(key))) throw new BridgeError('FORWARD_ARGUMENT_INVALID', 400);
  const { message_id, group_id, user_id } = params;
  const groupId = qq(group_id), peerId = qq(user_id);
  if ((groupId > 0) === (peerId > 0) || (group_id != null && !groupId) || (user_id != null && !peerId)) throw new BridgeError('FORWARD_SCOPE_REQUIRED', 400);
  const event = /^[1-9]\d{0,15}$/.test(String(message_id)) ? backend.messages.get(Number(message_id)) : null;
  if (event?.post_type !== 'message' || qq(event.self_id) !== account || event.message_type !== (groupId ? 'group' : 'private') ||
    (groupId ? event.group_id !== groupId : event.user_id !== peerId)) throw new BridgeError('FORWARD_NOT_IN_CONVERSATION_CACHE', 404);
  const descriptors = event.message.map(segment => segment[FORWARD_DESCRIPTOR]).filter(Boolean);
  if (descriptors.length !== 1) throw new BridgeError('FORWARD_NOT_IN_CONVERSATION_CACHE', 404);
  const { resId } = descriptors[0];
  let { selfUid } = descriptors[0];
  if (!selfUid && groupId) {
    try { selfUid = (await backend.directory.members(groupId)).find(row => row.user_id === account)?.uid; } catch { /* Missing account UID is reported below. */ }
  }
  if (!QQ_UID.test(selfUid || '')) throw new BridgeError('FORWARD_ACCOUNT_UID_UNAVAILABLE', 502);
  if (!sameConnection(backend, account, generation)) throw new BridgeError('FORWARD_CONNECTION_CHANGED', 409);
  const total={requests:0,nodes:0,expanded:0};
  async function requestNodes(resource,depth=1,nodePrefix=''){
    if(++total.requests>8)throw new Error('FORWARD_REQUEST_LIMIT');
    if(!sameConnection(backend,account,generation))throw new BridgeError('FORWARD_CONNECTION_CHANGED',409);
    const payload=join(bytes(1,join(bytes(1,bytes(2,selfUid)),bytes(2,resource),scalar(3,groupId?1:3))),bytes(15,join(scalar(1,2),scalar(2,1),scalar(3,3))));
    let reply;
    try{reply=await backend.controller.request('forward',{payload,nativeTimeoutMs:6000,timeoutMs:8000,expectedAccount:String(account)});}
    catch(error){throw new BridgeError(error.message==='HOST_ACCOUNT_CHANGED'?'FORWARD_CONNECTION_CHANGED':error.message==='NATIVE_NOT_CONNECTED'?'NATIVE_NOT_CONNECTED':'FORWARD_REQUEST_FAILED',502);}
    if(!sameConnection(backend,account,generation))throw new BridgeError('FORWARD_CONNECTION_CHANGED',409);
    if(reply.status||!reply.received||reply.nativeStatus)throw new BridgeError('FORWARD_REQUEST_FAILED',502);
    return decodeForwardReply(reply.payload,resource,{selfUid,self_id:account,message_id,group_id:groupId,user_id:peerId,depth,nodePrefix,budget:total});
  }
  async function hydrate(rows,depth,trail,path=''){
    for(let i=0;i<rows.length;i++){
      if(++total.nodes>MAX_NODES)throw new Error('FORWARD_NODE_LIMIT');
      const nodePath=path?`${path}.${i+1}`:String(i+1),segments=rows[i].message;
      for(let j=0;j<segments.length;j++){
        const segment=segments[j],card=segment[FORWARD_DESCRIPTOR];
        if(segment.type==='node'){await hydrate(segment.data.content,depth+1,trail,nodePath);continue;}
        if(!card)continue;
        if(depth>=MAX_DEPTH||trail.has(card.resId)||total.requests>=8){segments[j]=textSegment('[嵌套转发：达到读取上限或重复引用]');continue;}
        try{
          const children=await requestNodes(card.resId,depth+1,`${nodePath}.${j+1}`);
          await hydrate(children,depth+1,new Set([...trail,card.resId]),`${nodePath}.${j+1}`);
          segments[j]={type:'node',data:{content:children}};
        }catch(error){
          if(/CONNECTION_CHANGED|NATIVE_NOT_CONNECTED|_LIMIT$/.test(error.message))throw error;
          segments[j]=textSegment('[嵌套转发读取失败：FORWARD_REQUEST_FAILED]');
        }
      }
    }
  }
  try {
    const messages = await requestNodes(resId);
    await hydrate(messages,1,new Set([resId]));
    const collect = rows => rows.flatMap(row => row.message.flatMap(segment => segment.type === 'node' ? collect(segment.data.content) : [segment]));
    backend.rememberMedia?.({message:collect(messages)});
    return { messages };
  }
  catch (error) { throw new BridgeError(/^FORWARD_[A-Z_]+$/.test(error.message) ? error.message : 'FORWARD_PAYLOAD_INVALID', 502); }
}
