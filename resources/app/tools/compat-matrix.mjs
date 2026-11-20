#!/usr/bin/env node
'use strict';
/**
 * 兼容性矩阵：把「别人的机器」按维度组合出来，逐条跑判定逻辑，看结论对不对。
 *
 * 不注入、不启动 QQ、不联网：只喂假数据给 qq-compat / qq-diagnosis / update-feeds 的纯函数，
 * 覆盖安装路径、系统版本、运行库、权限、会话、架构、安全策略、QQ 版本、下载通道这些维度。
 *
 * 用法：node resources/app/tools/compat-matrix.mjs
 * 退出码：0 全部通过；1 有失败行。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const { diagnoseQQ } = await import(pathToFileURL(path.join(APP, 'src/qq-diagnosis.js')).href);
const { compareVersion, isPatchUpdate, normalizeManifest } = await import(pathToFileURL(path.join(APP, 'src/update-feeds.js')).href);
const { filterRepairUrls } = await import(pathToFileURL(path.join(APP, 'src/update-manager.js')).href);
const { peArchitecture } = await import(pathToFileURL(path.join(APP, 'src/qq-compat.js')).href);

const rows = [];
const check = (group, name, pass, detail = '') => rows.push({ group, name, pass, detail });

const qq = (over = {}) => ({ pid: 1001, name: 'QQ.exe', path: 'D:\\QQ\\QQ.exe', version: '9.9.36-53644',
  moduleName: 'wrapper.node', architecture: 'x64', supported: true, reason: null,
  alcorHostLoaded: false, foreignModules: [], startedAt: '133000000000000000', ...over });

const compat = (over = {}) => ({ os: { version: '10.0.22631', arch: 'AMD64', is64: true },
  self: { elevated: false, session: 1 }, loader: { ok: true, stage: 'arguments', bytes: 178176 },
  hostDll: { ok: true, bytes: 182272 },
  flags: { elevatedQQ: [], foreignSession: [], archMismatch: [], hvci: false, smartAppControl: false, loaderBroken: false, hostArtifactMissing: false },
  ...over });

/* 1. 安装路径：中文 / 空格 / 超长 都要能被中转目录兜住 */
const ascii = (dir) => /^[\x20-\x7e]+$/.test(dir) && dir.length <= 160;
const cases = [
  ['C:\\Program Files\\Alcor\\resources\\alcor\\artifacts\\native\\', true, '纯 ASCII 含空格 → 直接注入'],
  ['C:\\Users\\张三\\AppData\\Local\\Programs\\Alcor\\resources\\alcor\\artifacts\\native\\', false, '中文用户名 → 走中转目录'],
  ['D:\\我的软件\\Alcor\\resources\\alcor\\artifacts\\native\\', false, '中文安装目录 → 走中转目录'],
  ['C:\\' + 'x'.repeat(180) + '\\native\\', false, '超长路径 → 走中转目录'],
  ['C:\\Users\\dsj\\Downloads\\AlcorApp\\resources\\alcor\\artifacts\\native\\', true, '下载目录安装 → 直接注入']
];
for (const [dir, expectDirect, note] of cases) check('安装路径', note, ascii(dir) === expectDirect, ascii(dir) === expectDirect ? '符合预期' : '判定与预期不符');

