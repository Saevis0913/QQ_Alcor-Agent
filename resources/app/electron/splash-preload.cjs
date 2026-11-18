// 开屏动画窗口的 preload：只暴露一个「我可以关掉了」的信号。
// 用 CommonJS，与主 preload 保持一致（避免 ESM preload 的版本差异）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splashShell', {
  done: () => {
    try { ipcRenderer.send('splash-done'); } catch { /* ignore */ }
  }
});
