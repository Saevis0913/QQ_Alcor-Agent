import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = DAY / 24;

// The desktop owns an exclusive lock on its data profile. Reserve synchronously
// before starting HTTP so another chat callback cannot slip between these steps.
export class PendingMessageSends {
  constructor(directory) {
    this.directory = directory;
    this.active = new Set();
    this.nextCleanup = 0;
  }

  #removeExpired(key, now) {
    if (this.active.has(key)) return;
    const file = path.join(this.directory, key);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat?.isFile() && now - stat.mtimeMs >= DAY) fs.unlinkSync(file);
  }

  async run(selfId, kind, target, segments, send) {
    const serialized = JSON.stringify([selfId, kind, target, segments], (_name, value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
    });
    const key = createHash('sha256').update(serialized).digest('hex');
    const file = path.join(this.directory, key);
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      const now = Date.now();
      if (now >= this.nextCleanup) {
        this.nextCleanup = now + HOUR;
        try {
          for (const name of fs.readdirSync(this.directory)) {
            if (name !== key && /^[0-9a-f]{64}$/.test(name)) this.#removeExpired(name, now);
          }
        } catch (error) {
          console.warn('[onebot] 稍后清理过期发送记录', error.code);
        }
      }
      this.#removeExpired(key, now);
      fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code === 'EEXIST' && error.path === file) {
        throw Object.assign(new Error('同一账号和会话的这条消息仍待核对，已阻止重复发送。'),
          { code: 'SEND_RECEIPT_PENDING', delivery: 'unknown', nonretryable: true });
      }
      throw Object.assign(new Error('无法写入发送记录，本次消息尚未提交。', { cause: error }),
        { code: 'SEND_RECEIPT_STORE_UNAVAILABLE', nonretryable: true });
    }

    this.active.add(key);
    let uncertain = false;
    try { return await send(); }
    catch (error) { uncertain = error?.delivery === 'unknown'; throw error; }
    finally {
      this.active.delete(key);
      if (!uncertain) {
        try { fs.unlinkSync(file); }
        catch (error) { console.warn('[onebot] 清理发送记录失败', error.code); }
      }
    }
  }
}
