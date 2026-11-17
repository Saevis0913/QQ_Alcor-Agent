export function createDesktopActions(onRestart) {
 let scheduled=false;
 return [{method:'POST',pattern:'/api/desktop/restart',handler:({req,res,json})=>{
  if(req.headers['x-alcor-local-action']!=='restart')return json(res,403,{error:'LOCAL_ACTION_HEADER_REQUIRED'});
  if(typeof onRestart!=='function')return json(res,503,{error:'DESKTOP_RESTART_UNAVAILABLE'});
  if(!scheduled){scheduled=true;setTimeout(()=>onRestart(),300).unref();}
  return json(res,200,{ok:true,restarting:true});
 }}];
}
