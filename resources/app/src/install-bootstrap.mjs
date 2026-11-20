import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {randomBytes} from 'node:crypto';
import {inspectInstallConfig,isStandardEdition} from './environment-check.mjs';
import {mergePublicDefaults} from './public-defaults.mjs';

async function exists(file){try{await fs.access(file);return true;}catch{return false;}}
export async function availablePort(start){
  for(let port=start;port<start+80;port++){
    const free=await new Promise(resolve=>{const server=net.createServer();server.once('error',()=>resolve(false));server.listen(port,'127.0.0.1',()=>server.close(()=>resolve(true)));});
    if(free)return port;
  }
  throw new Error('PORT_RANGE_BUSY: 本地端口被占用，请运行“环境检测”');
}

/** Only initialize a fresh profile. Existing config, tokens and history are never overwritten. */
export async function initializeInstall({installRoot,dataDir=path.join(installRoot,'data'),selectPort=availablePort}={}){
  const configFile=path.join(dataDir,'config.json');
  const standard=isStandardEdition(installRoot);
  const profile=inspectInstallConfig({installRoot,dataDir});
  if(profile.issues.length)throw new Error(profile.issues.map(c=>`[${c.code}] ${c.title}: ${c.detail}\n${c.fix}`).join('\n\n'));
  if(await exists(configFile))return {created:false};
  await fs.mkdir(dataDir,{recursive:true});
  const coreFile=path.join(dataDir,'alcor.config.json');
  if(!standard&&!await exists(coreFile)){
    const core={listen:{host:'127.0.0.1',port:await selectPort(5310),token:randomBytes(32).toString('hex')},backend:{type:'native'},compatibility:'passthrough',readOnly:false};
    await fs.writeFile(coreFile,JSON.stringify(core,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  }
  const corePort=standard?null:(JSON.parse(await fs.readFile(coreFile,'utf8')).listen?.port??5310);
  let agentPort=await selectPort(5320);
  if(agentPort===corePort)agentPort=await selectPort(corePort+1);
  if(agentPort===corePort)throw new Error('PORT_COLLISION: Agent 和 Alcor 核心需要不同端口。');
  const baseConfig={server:{port:agentPort,startPaused:true,autoStart:false},alcor:{dir:'',configFile:'',autoLaunch:true},
    api:{baseUrl:'',model:'',apiKey:''},allow:{groups:[],private:[]},allowAllWhenEmpty:false,
    persona:{botName:'Alcor',roleText:''},customPersonas:[],personaByChat:{},
    store:{replyPolicy:{mode:'all',probability:10},unifiedTier:true},extensions:{hotReload:false},
    ui:{theme:'auto',installGuideSeen:false,alcorAccessGuideSeen:true,injectionCheckSeen:false}};
  let template='';
  try{template=await fs.readFile(path.join(installRoot,'resources/app/public-defaults.json'),'utf8');}catch{}
  const config=mergePublicDefaults(baseConfig,template);
  config.server={...config.server,port:agentPort,startPaused:true,autoStart:false,token:''};
  config.alcor={dir:'',configFile:'',autoLaunch:!standard,accessToken:'',httpAccessToken:'',
    ...(standard&&{httpUrl:'',wsUrl:''})};
  config.api={...config.api,baseUrl:'',model:'',apiKey:'',provider:'',fallbackModels:[],visionModel:'',videoModel:'',modelPrices:{}};
  config.providers=[];config.dshProviderKeys={};config.providersSourceYaml='';
  config.allow={groups:[],private:[]};config.deny={groups:[],private:[]};config.allowAllWhenEmpty=false;
  config.privatePolicy={...config.privatePolicy,adminQQs:[],specialFriendQQs:[]};
  config.blocklist={};config.globalBlocklist=[];config.communityExemptions=[];
  config.ui={...config.ui,installGuideSeen:false,alcorAccessGuideSeen:false,injectionCheckSeen:false};
  await fs.writeFile(configFile,JSON.stringify(config,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  return {created:true};
}
