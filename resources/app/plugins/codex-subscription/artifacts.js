import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const windowsReserved = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;

export function checkFiles(files) {
  if (!Array.isArray(files) || files.length > 24) throw new Error('文本产物超过 24 个或格式不正确。');
  const seen = new Set();
  let size = 0;
  return files.map(file => {
    const name = file?.path;
    if (typeof name !== 'string' || name.length > 160 || typeof file.text !== 'string') throw new Error('产物文件名或内容无效。');
    const parts = name.split('/');
    if (parts.some(part => !part || /^[. ]/.test(part) || /[. ]$/.test(part) ||
        /[\\:*?"<>|\u0000-\u001f\u007f]/u.test(part) || windowsReserved.test(part))) {
      throw new Error('产物文件名必须是安全的相对路径。');
    }
    const key = name.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new Error('产物包含重复文件名。');
    seen.add(key);
    size += Buffer.byteLength(file.text);
    if (size > 2 * 1024 * 1024) throw new Error('文本产物总大小超过 2 MiB。');
    return { parts, text: file.text };
  });
}

export async function archiveFiles(root, files, signal) {
  const items = checkFiles(files);
  if (!items.length) return null;
  signal?.throwIfAborted();
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('打包根目录是重解析点。');
  const location = await realpath(root);
  const staging = await mkdtemp(path.join(location, '.codex-'));
  const name = 'codex-' + randomUUID();
  const temporary = path.join(location, '.' + name + '.zip');
  const output = path.join(location, name + '.zip');
  try {
    for (const {parts, text} of items) {
      signal?.throwIfAborted();
      const filename = path.join(staging, ...parts);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, text, { flag:'wx', encoding:'utf8', signal });
    }
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    await executeFile(tar, ['-a', '-cf', temporary, '-C', staging, '.'], { windowsHide:true, timeout:30_000, signal });
    signal?.throwIfAborted();
    await rename(temporary, output);
    return output;
  } finally {
    if (path.dirname(staging) === location && await realpath(staging).catch(()=>'') === staging) {
      await rm(staging, { recursive:true, force:true }).catch(() => {});
    }
    await unlink(temporary).catch(() => {});
  }
}
