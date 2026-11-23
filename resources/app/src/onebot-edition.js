// 接入方式切换：内置核心（原生注入） ⇄ OneBot 进程外接入。
//
// 两套接入方式的开关不是一个配置项，而是安装目录里的一个标记文件：
// resources/app/onebot-edition.json —— app.js 用 isStandardEdition() 判它。
// 之所以仍然走文件：安装包/逆向者都能改 config.json，标记文件才是「这台机器装的是哪种版本」
// 的唯一事实来源；这里只负责把它做成用户点一下就能完成的事。
//
// 原生注入在一部分机器上注定拿不到 QQ 的消息服务对象（service_global 恒 0、
// get_service 绑在线程局部存储上），那种机器只能走 OneBot。界面上按诊断码
// IDENTITY_SERVICE_UNBOUND 给出这个入口，别让用户自己去翻文件。

import fs from 'node:fs';
import path from 'node:path';
import { normalizeStandardConnection } from './standard-connection.js';
import { editionMarkerPath as markerPathOf } from './environment-check.mjs';

export const ONEBOT_EDITION_MARKER = 'onebot-edition.json';

// 路径判定只有一处：environment-check 既给 isStandardEdition 用，也给这里用。
export const editionMarkerPath = markerPathOf;

export function onebotEditionEnabled(installRoot) {
  try { return fs.existsSync(editionMarkerPath(installRoot)); } catch { return false; }
}

// 连接设置必须指向本机别的端口：指回 Agent 自己会形成自环，normalizeStandardConnection
// 只管地址格式，端口冲突要在知道本进程端口的地方判。
export function connectionHitsPort(connection, port) {
  if (!port) return false;
  for (const value of [connection?.httpUrl, connection?.wsUrl]) {
    if (!value) continue;
    try { if (Number(new URL(value).port) === Number(port)) return true; } catch { /* 地址已由 normalize 校验 */ }
  }
  return false;
}

export function readEditionRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('接入设置格式无效。');
  return normalizeStandardConnection(body);
}

export function enableOneBotEdition({ installRoot, connection, now = new Date().toISOString() }) {
  if (!connection?.httpUrl || !connection?.wsUrl) throw new Error('OneBot 接入需要 HTTP 与 WebSocket 两个本机地址。');
  const marker = editionMarkerPath(installRoot);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  // switchedInPlace：这是用户在已装好的内置核心版里点的切换，不是「标准版安装包」。
  // environment-check 的 ONEBOT_SEPARATE_DIRECTORY 只放行带这个标记的目录。
  fs.writeFileSync(marker, JSON.stringify({ edition: 'onebot', switchedInPlace: true, enabledAt: now,
    httpUrl: connection.httpUrl, wsUrl: connection.wsUrl }, null, 2) + '\n', 'utf8');
  return { marker, enabledAt: now };
}

export function disableOneBotEdition({ installRoot }) {
  const marker = editionMarkerPath(installRoot);
  try { fs.unlinkSync(marker); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return { marker };
}
