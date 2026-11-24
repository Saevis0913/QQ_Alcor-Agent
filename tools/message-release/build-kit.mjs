import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = path.dirname(fileURLToPath(import.meta.url));
const [catalog, outputDir, edition] = process.argv.slice(2);
if (!catalog || !outputDir || (edition && edition !== '--core-receive')) throw Error('Usage: node build-kit.mjs <deltas.xml> <new-output-directory> [--core-receive]');
const core = edition === '--core-receive';
const exe = core ? 'Alcor-Receive-R1.exe' : 'Alcor-RC2.exe';
const out = path.resolve(outputDir);
fs.mkdirSync(out);
const csc = path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const result = spawnSync(csc, ['/nologo','/codepage:65001','/optimize+','/target:exe','/platform:x64',
  '/reference:System.Windows.Forms.dll','/reference:System.Xml.Linq.dll',
  '/resource:'+path.resolve(catalog)+',Alcor.deltas','/resource:observe.mjs,Alcor.observer',
  ...(core ? ['/define:CORE_RECEIVE_R1'] : []), '/out:'+path.join(out,exe),'AgentUpdate.cs'], {cwd:here,stdio:'inherit',windowsHide:true});
if (result.status !== 0) throw Error('C# build failed');
fs.copyFileSync(path.join(here,'observe.mjs'),path.join(out,'observe.mjs'));
fs.copyFileSync(path.join(here,core ? '收件修复说明.txt' : '使用说明.txt'),path.join(out,'使用说明.txt'));
for (const [name, mode] of [['01-检查','check'],[core ? '02-安装收件修复' : '02-安装RC2','apply'],['03-回退','rollback'],['04-现场核对','observe']]) {
  const lines = ['@echo off','setlocal DisableDelayedExpansion','if "%~1"=="" goto picker',
    '"%~dp0'+exe+'" '+mode+' "%~1"','goto finish',':picker','"%~dp0'+exe+'" '+mode,
    ':finish','set "rc=%errorlevel%"','pause','exit /b %rc%',''];
  fs.writeFileSync(path.join(out,name+'.cmd'),lines.join('\r\n'),'ascii');
}
