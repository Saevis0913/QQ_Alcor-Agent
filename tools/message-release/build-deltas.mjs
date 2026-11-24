import assert from 'node:assert/strict';
import { commands } from './delta-commands.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [stock, installed, candidate, output] = process.argv.slice(2);
if (!output) throw Error('Usage: node build-deltas.mjs <stock-root> <audited-installed-root> <tested-RC2-root> <output.xml>');
const rels = ['src/app.js', 'src/onebot.js', 'src/routes.js', 'src/sender.js', 'src/store.js',
  'ui/app/04-archive-usage.js', 'src/pending-message-sends.js'];
const read = (root, rel) => {
  const name = path.join(root, 'resources/app', rel);
  return fs.existsSync(name) ? fs.readFileSync(name) : null;
};
const hash = b => b === null ? '-' : createHash('sha256').update(b).digest('hex');
const norm = b => b.toString('utf8').replaceAll('\r\n', '\n');
const pieces = s => s.match(/[^\n]*\n|[^\n]+$/g) || [];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-field-delta-'));

// Preserve line endings on untouched lines, including mixed CRLF/LF source files.
function toBaselineEndings(before, target) {
  if (before === null) return Buffer.from(target);
  const old = pieces(before.toString('utf8'));
  const next = pieces(target);
  const a = path.join(scratch, 'before'), b = path.join(scratch, 'after');
  fs.writeFileSync(a, norm(before)); fs.writeFileSync(b, target);
  const diff = spawnSync('git', ['-c','core.autocrlf=false','diff','--no-index','--no-ext-diff','--text','-U0','--',a,b],
    { encoding:'utf8', windowsHide:true });
  if (![0,1].includes(diff.status)) throw Error(diff.stderr || 'git diff failed');
  const result=[];
  let cursor=0;
  for (const h of diff.stdout.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const removed = Number(h[2] ?? 1), added = Number(h[4] ?? 1);
    const from = Number(h[1]) - (removed ? 1 : 0);
    const to = Number(h[3]) - (added ? 1 : 0);
    result.push(...old.slice(cursor,from));
    const eol = (old[from] || old[from-1] || '').endsWith('\r\n') ? '\r\n' : '\n';
    result.push(...next.slice(to,to+added).map(line => line.replace(/\n$/,eol)));
    cursor = from + removed;
  }
  result.push(...old.slice(cursor));
  const bytes = Buffer.from(result.join(''));
  assert.equal(norm(bytes),target);
  return bytes;
}

function routeParts(source) {
  const mark = source.indexOf('/test-send$/');
  assert.ok(mark > 0 && mark === source.lastIndexOf('/test-send$/'));
  const start = source.lastIndexOf('    {\n',mark), end = source.indexOf('\n    },\n    {',mark);
  assert.ok(start>=0 && end>start);
  return [source.slice(0,start), source.slice(start,end), source.slice(end)];
}


try {
  const rows=[];
  for(const [id, root] of [['stock-as5',stock],['audited-as5',installed]]){
    const files=[];
    for(const rel of rels){
      const before=read(root,rel), tested=norm(read(candidate,rel));
      let target=tested;
      if(rel==='src/routes.js'){
        const [prefix,oldRoute,suffix]=routeParts(norm(before));
        assert.equal(oldRoute,routeParts(norm(read(installed,rel)))[1]);
        target=prefix+routeParts(tested)[1]+suffix;
      } else if(id==='stock-as5' && rel!=='src/onebot.js' && before) {
        assert.equal(norm(before),norm(read(installed,rel)));
      }
      const after=toBaselineEndings(before,target);
      files.push('<file path="'+rel+'" before="'+hash(before)+'" after="'+hash(after)+'"><forward>'+
        commands(before,after)+'</forward><reverse>'+commands(after,before)+'</reverse></file>');
    }
    rows.push('<profile id="'+id+'">'+files.join('\n')+'</profile>');
  }
  fs.writeFileSync(output,'<release id="alcor-agent-message-rc2">'+rows.join('\n')+'</release>');
} finally {
  for(const name of ['before','after'])fs.rmSync(path.join(scratch,name),{force:true});
  fs.rmdirSync(scratch);
}
