import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {commands} from './delta-commands.mjs';

const [older, patchedOlder, newer, patchedNewer, output] = process.argv.slice(2);
if (!output) throw Error('Usage: node build-core-receive.mjs <as5> <tested-as5> <as8> <tested-as8> <new-catalog.xml>');
const rels = ['src/native-backend.mjs','src/received-message.mjs'];
const sha = b => b === null ? '-' : createHash('sha256').update(b).digest('hex');
const profiles = [];
for (const [id,version,base,candidate] of [
  ['as5-core041','0.4.1',older,patchedOlder], ['as8-core043','0.4.3',newer,patchedNewer]
]) {
  const core = root => path.join(root,'resources/alcor');
  for (const root of [base,candidate]) assert.equal(JSON.parse(fs.readFileSync(path.join(core(root),'package.json'),'utf8')).version,version);
  const files = rels.map((rel,i) => {
    const original = path.join(core(base),rel);
    const before = fs.existsSync(original) ? fs.readFileSync(original) : null;
    const after = fs.readFileSync(path.join(core(candidate),rel));
    assert.equal(before === null,i === 1);
    assert.notEqual(sha(before),sha(after));
    return '<file path="'+rel+'" before="'+sha(before)+'" after="'+sha(after)+'"><forward>'+commands(before,after)+
      '</forward><reverse>'+commands(after,before)+'</reverse></file>';
  });
  profiles.push('<profile id="'+id+'" package="'+version+'">'+files.join('\n')+'</profile>');
}
fs.writeFileSync(output,'<release id="alcor-core-receive-r1">'+profiles.join('\n')+'</release>',{flag:'wx'});
