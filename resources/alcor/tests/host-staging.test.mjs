import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostArtifacts, stageDirFor } from '../native-core/controller.mjs';

function makeInstall(name){
  const root=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'alcor-stage-')),name);
  fs.mkdirSync(path.join(root,'runtime'),{recursive:true});
  for(const f of ['qq-host-loader.exe','alcor-host.dll'])fs.writeFileSync(path.join(root,f),'x');
  fs.writeFileSync(path.join(root,'runtime','alcor-runtime-abc.dll'),'y');
  return root;
}

test('ASCII 短路径不搬家，直接用安装目录里的加载器',()=>{
  const root=makeInstall('plain');
  const a=hostArtifacts(root);
  assert.equal(a.staged,false);
  assert.equal(a.loader,path.join(root,'qq-host-loader.exe'));
});

test('非 ASCII 路径搬家时必须把 runtime 目录一起搬走',()=>{
  const root=makeInstall('验收-as8');
  const previous=process.env.ProgramData;
  process.env.ProgramData=fs.mkdtempSync(path.join(os.tmpdir(),'alcor-pd-'));
  try{
    assert.ok(stageDirFor(root),'该路径应当触发搬家');
    const a=hostArtifacts(root);
    assert.equal(a.staged,true);
    assert.ok(fs.existsSync(path.join(a.dir,'qq-host-loader.exe')));
    assert.ok(fs.existsSync(path.join(a.dir,'alcor-host.dll')));
    assert.ok(fs.existsSync(path.join(a.dir,'runtime','alcor-runtime-abc.dll')),'runtime DLL 缺失会让宿主 receive 报 LB_HOST_IO');
  }finally{
    if(previous===undefined)delete process.env.ProgramData;else process.env.ProgramData=previous;
  }
});
