import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { runVideoTool, videoInputArgs } from './video-frames.js';

export function isQqSticker(data) {
  return data.sticker === true || Boolean(data.emoji_id) || String(data.sub_type) === '1';
}

export function groupFileMetadata(data) {
  const fileId = String(data?.file_id ?? '');
  const name = String(data?.file_name ?? data?.name ?? '').slice(0, 256);
  const busid = Number(data?.busid);
  const groupId = String(data?.group_id ?? '');
  const fileSize = Number(data?.file_size);
  if (!fileId || fileId.length > 512 || /[\x00-\x1f]/.test(fileId) ||
      data?.busid == null || !Number.isSafeInteger(busid) || busid < 0) return null;
  return {
    fileId, name, busid,
    ...(Number.isSafeInteger(fileSize) && fileSize >= 0 ? { fileSize } : {}),
    ...(/^\d+$/.test(groupId) ? { groupId } : {})
  };
}

export function privateFileMetadata(data) {
  const fileId=String(data?.file_id??''),userId=String(data?.user_id??''),fileSize=Number(data?.file_size);
  if(data?.group_id||!/^alcor-media-[a-f0-9]{64}$/.test(fileId)||! /^[1-9]\d{0,9}$/.test(userId)||Number(userId)>0xffffffff)return null;
  return {fileId,name:String(data?.name??'').slice(0,256),userId,...(Number.isSafeInteger(fileSize)&&fileSize>=0?{fileSize}:{})};
}

export async function withMediaScratch(prefix, work) {
  const root = path.resolve(DATA_DIR, 'media-work');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, prefix));
  try {
    return await work(dir);
  } finally {
    // This directory was just created by mkdtemp under the configured app data root.
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
  }
}

export function isAnimatedImage(buffer, mime, flagged) {
  if (mime === 'image/gif') return true;
  if (mime === 'image/webp') {
    return buffer.length >= 21 && buffer.toString('ascii', 12, 16) === 'VP8X' && (buffer[20] & 0x02) !== 0;
  }
  if (mime === 'image/png') {
    for (let offset = 8; offset + 12 <= buffer.length;) {
      const chunk = buffer.toString('ascii', offset + 4, offset + 8);
      if (chunk === 'acTL') return true;
      if (chunk === 'IDAT' || chunk === 'IEND') break;
      offset += 12 + buffer.readUInt32BE(offset);
    }
    return false;
  }
  // The QQ catalog can flag an animated sticker even when the CDN serves a static image.
  return mime !== 'image/jpeg' && mime !== 'image/jpg' && flagged === true;
}

export async function extractAnimatedImageFrames(buffer) {
  return withMediaScratch('animation-', async (dir) => {
    const input = path.join(dir, 'input');
    await fs.writeFile(input, buffer);
    const args = videoInputArgs(input);
    args[args.indexOf('-format_whitelist') + 1] = 'gif,apng,webp_anim,webp_pipe';
    let step = 0;
    try {
      const { stdout } = await runVideoTool('ffprobe', [
        '-v', 'error', ...args, '-show_entries', 'format=duration', '-of', 'csv=p=0'
      ]);
      const duration = Number(stdout.toString().trim());
      if (Number.isFinite(duration) && duration > 0) step = duration / 6;
    } catch { /* Decode the first six frames when duration is unavailable. */ }
    const { stdout } = await runVideoTool('ffmpeg', [
      '-nostdin', '-v', 'error', '-threads', '1', ...args,
      '-map', '0:v:0', '-filter_threads', '1',
      '-vf', `select='isnan(prev_selected_t)+gte(t-prev_selected_t,${step.toFixed(6)})',scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease`,
      '-fps_mode', 'vfr', '-frames:v', '6', '-an', '-c:v', 'mjpeg',
      '-threads', '1', '-q:v', '4', '-f', 'image2pipe', 'pipe:1'
    ], { timeout: 8000, maxBuffer: 2 * 1024 * 1024 });
    const frames = [];
    for (let start = 0; start + 2 < stdout.length;) {
      if (stdout.readUInt16BE(start) !== 0xffd8) break;
      const end = stdout.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) break;
      frames.push(`data:image/jpeg;base64,${stdout.subarray(start, end + 2).toString('base64')}`);
      start = end + 2;
    }
    if (!frames.length) throw new Error('无法从动图读取画面');
    return frames;
  });
}
