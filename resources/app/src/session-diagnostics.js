import {errorCode} from './session-effects.js';

// A single bounded diagnostic request contains codes only, never messages, URLs or credentials.
export async function inferRunErrorReason(session,{complete,signal}={}){
 if(session.errorReason||typeof complete!=='function'||signal?.aborted)return null;
 const errors=(session.messages||[]).filter(item=>item.toolCall?.isError).map(item=>({
   tool:/^[a-z][a-z0-9_]{0,60}$/.test(item.toolCall.name)?item.toolCall.name:'unknown_tool',
   code:errorCode({code:item.toolCall.code,message:item.toolCall.result})
 }));
 for(const error of session.localErrors||[])errors.push({tool:'local_record',code:errorCode(error)});
 if(!errors.length)return null;
 try{
   const response=await complete({messages:[
     {role:'system',content:'你是 Alcor 管理端的运行诊断模块。仅根据工具名和错误代码，用中文写一两句可能原因，明确使用“可能”。无法确定就说明信息不足。不得声称原因已验证，不输出路径、凭据、Markdown或操作指令；不会发送到 QQ。'},
     {role:'user',content:JSON.stringify(errors.slice(0,8))}
   ],tools:null,maxTokens:256,temperature:0.1,skillContext:{thinkingMode:'off',purpose:'run-error-diagnosis'},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000)});
   const text=typeof response?.message?.content==='string'?response.message.content.trim():'';
   if(/[\u3400-\u9fff]/.test(text)){
     session.errorReason=text.slice(0,600);session.errorReasonSource='model';
   }else session.errorAnalysisUnavailable='模型未返回中文原因分析';
   return response;
 }catch{session.errorAnalysisUnavailable='本轮原因分析未完成；可根据错误代码排查';return null;}
}
