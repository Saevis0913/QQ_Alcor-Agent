// 进程单实例锁：确保同一数据目录下只有一个 Alcor Agent 核心在跑。
//
// 为什么需要（Electron 的 requestSingleInstanceLock 管不到的场景）：
//   - Electron 桌面端 + `npm run server` headless 同时启动 → 两份核心
//   - 双击 .bat 又手动 node src/server.js → 两份核心
//   两份核心会双份连 Alcor、双份处理群消息 → 群里看到重复回复。
//
// 原理：在数据目录放一个 alcor-agent.lock 文件，内容 = PID。
//   启动时若锁文件存在且对应进程仍活着 → 判定已有实例，拒绝启动；
//   锁文件存在但进程已死（上次异常退出残留）→ 抢占锁，继续启动。
//   正常退出 / 被 kill 时删除锁文件。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA_DIR } from './config.js';

const LOCK_FILE = path.join(DATA_DIR, 'alcor-agent.lock');

/** 进程是否还活着（Windows / POSIX 通用：signal 0 不杀进程，只探测）。 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但无权发信号（别的用户），也算活着
    return error?.code === 'EPERM';
  }
}

/**
 * 这个 PID 现在还是不是 Alcor Agent（Electron 主进程或 headless node）？
 *
 * 只看"进程还活着"是不够的：Windows 会回收 PID，上次被强杀留下的锁文件里那个
 * PID 可能已经被 svchost.exe 之类的系统进程用掉 —— 于是每次启动都报
 * 「已有实例在运行（PID 2936）」，永远起不来（2026-11-19 实际踩到）。
 *
 * @returns {true|false|null} true=确实是 Alcor，false=已被别的进程占用，null=查不出来
 */
function pidIsAlcor(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        timeout: 4000,
        windowsHide: true,
      });
      const first = String(out).split('\n').map((line) => line.trim()).find((line) => line.startsWith('"'));
      if (!first) return null;
      const name = (first.match(/^"([^"]+)"/)?.[1] ?? '').toLowerCase();
      if (!name) return null;
      return /^(alcor agent|alcor|node)\.exe$/.test(name);
    }
    // POSIX：优先读 /proc，读不到再问 ps
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\u0000/g, ' ');
      if (cmdline.trim()) return /alcor|node/i.test(cmdline);
    } catch { /* 非 Linux 或没权限，走 ps */ }
    try {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 4000 });
      const cmd = String(out).trim();
      return cmd ? /alcor|node/i.test(cmd) : null;
    } catch { return null; }
  } catch {
    return null;
  }
}

/**
 * 尝试获取单实例锁。
 *
 * 用 `wx`（O_CREAT|O_EXCL）原子创建锁文件：文件已存在则创建失败，
 * 这是唯一能真正防"两个进程同时通过检查、都以为自己拿到锁"的机制。
 * 存在时再读 PID 判断是活锁（拒绝）还是残留锁（删除后重试一次）。
 *
 * @returns {{ ok: boolean, reason?: string, existingPid?: number }}
 */
export function acquireInstanceLock() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch { /* 忽略，下面写文件会再试 */ }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // wx：仅当文件不存在时创建，已存在则抛 EEXIST —— 原子操作，无竞态窗口
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
      return { ok: true };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { ok: false, reason: `无法写入实例锁文件：${error?.message ?? error}` };
      }
      // 锁文件已存在：读 PID 判断是否活锁
      let existingPid = null;
      try {
        existingPid = Number(String(fs.readFileSync(LOCK_FILE, 'utf8')).trim()) || null;
      } catch { /* 读不出就当残留 */ }
      if (existingPid && existingPid !== process.pid && pidAlive(existingPid)) {
        const identity = pidIsAlcor(existingPid);
        if (identity === true) {
          return { ok: false, reason: `已有 Alcor Agent 实例在运行（PID ${existingPid}）`, existingPid };
        }
        if (identity === null) {
          // 查不出身份时保守处理：宁可拒绝启动，也不能双开重复回复。
          return {
            ok: false,
            reason: `检测到锁文件记录的进程（PID ${existingPid}）仍在运行但无法确认身份；若不是 Alcor Agent，请删除 ${LOCK_FILE} 后重试`,
            existingPid,
          };
        }
        // identity === false：PID 已被系统回收给别的进程，这是残留锁，继续走清理分支。
      }
      // 残留锁（进程已死 / 锁是自己上次异常留下的）：删掉，下一轮用 wx 重新抢
      try { fs.unlinkSync(LOCK_FILE); } catch { /* 删不掉则下一轮 wx 仍 EEXIST，最终报错 */ }
    }
  }
  return { ok: false, reason: '实例锁被占用且无法清除（可能有实例正在启动）' };
}

/** 释放单实例锁（正常退出时调用）。 */
export function releaseInstanceLock() {
  try {
    // 只删自己的锁：万一锁被新实例抢走了，不能误删
    const content = String(fs.readFileSync(LOCK_FILE, 'utf8')).trim();
    if (Number(content) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch { /* 文件不存在/读不出都无所谓 */ }
}

/** 注册退出时自动释放锁（SIGINT/SIGTERM/正常 exit）。 */
export function registerLockCleanup() {
  const cleanup = () => releaseInstanceLock();
  // 锁的**唯一**释放时机是 'exit' 钩子：SIGINT 时立即释放会让优雅退出
  //（server.js 的 await app.stop()，可能数秒）期间新实例抢先拿锁、
  // 与旧实例短暂并存（双核心 = 群里重复回复）。交给 exit 钩子则天然
  // 排在进程真正结束之后，无竞态窗口。
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      // ⚠️ 不做任何事：不退出、不提前释放锁 —— 优雅退出 handler
      //   （server.js / electron）紧随其后执行，最终 process.exit 触发
      //   上面的 'exit' 钩子释放锁。
      // 保险丝：若 30 秒内没有别的 handler 退出进程（异常场景，优雅退出
      // 挂死），强制退出 —— 用非零码，让外层（守护脚本）能识别异常退出。
      const fuse = setTimeout(() => process.exit(1), 30000);
      fuse.unref?.();
    });
  }
}
