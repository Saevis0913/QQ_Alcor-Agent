#!/usr/bin/env node
// 发布一次更新：一条命令完成「算哈希 → 换滚动 release 的资产 → 改写 update/manifest.json」。
//
// 用法：
//   node tools/publish-update.mjs --file "D:\Alcor-pkg\0.3.1\out\Alcor-Agent-Setup-0.3.1-x64.exe" --version 0.3.1
//   node tools/publish-update.mjs --file ... --version 0.3.1 --dry        # 只算哈希、打印清单，不上传
//
// 需要的环境变量：GITHUB_TOKEN（fine-grained PAT，仓库 Contents 读写 + 该 release 的资产写）
// 可选：GITHUB_REPO（默认 Saevis0913/QQ_Alcor-Agent）、TAG（默认 v<major.minor>-latest）
//
// 设计约定：每个大版本只保留一条滚动 release（v0.3-latest / v0.4-latest），
// 小版本只替换这条 release 里的资产，所以 GitHub 的 Releases 列表不会堆成一堆小版本。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

function arg(name, fallback = '') {
  const index = process.argv.indexOf('--' + name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : 'true';
}

const file = path.resolve(arg('file'));
const version = String(arg('version')).replace(/^v/, '');
const dry = arg('dry') === 'true';
const repo = process.env.GITHUB_REPO || 'Saevis0913/QQ_Alcor-Agent';
const token = process.env.GITHUB_TOKEN || '';
const [owner, name] = repo.split('/');

if (!fs.existsSync(file)) {
  console.error('找不到安装包：' + file);
  process.exit(2);
}
if (!/^\d+\.\d+\.\d+(?:-as\.\d+)?$/.test(version)) {
  console.error('版本号要写成 1.2.3 或 1.2.3-as.1 这种形式，收到：' + version);
  process.exit(2);
}
const isAsPatch = /-as\.\d+$/.test(version);
const majorMinor = version.split('.').slice(0, 2).join('.');
const tag = process.env.TAG || `v${majorMinor}-latest`;
const isPrerelease = process.env.PRERELEASE !== '0';
const releaseName = process.env.RELEASE_NAME || (isPrerelease ? '更新下载通道（自动更新用，请勿手动下载）' : `Alcor Agent 正式版 v${version}`);
const assetName = path.basename(file);

const bytes = fs.statSync(file).size;
const sha256 = await new Promise((resolve, reject) => {
  const digest = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (chunk) => digest.update(chunk)).on('error', reject).on('end', () => resolve(digest.digest('hex')));
});

const notes = arg('notes', '') || `Alcor Agent ${version}`;
const manifest = {
  product: 'Alcor Agent',
  latest: version,
  minSupported: arg('min', '0.2.0'),
  applyMode: 'restart',
  notes,
  publishedAt: new Date().toISOString(),
  rollout: 100,
  full: {
    urls: [`https://github.com/${repo}/releases/download/${tag}/${assetName}`],
    bytes,
    sha256,
    fileName: assetName
  }
};

console.log(`版本 ${version} · ${(bytes / 1048576).toFixed(1)} MB`);
console.log(`sha256 ${sha256}`);
console.log(`滚动 release ${tag} · 资产 ${assetName}`);
if (dry) {
  const out = path.join(process.cwd(), 'update', 'manifest.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  console.log('已写本地清单：' + out + '（--dry 模式，没有上传任何东西）');
  process.exit(0);
}
if (!token) {
  console.error('缺少 GITHUB_TOKEN 环境变量');
  process.exit(2);
}

async function api(method, url, body, raw = false, size = 0) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/vnd.github+json',
      ...(body && !raw ? { 'content-type': 'application/json' } : {}),
      ...(raw ? { 'content-type': 'application/octet-stream' } : {}),
      ...(raw && size ? { 'content-length': String(size) } : {})
    },
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
    duplex: raw ? 'half' : undefined
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 200) }; }
  if (!response.ok) throw Object.assign(Error(`${method} ${url} → ${response.status}`), { status: response.status, data });
  return data;
}