/* 2. 系统与环境：只看判定码是否给出可执行建议 */
const envs = [
  ['Win10 22H2 普通权限 会话1', { compat: compat({ os: { version: '10.0.19045', arch: 'AMD64', is64: true } }) }, 'READY_TO_CONNECT'],
  ['Win11 23H2 HVCI 开启', { compat: compat({ flags: { ...compat().flags, hvci: true } }) }, 'READY_TO_CONNECT'],
  ['Win11 智能应用控制开启', { compat: compat({ flags: { ...compat().flags, smartAppControl: true } }) }, 'READY_TO_CONNECT'],
  ['Windows Server 无 VC++', { compat: compat({ flags: { ...compat().flags, hostArtifactMissing: true } }) }, 'HOST_RUNTIME_BROKEN'],
  ['注入器被删', { compat: compat({ flags: { ...compat().flags, loaderBroken: true } }) }, 'HOST_RUNTIME_BROKEN'],
  ['QQ 是管理员，Alcor 是普通', { compat: compat({ flags: { ...compat().flags, elevatedQQ: [1001] } }) }, 'ELEVATION_MISMATCH'],
  ['QQ 在另一个会话', { compat: compat({ flags: { ...compat().flags, foreignSession: [1001] } }) }, 'SESSION_MISMATCH'],
  ['32 位 QQ', { compat: compat({ flags: { ...compat().flags, archMismatch: [1001] } }) }, 'ARCH_MISMATCH'],
  ['QQ 没运行', { processes: [] }, 'NO_QQ_RUNNING'],
  ['有外来框架模块', { processes: [qq({ foreignModules: ['napcat.mjs'], supported: false, reason: 'FOREIGN_MODULES_PRESENT' })] }, 'FOREIGN_MODULES'],
  ['未登记构建（同系列）', { processes: [qq({ supported: false, reason: 'FAMILY_UNVERIFIED', version: '9.9.40-58000' })] }, 'QQ_BUILD_UNLISTED'],
  ['未登记构建（跨系列）', { processes: [qq({ supported: false, reason: 'UNSUPPORTED_BUILD', version: '9.9.99-1' })] }, 'QQ_BUILD_UNLISTED'],
  ['已连接', { connection: { connected: true, accountLastFour: '8295' }, backendReady: true }, 'ALREADY_CONNECTED']
];
for (const [name, input, expect] of envs) {
  const got = diagnoseQQ({ running: true, processes: input.processes ?? [qq()], compat: input.compat ?? compat(),
    connection: input.connection ?? null, backendReady: input.backendReady === true }).code;
  check('运行环境', name, got === expect, `期望 ${expect}，实际 ${got}`);
}

/* 3. 版本与补丁通道：0.3.1-as.N 必须比 0.3.1 新，否则老用户收不到小版本 */
check('更新通道', '0.3.1-as.1 > 0.3.1', compareVersion('0.3.1-as.1', '0.3.1') === 1);
check('更新通道', '0.3.1-as.2 > 0.3.1-as.1', compareVersion('0.3.1-as.2', '0.3.1-as.1') === 1);
check('更新通道', '0.3.2 > 0.3.1-as.9', compareVersion('0.3.2', '0.3.1-as.9') === 1);
check('更新通道', '0.3.1 > 0.3.0', compareVersion('0.3.1', '0.3.0') === 1);
check('更新通道', 'as 补丁算小版本', isPatchUpdate('0.3.1-as.1', '0.3.1') === true);
check('更新通道', '跨大版本不算补丁', isPatchUpdate('0.4.0', '0.3.1') === false);
check('更新通道', '清单接受 as 版本', (() => {
  try { normalizeManifest({ latest: '0.3.1-as.1', full: { urls: ['https://example.com/a.exe'], bytes: 10, sha256: 'a'.repeat(64), fileName: 'a.exe' } }); return true; }
  catch { return false; }
})());

/* 4. 下载兜底：模型给出的 URL 只认 https + 白名单 + exe */
const urls = filterRepairUrls([
  'https://github.com/Saevis0913/QQ_Alcor-Agent/releases/download/v0.3-latest/x.exe',
  'http://github.com/insecure/x.exe',
  'https://evil.example.com/x.exe',
  'https://ghfast.top/https://github.com/a/b.exe',
  'file:///C:/x.exe'
]);
check('下载兜底', '只留 https+白名单', urls.length === 2 && urls.every(u => u.startsWith('https://')), JSON.stringify(urls));

/* 5. PE 架构识别：x64 QQ 才注入 */
const selfExe = process.execPath;
const arch = peArchitecture(selfExe);
check('架构识别', '当前 node.exe 判为 x64', arch === 'x64', `实际 ${arch}`);
check('架构识别', '不存在路径不抛错', peArchitecture(path.join(APP, 'no-such-file.exe')) === null);

/* 输出 */
const failed = rows.filter(r => !r.pass);
let group = '';
for (const row of rows) {
  if (row.group !== group) { group = row.group; console.log(`\n[${group}]`); }
  console.log(`  ${row.pass ? '✓' : '✗'} ${row.name}${row.detail ? ' —— ' + row.detail : ''}`);
}
console.log(`\n共 ${rows.length} 项，通过 ${rows.length - failed.length} 项，失败 ${failed.length} 项。`);
process.exit(failed.length ? 1 : 0);
