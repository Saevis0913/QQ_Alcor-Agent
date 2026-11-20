'use strict';
/**
 * 首启「进程注入可行性检测」。
 *
 * 只做两件事：把本机条件查清楚、把能自动修的项目当场修掉。
 * 检测本身是只读的（不注入、不启动 QQ、不改功能配置）。
 */
const INJECTION_STATUS_TEXT = { ok: '通过', fixable: '可自动修复', manual: '需要你处理', optional: '提示' };

function injectionItemHtml(item) {
  const status = INJECTION_STATUS_TEXT[item.status] || item.status;
  const fixable = item.fix && item.status !== 'ok';
  return `<li class="inject-item inject-${esc(item.status)}" data-inject-id="${esc(item.id)}">
    <span class="inject-mark" aria-hidden="true"></span>
    <div class="inject-body">
      <div class="inject-line"><strong>${esc(item.label)}</strong><span class="inject-status">${esc(status)}</span></div>
      <p class="inject-detail">${esc(item.detail)}</p>
    </div>
    ${fixable ? `<button class="btn btn-small" data-inject-fix="${esc(item.fix)}" data-inject-item="${esc(item.id)}">自动修复</button>` : ''}
  </li>`;
}

function injectionListHtml(result) {
  const items = Array.isArray(result?.items) ? result.items : [];
  const summary = result?.summary || {};
  return `<div class="inject-summary">通过 ${summary.ok || 0} · 可自动修复 ${summary.fixable || 0} · 需要你处理 ${summary.manual || 0} · 提示 ${summary.optional || 0}</div>
    <ul class="inject-list">${items.map(injectionItemHtml).join('')}</ul>`;
}

async function showInjectionCheck({ firstRun = false } = {}) {
  if (document.querySelector('#injection-check')) return;
  const modal = modelModalShell({
    head: '进程注入可行性检测',
    body: `<p class="inject-lead"><strong>推荐进行进程注入可行性检测，请确认</strong></p>
      <p class="hint">检测只读取本机信息：系统版本、QQ 进程、注入器与宿主组件、运行库、权限与会话、安全策略。不会注入 QQ，也不会改动你的聊天记录与设置。</p>
      <div id="injection-check" aria-live="polite"><p class="hint">点「开始检测」后大约需要几秒。</p></div>`,
    foot: `<span id="injection-check-status" class="hint" role="status"></span>
      <button class="btn btn-primary" id="injection-check-run">开始检测</button>
      <button class="btn" id="injection-check-later">稍后</button>`
  });
  modal.classList.add('injection-overlay');
  const body = modal.querySelector('#injection-check');
  const runBtn = modal.querySelector('#injection-check-run');
  const laterBtn = modal.querySelector('#injection-check-later');
  const statusLine = modal.querySelector('#injection-check-status');
  let lastResult = null;

  const markSeen = () => api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { injectionCheckSeen: true } }) }).catch(() => {});

  async function run() {
    runBtn.disabled = true; laterBtn.textContent = '关闭';
    statusLine.textContent = '正在检测…';
    body.innerHTML = '<p class="hint">正在读取系统、QQ 进程与注入组件…</p>';
    try {
      const res = await api('/api/injection-check');
      lastResult = res?.data || res;
      body.innerHTML = injectionListHtml(lastResult);
      const s = lastResult?.summary || {};
      statusLine.textContent = (s.fixable || s.manual) ? `${(s.fixable || 0) + (s.manual || 0)} 项需要处理` : '检测通过';
      runBtn.textContent = '重新检测';
      ensureReportButton();
    } catch (error) {
      body.innerHTML = `<p class="inject-fail">[INJECTION_CHECK_FAILED] 检测没跑完：${esc(error?.message || error)}</p>
        <p class="hint">可以先按「关闭」，在设置 → 连接与桌面 → QQ 接入里用排查程序确认。</p>`;
      statusLine.textContent = '检测未完成';
      runBtn.textContent = '重新检测';
    } finally {
      runBtn.disabled = false;
    }
  }

  function ensureReportButton() {
    if (modal.querySelector('#injection-check-copy')) return;
    const copy = document.createElement('button');
    copy.className = 'btn'; copy.id = 'injection-check-copy'; copy.textContent = '复制报告';
    copy.onclick = async () => {
      const text = lastResult?.text || '';
      try { await navigator.clipboard.writeText(text); statusLine.textContent = '报告已复制'; }
      catch { statusLine.textContent = '复制失败，请截图'; }
    };
    laterBtn.before(copy);
  }

  body.addEventListener('click', async event => {
    const button = event.target.closest('[data-inject-fix]');
    if (!button) return;
    const fixId = button.dataset.injectFix;
    button.disabled = true; button.textContent = '修复中…';
    statusLine.textContent = '正在修复…（下载安装包时可能要一会儿）';
    try {
      const res = await api('/api/injection-check/fix', { method: 'POST', body: JSON.stringify({ id: fixId }) });
      const data = res?.data || res;
      statusLine.textContent = data?.ok ? `已修复：${data.message}` : `没能自动修：${data?.message || '未知原因'}`;
      await run();
    } catch (error) {
      button.disabled = false; button.textContent = '自动修复';
      statusLine.textContent = `修复失败：${error?.message || error}`;
    }
  });

  runBtn.onclick = () => { markSeen(); run(); };
  laterBtn.onclick = () => { markSeen(); closeModelModal(modal); };
  if (firstRun) statusLine.textContent = '建议先检测一次，之后再登录 QQ 连接。';
}

window.showInjectionCheck = showInjectionCheck;
