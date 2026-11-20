import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findQQBuildProfile, matchQQFamily } from './qq-profiles.mjs';
const run=promisify(execFile);
/* 其他 QQ 框架（LiteLoader 插件宿主、旧 snowluma、napcat 之类）注入的模块会一直驻留到 QQ 重启，
   而它们占用的正是原生接入要读的服务对象，所以扫描阶段就要把它们和 Alcor 自己的宿主分出来。 */
const foreignPattern=/^(?:lite-?loader|snowluma|napcat|onebot|qqbot|qq-?agent|qqntbot|ntqqbot|koishi|mirai|atreus|electrolite|qsign)/i;
const hostModule='alcor-host.dll';
const moduleNamePattern=/^[A-Za-z0-9._+-]{1,96}$/;
export function isForeignQQModule(name){
  return typeof name==='string'&&moduleNamePattern.test(name)&&!name.toLowerCase().includes(hostModule)&&foreignPattern.test(name);
}
const script=String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$rows=@(Get-Process QQ -ErrorAction SilentlyContinue | ForEach-Object {
  $p=$_; $module=$null
  try {
    $module=$p.Modules | Where-Object {$_.ModuleName -eq 'wrapper.node'} | Select-Object -First 1
    if($module) {
      $sha=[Security.Cryptography.SHA256]::Create(); $stream=[IO.File]::OpenRead($module.FileName)
      try {$digest=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','')} finally {$stream.Dispose();$sha.Dispose()}
      $started=$p.StartTime.ToUniversalTime()
      $names=New-Object System.Collections.ArrayList
      try { foreach($m in @($p.Modules)) { $name=[IO.Path]::GetFileName([string]$m.FileName); if($name -and -not $names.Contains($name)){[void]$names.Add($name)} } } catch {}
      [pscustomobject]@{pid=$p.Id;path=$p.Path;moduleName=$module.ModuleName;sha256=$digest;version=$module.FileVersionInfo.FileVersion;startedAt=$started.ToString('o');creationTime=$started.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture);modules=@($names | Select-Object -First 512)}
    }
  } catch { [pscustomobject]@{pid=$p.Id;reason='PROCESS_INSPECTION_UNAVAILABLE'} }
})
ConvertTo-Json -InputObject $rows -Depth 3 -Compress
`;
const bounded=(list,limit)=>Array.isArray(list)?list.filter(name=>typeof name==='string'&&moduleNamePattern.test(name)).slice(0,limit):[];
export function classifyQQProcess(row){
  const isQQ=typeof row.path==='string'&&/(?:^|[\\/])QQ\.exe$/i.test(row.path);
  const profile=isQQ?findQQBuildProfile(row.moduleName,row.sha256):null;
  const family=!profile&&isQQ?matchQQFamily(row.moduleName,row.version):null;
  const modules=bounded(row.modules,512);
  const alcorHostLoaded=modules.length?modules.some(name=>name.toLowerCase().includes(hostModule)):row.alcorHostLoaded===true;
  const foreignModules=modules.length?modules.filter(isForeignQQModule).slice(0,8):bounded(row.foreignModules,8);
  const {modules:_inventory,...rest}=row;
  return {...rest,foreignModules,alcorHostLoaded,supported:!!profile,version:profile?.version||row.version,
    verification:profile?.verification||family?.verification||null,architecture:profile?.architecture||family?.architecture||null,
    family:family?.version||null,
    reason:profile?(alcorHostLoaded?'ALCOR_HOST_PRESENT':foreignModules.length?'FOREIGN_MODULES_PRESENT':'IDENTITY_REQUIRES_CONNECTION'):(family?'FAMILY_UNVERIFIED':row.reason||'UNSUPPORTED_BUILD')};
}
/** Inventory only: module identity is not proof of account login or server reachability. */
export async function discoverQQ(){
  if(process.platform!=='win32') return [];
  const encoded=Buffer.from(script,'utf16le').toString('base64');
  const read=async()=>{
    const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{windowsHide:true,timeout:25000,maxBuffer:262144});
    return stdout;
  };
  // 慢机器上首次拉起 PowerShell（杀软扫描、磁盘冷启动）容易超时；重试一次比直接报
  // PROCESS_INSPECTION_UNAVAILABLE 更接近真实情况，且仍然是有界等待。
  let stdout;
  try{ stdout=await read(); }
  catch(error){ if(error?.killed!==true)throw error; await new Promise(r=>setTimeout(r,800)); stdout=await read(); }
  const rows=JSON.parse(stdout.replace(/^\uFEFF/,''));
  if(!Array.isArray(rows)||rows.length>128)throw new Error('PROCESS_INVENTORY_INVALID');
  return rows.map(classifyQQProcess);
}
