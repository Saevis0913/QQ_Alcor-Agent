import fs from 'node:fs';
import path from 'node:path';
import {ROOT, getConfig} from './config.js';

const documentNames = ['skill-development.md','plugin-development.md','skill-reference.md','alcor-capabilities.md'];

// Derive from the application files, never the user data directory or shell cwd.
export function extensionWorkspace(appRoot = ROOT) {
  const root = path.resolve(appRoot);
  const skillsDir = path.join(root, 'skills'), pluginsDir = path.join(root, 'plugins');
  const docsDir = path.join(root, 'doc', 'extend_development');
  for (const dir of [skillsDir, pluginsDir]) fs.mkdirSync(dir, {recursive:true});
  const documents = documentNames.map(name => ({name, path:path.join(docsDir,name)}));
  if (documents.some(doc => !fs.existsSync(doc.path) || !fs.statSync(doc.path).isFile())) {
    throw new Error('扩展开发说明缺失，请修复或重新安装 Alcor Agent');
  }
  return {schemaVersion:1,appRoot:root,skillsDir,pluginsDir,docsDir,documents,
    hotReload:process.env.ALCOR_AGENT_DEV === '1' || getConfig().extensions?.hotReload !== false};
}
