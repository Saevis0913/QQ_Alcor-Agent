import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MAX_INPUT_BYTES = 200 * 1024 * 1024;
const MAX_ALLOC_BYTES = 128 * 1024 * 1024;
const MAX_INPUT_PIXELS = 4096 * 4096;
const VIDEO_FORMATS = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpeg,mpegts,flv,asf,ogg,rm,gif,apng';
const checkedTools = new Map();

export function runVideoTool(command, args, { timeout = 5000, maxBuffer = 64 * 1024 } = {}) {
  return exec(command, args, { encoding: 'buffer', windowsHide: true, shell: false, timeout, maxBuffer });
}

export function hasVideoTool(command) {
  const now = Date.now();
  const cached = checkedTools.get(command);
  if (cached && cached.expiresAt > now) return cached.result;
  const result = runVideoTool(command, ['-version']).then(
    ({ stdout }) => stdout.toString('utf8').startsWith(`${command} version `),
    () => false
  );
  checkedTools.set(command, { expiresAt: now + 60000, result });
  return result;
}

function isLocalAbsolutePath(filePath) {
  if (typeof filePath !== 'string' || filePath.includes('\0')) return false;
  return process.platform === 'win32'
    ? /^[a-z]:[\\/][^:]*$/i.test(filePath)
    : path.isAbsolute(filePath);
}

export async function localVideoPath(filePath) {
  if (!isLocalAbsolutePath(filePath)) return null;
  try {
    const resolved = await fs.realpath(filePath);
    if (!isLocalAbsolutePath(resolved)) return null;
    const stat = await fs.stat(resolved);
    return stat.isFile() && stat.size > 0 && stat.size <= MAX_INPUT_BYTES ? resolved : null;
  } catch {
    return null;
  }
}

export function videoInputArgs(filePath) {
  return [
    '-max_alloc', String(MAX_ALLOC_BYTES),
    '-max_pixels', String(MAX_INPUT_PIXELS),
    // Reject playlists and other demuxers that can open secondary inputs.
    '-format_whitelist', VIDEO_FORMATS,
    '-protocol_whitelist', 'file',
    '-i', filePath
  ];
}
