import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = path.dirname(fileURLToPath(import.meta.url));
const [catalog, outputDir] = process.argv.slice(2);
if (!catalog || !outputDir) throw Error('Usage: node build-kit.mjs <deltas.xml> <new-output-directory>');
const out = path.resolve(outputDir);
fs.mkdirSync(out);
const csc = path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const result = spawnSync(csc, ['/nologo','/codepage:65001','/optimize+','/target:exe','/platform:x64',
  '/reference:System.Windows.Forms.dll','/reference:System.Xml.Linq.dll',
  '/resource:'+path.resolve(catalog)+',Alcor.deltas','/resource:observe.mjs,Alcor.observer',
  '/out:'+path.join(out,'Alcor-RC2.exe'),'AgentUpdate.cs'], {cwd:here,stdio:'inherit',windowsHide:true});
if (result.status !== 0) throw Error('C# build failed');
for (const name of ['observe.mjs','使用说明.txt']) fs.copyFileSync(path.join(here,name),path.join(out,name));
for (const [name, mode] of [['01-检查','check'],['02-安装RC2','apply'],['03-回退','rollback'],['04-现场核对','observe']]) {
  const lines = ['@echo off','setlocal DisableDelayedExpansion','if "%~1"=="" goto picker',
    '"%~dp0Alcor-RC2.exe" '+mode+' "%~1"','goto finish',':picker','"%~dp0Alcor-RC2.exe" '+mode,
    ':finish','set "rc=%errorlevel%"','pause','exit /b %rc%',''];
  fs.writeFileSync(path.join(out,name+'.cmd'),lines.join('\r\n'),'ascii');
}
