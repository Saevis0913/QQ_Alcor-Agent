import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_AGE = 24 * 60 * 60 * 1000;
const AUTH_DOMAINS = { p_uin: ['qzone.qq.com', 'user.qzone.qq.com'], p_skey: ['qzone.qq.com', 'user.qzone.qq.com'], uin: ['qq.com'], skey: ['qq.com'] };

export function isQzoneAuthCookie(cookie) {
  return Object.hasOwn(AUTH_DOMAINS, cookie?.name) && AUTH_DOMAINS[cookie.name].includes(cookie.domain?.replace(/^\./, ''))
    && cookie.path === '/' && typeof cookie.value === 'string' && cookie.value.length > 0 && cookie.value.length <= 4096;
}

export function createQzoneSessionStore({ dataDir, safeStorage, partition, now = Date.now }) {
  const file = path.join(dataDir, 'qzone', 'session.bin');
  const clear = async () => { await fs.rm(file, { force: true }); };

  async function save(account, cookies) {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const sessionCookies = cookies.filter((cookie) => isQzoneAuthCookie(cookie) && cookie.session === true)
      .map(({ name, value, domain, hostOnly, path, secure, httpOnly, sameSite }) => ({ name, value, domain, hostOnly, path, secure, httpOnly, sameSite }));
    if (!sessionCookies.length) { await clear(); return true; }
    const encrypted = safeStorage.encryptString(JSON.stringify({ version: 1, account, savedAt: now(), cookies: sessionCookies }));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, encrypted);
    await fs.rename(`${file}.tmp`, file);
    return true;
  }

  async function restore(expectedAccount) {
    if (!expectedAccount || !safeStorage.isEncryptionAvailable()) return false;
    try {
      if ((await fs.stat(file)).size > 64 * 1024) { await clear(); return false; }
      const stored = JSON.parse(safeStorage.decryptString(await fs.readFile(file)));
      const age = now() - stored.savedAt;
      if (stored.version !== 1 || stored.account !== expectedAccount || !Number.isFinite(age) || age < 0 || age >= MAX_AGE ||
          !Array.isArray(stored.cookies) || stored.cookies.length > 8 || !stored.cookies.every(isQzoneAuthCookie)) {
        await clear();
        return false;
      }
      for (const cookie of stored.cookies) {
        const domain = cookie.domain.replace(/^\./, '');
        await partition.cookies.set({
          url: `https://${domain}/`, name: cookie.name, value: cookie.value,
          ...(cookie.hostOnly === true ? {} : { domain: cookie.domain }),
          path: '/', secure: cookie.secure === true, httpOnly: cookie.httpOnly === true, sameSite: cookie.sameSite
        });
      }
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') await clear().catch(() => {});
      return false;
    }
  }

  return { save, restore, clear };
}
