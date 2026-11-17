import fs from 'node:fs/promises';
import path from 'node:path';
import silk from 'silk-wasm';
import { ROOT } from '../../src/config.js';
import { withMediaScratch } from '../../src/group-media.js';
import { safeFetchBinary } from '../../src/safe-fetch.js';
import { hasVideoTool, runVideoTool } from '../../src/video-frames.js';

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_SECONDS = 120;
const SAMPLE_RATE = 16000;
const MAX_PCM_BYTES = MAX_SECONDS * SAMPLE_RATE * 2;
const NO_RUNTIME = '本地 Whisper 可执行文件或语音模型缺失';
const NO_TRANSCRIPT = '未识别到可转写内容';
let activeJobs = 0;

async function speechRuntime() {
  const configured = process.env.ALCOR_AGENT_MEDIA_RUNTIME_DIR;
  const candidates = configured ? [configured] : [
    path.resolve(ROOT, '..', 'media-runtime'),
    path.resolve(ROOT, '..', '..', '..', 'media-runtime'),
    path.resolve(ROOT, '..', '..', 'development', 'media-runtime')
  ];
  for (const dir of candidates) {
    const executable = path.resolve(dir, 'whisper-v1.8.3', 'Release', 'whisper-cli.exe');
    const model = path.resolve(dir, 'ggml-small-q5_1.bin');
    const [exe, weights] = await Promise.all([
      fs.stat(executable).catch(() => null), fs.stat(model).catch(() => null)
    ]);
    if (exe?.isFile() && weights?.isFile() && weights.size === 190085487) return { executable, model };
  }
  return null;
}

function pcmWave(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function decodeVoice(buffer, dir) {
  if (!buffer.length || buffer.length > MAX_AUDIO_BYTES) throw new Error('语音文件超过读取上限或内容为空');
  if (silk.isSilk(buffer)) {
    if (silk.getDuration(buffer) > MAX_SECONDS * 1000) throw new Error('语音超过 120 秒');
    const { data } = await silk.decode(buffer, SAMPLE_RATE);
    if (!data.length || data.length > MAX_PCM_BYTES) throw new Error('解码后的语音超过上限或内容为空');
    return Buffer.from(data);
  }
  if (!await hasVideoTool('ffmpeg')) throw new Error('音频转换需要 FFmpeg');
  const input = path.join(dir, 'input');
  await fs.writeFile(input, buffer);
  const { stdout } = await runVideoTool('ffmpeg', [
    '-nostdin', '-v', 'error', '-threads', '1', '-max_alloc', '67108864',
    '-format_whitelist', 'wav,mp3,amr,aac,ogg,flac,mov,mp4,m4a,3gp,matroska,webm',
    '-protocol_whitelist', 'file', '-i', input, '-map', '0:a:0',
    '-t', String(MAX_SECONDS + 1), '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 's16le', 'pipe:1'
  ], { timeout: 15000, maxBuffer: MAX_PCM_BYTES + SAMPLE_RATE * 2 + 65536 });
  if (!stdout.length || stdout.length > MAX_PCM_BYTES) throw new Error('语音超过 120 秒或内容为空');
  return stdout;
}

export async function transcribeAudio(buffer, runtime = null) {
  runtime ??= await speechRuntime();
  if (!runtime) return { ok: false, error: NO_RUNTIME };
  return withMediaScratch('speech-', async (dir) => {
    const pcm = await decodeVoice(buffer, dir);
    if (!pcm.some((byte) => byte !== 0)) return { ok: false, error: NO_TRANSCRIPT };
    const wave = path.join(dir, 'speech.wav');
    await fs.writeFile(wave, pcmWave(pcm));
    const output = path.join(dir, 'transcript');
    await runVideoTool(runtime.executable, [
      '-m', runtime.model, '-f', wave, '-l', 'auto', '-t', '4', '-ng', '-nt', '-otxt', '-of', output
    ], { timeout: 120000, maxBuffer: 256 * 1024 });
    const text = (await fs.readFile(`${output}.txt`, 'utf8')).trim().slice(0, 4000);
    return text ? { ok: true, text } : { ok: false, error: NO_TRANSCRIPT };
  });
}

async function transcribe({ record, onebot } = {}) {
  const runtime = await speechRuntime();
  if (!runtime) return { ok: false, error: NO_RUNTIME };
  const file = String(record?.file ?? '');
  if (!onebot || !file || file.length > 512) return { ok: false, error: '缺少 QQ 语音文件标识' };
  if (activeJobs >= 2) return { ok: false, error: '语音识别繁忙' };
  activeJobs++;
  try {
    const info = await onebot.call('get_record', { file, out_format: 'silk' });
    const url = info?.url;
    if (!url || Number(info.file_size) > MAX_AUDIO_BYTES) return { ok: false, error: '语音不可下载或超过 8 MB' };
    const { buffer } = await safeFetchBinary(url, MAX_AUDIO_BYTES + 1, {
      publicOnly: true, httpsOnly: true, timeoutMs: 15000
    });
    return await transcribeAudio(buffer, runtime);
  } catch {
    return { ok: false, error: '语音下载、解码或识别失败' };
  } finally {
    activeJobs--;
  }
}

export const providers = {
  'media.transcribe': transcribe,
  'media.transcribe.available': async () => {
    const ok = Boolean(await speechRuntime());
    return { ok, reason: ok ? '' : NO_RUNTIME };
  }
};
