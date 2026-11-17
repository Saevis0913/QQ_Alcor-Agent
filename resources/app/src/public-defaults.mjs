// Distribution settings are a closed schema. Never infer safe fields from their type alone.
const bool={kind:'boolean'};
const num=(min,max,integer=true)=>({kind:'number',min,max,integer});
const oneOf=(...values)=>({kind:'enum',values});
const time={kind:'time'};
const reply={mode:oneOf('off','mentions','probability','all'),probability:num(0.1,99.9,false)};
const enabled={enabled:bool};
const schema={
 api:{videoMode:oneOf('auto','native','frames','off'),vision:bool,video:bool,temperature:num(0,2,false),maxRounds:num(1,100),timeoutMs:num(1000,600000),thinkingMode:oneOf('off','auto','on'),thinkingEffort:oneOf('','off','low','medium','high','xhigh','max'),thinkingBudget:num(0,128000)},
 webSearch:{enabled:bool,maxResults:num(1,50)},
 privatePolicy:{enabled:bool,dailyLimit:num(0,100000),skipNewFriendGreeting:bool},
 qzone:{enabled:bool,scope:oneOf('both','own','friends'),dailyLimit:num(1,100),readTime:time,timezone:oneOf('Asia/Shanghai')},
 wakeDelayMs:num(0,600000),drainDelayMs:num(0,600000),maxConcurrentRuns:num(1,100),sessionRetryAttempts:num(0,20),
 send:{minGapMs:num(0,600000),maxGapMs:num(0,600000),byLengthMs:num(0,10000),maxPerMinute:num(0,100000),maxPerHour:num(0,100000),hardSplitAt:num(0,100000),dedupeWindowMs:num(0,3600000)},
 proactive:{enabled:bool,checkIntervalMinMs:num(0,604800000),checkIntervalMaxMs:num(0,604800000),idleThresholdMs:num(0,604800000),probability:num(0,1,false)},
 chatActive:{enabled:bool,ttlMinutes:num(1,1440)},
 sticker:{enabled:bool,promptMaxStickers:oneOf(20),collectEnabled:bool,maxCollectPerHour:num(0,1000),sendTier:oneOf(1,2,3,4),policyVersion:oneOf(1)},
 store:{maxMessagesPerChat:num(0,1000000),contextTier:oneOf(1,2,3,4),historyCount:num(0,10000),randomPercent:num(0.1,99.9,false),replyPolicy:reply,promptAnchor:{enabled:bool,maxExtraRead:num(0,1000)},unifiedTier:bool,keepSessionFiles:num(0,1000000),peakSchedule:{enabled:bool,peak:{start:time,end:time,sliderPos:num(0,100,false),replyPolicy:reply},valley:{sliderPos:num(0,100,false),replyPolicy:reply}}},
 commandMute:{enabled:bool,durationMin:num(0,10080)},
 memory:{consolidateEnabled:bool,consolidateMinIntervalMs:num(1800000,604800000),useChatModel:bool},
 persona:{participation:oneOf('low','medium','high')},personaUnified:bool,
 tools:{enabled:bool,crossChatSend:bool,categories:{messaging:bool,sticker:bool,query:bool,memory:bool,web:bool,knowledge:bool,media:bool,system:bool}},
 extensions:{hotReload:bool},
 ui:{theme:oneOf('auto','light','dark'),themeSchedule:{lightStart:time,darkStart:time},showVision:bool,refreshMs:num(1000,3600000)},
 skills:{
  'video-frames':enabled,'speech-to-text':enabled,'qzone-reader':enabled,
  'long-memory':{enabled:bool,archivePrivate:bool,autoRecall:bool,shareGroupFacts:bool,sharePrivateFacts:bool,lookbackDays:num(1,90),recallLimit:num(1,12),dailySourceLimit:num(1,20),rowsPerSource:num(10,200),outputBudget:num(128,1200),maxModelCallsPerDay:num(1,500)},
  'group-style':{enabled:bool,fallbackStart:time,fallbackEnd:time,sampleRows:num(10,200),minSamples:num(3,40),nightlyGroups:num(1,12),outputBudget:num(128,900),publicTrends:bool,maxModelCallsPerDay:num(1,500)},
  'sticker-library':{enabled:bool,batchDelayMs:num(1500,15000),maxModelCallsPerDay:num(1,500)},
  'sticker-review':{enabled:bool,maxModelCallsPerDay:num(1,500)},
  'admin-errors':{enabled:bool,autoReport:bool,intervalSeconds:num(60,3600)},
  'token-saver':enabled,'memory-recall':enabled,'profile-like':enabled,'sticker-tags':enabled,
  gengjing:{enabled:bool,allowContextualSend:bool,cooldownSeconds:num(10,600)},'admin-digest':enabled
 }
};

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
function pick(input,shape){
 if(!plain(input))return {};
 const output={};
 for(const [key,rule] of Object.entries(shape)){
  if(!Object.hasOwn(input,key))continue;
  const value=input[key];
  if(!rule.kind){const nested=pick(value,rule);if(Object.keys(nested).length)output[key]=nested;continue;}
  const valid=rule.kind==='boolean'?typeof value==='boolean':rule.kind==='enum'?rule.values.includes(value):rule.kind==='time'?typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value):typeof value==='number'&&Number.isFinite(value)&&value>=rule.min&&value<=rule.max&&(!rule.integer||Number.isSafeInteger(value));
  if(valid)output[key]=value;
 }
 return output;
}

export function sanitizePublicDefaults(input){
 if(!plain(input))return {};
 const result=pick(input,schema);
 if(plain(input?.sticker)&&!Object.hasOwn(result.sticker??{},'sendTier')&&Number.isInteger(input.sticker.encourage)&&input.sticker.encourage>=0&&input.sticker.encourage<=3){
  result.sticker={...result.sticker,sendTier:input.sticker.encourage+1,policyVersion:1,promptMaxStickers:20};
 }
 return result;
}

export function parsePublicDefaults(text){
 try{const value=JSON.parse(String(text).replace(/^\uFEFF/,''));return plain(value)&&value.schemaVersion===1&&plain(value.settings)?sanitizePublicDefaults(value.settings):{};}
 catch{return {};}
}

function canonical(value){return plain(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;}
export function assertPublicDefaults(value){
 if(!plain(value)||value.schemaVersion!==1||!plain(value.settings)||Object.keys(value).some(key=>!['schemaVersion','settings'].includes(key))||JSON.stringify(canonical(value.settings))!==JSON.stringify(canonical(sanitizePublicDefaults(value.settings))))throw Error('PUBLIC_DEFAULTS_INVALID');
 return value;
}

export function mergePublicDefaults(base,text){
 const merge=(current,patch)=>{const result={...current};for(const [key,value] of Object.entries(patch))result[key]=plain(value)?merge(plain(current?.[key])?current[key]:{},value):value;return result;};
 return merge(structuredClone(base),parsePublicDefaults(text));
}
