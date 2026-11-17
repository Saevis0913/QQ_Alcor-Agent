// 〔启动 loading 壳 / 就绪体检 / 状态栏〕——M9 拆分第 2 段
'use strict';
// ── 状态栏 ──
async function refreshStatus() {
  try {
    state.status = await api('/api/status');
    const s = state.status;
    const dot = $('#onebot-dot');
    const label = $('#onebot-label');
    dot.className = 'dot ' + (s.onebot.connected ? 'dot-on' : (s.onebot.everConnected ? 'dot-wait' : 'dot-off'));
    // 未连接时展示后端诊断（2026-09-19）：区分「Alcor 没起 / 没登录账号 / 令牌不匹配」，
    // 不再让用户面对一句干巴巴的"未连接"猜原因。
    const account = s.onebot.self?.nickname || s.onebot.self?.userId;
    label.textContent = s.onebot.connected
      ? `Alcor 已连接${account ? `（${account}）` : ''}${s.alcor?.backendReady ? '' : ' · QQ 尚未就绪'}`
      : (s.onebot.diagnosis || 'OneBot 未连接');
    label.title = s.onebot.connected ? '' : (s.onebot.error || '');
    $('#model-label').textContent = `模型：${s.orchestrator.model || '未设置'}`;
    const u = s.usage;
    const c = s.cost;
    const costTxt = c && !['none', 'unmatched'].includes(c.source) ? `¥${c.cost.toFixed(3)}` : '—';
    const rateTxt = u.promptTokens > 0 ? `${Math.round(s.cacheHitRate * 100)}%` : '—';
    $('#usage-label').textContent = `今日 ${u.runs} 次运行 · ${fmtTokens(u.totalTokens)} · 缓存命中 ${rateTxt} · 估算 ${costTxt}`;
    $('#usage-label').title = '底栏用当前模型的单价估算今日费用。查看「用量」可按实际调用的模型统计。';
    $('#search-count-label').textContent = `今日联网：${s.webSearchCount ?? u.webSearchCount ?? 0} 次`;
    state.paused = s.paused;
    state.pauseReason = s.pauseReason;
    state.dataDir = s.dataDir || '';
    $('#pause-btn').textContent = state.paused ? '恢复' : '暂停';
    renderBanner();
    updateReadinessDots(s);
  } catch (e) { /* 忽略瞬时错误 */ }
}

/** 更新就绪进度指示器（4 圆点） */
function updateReadinessDots(s) {
  const dots = $$('#readiness-dots .rdot');
  if (dots.length !== 4) return;

  const standard = s?.onebotEdition;
  const qqRunning = !!s?.alcor?.backendReady;
  const slRunning = !!s?.alcor?.running;
  const connectionConfigured = Boolean(standard ? standard.httpUrl && standard.wsUrl : slRunning);
  const obConnected = !!s?.onebot?.connected;
  const cfg = state.config || {};
  const cfgReady = !!(cfg.api?.baseUrl && cfg.api?.model && (cfg.allow?.groups?.length || cfg.allow?.private?.length || cfg.allowAllWhenEmpty));

  // 圆点 0：QQ 内核
  dots[0].className = 'rdot' + (qqRunning ? ' on' : '');
  dots[0].title = qqRunning ? 'QQ 后端账号在线' : 'QQ 后端尚未就绪（点击查看登录说明）';

  // 圆点 1：Alcor
  dots[1].className = 'rdot' + (connectionConfigured ? ' on' : '');
  if (standard) dots[1].title = connectionConfigured ? 'OneBot 地址已配置' : 'OneBot 地址待配置（点击前往设置）';
  else dots[1].title = slRunning ? 'Alcor 运行中' : 'Alcor 未运行（点击前往启动）';

  // 圆点 2：OneBot
  dots[2].className = 'rdot' + (obConnected ? ' on' : (connectionConfigured ? ' wait' : ''));
  dots[2].title = obConnected ? 'OneBot 已连接' : (s?.onebot?.diagnosis || (connectionConfigured ? 'OneBot 连接中…' : 'OneBot 未连接'));

  // 圆点 3：配置完成
  dots[3].className = 'rdot' + (cfgReady ? ' on' : '');
  dots[3].title = cfgReady ? '配置已完成' : '配置未完成（点击前往设置）';
  dots.forEach((dot) => dot.setAttribute('aria-label', dot.title));
}

// 就绪圆点点击跳转
$$('#readiness-dots .rdot').forEach((dot) => {
  dot.addEventListener('click', () => {
    const target = dot.dataset.target;
    if (target === 'alcor') switchTab('alcor');
    else if (target === 'settings') switchTab('settings');
  });
});

function fmtTokens(n) {
  n = Number(n) || 0;
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万 token` : `${n} token`;
}

$('#pause-btn').addEventListener('click', async () => {
  if (state.paused) {
    await resumePause({ skipBacklog: false });
  } else {
    await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: true }) });
    refreshStatus();
  }
});

// ── 会话渲染合批 ──
// 运行中的会话 SSE 事件非常密：每轮"正在思考…"开/关两次 + 每个工具调用一次。
// 曾经来一条事件就全量重建一次会话列表 + 会话详情（含大提示词的 esc/innerHTML），
// 主线程被反复长阻塞，详情内容反而"更新缓慢"、还伴随滚动跳动。
// 现在：patch 立即进 state（数据不延迟），渲染合并到短定时器一次；
// 窗口内的多次事件只渲染最终状态（中间的 activity 翻转根本不必上屏）。
//
// ⚠️ 用 setTimeout 而不是 requestAnimationFrame：
//    窗口被遮挡/最小化时 Chromium 会完全停发 rAF，渲染全部积压到切回前台
//    才一次性出现 —— 用户看到的就是"不手动刷新就不更新"。
//    setTimeout 在后台页面仍会执行（最多被节流到 1s），远比不执行强。
const pendingSessionDetail = new Map();   // sessionId -> 合并后的 patch
let sessionRenderScheduled = false;

function scheduleSessionRender() {
  if (sessionRenderScheduled) return;
  sessionRenderScheduled = true;
  setTimeout(() => {
    sessionRenderScheduled = false;
    if (state.tab === 'sessions') renderSessionList();
    const id = state.currentSessionId;
    const patch = id ? pendingSessionDetail.get(id) : null;
    pendingSessionDetail.clear();
    if (patch && state.tab === 'sessions') {
      // 详情用事件里的消息流渲染：HTTP 详情（systemPrompt 等）打底，SSE patch 覆盖动态字段。
      // sent/finishReason 等收尾字段 patch 优先 —— 它们走 SSE 实时推，HTTP 详情里的是旧值。
      renderSessionDetail({
        ...(state.sessionDetail || {}),
        ...patch,
        triggerSummary: patch.triggerSummary ?? state.sessionDetail?.triggerSummary ?? '',
        systemPrompt: state.sessionDetail?.systemPrompt ?? '',
        userPrompt: state.sessionDetail?.userPrompt ?? '',
        sent: patch.sent ?? state.sessionDetail?.sent ?? [],
        error: patch.error !== undefined ? patch.error : (state.sessionDetail?.error ?? null),
        finishReason: patch.finishReason ?? state.sessionDetail?.finishReason ?? null,
        endedAt: patch.endedAt ?? state.sessionDetail?.endedAt ?? null
      });
    }
  }, 80);
}