// 1) 确保滚动 release 存在
let release = null;
try {
  release = await api('GET', `${API}/repos/${owner}/${name}/releases/tags/${tag}`);
} catch (error) {
  if (error.status !== 404) throw error;
}
if (release && (release.name !== releaseName || release.prerelease !== isPrerelease)) {
  release = await api('PATCH', `${API}/repos/${owner}/${name}/releases/${release.id}`, {
    name: releaseName,
    prerelease: isPrerelease
  });
  console.log('已校正滚动 release：标为预发行，不占仓库首页 Releases 位');
}
if (!release) {
  const main = await api('GET', `${API}/repos/${owner}/${name}/commits/main`);
  release = await api('POST', `${API}/repos/${owner}/${name}/releases`, {
    tag_name: tag,
    target_commitish: main.sha,
    name: releaseName,
    prerelease: isPrerelease,
    body: isPrerelease ? `这个 release 只放当前大版本的最新安装包，资产会随小版本更新替换；历史版本请在 git tag 里查。` : notes,
    draft: false
  });
  console.log('已创建滚动 release：' + tag);
}

// 2) 旧资产先留着：上传失败时清单还指向它，删早了会把通道打空（0.3.1-as.3 那次就是这样）

// 3) 上传新安装包（断线重试一次）
const uploadUrl = `${UPLOADS}/repos/${owner}/${name}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`;
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    console.log(`上传中（第 ${attempt} 次）…`);
    const result = await api('POST', uploadUrl, fs.createReadStream(file), true, bytes);
    console.log('上传完成：' + result.state + ' · ' + result.size + ' B · ' + (result.digest || ''));
    break;
  } catch (error) {
    console.error('上传失败：' + error.message);
    if (attempt === 3) throw error;
    await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
  }
}

// 3.5) 新包上传成功后才删旧资产，且不删刚上传的那份
for (const asset of release.assets || []) {
  if (asset.name === assetName) continue;
  try {
    await api('DELETE', `${API}/repos/${owner}/${name}/releases/assets/${asset.id}`);
    console.log('已删除旧资产：' + asset.name);
  } catch (error) {
    console.error('旧资产删除失败（不影响新包）：' + error.message);
  }
}

// 4) 顺带放一份 SHA256SUMS.txt，老版本走 Releases 接口时也能校验
const sums = `${sha256}  ${assetName}\n`;
try {
  await api('POST', `${UPLOADS}/repos/${owner}/${name}/releases/${release.id}/assets?name=SHA256SUMS.txt`, Buffer.from(sums), true);
  console.log('已上传 SHA256SUMS.txt');
} catch (error) {
  console.error('SHA256SUMS.txt 上传失败（不影响新链路）：' + error.message);
}

// 4) 更新清单（GitHub 上的 update/manifest.json）
const content = Buffer.from(JSON.stringify(manifest, null, 2) + '\n').toString('base64');
let sha = null;
try {
  const current = await api('GET', `${API}/repos/${owner}/${name}/contents/update/manifest.json`);
  sha = current.sha;
} catch (error) {
  if (error.status !== 404) throw error;
}
await api('PUT', `${API}/repos/${owner}/${name}/contents/update/manifest.json`, {
  message: `Publish update manifest for ${version}`,
  content,
  branch: 'main',
  ...(sha ? { sha } : {})
});
// 4b) 小版本记录：同一个文件每次覆盖，仓库 update/ 目录里看到的永远是最新一次
const rolling = [
  '<!-- 每次发布由 tools/publish-update.mjs 覆盖本文件，这里只保留最新一条。 -->',
  '# Alcor Agent 小版本更新记录',
  '',
  '- 版本：' + version,
  '- 发布时间：' + manifest.publishedAt,
  '- 安装包：' + assetName + '（' + bytes + ' B）',
  '- sha256：' + sha256,
  '- 下载：' + manifest.full.urls[0],
  '',
  '## 本次更新',
  '',
  notes,
  ''
].join('\n');
let notesSha = null;
try {
  const current = await api('GET', `${API}/repos/${owner}/${name}/contents/update/notes.md`);
  notesSha = current.sha;
} catch (error) {
  if (error.status !== 404) throw error;
}
await api('PUT', `${API}/repos/${owner}/${name}/contents/update/notes.md`, {
  message: `Publish update notes for ${version}`,
  content: Buffer.from(rolling).toString('base64'),
  branch: 'main',
  ...(notesSha ? { sha: notesSha } : {})
});
console.log('小版本记录已覆盖：update/notes.md → ' + version);

// 5) 清掉 jsDelivr 的缓存，否则它可能还在发上一个版本（客户端会挑最高版本，但清掉更快）
try {
  const response = await fetch(`https://purge.jsdelivr.net/gh/${owner}/${name}@main/update/manifest.json`);
  console.log('jsDelivr 缓存清理：' + response.status);
} catch (error) {
  console.error('jsDelivr 缓存清理失败（不影响发布）：' + error.message);
}

console.log('清单已更新：update/manifest.json → ' + version);
console.log('用户端最多 20 秒后就能看到提示（小版本会自动下载并安装）。');
