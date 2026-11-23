import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {discoverQQ} from '../native-core/discovery.mjs';
import {BridgeError} from './backend.mjs';import {normalizeConfig,readConfigJson} from './config.mjs';
import {NATIVE_ACTIONS} from './native-backend.mjs';
const observed=JSON.parse(fs.readFileSync(new URL('./action-catalog.json',import.meta.url),'utf8')).actions;
const nativeActions=new Set(NATIVE_ACTIONS);
const catalog=[...observed,...NATIVE_ACTIONS.filter(action=>!observed.some(row=>row.action===action)).map(action=>({action,module:'native'}))];
const defaults={theme:'system',accent:'blue',oled:false,compact:false};
const bad=()=>{throw new BridgeError('INVALID_MANAGEMENT_SETTINGS',400);};
function atomic(file,value){
  if(!file)return;
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+'.'+process.pid+'.tmp';
  try {
    fs.writeFileSync(tmp,JSON.stringify(value,null,2));
    fs.renameSync(tmp,file);
  } catch (error) {
    try { fs.rmSync(tmp,{force:true}); } catch { /* Preserve the save error. */ }
    throw error;
  }
}
export function createManagement({config,backend,status,inventory=discoverQQ,stateFile,configFile,nativeResume}){
  let settings={...defaults};try{const disk=readConfigJson(stateFile);settings={...defaults,...validateSettings(disk)};}catch{}
  let serial=0;const logs=[];let lastCpu=os.cpus();let processTask=null;let pendingNodes=null;let pendingTransports=null;
  function configForNextStart(){
    const { host, port } = pendingNodes ?? config.listen;
    return {
      ...config, ...pendingTransports, listen: { ...config.listen, host, port },
      readOnly: pendingNodes?.readOnly ?? config.readOnly
    };
  }
  function log(level,module,message){logs.push({id:++serial,time:new Date().toISOString(),level,module,message});if(logs.length>500)logs.shift();}
  function validateSettings(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!Object.hasOwn(defaults,k)))bad();
    if(input.theme!==undefined&&!['system','light','dark'].includes(input.theme))bad();
    if(input.accent!==undefined&&!['blue','violet','green','orange'].includes(input.accent))bad();
    for(const k of ['oled','compact'])if(input[k]!==undefined&&typeof input[k]!=='boolean')bad();return input;
  }
  function resources(){const cpus=os.cpus();const usage=cpus.map((c,i)=>{const old=lastCpu[i]?.times??c.times;const all=Object.values(c.times).reduce((a,b)=>a+b,0)-Object.values(old).reduce((a,b)=>a+b,0);return all?Math.round((1-(c.times.idle-old.idle)/all)*100):0;});lastCpu=cpus;return {hostname:os.hostname(),platform:os.platform(),release:os.release(),cpu:{name:cpus[0]?.model??'',cores:cpus.length,usage},memory:{total:os.totalmem(),free:os.freemem(),...process.memoryUsage()},process:{pid:process.pid,node:process.version},hostUptime:Math.floor(os.uptime())};}
  log('info','core','Alcor 管理服务已启动');
  async function handle(route,method,body){
    if(route==='overview'&&method==='GET')return {...status(),resources:resources(),recentWarnings:logs.filter(x=>x.level==='warn'||x.level==='error').slice(-5)};
    if(route==='processes'&&method==='GET'){
      if(!processTask)processTask=Promise.resolve().then(inventory).finally(()=>{processTask=null;});
      return {processes:await processTask,connection:backend.controller?backend.snapshot():null,backendType:config.backend.type??'onebot'};
    }
    if(route==='native/connect'&&method==='POST'){
      if(!backend.controller)throw new BridgeError('SELECT_NATIVE_CONFIGURATION_FIRST',409);
      try{const allowUnverified=body.allowUnverified===true;const r=await (nativeResume ? nativeResume.select(body.pid, {allowUnverified}) : backend.connect(body.pid, {allowUnverified}));log('info','native','已连接官方 QQ 进程，群聊与私聊接收已启动');return r;}
      catch(e){
        const code=/^[A-Z_]+$/.test(e.message)?e.message:'NATIVE_CONNECT_FAILED';
        log('warn','native','原生连接失败 · '+code);
        throw new BridgeError(code,409);
      }
    }
    if(route==='native/disconnect'&&method==='POST'){
      if(!backend.controller)throw new BridgeError('NOT_NATIVE_BACKEND',409);
      await (nativeResume ? nativeResume.disconnect() : backend.disconnect());log('info','native','已断开本核心拥有的原生宿主');return {disconnected:true};
    }
    if(route==='settings'){
      if(method==='GET')return settings;
      if(method==='POST'){
        const next={...settings,...validateSettings(body)};
        atomic(stateFile,next);
        settings=next;
        log('info','settings','外观设置已保存');
        return settings;
      }
    }
    if(route==='logs'&&method==='GET')return {entries:logs,capacity:500};
    if(route==='logs/clear'&&method==='POST'){logs.length=0;log('info','logs','运行日志已清空');return {cleared:true};}
    if(route==='actions'&&method==='GET')return {actions:catalog.map(x=>({...x,native:nativeActions.has(x.action)?'implemented':'not-implemented',mode:/^(get_|can_)/.test(x.action)?'read':'write'})),note:'名称目录来自接口清单，不代表全部动作已实现或通过实网验收。'};
    if(route==='transports'){
      const source=pendingTransports??config;
      if(method==='GET')return {httpCallbacks:source.httpCallbacks.map(({secret,...row},id)=>({...row,id,secretConfigured:!!secret})),
        reverseWebSockets:source.reverseWebSockets.map(({token,...row},id)=>({...row,id,tokenConfigured:!!token})),
        editable:!!configFile,restartRequired:!!pendingTransports,runtime:status().outbound};
      if(method==='POST'){
        if(Object.keys(body).some(k=>!['httpCallbacks','reverseWebSockets'].includes(k)))bad();
        if(!configFile)throw new BridgeError('CONFIG_FILE_NOT_WRITABLE_IN_THIS_SESSION',409);
        const fields={};
        for(const key of ['httpCallbacks','reverseWebSockets']){
          if(!Array.isArray(body[key])||body[key].length>8)bad();
          const credential=key==='httpCallbacks'?'secret':'token';const used=new Set();
          fields[key]=body[key].map(input=>{
            if(!input||typeof input!=='object'||Array.isArray(input))bad();
            const {id,...row}=input;
            if(id!==undefined&&(!Number.isInteger(id)||id<0||!source[key][id]||used.has(id)))bad();
            if(id!==undefined){used.add(id);if(row[credential]===undefined)row[credential]=source[key][id][credential];}
            return row;
          });
        }
        let next;try{next=normalizeConfig({...configForNextStart(),...fields});}catch{bad();}
        const saved=readConfigJson(configFile);
        saved.httpCallbacks=next.httpCallbacks;saved.reverseWebSockets=next.reverseWebSockets;
        atomic(configFile,saved);pendingTransports={httpCallbacks:next.httpCallbacks,reverseWebSockets:next.reverseWebSockets};
        log('info','nodes','事件回调与反向连接配置已保存，重启后应用');return {saved:true,restartRequired:true};
      }
    }
    if(route==='nodes'){
      if(method==='GET')return {active:{host:config.listen.host,port:config.listen.port,readOnly:config.readOnly},pending:pendingNodes,editable:!!configFile,transports:[{type:'HTTP',enabled:true},{type:'WebSocket',enabled:true,path:'/events'},{type:'HTTP 回调',enabled:config.httpCallbacks.length>0,implemented:true},{type:'反向 WebSocket',enabled:config.reverseWebSockets.length>0,implemented:true}]};
      if(method==='POST'){
        if(Object.keys(body).some(k=>!['host','port','readOnly'].includes(k)))bad();
        const staged = configForNextStart();
        const { readOnly, ...listenPatch } = body;
        let next;
        try {
          next=normalizeConfig({...staged,listen:{...staged.listen,...listenPatch},readOnly:readOnly??staged.readOnly});
        } catch { bad(); }
        if(next.listen.port===0)bad();
        if(!configFile)throw new BridgeError('CONFIG_FILE_NOT_WRITABLE_IN_THIS_SESSION',409);
        const saved=readConfigJson(configFile);saved.listen={...saved.listen,host:next.listen.host,port:next.listen.port};saved.readOnly=next.readOnly;
        atomic(configFile,saved);pendingNodes={host:next.listen.host,port:next.listen.port,readOnly:next.readOnly};log('info','nodes','节点配置已保存，重启后应用');return {saved:true,restartRequired:true,pending:pendingNodes};
      }
    }
    throw new BridgeError('MANAGEMENT_ROUTE_NOT_FOUND',404);
  }
  return {handle,log};
}
