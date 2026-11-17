import { hasVideoTool, localVideoPath, runVideoTool, videoInputArgs } from '../../src/video-frames.js';

const MAX_FRAMES = 12;
const MAX_JPEG_BYTES = 1024 * 1024;
const MAX_DURATION_SECONDS = 4 * 60 * 60;
const JOB_TIMEOUT_MS = 30000;
const FRAME_TIMEOUT_MS = 5000;
const FRAME_SCALE = "scale='min(960,iw)':'min(960,ih)':force_original_aspect_ratio=decrease";
const FFMPEG_UNAVAILABLE = '未找到可运行的 FFmpeg';

async function extractFrames({ filePath, count, durationSec } = {}) {
  const input = await localVideoPath(filePath);
  const frames = [];
  const times = [];
  if (!input) return { frames, times, error: '抽帧需要不超过 200 MB 的本地视频文件' };
  if (!await hasVideoTool('ffmpeg')) return { frames, times, error: FFMPEG_UNAVAILABLE };
  if (durationSec > MAX_DURATION_SECONDS) return { frames, times, error: '视频超过 4 小时抽帧上限' };

  const targetCount = Number.isFinite(count) ? Math.min(MAX_FRAMES, Math.max(1, Math.floor(count))) : 6;
  const hasDuration = Number.isFinite(durationSec) && durationSec > 0;
  const samples = hasDuration
    ? Array.from({ length: targetCount }, (_, i) => durationSec * (i + 0.5) / targetCount)
    : [0];
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  for (const time of samples) {
    const timeout = Math.min(FRAME_TIMEOUT_MS, deadline - Date.now());
    if (timeout <= 0) break;
    try {
      const { stdout } = await runVideoTool('ffmpeg', [
        '-nostdin', '-v', 'error', '-ss', time.toFixed(6), '-threads', '2',
        ...videoInputArgs(input),
        '-map', '0:V:0', '-filter_threads', '1', '-vf', FRAME_SCALE,
        '-frames:v', '1', '-an', '-c:v', 'mjpeg', '-threads', '1', '-q:v', '4',
        '-f', 'image2pipe', 'pipe:1'
      ], { timeout, maxBuffer: MAX_JPEG_BYTES });
      if (stdout.length < 4 || stdout.readUInt16BE(0) !== 0xffd8 ||
          stdout.readUInt16BE(stdout.length - 2) !== 0xffd9) continue;
      frames.push(`data:image/jpeg;base64,${stdout.toString('base64')}`);
      times.push(time);
    } catch (error) {
      // A failed seek can leave other samples usable. Missing FFmpeg affects the whole job.
      if (error.code === 'ENOENT') return { frames, times, error: FFMPEG_UNAVAILABLE };
    }
  }
  return { frames, times, error: frames.length ? undefined : '无法从该视频读取画面' };
}

export const providers = {
  'video.frames': extractFrames,
  'video.frames.available': async () => {
    const ok = await hasVideoTool('ffmpeg');
    return { ok, reason: ok ? '' : FFMPEG_UNAVAILABLE };
  }
};
