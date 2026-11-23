import { setTimeout as delay } from 'node:timers/promises';

// Electron's bundled Node does not expose TestContext.waitFor.
export async function waitFor(assertion, { timeout = 3000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try { return await assertion(); }
    catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await delay(interval);
  }
}
