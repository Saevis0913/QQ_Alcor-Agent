// 〔设置渲染 / 模型目录 / 技能插件页〕——M9 拆分第 7 段
'use strict';
// ── 模型目录（多提供商；面板式选择 + 图片输入能力徽标） ──
function visionBadge(providerId, model) {
  const r = (state.visionResults || {})[`${providerId}|||${model}`];
  const src = r?.source === 'docs' ? '官方资料' : (r?.source === 'probe' ? '在线探测' : '');
  const show = state.config?.ui?.showVision !== false;
  const t = (cls, text) => `<span class="vbadge ${cls}" style="${show ? '' : 'display:none'}" title="${esc((src ? `【${src}】` : '') + (r?.note || ''))}">${text}</span>`;
  if (!r) return t('unk', '未检测');
  if (r.verdict === 'vision') return t('ok', '支持图片输入');
  if (r.verdict === 'no-vision') return t('no', '不支持图片输入');
  return t('unk', '无法判定');
}

/** 左右开关（.switch）：设置页统一勾选形态。 */
function switchHtml(id, checked, label, extra = '') {
  return `<label class="switch"${extra ? ` ${extra}` : ''}>
    <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} />
    <span class="track"><span class="thumb"></span></span>
    <span>${label}</span>
  </label>`;
}

// ── 两栏悬停下拉：左供应商 / 右模型 ──
function visionVerdictOf(providerId, model) {
  return (state.visionResults || {})[`${providerId}|||${model}`]?.verdict;
}

// 说明：这里曾经有一个 bindModelDdDismiss()，目标是 #model-dd / #model-pick-btn，
// 但真正的模型选择控件 id 是 #cfg-model-pick / #cfg-model（记忆页是 #cfg-mem-model-pick），
// 那两个 id 全项目从未被创建过 —— 函数也从未被调用，属于纯死代码，已删除。
// 若将来需要一个"点击外部/Esc 收起目录"的通用行为，请在 modelModalShell 里统一实现。




// 设置分区按「同类合并」归成五栏：一个栏目里并排放同类选项，切换一次看到一组。
const SETTINGS_GROUPS = [
  { id: 'model', label: '模型与联网', sub: '模型 · 联网搜索', items: ['api', 'search'] },
  { id: 'chat', label: '聊天与人格', sub: '人设 · 白名单 · 聊天', items: ['persona', 'admins', 'allow', 'chat'] },
  { id: 'memory', label: '记忆', sub: '长期记忆', items: ['memory'] },
  { id: 'connect', label: '连接与桌面', sub: 'OneBot · 桌面端', items: ['onebot', 'qzone', 'desktop'] },
  { id: 'extend', label: '扩展', sub: '工具与技能', items: ['tools'] }
];
const SECTION_TO_GROUP = new Map(SETTINGS_GROUPS.flatMap((g) => g.items.map((i) => [i, g.id])));
const VSCODE_GROUP_IDS = new Set(SETTINGS_GROUPS.map((g) => g.id));
// 旧代码经常直接把 settingsSection 设成 'api' / 'allow' / 'desktop'，这里统一归到所属栏目，
// 同时把「想直接跳到哪一块」留给调用方（renderSettings 用 settingsFocus 滚动到位）。
function settingsGroupOf(section) {
  if (VSCODE_GROUP_IDS.has(section)) return section;
  return SECTION_TO_GROUP.get(section) || 'model';
}

function renderSettingsSidebar() {
  const s = state.status;
  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;
  const activeGroup = settingsGroupOf(state.settingsSection);
  sidebar.innerHTML = `
    <div class="settings-runstate">
      <div class="rs-title">QQ 接入状态</div>
      <div class="rs-row"><span class="dot ${s?.onebot?.connected ? 'dot-on' : 'dot-off'}"></span><span>${s?.onebot?.connected ? 'OneBot 已连接' : 'OneBot 未连接'}</span></div>
      <div class="rs-row muted">${state.paused ? '已暂停' : (s?.orchestrator?.model ? `模型：${esc(s.orchestrator.model)}` : '模型：未设置')}</div>
    </div>
    <div class="settings-menu">
      ${SETTINGS_GROUPS.map((g) => `<button class="settings-menu-item ${activeGroup === g.id ? 'active' : ''}" data-section="${g.id}"><span class="smi-label">${g.label}${g.id === 'connect' && (typeof updateAvailable !== 'undefined' && updateAvailable) ? '<span class="update-dot" title="发现新版本"></span>' : ''}</span><span class="smi-sub">${g.sub}</span></button>`).join('')}
      <button class="settings-menu-item egg-hot" id="qrcode-egg-btn">群二维码</button>
    </div>`;
  // 群二维码彩蛋：点一下弹出，再点屏幕任意位置关闭
  // 图片 onerror 兜底：group-qrcode.jpg 正常随 ui/ 分发，
  // 万一分发包缺了这张图，显示一句说明而不是一个裂图图标。
  sidebar.querySelector('#qrcode-egg-btn')?.addEventListener('click', () => {
    const ov = document.createElement('div');
    ov.className = 'qrcode-egg-overlay';
    ov.innerHTML = '<img src="group-qrcode.jpg" alt="群二维码" '
      + 'onerror="this.remove(); this.parentElement?.insertAdjacentText(\'afterbegin\', \'群二维码图片未随应用提供\')" />';
    const close = () => closeAnimatedOverlay(ov);
    ov.addEventListener('click', close);
    document.body.appendChild(ov);
  });
  sidebar.querySelectorAll('.settings-menu-item').forEach((el) => {
    el.addEventListener('click', () => {
      // 切区块 = 整页表单重建：先把防抖窗口内挂起的保存发出，
      // 否则刚输入的内容直接被重渲染吹掉（与切页签同一条防线）。
      flushSettingsSaves();
      state.settingsSection = el.dataset.section;
      renderSettingsSidebar();
      renderSettings();
      // 切设置分区 = 整页表单重建：新内容淡入（对齐 concept2 的 pane 切换）
      uiEnter($('#settings-form'));
    });
  });
}

function renderSettings() {
  // 渲染守卫：自动保存进行中（表单正在被读取 / state.config 即将被覆盖）时
  // 不允许重建表单 DOM —— 会吹掉用户正在输入的未保存内容。
  // 拦下的请求由 endSettingsGuard() 在保存完成后补放。
  if (settingsGuard.pending > 0) {
    settingsGuard.needRerender = true;
    return;
  }
  // 焦点保护（2026-09-19 修"文本框偶发点不进/失焦"）：守卫只护住"保存进行中"的
  // 窗口，但守卫之外仍有一批异步重渲染（群名补底 / 视觉扫描完成 / 技能开关保存 /
  // 守卫补放的延迟渲染）会在用户打字途中重建 innerHTML —— 焦点、光标位置、
  // 未落盘的输入值全部被吹掉。这里在重建前后做"焦点与选区快照恢复"：
  //   ① 记下正在聚焦的输入框 id + 光标位置 + 当前值；
  //   ② 重建后按 id 找回元素，把值写回（渲染用的是 state.config，可能还没
  //      带上防抖窗口内的输入），恢复焦点与光标。
  const box = $('#settings-form');
  // 滚动位置保持：innerHTML 重建会把阅读位置弹回顶部（也是一次大滚动跳转，
  // 会加剧深滚动下的合成错位）。重建后原样恢复。
  const prevScrollTop = box ? box.scrollTop : 0;
  const focusSnap = (() => {
    const el = document.activeElement;
    if (!box || !el || el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT') return null;
    if (el.type === 'checkbox' || el.type === 'radio' || !box.contains(el)) return null;
    return {
      id: el.id,
      selStart: el.selectionStart ?? null,
      selEnd: el.selectionEnd ?? null,
      value: el.value
    };
  })();
  const c = state.config;
  const requestedSection = state.settingsSection;
  renderSettingsSidebar();
  try {
    box.innerHTML = `
    ${renderSettingsSection(c)}`;
    // 先折叠收纳再绑事件：autoFold 会搬 DOM，但节点上的监听会跟着节点走；
    // 挂在 #settings-form 上的委托不受影响。放后面绑定则能找到最终结构。
    if (typeof enhanceConcept2UI === 'function') enhanceConcept2UI(box);
    bindSettingsEvents(c);
    if (state.settingsSection === 'qzone') mountQzoneSettings();
    if (box && prevScrollTop) box.scrollTop = prevScrollTop;
  } catch (err) {
    // 单个设置区渲染失败不能让整页空白 —— 显示错误占位，其余页签仍可用
    console.error('[settings] 渲染失败:', err);
    box.innerHTML = `<div class="empty-hint">设置页渲染失败：${esc(err?.message || err)}<br />可切换其它页签，或刷新后重试。</div>`;
    return;
  }
  if (focusSnap?.id) {
    const back = box.querySelector('#' + focusSnap.id);
    if (back && (back.tagName === 'INPUT' || back.tagName === 'TEXTAREA')) {
      try {
        if (typeof setCardExpanded === 'function') setCardExpanded(back.closest('.setcard.fold'), true);
        back.value = focusSnap.value;   // 覆盖渲染值：防抖窗口内的输入不被回滚
        if (focusSnap.selStart != null) back.setSelectionRange(focusSnap.selStart, focusSnap.selEnd ?? focusSnap.selStart);
        back.focus({ preventScroll: true });
      } catch { /* 恢复失败不致命 */ }
    }
  }
  // 一次性滚动定位：从别的页跳进「聊天白名单」「桌面端」这类细分项时，
  // 直接滚到那一块，而不是停在栏目顶部让人自己找。
  if (requestedSection && requestedSection !== settingsGroupOf(requestedSection) && box) {
    const target = box.querySelector('[data-block="' + requestedSection + '"]');
    if (target) target.scrollIntoView({ block: 'start', behavior: 'auto' });
  }
  // 群名补底（一次性）：分群按钮/自动回复策略下拉第一次渲染时 state.chats 可能还没到
  // （switchTab 只在列表为空时才拉）。这里发现为空就补拉，到达后重渲染一次。
  if (!(state.chats || []).length && !renderSettings.__chatsFetch) {
    renderSettings.__chatsFetch = true;
    api('/api/chats').then((d) => {
      if ((d.chats || []).length && state.tab === 'settings') renderSettings();
    }).catch(() => {}).finally(() => { renderSettings.__chatsFetch = false; });
  }
}

function renderSettingsSection(c) {
  const sections = {
    api: () => renderApiSection(c),
    search: () => renderSearchSection(c),
    memory: () => renderMemorySettingsSection(c),
    persona: () => renderPersonaSection(c),
    admins: () => renderAdminsSection(c),
    allow: () => renderAllowSection(c),
    chat: () => renderChatSection(c),
    qzone: () => renderQzoneSettings(),
    desktop: () => renderDesktopSection(c),
    onebot: () => renderOnebotSection(c),
    tools: () => renderToolsSection(c)
  };
  const group = SETTINGS_GROUPS.find((g) => g.id === settingsGroupOf(state.settingsSection)) || SETTINGS_GROUPS[0];
  return group.items.map((id) => {
    const render = sections[id] || sections.api;
    return `<section class="settings-block" data-block="${id}">${render()}</section>`;
  }).join('');
}
function renderApiSection(c) {
  const currentProvider = (state.providers || []).find((p) => p.id === c.api.provider);
  const currentModelDisplay = (currentProvider?.modelNames || {})[c.api.model] || c.api.model;
  // 专用模型的显示名：跨提供商选择时也能读出目录名（找不到就显示裸 id）
  const displayOf = (modelId) => {
    const m = String(modelId || '').trim();
    if (!m) return '';
    for (const p of (state.providers || [])) {
      if ((p.modelNames || {})[m]) return `${p.modelNames[m]}`;
    }
    return m;
  };
  const visionModelDisplay = displayOf(c.api.visionModel);
  const videoModelDisplay = displayOf(c.api.videoModel);
  const sc = (typeof setCard === 'function') ? setCard : (o) => `<div class="setcard">${o.body}</div>`;
  return `
    <h3 id="settings-api">模型 API</h3>
    ${sc({
      id: 'card-api-model',
      icon: '🔑',
      title: '模型与提供商',
      sub: '当前聊天模型与 API 地址',
      val: esc(c.api.model || '未选择模型'),
      open: true,
      body: `
    <div class="field">
      <div class="api-console">
        <div class="ac-main">
          <p class="ac-label">当前聊天模型</p>
          <p class="ac-model">${esc(c.api.model || '未选择模型')}</p>
          <p class="ac-meta">${currentProvider ? esc(currentProvider.displayName) + ' · ' + esc(currentProvider.baseURL) : '尚未选择提供商'}</p>
          <div class="ac-flags">
            <span class="ac-flag ${currentProvider && currentProvider.hasKey ? 'is-ok' : 'is-warn'}">${currentProvider && currentProvider.hasKey ? 'API Key 已保存' : 'API Key 未保存'}</span>
            <span class="ac-flag ${visionModelDisplay ? 'is-ok' : 'is-off'}">${visionModelDisplay ? '视觉 · ' + esc(visionModelDisplay) : '视觉 · 未配置'}</span>
          </div>
        </div>
        <div class="ac-actions">
          <button class="ac-action" id="open-model-config-btn" type="button">
            <span class="ac-action-text"><b>模型配置</b><small>提供商、API 地址与密钥</small></span>
            <span class="ac-action-go" aria-hidden="true">›</span>
          </button>
          <button class="ac-action" id="open-model-manage-btn" type="button">
            <span class="ac-action-text"><b>模型管理</b><small>模型目录、增删与专用模型</small></span>
            <span class="ac-action-go" aria-hidden="true">›</span>
          </button>
        </div>
      </div>
      <div class="hint" id="provider-hint" style="margin-top:10px">${currentProvider ? `当前：${esc(currentProvider.displayName)} · ${esc(c.api.model || '未选择模型')} · ${esc(currentProvider.baseURL)}${currentProvider.hasKey ? ' · 已保存 API Key' : ' · 未保存 API Key'}` : '尚未选择模型'}</div>
      <div class="hint" id="model-vision-hint" style="margin-top:6px"></div>
      <input type="hidden" id="cfg-provider" value="${esc(c.api.provider || '')}" />
      <input type="hidden" id="cfg-model" value="${esc(c.api.model || '')}" />
      <input type="hidden" id="cfg-baseurl-value" value="${esc(c.api.baseUrl)}" />
    </div>`
    })}
    ${sc({
      id: 'card-api-fallback',
      icon: '🔄',
      gray: true,
      title: '备选模型',
      sub: '主模型失败时按列表顺序尝试。列表为空时不切换。',
      body: `
    <div id="fallback-model-rows"></div>
    <button class="btn btn-small fb-add-row" id="add-fallback-row-btn" type="button">＋ 添加备选模型</button>`
    })}
    ${sc({
      id: 'card-api-price',
      icon: '💰',
      gray: true,
      title: '费用估算',
      sub: '价格表与自定义单价',
      body: `
    <div class="price-toolbar">
      ${switchHtml('cfg-useofficialprice', c.api.useOfficialPrice !== false, '按价格表估算费用（按模型 ID 匹配，单独设置优先）')}
      <button class="btn btn-small" id="price-feed-refresh-btn" title="下载 Alcor 发布的模型价格表">更新价格表</button>
    </div>
    <div class="hint" id="price-feed-status" style="margin-bottom:10px"></div>

    <div class="price-card" id="model-price-card">
      <div class="pc-head">
        <span class="pc-title">当前模型的估算单价</span>
        <span class="pc-model" id="pc-model">${esc(c.api.model || '（未选择模型）')}</span>
      </div>
      <div class="pc-rows">
        <div class="pc-row"><span class="pc-label">未命中缓存的输入</span>
          <input type="number" id="cfg-price-in" step="0.01" min="0" value="0" /><span class="pc-unit">元 / 百万 token</span></div>
        <div class="pc-row"><span class="pc-label">输出</span>
          <input type="number" id="cfg-price-out" step="0.01" min="0" value="0" /><span class="pc-unit">元 / 百万 token</span></div>
        <div class="pc-row"><span class="pc-label">命中缓存的输入</span>
          <input type="number" id="cfg-price-cached" step="0.01" min="0" value="0" /><span class="pc-unit">元 / 百万 token</span></div>
      </div>
      <div class="pc-note" id="pc-note"></div>
    </div>

    <div style="display:flex;gap:8px;margin:8px 0">
      <button class="btn btn-small" id="batch-price-btn">批量编辑模型价格</button>
      <span class="muted" style="font-size:12px;align-self:center">如使用中转服务，可按实际单价为模型定价。</span>
    </div>`
    })}`;
}


function renderSearchSection(c) {
  // 每个提供方区块的初始显隐都要跟当前 provider 一致
  const prov = String(c.webSearch?.provider || 'bing');
  // 自定义搜索提供商列表（可多个），用于动态生成下拉框选项
  const customProvs = Array.isArray(c.webSearch?.providers) ? c.webSearch.providers : [];
  return `
    <h3 id="settings-search">搜索服务</h3>
    <div class="hint" style="margin-bottom:12px">
      当前搜索服务：${prov === 'bing' ? 'Bing 网页解析' : prov === 'deepseek' ? 'DeepSeek 原生搜索' : prov === 'zhipu' ? '智谱 Web Search' : prov === 'bocha' ? '博查 AI Search' : prov === 'baidu' ? '百度千帆 AI Search' : prov === 'metaso' ? '秘塔 AI 搜索' : '自定义'}
      ${(() => {
        // 当前提供方已保存的 Key 状态（与模型 API 页同款提示口径）
        const keyState = {
          deepseek: c.webSearch?.deepseek?.hasApiKey,
          zhipu: c.webSearch?.zhipu?.hasApiKey,
          bocha: c.webSearch?.bocha?.hasApiKey,
          baidu: c.webSearch?.baidu?.hasApiKey,
          metaso: c.webSearch?.metaso?.hasApiKey
        }[prov];
        if (prov === 'bing') return ' · 无需 API Key';
        if (prov?.startsWith('custom:')) return '';
        return keyState ? ' · 已保存 API Key' : ' · 未保存 API Key';
      })()}
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-websearch" ${c.webSearch?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-websearch">允许模型搜索和读取网页（web_search / web_fetch）</label></div>
    <div class="field"><label>搜索服务提供商</label>
      <select id="cfg-searchprovider">
        <option value="bing" ${prov === 'bing' ? 'selected' : ''}>Bing 网页解析</option>
        <option value="deepseek" ${prov === 'deepseek' ? 'selected' : ''}>DeepSeek 原生搜索</option>
        <option value="zhipu" ${prov === 'zhipu' ? 'selected' : ''}>智谱 Web Search</option>
        <option value="bocha" ${prov === 'bocha' ? 'selected' : ''}>博查 AI Search</option>
        <option value="baidu" ${prov === 'baidu' ? 'selected' : ''}>百度千帆 AI Search</option>
        <option value="metaso" ${prov === 'metaso' ? 'selected' : ''}>秘塔 AI 搜索</option>
        ${customProvs.map((p) => `<option value="custom:${esc(p.id)}" ${prov === `custom:${p.id}` ? 'selected' : ''}>${esc(p.name || p.baseUrl)}（自定义 · ${p.type === 'bing' ? '网页解析' : 'JSON 接口'}）</option>`).join('')}
      </select></div>
    <div class="field" id="custom-provider-manage" style="${prov.startsWith('custom:') ? '' : 'display:none'}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <button class="btn btn-small" id="test-search-provider-btn">测试搜索服务</button>
        <button class="btn btn-small btn-danger" id="del-search-provider-btn">删除搜索服务</button>
        <span id="search-provider-action-hint" class="muted" style="font-size:12px"></span>
      </div>
      <label>API Key${(() => {
        const cp = customProvs.find((p) => `custom:${p.id}` === prov);
        return cp?.hasApiKey ? '（已保存，可查看、替换或清除）' : '（未保存。自建服务若无需鉴权，可留空。）';
      })()}</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-custom-sp-key" value="${esc(customProvs.find((p) => `custom:${p.id}` === prov)?.hasApiKey ? '******' : '')}" placeholder="填写新 API Key 可替换，留空则保留原值" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-custom-sp-key-toggle" type="button">显示</button>
        <button class="btn btn-small btn-danger" id="cfg-custom-sp-key-clear" type="button" title="要删除已保存的 API Key，请使用此按钮。留空会保留原值。">清除密钥</button>
      </div>
    </div>
    <div class="field" id="bing-search-fields" style="${prov === 'bing' ? '' : 'display:none'}"><label>搜索页地址（可填写兼容 Bing 结果格式的地址）</label><input type="text" id="cfg-searchurl" value="${esc(c.webSearch?.searchUrl || 'https://cn.bing.com/search')}" /></div>
    <div class="field-row" id="deepseek-search-fields" style="${prov === 'deepseek' ? '' : 'display:none'}">
      <div class="field"><label>DeepSeek 搜索 API Key（未配置时读取 DEEPSEEK_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-ds-searchkey" value="${esc(c.webSearch?.deepseek?.hasApiKey ? '******' : '')}" placeholder="填写新 API Key 可替换，留空则保留原值" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-ds-searchkey-toggle" type="button">显示</button>
          <button class="btn btn-small btn-danger" id="cfg-ds-searchkey-clear" type="button" title="要删除已保存的 API Key，请使用此按钮。留空会保留原值。">清除密钥</button>
        </div></div>
      <div class="field"><label>模型</label><input type="text" id="cfg-ds-searchmodel" value="${esc(c.webSearch?.deepseek?.model || 'deepseek-v4-flash')}" /></div>
    </div>
    <div class="field-row" id="zhipu-search-fields" style="${prov === 'zhipu' ? '' : 'display:none'}">
      <div class="field"><label>智谱 API Key（未配置时读取 ZHIPU_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-zhipu-key" value="${esc(c.webSearch?.zhipu?.hasApiKey ? '******' : '')}" placeholder="填写新 API Key 可替换，留空则保留原值" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-zhipu-key-toggle" type="button">显示</button>
          <button class="btn btn-small btn-danger" id="cfg-zhipu-key-clear" type="button" title="要删除已保存的 API Key，请使用此按钮。留空会保留原值。">清除密钥</button>
        </div></div>
      <div class="field"><label>搜索引擎</label>
        <select id="cfg-zhipu-engine">
          <option value="search_std" ${c.webSearch?.zhipu?.engine === 'search_std' ? 'selected' : ''}>基础版 ¥0.01/次</option>
          <option value="search_pro" ${c.webSearch?.zhipu?.engine === 'search_pro' ? 'selected' : ''}>高级版 ¥0.03/次</option>
          <option value="search_pro_sogou" ${c.webSearch?.zhipu?.engine === 'search_pro_sogou' ? 'selected' : ''}>搜狗版 ¥0.05/次</option>
          <option value="search_pro_quark" ${c.webSearch?.zhipu?.engine === 'search_pro_quark' ? 'selected' : ''}>夸克版 ¥0.05/次</option>
        </select></div>
    </div>
    <div class="field" id="bocha-search-fields" style="${prov === 'bocha' ? '' : 'display:none'}">
      <label>博查 API Key</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-bocha-key" value="${esc(c.webSearch?.bocha?.hasApiKey ? '******' : '')}" placeholder="填写新 API Key 可替换，留空则保留原值" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-bocha-key-toggle" type="button">显示</button>
        <button class="btn btn-small btn-danger" id="cfg-bocha-key-clear" type="button" title="要删除已保存的 API Key，请使用此按钮。留空会保留原值。">清除密钥</button>
      </div></div>
    <div class="field" id="baidu-search-fields" style="${prov === 'baidu' ? '' : 'display:none'}">
      <label>百度千帆 API Key（未配置时读取 BAIDU_SEARCH_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-baidu-key" value="${esc(c.webSearch?.baidu?.hasApiKey ? '******' : '')}" placeholder="填写新 API Key 可替换，留空则保留原值" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-baidu-key-toggle" type="button">显示</button>
        <button class="btn btn-small btn-danger" id="cfg-baidu-key-clear" type="button" title="要删除已保存的 API Key，请使用此按钮。留空会保留原值。">清除密钥</button>
      </div></div>
    <div class="field" id="metaso-search-fields" style="${prov === 'metaso' ? '' : 'display:none'}">
      <label>秘塔 API Key（未配置时读取 METASO_API_KEY，也可使用服务的免密钥额度）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-metaso-key" value="${esc(c.webSearch?.metaso?.hasApiKey ? '******' : '')}" placeholder="填写新 API Key 可替换，留空则保留原值" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-metaso-key-toggle" type="button">显示</button>
        <button class="btn btn-small btn-danger" id="cfg-metaso-key-clear" type="button" title="要删除已保存的 API Key，请使用此按钮。留空会保留原值。">清除密钥</button>
      </div></div>

    <h3>添加自定义搜索服务</h3>
    <div class="field-row">
      <div class="field"><label>显示名称</label>
        <input type="text" id="new-sp-name" placeholder="例如：自建 SearXNG" /></div>
      <div class="field"><label>类型</label>
        <select id="new-sp-type">
          <option value="openai">JSON 搜索接口（POST）</option>
          <option value="bing">网页解析（Bing 结果格式）</option>
        </select></div>
    </div>
    <div class="field"><label>搜索接口或搜索页地址</label>
      <input type="text" id="new-sp-baseurl" placeholder="JSON 类型：https://your-search.example.com/search；网页类型：https://your-searx.example.com/search" style="width:100%" /></div>
    <div class="field-row">
      <div class="field"><label>API Key（可选）</label>
        <input type="password" id="new-sp-apikey" placeholder="服务无需鉴权时可留空" autocomplete="new-password" style="width:100%" /></div>
      <div class="field"><label>模型名（可选）</label>
        <input type="text" id="new-sp-model" placeholder="供兼容 Responses API 的服务使用" /></div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin:8px 0">
      <button class="btn btn-small" id="add-search-provider-btn">添加并使用</button>
      <span id="add-search-provider-hint" class="muted" style="font-size:12px"></span>
    </div>
  `;
}

function renderMemorySettingsSection(c) {
  const mem = c.memory || {};
  const providers = state.providers || [];
  const useChat = mem.useChatModel !== false;
  const selP = providers.find((p) => p.id === mem.provider);
  const currentDisplay = selP ? `${selP.displayName || selP.id} · ${mem.model || '未选择模型'}` : (mem.model || '未选择模型');
  return `
    <h3 id="settings-memory">记忆整理</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-consolidate" ${mem.consolidateEnabled !== false ? 'checked' : ''} />
      <label for="cfg-mem-consolidate">自动整理会话记忆</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-usechat" ${useChat ? 'checked' : ''} />
      <label for="cfg-mem-usechat">沿用聊天模型</label></div>
    <div id="mem-model-box" style="${useChat ? 'display:none' : ''}">
      <div class="field"><label>专用记忆整理模型</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-mem-model-pick" readonly placeholder="点击选择模型" value="${esc(currentDisplay)}" style="flex:1;cursor:pointer" />
        </div>
        <div class="hint" id="mem-model-hint">${selP ? `当前：${esc(selP.displayName)} @ ${esc(selP.baseURL)}` : '尚未选择专用模型'}</div>
        <input type="hidden" id="cfg-mem-provider" value="${esc(mem.provider || '')}" />
        <input type="hidden" id="cfg-mem-model" value="${esc(mem.model || '')}" />
      </div>
    </div>
    <div class="field"><label>两次自动整理的最短间隔（毫秒）</label><input type="number" id="cfg-mem-interval" min="1800000" step="600000" value="${esc(mem.consolidateMinIntervalMs ?? 21600000)}" /></div>
    <div class="hint">群成员印象的总条数或单人条数超过上限，且距上次整理达到设定间隔时，会话运行结束后会在后台整理。默认间隔为 6 小时（21,600,000 毫秒）。</div>`;
}

function renderPersonaSection(c) {
  // 统一人设开关：开启（默认）= 所有用同一套全局人设（下方完整编辑器）；
  // 关闭 = 每个白名单会话一个按钮，点开模态框单独编辑（personaByChat）。
  const unified = c.personaUnified !== false;
  const perChat = c.personaByChat || {};
  const allowIds = [
    ...(c.allow?.groups || []).map((g) => `group:${g}`),
    ...(c.allow?.private || []).map((p) => `private:${p}`)
  ].map(String);
  const extraIds = Object.keys(perChat).filter((id) => !allowIds.includes(id));
  const chatIds = [...allowIds, ...extraIds];

  const unifiedEditor = `
    ${renderPersonaPicker(c)}
    <div class="field-row">
      <div class="field"><label>参与度</label>
        <select id="cfg-participation">
          <option value="high" ${c.persona.participation === 'high' ? 'selected' : ''}>活跃</option>
          <option value="medium" ${c.persona.participation === 'medium' ? 'selected' : ''}>普通</option>
<option value="low" ${c.persona.participation === 'low' ? 'selected' : ''}>安静</option>
        </select></div>
    </div>
    <div class="field"><label>角色设定</label>
      <textarea id="cfg-roletext" class="persona-role-text" placeholder="请填写角色的身份、性格、说话方式和边界……">${esc(c.persona.roleText || '')}</textarea></div>
    <div class="field"><label>管理员附加规则（可选，加入系统提示词）</label>
      <textarea id="cfg-customrules" class="persona-role-text" style="min-height:100px">${esc(c.persona.customRules || '')}</textarea></div>
    <div class="field">
      <label>自定义系统提示词（高级，可选）</label>
      <textarea id="cfg-sysprompt" class="persona-role-text" style="min-height:120px" placeholder="留空时使用内置系统提示词">${esc(c.persona.systemPromptOverride || '')}</textarea>
      <div class="hint">
        填写后将<b>完整替换</b>内置系统提示词。如仍需要默认的安全、工具协议或表达风格约束，请在自定义文本中写明。
        可用占位符：<code>{botName}</code> <code>{roleText}</code> <code>{participation}</code>。留空时继续使用内置规则。
      </div>
    </div>`;

  // 分会话模式：按钮网格（白名单 ∪ 已配置过的会话）
  const chatButtons = chatIds.map((chatKey) => {
    const conf = perChat[chatKey] || {};
    const hasCustom = Boolean(conf.roleText || conf.participation || conf.customRules || conf.systemPromptOverride);
    const title = formatChatTitle(chatKey, extraIds.includes(chatKey) ? '' : chatNameOf(chatKey));
    return `
      <button class="btn persona-chat-btn ${hasCustom ? 'has-custom' : ''}" data-chat="${esc(chatKey)}" title="${esc(title)}的人设">
        ${esc(title)}${hasCustom ? ' ●' : ''}
      </button>`;
  }).join('');

  return `
    <h3>人设</h3>
    <p class="hint">本程序不附带人设。首次使用请自行添加人设，或直接填写角色设定；已有配置可继续编辑。</p>
    <div class="checkbox-row"><input type="checkbox" id="cfg-persona-unified" ${unified ? 'checked' : ''} />
      <label for="cfg-persona-unified">所有群聊和私聊共用人设</label></div>
    <div class="hint" style="margin-bottom:12px">${unified
      ? '下方设置将应用于所有会话。'
      : '选择会话后可单独编辑人设。圆点标记已设置的会话，留空的字段沿用全局人设。'}</div>
    <div id="persona-unified-box" style="${unified ? '' : 'display:none'}">
      ${unifiedEditor}
    </div>
    <div id="persona-perchat-box" style="${unified ? 'display:none' : ''}">
      <div class="field" style="margin-bottom:10px">
        <button class="btn" id="open-global-persona-btn">编辑全局人设</button>
      </div>
      <div class="persona-chat-grid">${chatButtons || '<div class="hint">请先在「聊天白名单」添加要单独设置的群聊或私聊。</div>'}</div>
    </div>`;
}

/**
 * 「全局人设设置」模态框（2026-09-18）：统一人设关闭（分群模式）时，
 * persona 主编辑器不在场 —— 没有独立人设的会话跟随的全局字段就没了编辑入口。
 * 这里弹出同款字段（选择人设 / 参与度 / 角色设定 / 附加规则 / 系统提示覆盖 /
 * 机器人名字 / 群内展示名），保存直接 POST /api/config 的 persona 补丁。
 */
function openGlobalPersonaModal() {
  const c = state.config || {};
  const per = c.persona || {};
  const overlay = modelModalShell({
    head: '全局人设设置',
    body: `
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <input type="text" id="gp-pick" readonly placeholder="点击选择人设" value="${esc(Object.values(state.personaTemplates || {}).find((p) => p.text === (per.roleText || ''))?.name || (String(per.roleText || '').trim() ? '自定义（当前文本）' : ''))}" style="flex:1;cursor:pointer" />
        <button class="btn btn-small" id="gp-new-btn">＋ 添加人设</button>
      </div>
      <div class="field-row">
        <div class="field"><label>参与度</label>
          <select id="gp-participation">
            <option value="high" ${per.participation === 'high' ? 'selected' : ''}>活跃</option>
            <option value="medium" ${per.participation === 'medium' ? 'selected' : ''}>普通</option>
<option value="low" ${per.participation === 'low' ? 'selected' : ''}>安静</option>
          </select></div>
      </div>
      <div class="field"><label>角色设定</label>
        <textarea id="gp-roletext" class="persona-role-text" style="min-height:180px" placeholder="请填写角色的身份、性格、说话方式和边界……">${esc(per.roleText || '')}</textarea></div>
      <div class="field"><label>管理员附加规则（可选，加入系统提示词）</label>
        <textarea id="gp-customrules" class="persona-role-text" style="min-height:80px">${esc(per.customRules || '')}</textarea></div>
      <div class="field"><label>自定义系统提示词（高级，可选）</label>
        <textarea id="gp-sysprompt" class="persona-role-text" style="min-height:80px" placeholder="留空 = 使用内置默认系统提示词">${esc(per.systemPromptOverride || '')}</textarea></div>
      <div class="hint" style="margin-top:6px">未单独设置的会话字段会沿用这里的值。</div>`,
    foot: `<button class="btn" id="gp-cancel">取消</button>
           <button class="btn btn-primary" id="gp-save">保存</button>`
  });

  // 选择人设：与统一编辑器同一份模板列表
  overlay.querySelector('#gp-pick').addEventListener('click', () => openPersonaPicker(overlay.querySelector('#gp-pick'),overlay.querySelector('#gp-roletext'),overlay.querySelector('#gp-customrules')));
  overlay.querySelector('#gp-new-btn').addEventListener('click', () => {
    openPersonaCreateModal({anchor:overlay.querySelector('#gp-pick'),role:overlay.querySelector('#gp-roletext'),rules:overlay.querySelector('#gp-customrules')});
  });

  overlay.querySelector('#gp-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#gp-save').addEventListener('click', async () => {
    const patch = {
      persona: {
        ...(c.persona || {}),
        participation: overlay.querySelector('#gp-participation').value,
        roleText: overlay.querySelector('#gp-roletext').value.trim(),
        customRules: overlay.querySelector('#gp-customrules').value.trim(),
        systemPromptOverride: overlay.querySelector('#gp-sysprompt').value.trim()
      }
    };
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
      closeModelModal(overlay);
      loadSettings();
    } catch (e) {
      alert(`保存全局人设失败：${e.message}`);
    }
  });
}

/**
 * 分会话人设编辑模态框：与统一编辑器同款字段（人设选择/添加/机器人名字沿用全局说明/参与度/
 * 角色设定/附加规则/系统提示词覆盖）。保存按钮直接 POST /api/config 落盘
 * （personaByChat 整体 __replace__），不经过表单自动保存链。
 */
function openPerChatPersonaModal(chatKey) {
  const conf = (state.config?.personaByChat || {})[chatKey] || {};
  const chatName = formatChatTitle(chatKey, chatNameOf(chatKey));
  const overlay = modelModalShell({
    head: `${chatName} 的独立人设`,
    body: `
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <input type="text" id="pcp-pick" readonly placeholder="点击选择人设" value="${esc(conf.roleText ? (Object.values(state.personaTemplates || {}).find((p) => p.text === conf.roleText)?.name || '自定义') : '')}" style="flex:1;cursor:pointer" />
        <button class="btn btn-small" id="pcp-new-btn">＋ 添加人设</button>
      </div>
      <div class="field"><label>参与度（留空跟随全局）</label>
        <select id="pcp-participation">
          <option value="" ${!conf.participation ? 'selected' : ''}>跟随全局</option>
          <option value="high" ${conf.participation === 'high' ? 'selected' : ''}>活跃</option>
          <option value="medium" ${conf.participation === 'medium' ? 'selected' : ''}>普通</option>
<option value="low" ${conf.participation === 'low' ? 'selected' : ''}>安静</option>
        </select></div>
      <div class="field"><label>角色设定（留空跟随全局）</label>
        <textarea id="pcp-roletext" class="persona-role-text" style="min-height:180px" placeholder="留空 = 用全局人设的角色设定">${esc(conf.roleText || '')}</textarea></div>
      <div class="field"><label>管理员附加规则（可选）</label>
        <textarea id="pcp-customrules" style="min-height:80px" placeholder="可选：追加到系统提示的规则（留空 = 用全局）">${esc(conf.customRules || '')}</textarea></div>
      <div class="field"><label>自定义系统提示词（高级，可选）</label>
        <textarea id="pcp-sysprompt" style="min-height:80px" placeholder="可选：整体替换系统提示（留空 = 用全局）">${esc(conf.systemPromptOverride || '')}</textarea></div>
      <div class="hint" style="margin-top:6px">未单独配置的字段跟随全局人设。</div>`,
    foot: `<button class="btn" id="pcp-clear">清空独立人设</button>
           <button class="btn" id="pcp-cancel">取消</button>
           <button class="btn btn-primary" id="pcp-save">保存</button>`
  });

  // 选择人设：复用人设模板列表
  overlay.querySelector('#pcp-pick').addEventListener('click', () => openPersonaPicker(overlay.querySelector('#pcp-pick'),overlay.querySelector('#pcp-roletext'),overlay.querySelector('#pcp-customrules')));
  overlay.querySelector('#pcp-new-btn').addEventListener('click', () => {
    // 复用统一编辑器的添加流程：加完模板直接填进本会话的角色设定
    openPersonaCreateModal();
  });

  // 直接 POST 落盘：不走"写隐藏 JSON + 等表单链保存"的老路。
  // 老路的两个坑（2026-09-17 用户实测）：
  //   1. modal 挂在 body 下、不在 #settings-form 内，dispatchEvent(change) 冒泡
  //      到不了 form 的委托监听 —— 从来没触发过自动保存；
  //   2. 就算触发了，随后的 loadSettings() 重建表单 DOM，隐藏 input 被重渲染成
  //      GET 回来的旧值，用户刚写的条目被无声丢弃 → 重开 modal 一片空白。
  const saveToMap = async (entry) => {
    const current = state.config?.personaByChat || {};
    const next = { ...current };
    if (entry) next[chatKey] = entry; else delete next[chatKey];
    try {
      const r = await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ personaByChat: { __replace__: next } })
      });
      if (r?.config) state.config = r.config;
    } catch (e) {
      alert(`保存独立人设失败：${e?.message || e}`);
      throw e;
    }
  };

  overlay.querySelector('#pcp-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#pcp-clear').addEventListener('click', async () => {
    try { await saveToMap(null); } catch { return; }
    closeModelModal(overlay);
    renderSettings();   // 只刷人设区块（按钮上的 ● 标记），不整页重拉 7 个接口
  });
  overlay.querySelector('#pcp-save').addEventListener('click', async () => {
    const roleText = overlay.querySelector('#pcp-roletext').value.trim();
    const participation = overlay.querySelector('#pcp-participation').value;
    const customRules = overlay.querySelector('#pcp-customrules').value.trim();
    const sysPrompt = overlay.querySelector('#pcp-sysprompt').value.trim();
    if (!roleText && !participation && !customRules && !sysPrompt) {
      try { await saveToMap(null); } catch { return; }   // 全空 = 清除独立人设
    } else {
      const entry = {};
      if (roleText) entry.roleText = roleText;
      if (participation) entry.participation = participation;
      if (customRules) entry.customRules = customRules;
      if (sysPrompt) entry.systemPromptOverride = sysPrompt;
      try { await saveToMap(entry); } catch { return; }
    }
    closeModelModal(overlay);
    renderSettings();
  });
}

function renderAdminsSection(c) {
  const admins = c.privatePolicy?.adminQQs || [];
  return `
    <h3 id="settings-admins">管理员</h3>
    <p class="setsub">按 QQ 号码设置 Alcor Agent 管理员，保存后立即生效。</p>
    <h3>管理员名单</h3>
    <div class="field">
      <label for="cfg-private-admins">管理员 QQ 号</label>
      <textarea id="cfg-private-admins" rows="3" autocomplete="off" spellcheck="false" aria-describedby="admin-qq-help admin-save-status">${esc(admins.join('\n'))}</textarea>
      <div class="hint" id="admin-qq-help">填写 5–10 位 QQ 号码，用逗号、空格或换行分隔。重复号码会合并；留空后保存会取消全部管理员。</div>
    </div>
    <div class="allow-pick-row">
      <button type="button" class="btn btn-primary" id="admin-save-btn">保存管理员</button>
      <span class="hint" id="admin-save-status" role="status" aria-live="polite">已配置 ${admins.length} 名管理员，修改后自动保存。</span>
    </div>
    <p class="hint">管理员不受每日私聊消息上限限制。启用 QQ 空间后，仅管理员私聊可使用「读取 QQ 空间」查看当天的本地快照。</p>
    <p class="hint">此身份不授予本地命令执行或 QQ 群管理权限。聊天白名单、暂停和屏蔽规则仍然生效；添加管理员不会自动加入聊天白名单。</p>`;
}

function renderAllowSection(c) {
  const privatePolicy = c.privatePolicy || {};
  return `
    <h3 id="settings-allow">聊天白名单</h3>
    <p class="allow-intro">白名单决定机器人在哪些会话里自动处理与回复。名单外的来信仍可在「会话」查看。</p>
    <label class="allow-mode" for="cfg-allowallwhenempty">
      <input type="checkbox" id="cfg-allowallwhenempty" ${c.allowAllWhenEmpty === true ? 'checked' : ''} />
      <span class="am-text"><b>空名单时全部放行</b><small>两份名单都为空时才处理所有会话；任一名单填了号码就按名单来。</small></span>
      <span class="am-state" aria-hidden="true"></span>
    </label>
    <div class="allow-grid">
      <section class="allow-col">
        <header class="allow-col-head">
          <span class="allow-col-name">群聊</span>
          <span class="allow-count">${((c.allow.groups || [])).length}</span>
          <button class="btn btn-small" id="pick-groups-btn" type="button">从联系人选择</button>
        </header>
        <input type="text" id="cfg-allowgroups" aria-label="允许的群号" placeholder="群号，用逗号分隔" value="${esc(((c.allow.groups || [])).join(','))}" />
      </section>
      <section class="allow-col">
        <header class="allow-col-head">
          <span class="allow-col-name">私聊好友</span>
          <span class="allow-count">${((c.allow.private || [])).length}</span>
          <button class="btn btn-small" id="pick-friends-btn" type="button">从联系人选择</button>
        </header>
        <input type="text" id="cfg-allowprivate" aria-label="允许私聊的 QQ 号" placeholder="QQ 号，用逗号分隔" value="${esc(((c.allow.private || [])).join(','))}" />
      </section>
    </div>
    <div class="allow-actions">
      <button class="btn btn-primary btn-small" id="allow-save-btn" type="button">保存名单</button>
      <span class="hint" id="allow-save-status" role="status">改完点保存，或直接按回车。</span>
    </div>
    <div class="allow-pick-row"><span id="pick-result" class="muted allow-pick-msg"></span></div>
    <div class="hint">如需给单个会话设置人设，请在「人设」关闭共用人设。</div>
    <h3>私聊规则</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-private-policy" ${privatePolicy.enabled !== false ? 'checked' : ''} />
      <label for="cfg-private-policy">启用私聊规则</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-private-greeting" ${privatePolicy.skipNewFriendGreeting !== false ? 'checked' : ''} />
      <label for="cfg-private-greeting">收到新好友的第一条消息时不自动回复</label></div>
    <div class="field-row">
      <div class="field"><label for="cfg-private-limit">每位好友每天可发送的私聊消息数（0 表示不限）</label><input type="number" id="cfg-private-limit" min="0" step="1" value="${esc(String(privatePolicy.dailyLimit ?? 0))}" /></div>
      <div class="field"><label for="cfg-private-notice">超限提醒内容（每位好友每天最多收到一次）</label><input type="text" id="cfg-private-notice" maxlength="200" value="${esc(privatePolicy.limitNotice || '今天的私聊消息已达上限，请明天再发。')}" /></div>
    </div>
    <div class="hint">机器人每收到该好友一条新消息计 1 条，机器人发出的回复不计入。北京时间零点重置，重复推送只计一次。新好友首条消息，以及暂停或被名单过滤时收到的消息仍计入额度。</div>
    <div class="field-row">
      <div class="field"><label for="cfg-private-special">不受限额的特殊好友 QQ 号（用逗号分隔）</label><input type="text" id="cfg-private-special" value="${esc((privatePolicy.specialFriendQQs || []).join(','))}" /></div>
    </div>
    <div class="allow-pick-row"><button type="button" class="btn btn-small" id="open-admin-settings">设置管理员</button><span class="hint">管理员名单在独立的「管理员」设置中维护。</span></div>`;
}

// 表情包积极程度档位：[值, 显示名]
const STICKER_LEVELS = [
  [1, '1 不发'],
  [2, '2 偶尔发'],
  [3, '3 正常'],
  [4, '4 经常发']
];

// 读取历史档位：名称与说明（档位制，累积生效）
/** 把输入钳制到 [min,max]，非法值退回 fallback。 */
/**
 * 取会话的群名（群聊才有）。
 * 群名由后端 /api/chats 附带（走 OneBot get_group_info，带缓存与超时保护），
 * 拿不到就返回空串 —— 调用方会自动退回只显示群号。
 */
function chatNameOf(chatKey) {
  const c = (state.chats || []).find((x) => x.key === chatKey);
  return String(c?.chatName || '').trim();
}

/**
 * 会话标题：群名 / 私聊昵称
 * 侧栏只显示名字（过长由 CSS 省略号截断），不拼群号 —— 拼了会被挤爆。
 * 拿不到名字时才退回「群 123 / 私聊 123」兜底。
 */
function formatChatTitle(chatKey, name = '') {
  const n = String(name || '').trim();
  if (n) return n;
  const m = /^group:(\d+)$/.exec(String(chatKey || ''));
  if (m) return `群 ${m[1]}`;
  const p = /^private:(\d+)$/.exec(String(chatKey || ''));
  if (p) return `私聊 ${p[1]}`;
  return String(chatKey || '');
}

/** 详情页标题：名字 + 号（需要确认身份时用） */
function formatChatTitleWithId(chatKey, name = '') {
  const m = /^group:(\d+)$/.exec(String(chatKey || ''));
  if (m) return name ? `${name}（${m[1]}）` : `群 ${m[1]}`;
  const p = /^private:(\d+)$/.exec(String(chatKey || ''));
  if (p) return name ? `${name}（${p[1]}）` : `私聊 ${p[1]}`;
  return formatChatTitle(chatKey, name);
}

/**
 * 群名补底缓存（id → 群名）：/api/onebot/groups 的群列表名字。
 * 没有消息存档的白名单群在 /api/chats 里查不到名字，分群按钮会退化成「群 <号>」，
 * 不方便辨识 —— 这里用 OneBot 群列表把名字补齐。
 */
async function loadQqGroupNames() {
  if (state.qqGroupNamesLoading) return state.qqGroupNames || {};
  state.qqGroupNamesLoading = true;
  try {
    const data = await api('/api/onebot/groups');
    state.qqGroupNames = state.qqGroupNames || {};
    for (const g of data.groups || []) {
      const id = String(g?.id ?? '').trim();
      const name = String(g?.name ?? '').trim();
      if (id && name) state.qqGroupNames[id] = name;
    }
  } catch { /* OneBot 未连接时静默：退回群号兜底 */ }
  finally { state.qqGroupNamesLoading = false; }
  return state.qqGroupNames || {};
}

/** 分群场景的群显示名：**仅群名**（拿不到才退回「群 <号>」兜底）。 */
function groupDisplayName(gid) {
  const id = String(gid ?? '').trim();
  const n = chatNameOf(`group:${id}`) || String(state.qqGroupNames?.[id] || '').trim();
  return n || `群 ${id}`;
}

function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/*
 * 滑条换算（前端显示用）。
 *
 * 换算逻辑来自 /vendor/tier-slider.js（与 src/tier-slider.js 同一份镜像）。
 * 后端保存配置时会用它**重新权威换算**档位与概率，前端这里只负责界面即时反馈。
 * 下面的 sliderToTierUI / sliderToTierUI_tierToSlider 是对共享函数的薄封装，
 * 保持既有调用点签名不变。
 */
function sliderToTierUI(pos) {
  return sliderToTier(pos);
}

/** 已保存配置 → 滑条位置（优先用存下来的位置，老配置没有就从 tier/概率反推）。 */
function sliderToTierUI_tierToSlider(st) {
  const saved = Number(st?.contextSliderPos);
  if (Number.isFinite(saved)) return Math.min(100, Math.max(0, saved));
  return tierToSlider(st?.contextTier, st?.randomPercent);
}

/** 滑条位置 → 一句话说明（给用户的即时反馈）。 */
function sliderDesc(pos) {
  const { tier, randomPercent } = sliderToTierUI(pos);
  if (tier === 1) return '<b>1 档 · 仅艾特</b>：只有被 @ 时才响应，其余消息标记已读、不调模型（最省）';
  if (tier === 2) return '<b>2 档 · +关键词</b>：被 @ 或命中关键词时响应';
  // 3 档概率展示必须与后端判定同源：resolveContextTier 用 Math.random()*100 与
  // randomPercent 比较（即"骰子值 < 阈值"），滑条换算出的 randomPercent 就是这个阈值。
  // 之前这里展示的是 sliderToTier 的 randomPercent 四舍五入值，而后端在保存时会
  // 重新权威换算一次 —— 两边都来自同一公式，但旧版 desc 里取整方式不同导致偶发不一致，
  // 现在统一保留一位小数（与 sliderToTier 一致）。
  if (tier === 3) return `<b>3 档 · +随机</b>：被 @ / 关键词必响应；此外每批普通消息有 <b>${randomPercent}%</b> 概率响应`;
  return '<b>4 档 · 全响应</b>：任何消息都响应，且艾特/关键词/随机的判定全部失效';
}

const TIER_NAME = { 1: '仅艾特', 2: '+关键词', 3: '+随机', 4: '全响应' };

/** 滑条位置 → 纯文本档位名（无 HTML 标签，供双点滑条说明文字使用）。 */
function sliderDescText(pos) {
  const { tier, randomPercent } = sliderToTierUI(pos);
  if (tier === 3) return `3 档 · +随机（${randomPercent}%）`;
  return `${tier} 档 · ${TIER_NAME[tier]}`;
}
const TIER_HINT = {
  1: '只有被 @ 时才响应，其余消息标记已读、不调模型（最省 token）',
  2: '在 1 档基础上，命中关键词也响应',
  3: '在 2 档基础上，再按概率随机响应一些消息',
  4: '任何消息都响应（改造前的行为，最费 token）'
};

/* 思考强度：六挡滑杆（轻度 / 中 / 高 / 极高 / max / Ultra）。
   等价状态仍是老的 (mode, effort) 二维：
     off=明确关闭、''=服务默认、on-noeffort=开启但用服务默认强度、low…ultra=指定挡位。
   隐藏域 #sc-thinking-effort 保留原 id，保存路径（08-modals 的 saveConfig）不用改。 */
const EFFORT_STOPS = Object.freeze([
  ['low', '轻度'],
  ['medium', '中'],
  ['high', '高'],
  ['xhigh', '极高'],
  ['max', 'max'],
  ['ultra', 'Ultra']
]);

function renderEffortControl(c) {
  const eff = String(c.api?.thinkingEffort || '');
  const mode = c.api?.thinkingMode || 'auto';
  const value = mode === 'off' ? 'off' : (EFFORT_STOPS.some(([v]) => v === eff) ? eff : (mode === 'on' ? 'on-noeffort' : ''));
  const known = EFFORT_STOPS.findIndex(([v]) => v === value);
  const index = known >= 0 ? known : 2;
  const pct = (index / (EFFORT_STOPS.length - 1)) * 100;
  const activeMode = value === 'off' ? 'off' : (value === '' ? 'auto' : 'on');
  const read = value === 'off' ? '关闭' : value === '' ? '服务默认' : (known >= 0 ? EFFORT_STOPS[known][1] : '服务默认强度');
  const disabled = activeMode !== 'on';
  const ticks = EFFORT_STOPS.map(([, label], i) => {
    const at = `left:calc(7px + (100% - 14px) * ${i / (EFFORT_STOPS.length - 1)})`;
    const cls = i === index ? 'current' : (i < index ? 'done' : '');
    return `<span class="effort-tick ${cls}" style="${at}" data-tick="${i}" title="${label}"></span>`;
  }).join('');
  return `
  <div class="effort" data-effort-root data-value="${esc(value)}">
    <div class="effort-head">
      <div class="effort-mode" role="group" aria-label="思考模式">
        <button type="button" class="effort-mode-item ${activeMode === 'off' ? 'on' : ''}" data-effort-mode="off">关闭</button>
        <button type="button" class="effort-mode-item ${activeMode === 'auto' ? 'on' : ''}" data-effort-mode="auto">服务默认</button>
        <button type="button" class="effort-mode-item ${activeMode === 'on' ? 'on' : ''}" data-effort-mode="on">指定挡位</button>
      </div>
      <span class="effort-read" data-effort-read>${read}</span>
    </div>
    <div class="effort-slider" role="slider" tabindex="0" aria-label="思考强度挡位"
         aria-valuemin="0" aria-valuemax="${EFFORT_STOPS.length - 1}" aria-valuenow="${index}"
         aria-valuetext="${EFFORT_STOPS[index][1]}" aria-disabled="${disabled ? 'true' : 'false'}"
         data-effort-slider>
      <span class="effort-track"><span class="effort-fill" style="width:${pct}%"></span></span>
      ${ticks}
      <span class="effort-knob" style="left:calc(7px + (100% - 14px) * ${index / (EFFORT_STOPS.length - 1)})" data-effort-knob></span>
    </div>
    <div class="effort-labels">
      ${EFFORT_STOPS.map(([, label], i) => `<span class="${i === index ? 'on' : ''}">${label}</span>`).join('')}
    </div>
    <input type="hidden" id="sc-thinking-effort" value="${esc(value)}" data-effort-value />
    <div class="effort-caption">拖到哪挡就用到哪挡。Alcor Agent 会把它翻译成提供商的思考参数；服务不支持所选高档时，自动降到最接近的较低档。</div>
  </div>`;
}

function renderChatSection(c) {
  const st = c.store || {};
  const fold = (typeof setCard === 'function') ? setCard : (o) => `<div class="setcard">${o.body}</div>`;
return `
    <h3>聊天设置</h3>
    ${fold({
      id: 'card-send-config',
      icon: '📨',
      title: '模型运行与消息发送',
      sub: '模型参数、会话队列与发送频率',
      body: `
      <div class="field-row">
        <div class="field"><label>采样温度</label><input type="number" id="sc-temperature" step="0.1" min="0" max="2" value="${esc(c.api?.temperature ?? 0.8)}" /></div>
        <div class="field"><label>每次运行的工具调用轮数上限</label><input type="number" id="sc-maxrounds" min="1" max="40" value="${esc(c.api?.maxRounds ?? 12)}" /></div>
      </div>
      <div class="field"><label>思考强度</label>
        ${renderEffortControl(c)}
      </div>
      <div class="field-row">
        <div class="field"><label>合并连续来信的等待时间（毫秒）</label><input type="number" id="sc-wakedelay" min="0" value="${esc(c.wakeDelayMs)}" /></div>
        <div class="field"><label>处理批次之间的间隔（毫秒）</label><input type="number" id="sc-draindelay" min="0" value="${esc(c.drainDelayMs)}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>同时运行的会话数上限</label><input type="number" id="sc-maxruns" min="1" max="8" value="${esc(c.maxConcurrentRuns)}" /></div>
        <div class="field"><label>每次失败运行的重试次数上限</label><input type="number" id="sc-sessionretry" min="0" max="5" value="${esc(c.sessionRetryAttempts ?? 2)}" />
          <div class="hint">填 0 关闭重试。一次运行已发出消息时，不会自动重试该次运行。</div></div>
      </div>
      <div class="field-row">
        <div class="field"><label>连续发送的最短间隔（毫秒）</label><input type="number" id="sc-mingap" min="200" value="${esc(c.send?.minGapMs ?? 1000)}" /></div>
        <div class="field"><label>连续发送的最长间隔（毫秒）</label><input type="number" id="sc-maxgap" min="500" value="${esc(c.send?.maxGapMs ?? 3000)}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>每分钟发送上限（条）</label><input type="number" id="sc-maxpermin" min="1" value="${esc(c.send?.maxPerMinute ?? 80)}" /></div>
        <div class="field"><label>每小时发送上限（条）</label><input type="number" id="sc-maxperhour" min="1" value="${esc(c.send?.maxPerHour ?? 500)}" /></div>
      </div>
      <div class="hint">改动会自动保存并应用。</div>`
    })}
    ${fold({
      id: 'card-active-config',
      icon: '⚡',
      title: '自动回复策略',
      sub: '回复条件与分时策略',
      val: st.replyPolicy ? replyPolicySummary(st.replyPolicy) : tierSummary(sliderToTierUI_tierToSlider(st)),
      // 卡头插槽：竖分割线 + 三件套（峰谷时段 / 档位参数 / 统一设置），
      // 紧贴标题块左侧排布，与右上角档位摘要之间留白。
      extra: `<span class="ac-head-controls"><span class="ac-head-div"></span>
        <div class="btn ac-peak-btn" id="ac-peak-btn" role="button" tabindex="0" title="点击设置高峰时段（开始 / 结束与预设方案）">
          <span class="control-caption">${AlcorIcons.draw('sun')}峰谷时段</span>
          <label class="switch ac-peak-switch" title="启用 / 停用峰谷切换（高峰时段用高峰档，其余时间用低谷档）"><input type="checkbox" id="ac-peak-enabled" ${st.peakSchedule?.enabled === true ? 'checked' : ''} /><span class="track"><span class="thumb"></span></span></label>
        </div>
      </span>`,
      open: true,
      body: `<div id="ac-editor"></div>`
    })}

    ${fold({
      id: 'card-cmdmute',
      icon: '🔇',
      title: '指令禁言',
      sub: '收到包含 @ 和指令的消息后，暂时只回应 @。',
      open: false,
      body: `
      <div class="field-row">
        <div class="field"><label>禁言指令（与 @机器人 写在同一条消息）</label>
          <input type="text" id="ac-cmdmute-command" value="${esc(c.commandMute?.command || '/安静')}" placeholder="如 /安静" /></div>
        <div class="field"><label>禁言时长（分钟，0 表示手动解除）</label>
          <input type="number" id="ac-cmdmute-duration" min="0" value="${esc(Number(c.commandMute?.durationMin ?? 30))}" /></div>
      </div>
      <div class="checkbox-row"><input type="checkbox" id="ac-cmdmute-enabled" ${c.commandMute?.enabled !== false ? 'checked' : ''} />
        <label for="ac-cmdmute-enabled">启用指令禁言</label></div>
      <div class="hint">改动会自动保存并应用。</div>`
    })}

    ${fold({
      id: 'card-proactive',
      icon: '💬',
      title: '主动开话题',
      sub: '聊天冷场时尝试主动开话题',
      body: `
      <div class="checkbox-row"><input type="checkbox" id="cfg-proactive" ${c.proactive.enabled ? 'checked' : ''} />
        <label for="cfg-proactive">聊天冷场时尝试主动开话题</label></div>
      <div class="field-row">
        <div class="field"><label>最短检查间隔（毫秒）</label><input type="number" id="cfg-pro-min" min="60000" value="${esc(c.proactive.checkIntervalMinMs)}" /></div>
        <div class="field"><label>最长检查间隔（毫秒）</label><input type="number" id="cfg-pro-max" min="120000" value="${esc(c.proactive.checkIntervalMaxMs)}" /></div>
        <div class="field"><label>每次检查的触发概率（0 到 1）</label><input type="number" id="cfg-pro-prob" step="0.05" min="0" max="1" value="${esc(c.proactive.probability)}" /></div>
      </div>`
    })}

    ${fold({
      id: 'card-sticker',
      icon: '😄',
      title: '表情包',
      sub: '收藏同步、发送偏好与模型可见范围',
      body: `
      <div class="checkbox-row"><input type="checkbox" id="cfg-sticker" ${c.sticker.enabled ? 'checked' : ''} />
        <label for="cfg-sticker">同步收藏表情并启用表情包发送工具</label></div>
      <div class="field">
        <label for="cfg-sticker-encourage">主动发送表情的频率</label>
        <select id="cfg-sticker-encourage">
          ${STICKER_LEVELS.map(([v, label], i) =>
            `<option value="${v}" ${Number(c.sticker?.sendTier ?? 2) === v ? 'selected' : ''}>${esc(label)}</option>`
          ).join('')}
        </select>
        <div class="hint">
          任何成员明确请求发送表情时，本轮直接获得发送许可。原生表情和梗鲸每轮合计最多一张。
          主动配图每轮判定一次，四档概率为 0%、20%、35%、70%。主动发送后最近 10 条机器人消息中，表情上限依次为 0、3、6、8 张。
        </div>
      </div>
      <div class="field">
        <label>每轮候选表情：20 个</label>
        <div class="hint">
          按标签和 ID 列出当前账号、当前会话内已审核的表情；可用数量不足 20 个时列出全部。
          标签已能表达含义时，无需再次看图。
        </div>
      </div>`
    })}

    <div class="field" style="margin-top:14px">
      <button class="btn" id="blocklist-btn" style="height:44px;padding:0 28px;font-size:14px">管理屏蔽名单</button>
    </div>`;
}

function renderDesktopSection(c) {
  return `
    <h3>桌面端</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-autostart" ${c.server?.autoStart ? 'checked' : ''} />
      <label for="cfg-autostart">登录 Windows 后自动启动</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-closetray" ${c.server?.closeToTray !== false ? 'checked' : ''} />
      <label for="cfg-closetray">关闭窗口时继续在系统托盘运行</label></div>
    <h3>界面</h3>
    <div class="field"><label>主题</label>
      <div class="theme-picker" id="theme-picker">
        ${THEME_VALUES.map((t) => `
          <div class="theme-option${getThemePref() === t ? ' on' : ''}" data-theme-opt="${t}" role="button" tabindex="0" aria-pressed="${getThemePref() === t}">
            <span class="t-ico">${THEME_ICON[t]}</span>
            <span>${THEME_LABEL[t]}</span>
          </div>`).join('')}
      </div>
    </div>
    <div class="theme-schedule-controls">
      <div class="field"><label for="theme-light-start">日间开始</label><input id="theme-light-start" type="time" value="${esc(getThemeSchedule().lightStart)}" required></div>
      <div class="field"><label for="theme-dark-start">夜间开始</label><input id="theme-dark-start" type="time" value="${esc(getThemeSchedule().darkStart)}" required></div>
    </div>
    <p class="hint" id="theme-schedule-hint" role="status">「随时间」按本机时间切换外观。请填写两个不同的开始时间。</p>
    <div class="checkbox-row"><input type="checkbox" id="cfg-showvision" ${c.ui?.showVision !== false ? 'checked' : ''} />
      <label for="cfg-showvision">在模型目录显示图片输入能力</label></div>
    <div class="field"><label>界面数据轮询间隔（毫秒）</label><input type="number" id="cfg-refreshms" min="1000" step="1000" value="${esc(c.ui?.refreshMs ?? 15000)}" /></div>
    <h3>数据管理</h3>
    <div class="field"><label>用户数据目录</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-datadir" readonly value="${esc(state.dataDir || '（加载中…）')}" style="flex:1" />
        <button class="btn btn-small" id="open-datadir-btn">打开文件夹</button>
      </div>
      <div class="hint">此目录保存本机配置、聊天记录、记忆和表情包。</div>
    </div>
    <div class="field">
      <button class="btn btn-danger" id="reset-data-btn">重置应用数据</button>
      <span class="hint" id="reset-data-hint" style="margin-left:10px"></span>
      <div class="hint" style="margin-top:6px">重置会永久删除本机配置、聊天记录、记忆和表情包。请先备份需要保留的资料。</div>
    </div>
    <h3 id="settings-update">更新与 GitHub</h3>
    <div class="field">
      <div class="update-head">
        <span class="update-version"><span class="uv-label">当前版本</span><b id="update-current" class="uv-value">—</b></span>
        <span class="update-link-state" id="update-source-state" hidden></span>
      </div>
      <label for="cfg-github-repo">GitHub 仓库或发布清单地址</label>
      <div class="update-source-row">
        <input type="text" id="cfg-github-repo" placeholder="https://github.com/owner/repo" spellcheck="false" autocomplete="off" />
        <button class="btn btn-small" id="save-update-source" type="button">保存地址</button>
      </div>
      <div class="hint" id="update-source-hint">粘贴 GitHub 仓库页地址即可从 Releases 检查更新；留空保存表示回到随包出厂的更新源。</div>
      <div class="update-actions">
        <button class="btn btn-primary btn-small" id="check-update-btn" type="button">检查更新</button>
        <a class="btn btn-small" id="update-project" target="_blank" rel="noopener noreferrer" hidden>在 GitHub 查看项目</a>
        <a class="btn btn-small" id="update-download" target="_blank" rel="noopener noreferrer" hidden>打开下载页面</a>
      </div>
      <p class="hint" id="update-status-text" role="status">从更新源查看新版本和发布说明。</p>
      <p class="hint" id="update-notes" style="white-space:pre-wrap;overflow-wrap:anywhere" hidden></p>
    </div>`;
}

function renderOnebotSection(c) {
  return `
    <h3 id="settings-onebot">OneBot（Alcor）</h3>
    <div class="hint" style="margin-bottom:10px">在这里查看 Agent 与 Alcor 核心的连接配置。启动、停止和日志入口在侧栏的「Alcor」。</div>
    <div class="field"><label>Alcor 核心目录（留空则使用内置核心）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-alcordir" value="${esc(c.alcor.dir || '')}" style="flex:1" />
        <button class="btn btn-small" id="open-alcor-btn">打开文件夹</button>
      </div>
      <div class="hint" id="alcor-hint"></div></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-alcorlaunch" ${c.alcor.autoLaunch ? 'checked' : ''} />
      <label for="cfg-alcorlaunch">Agent 启动时自动启动尚未运行的 Alcor 核心</label></div>
    <div class="field-row">
      <div class="field"><label>WebSocket 事件地址（只读）</label><input type="text" id="cfg-wsurl" readonly value="${esc(c.alcor.wsUrl)}" /></div>
      <div class="field"><label>HTTP 操作接口地址（只读）</label><input type="text" id="cfg-httpurl" readonly value="${esc(c.alcor.httpUrl)}" /></div>
      <div class="field"><label>WebSocket 令牌</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-obtoken" readonly value="${esc(c.alcor?.hasAccessToken ? '******' : '')}" placeholder="令牌由 Alcor 核心配置同步" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-obtoken-toggle" type="button">显示</button>
        </div></div>
      <div class="field"><label>HTTP 接口令牌（与 WebSocket 共用）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-obhttptoken" readonly value="${esc(c.alcor?.hasHttpAccessToken ? '******' : '')}" placeholder="令牌由 Alcor 核心配置同步" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-obhttptoken-toggle" type="button">显示</button>
        </div></div>
    </div>
    <div class="hint">连接地址和令牌由 data/alcor.config.json 自动同步。模型、人设和白名单修改会自动保存并生效。</div>`;
}

/**
 * 刷新 Skill 状态（后端判定结果）。
 * 单独抽出来是因为开关切换后需要立即重取，而不是等下一次 loadSettings。
 */
/**
 * 拉取技能/插件列表（内存态）。**不含磁盘重扫** —— 想让新放入的目录
 * 被看到，走 rescanSkills()。
 */
async function loadSkillsStatus() {
  try {
    const data = await api('/api/skills');
    state.skills = data.skills || [];
    state.skillsSummary = data.summary || {};
    state.uninstalledSkills = data.uninstalled || [];
  } catch {
    /* 取不到就保持原值，不覆盖成空列表造成"条目都不见了"的假象 */
  }
}

/**
 * 重扫磁盘并刷新列表：技能/插件页「刷新」按钮的完整动作。
 * 之前刷新只重读内存注册表，后台文件监听一旦丢事件（目录删除重建、
 * 网络盘、杀毒软件），放进去的新插件无论点多少次刷新都看不到。
 * 现在先 POST /api/skills/reload 让后端真正重扫；接口不可用时退回
 * 普通列表拉取（不比旧行为差）。
 */
async function rescanSkills({ quiet = false } = {}) {
  try {
    const r = await api('/api/skills/reload', { method: 'POST' });
    if (r && r.skills) {
      state.skills = r.skills;
      state.skillsSummary = r.summary || {};
      // 重扫接口的响应没有 uninstalled 字段，补拉一次（很轻，还能顺带拿脱敏配置）
      await loadSkillsStatus();
      if (!quiet && r.failed?.length) {
        console.warn('[skill] 本次重扫失败条目：', r.failed);
      }
      return r;
    }
  } catch (e) {
    console.warn('[skill] 重扫请求失败：', e?.message || e);
  }
  await loadSkillsStatus();
  return null;
}

/**
 * 技能设置弹窗。
 *
 * 为什么把设置放在技能自己的弹窗里（而不是塞进设置页）：
 *   · 这些字段**只对这个技能有意义** —— 分散在全局设置页里，用户根本对不上号
 *   · 技能页本来就该是"这个技能能配什么"的唯一入口
 *   · 开关和设置放在一起，改完立刻能看到状态徽章变化
 *
 * 表单**完全按 manifest 的 configSchema 渲染**，前端不硬编码任何字段名 ——
 * 加一个新技能、加一个字段，这里一行都不用改。
 * 支持的 type：boolean（复选框）/ number（数字输入）/ enum（下拉）/ string（文本框）
 * 另外 secret: true 的字段用密码框，且留空 = 不修改（后端也按同一约定处理）。
 */
/**
 * 生成技能设置弹窗的 HTML（**纯函数**，不碰 DOM）。
 *
 * 拆出来的唯一目的是可测：这次改动的重点是视觉层级
 * （名字用等宽大字、介绍用正文小字、模态框加宽），
 * 埋在 DOM 操作里就只能靠肉眼看，改坏了没人发现。
 *
 * @returns {{ html: string } | { error: string }}
 */
function renderSkillSettingsModal(skill) {
  if (!skill) return { error: '技能不存在' };
  const skillId = skill.id;
  const schema = skill.configSchema || {};
  const values = skill.settings || {};
  // internal 字段（列表/对象类）不渲染成表单输入 —— 它们由专用界面管理。
  // 但仍然要在弹窗里列出来并说明去哪改，否则用户会以为"这个设置根本不存在"。
  const allKeys = Object.keys(schema);
  const internalKeys = allKeys.filter((k) => schema[k]?.type === 'internal');
  const keys = allKeys.filter((k) => schema[k]?.type !== 'internal');
  if (!allKeys.length) return { error: '这个技能没有可配置项' };

  const fieldHtml = (key) => {
    const d = schema[key] || {};
    const v = values[key] ?? d.default ?? '';
    const label = esc(d.label || key);
    const hint = d.description ? `<div class="hint">${esc(d.description)}</div>` : '';
    const id = `skset-${esc(skillId)}-${esc(key)}`;
    // secret：用密码框 + 占位符提示"留空不改"，避免把脱敏值当明文回填
    const isSecret = d.secret === true;
    // 长文本字段跨整行：窄列里换行会碎成一条，读起来很累
    const isWide = d.type === 'string' && (d.multiline === true || String(d.description || '').length > 60);
    const cls = 'field' + (isWide ? ' field--wide' : '');
    let input;
    if (d.type === 'boolean') {
      // 整行做成可点区域：单摆一个小复选框在宽弹窗里像没渲染完
      input = `<label class="skill-toggle-row">
        <input type="checkbox" id="${id}" data-key="${esc(key)}" data-type="boolean" ${v ? 'checked' : ''} />
        <span class="st-text">${v ? '已开启' : '已关闭'}</span>
      </label>`;
    } else if (d.type === 'number') {
      input = `<input type="number" id="${id}" data-key="${esc(key)}" data-type="number" value="${esc(v)}" step="any" />`;
    } else if (d.type === 'enum' && Array.isArray(d.values)) {
      // 枚举渲染成下拉：值写错会让技能行为异常，下拉从根上避免手抖
      input = `<select id="${id}" data-key="${esc(key)}" data-type="enum">${
        d.values.map((x) => `<option value="${esc(x)}" ${String(v) === String(x) ? 'selected' : ''}>${esc(x)}</option>`).join('')
      }</select>`;
    } else {
      input = `<input type="${isSecret ? 'password' : 'text'}" id="${id}" data-key="${esc(key)}" data-type="string" value="${isSecret ? '' : esc(v)}" placeholder="${isSecret ? (v ? '已设置（留空 = 不修改）' : '未设置') : ''}" autocomplete="off" />`;
    }
    return `<div class="${cls}"><label>${label}${d.secret ? ' 🔒' : ''}</label>${input}${hint}</div>`;
  };

  return { html: `<div class="modal skill-modal" role="dialog" aria-modal="true" aria-label="${esc(skill.name)} 设置">
    <div class="skill-modal__head">
      <div class="skill-modal__titles">
        <div class="skill-modal__name">
          ${esc(skill.name)}
          <span class="skill-modal__ver">v${esc(skill.version || '')}</span>
        </div>
        <div class="skill-modal__id">${esc(skillId)}</div>
        <div class="skill-modal__desc">${esc(skill.description || '（这个技能没有写介绍）')}</div>
      </div>
      <button class="icon-btn" id="skset-x" title="关闭" aria-label="关闭">✕</button>
    </div>
    <div class="skill-modal__body">
      <div class="skill-modal__note">
        共 <b>${keys.length}</b> 项设置 · 保存在 <code>config.skills['${esc(skillId)}']</code>，只有这个技能会读到它们。
      </div>
      <div class="skill-form">${keys.map(fieldHtml).join('')}</div>
      ${internalKeys.length ? `<div class="skill-modal__internal">
        <div class="skill-modal__internal-head">以下设置不在这里改</div>
        ${internalKeys.map((k) => `<div class="skill-modal__internal-item"><b>${esc(schema[k].label || k)}</b><br />${esc(schema[k].description || '')}</div>`).join('')}
      </div>` : ''}
    </div>
    <div class="skill-modal__foot">
      <span class="skill-modal__foot-tip">改动即时生效，无需重启</span>
      <span class="spacer"></span>
      <button class="btn btn-small" id="skset-cancel">取消</button>
      <button class="btn btn-primary" id="skset-save">保存</button>
    </div>
  </div>` };
}

/** 打开某个技能的设置弹窗。 */
function openSkillSettings(skillId) {
  const skill = (state.skills || []).find((x) => x.id === skillId);
  if (!skill) return;
  const built = renderSkillSettingsModal(skill);
  if (built.error) { alert(built.error); return; }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = built.html;
  document.body.appendChild(overlay);

  const close = () => closeAnimatedOverlay(overlay);
  overlay.querySelector('#skset-x').addEventListener('click', close);
  overlay.querySelector('#skset-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  // Esc 关闭：弹窗大了以后鼠标要移很远，键盘出口是必需的
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  overlay.setAttribute('tabindex', '-1');
  overlay.focus();

  // 复选框旁边的"已开启/已关闭"文字要跟着变，否则看不出当前状态
  overlay.querySelectorAll('input[type="checkbox"][data-type="boolean"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const span = cb.parentElement?.querySelector('.st-text');
      if (span) span.textContent = cb.checked ? '已开启' : '已关闭';
    });
  });

  overlay.querySelector('#skset-save').addEventListener('click', async () => {
    const settings = {};
    overlay.querySelectorAll('[data-key]').forEach((el) => {
      const key = el.dataset.key;
      const type = el.dataset.type;
      if (type === 'boolean') settings[key] = el.checked;
      else if (type === 'number') {
        const n = Number(el.value);
        // 空值/非数字：不提交这个键，让后端保留原值（而不是写进一个 NaN）
        if (el.value.trim() !== '' && Number.isFinite(n)) settings[key] = n;
      } else if (type === 'enum') settings[key] = el.value;
      else settings[key] = el.value;   // secret 留空 → 后端按"不修改"处理
    });
    try {
      const r = await api(`/api/skills/${encodeURIComponent(skillId)}`, {
        method: 'POST',
        body: JSON.stringify({ settings })
      });
      const idx = (state.skills || []).findIndex((x) => x.id === skillId);
      if (idx >= 0 && r.skill) {
        // 后端返回的是 status 视图；把设置与 schema 合并回去，避免卡片丢掉这两项
        state.skills[idx] = { ...state.skills[idx], ...r.skill, settings: r.settings || {}, configSchema: state.skills[idx].configSchema };
      }
      if (r.config) state.config = r.config;
      await loadSkillsStatus();
      // 两页都重绘：设置弹窗可能从技能页或插件页打开，
      // 而改动会同时影响状态徽章。重绘代价可忽略（每页最多十来张卡片）。
      renderModulePage('skill');
      renderModulePage('plugin');
      close();
    } catch (err) {
      alert(`保存失败：${err.message}`);
    }
  });
}

/**
 * 扩展页（技能 / 插件）
 *
 * 两型在**代码里完全同构**（同一条加载器、同一套清单字段、同一个开关），
 * 唯一的区别是"谁决定何时执行"：
 *   skill  （LLM 型）  —— 注册工具，模型看了 description 自己决定调不调
 *   plugin （确定性型）—— 提供能力/钩子，核心代码按能力名确定性调用，必然执行
 *
 * 这件事对使用者太重要了（决定"这个功能会不会被模型忽略"），所以拆成两个页签，
 * 但渲染逻辑共用一份 —— 否则两页的卡片、分组、开关行为迟早会分叉。
 *
 * ⚠️ 状态一律用后端 /api/skills 的判定结果，前端**不自己推断**能不能用 ——
 * 否则又会出现"界面说能用、实际不生效"的两套口径。
 */
const MODULE_KINDS = {
  skill: {
    kind: 'skill',
    tab: 'skills',
    boxSel: '#skills-page',
    title: '技能（Skill）',
    dir: 'skills/',
    emptyHint: `还没加载到任何技能。<br />LLM 型技能放在项目的 <code>skills/&lt;id&gt;/</code> 目录，需要 <code>skill.json</code> + <code>index.js</code>。`,
    lead: `技能是 <b>LLM 型</b>扩展：它们注册工具进模型的 function 列表，<b>用不用、什么时候用由模型自己判断</b>。<br />
      所以技能不会"一定生效" —— 模型可能一直不调用它。需要"条件满足必跑"的功能，应该做成插件（见旁边的「插件」页签）。`,
    setupTitle: '新增技能',
    setupHint: `在 <code>skills/&lt;id&gt;/</code> 放 <code>skill.json</code> + <code>index.js</code>，
      导出 <code>setup(api)</code> 并在里面 <code>api.registerTool({...})</code>。
      热重载默认开启，保存即生效。完整规范见 <code>doc/extend_development/skill-development.md</code>。`
  },
  plugin: {
    kind: 'plugin',
    tab: 'plugins',
    boxSel: '#plugins-page',
    title: '插件（Plugin）',
    dir: 'plugins/',
    emptyHint: `还没加载到任何插件。<br />确定性型插件放在项目的 <code>plugins/&lt;id&gt;/</code> 目录，需要 <code>plugin.json</code> + <code>index.js</code>。`,
    lead: `插件是 <b>确定性型</b>扩展：它们提供<b>能力</b>（<code>providers</code>）或<b>钩子</b>（<code>hooks</code>），
      由核心代码按能力名确定性调用 —— <b>条件满足就一定会执行，不经过 LLM，模型想忽略也忽略不掉</b>。<br />
      代价是它不能"看情况发挥"：什么时候触发必须在代码里写死。需要模型理解意图的功能，应该做成技能（见旁边的「技能」页签）。`,
    setupTitle: '新增插件',
    setupHint: `在 <code>plugins/&lt;id&gt;/</code> 放 <code>plugin.json</code> + <code>index.js</code>，
      导出 <code>setup(api)</code>，并用 <code>export const providers = {...}</code> 或 <code>export const hooks = {...}</code> 声明扩展点。
      热重载默认开启，保存即生效。完整规范见 <code>doc/extend_development/plugin-development.md</code>。`
  }
};

async function loadModulePage(kind, { rescan = false } = {}) {
  const meta = MODULE_KINDS[kind];
  if (!meta) return;
  const box = $(meta.boxSel);
  if (!box) return;
  box.innerHTML = renderModuleSkeleton(meta);
  if (rescan) await rescanSkills({ quiet: true });
  else await loadSkillsStatus();
  renderModulePage(kind);
  // 页面整页重建（切页签 / 手动刷新）时内容淡入；卡片开关后的原地重绘不播
  uiEnter(box);
}

function renderModuleSkeleton(meta) {
  return `<div class="usage-wrap">
    <div class="usage-head"><h2>${esc(meta.title)}</h2></div>
    <div class="sk-block">${'<div class="sk-row"></div>'.repeat(5)}</div>
  </div>`;
}

/**
 * 渲染一页（技能或插件）。
 *
 * @param {'skill'|'plugin'} kind 只渲染该类型；另一类的条目**完全不进这一页**
 */
function renderModulePage(kind) {
  const meta = MODULE_KINDS[kind];
  if (!meta) return '';
  const box = $(meta.boxSel);
  const all = state.skills || [];
  // 只留本页该管的类型。
  // ⚠️ kind 为 null（自定义根目录，如测试用的临时目录）时归入**技能页**而不是丢弃 ——
  // "界面上凭空少了一个条目"比"归错页"难排查得多（用户刚刚就踩过这个坑）。
  // 卡片上会标「目录未识别」提示作者去确认放置位置。
  const items = all.filter((s) => s.kind === meta.kind || (s.kind == null && meta.kind === 'skill'));

  // 统计按本页条目现算：后端 summary 是全量的，直接用会把另一类也算进来
  const mine = {
    total: items.length,
    active: items.filter((s) => s.active).length,
    off: items.filter((s) => s.loaded && !s.enabled).length,
    broken: items.filter((s) => !s.loaded).length
  };

  if (!items.length) {
    const emptyHtml = `<div class="usage-wrap">
      <div class="usage-head"><h2>${esc(meta.title)}</h2>
        <button class="btn btn-small" id="${esc(meta.tab)}-add-btn" title="查看创建指南与实际目录">＋ 添加${meta.kind === 'skill' ? '技能' : '插件'}</button>
        <div class="usage-days">
          <button class="btn btn-small" id="${esc(meta.tab)}-refresh-btn">刷新</button>
        </div></div>
      <div class="empty-hint">${meta.emptyHint}</div>
      <div class="hint" style="margin-top:10px">${meta.lead}</div>
    </div>`;
    if (box) box.innerHTML = emptyHtml;
    bindModulePageEvents(kind);
    return emptyHtml;
  }

  const catLabel = { model: '模型', message: '消息', knowledge: '知识', media: '媒体', utility: '工具' };

  // 按分类分组：一屏里按功能归类，比一长串平铺好找
  const order = ['model', 'message', 'media', 'knowledge', 'utility'];
  const byCat = new Map();
  for (const s of items) {
    const c = order.includes(s.category) ? s.category : 'utility';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(s);
  }

  // ── 卡片：单列一行，名称+简介常显，状态与启停/设置钉在行尾 ──
  // 不再做正反面翻转（悬停才看简介）；按钮固定在内容框后侧，不随文字换行。
  const card = (s) => {
    const loadedOk = s.loaded;
    const active = loadedOk && s.enabled && s.active;
    const stateCls = !loadedOk ? 'mcard-broken' : (!s.enabled ? 'mcard-off' : (active ? 'mcard-on' : 'mcard-dep'));
    const stateLabel = !loadedOk ? '加载失败' : (!s.enabled ? '已停用' : (active ? '已启用 · 生效中' : '已启用 · 待就绪'));
    // 无法真正生效时，把原因写在卡片上（不再只藏在 title 提示里）
    let errLine = '';
    if (!loadedOk) {
      errLine = String(s.loadError || '加载失败，原因未知').slice(0, 160);
    } else if (s.enabled && !s.active) {
      errLine = String(s.reason || (s.missingRequires || []).map((r) => `缺少能力：${r}`).join('、') || '依赖未就绪').slice(0, 160);
    }
    const allFields = Object.keys(s.configSchema || {});
    const settingsBtn = allFields.length
      ? `<button class="mcard-gear" data-skill-id="${esc(s.id)}" title="设置（${allFields.length} 项）" aria-label="打开 ${esc(s.name)} 的设置">⚙</button>`
      : '';
    const toggleBtn = `<button type="button" class="btn btn-small mcard-toggle" data-skill-id="${esc(s.id)}" aria-label="${s.enabled ? '停用' : '启用'} ${esc(s.name)}" ${loadedOk ? '' : 'disabled title="请先修复加载错误，再刷新列表"'}>${s.enabled ? '停用' : '启用'}</button>`;
    const haystack = [s.id, s.name, s.description, s.dir].filter(Boolean).join(' ').toLowerCase();
    return `
    <div class="mcard ${stateCls}" data-skill-id="${esc(s.id)}" data-search="${esc(haystack)}" >
      <div class="mcard-main">
        <div class="mcard-name">${esc(s.name)} <span class="skill-card__ver">v${esc(s.version)}</span></div>
        ${(s.toolIds || []).length ? `<div class="mcard-tools" title="本技能注册的工具 id">${(s.toolIds || []).map((id) => `<code class="mcard-tool-id">${esc(id)}</code>`).join('')}</div>` : ''}
        <div class="mcard-desc">${esc(s.description || '（没有写介绍）')}</div>
        ${errLine ? `<div class="mcard-err">${esc(errLine)}</div>` : ''}
      </div>
      <div class="mcard-controls"><span class="mcard-status">${esc(stateLabel)}</span><div class="mcard-acts">${toggleBtn}${settingsBtn}</div></div>
    </div>`;
  };

  const sections = [...byCat.entries()].map(([cat, list]) => `
    <h3 class="usage-h3">${catLabel[cat] || cat}（${list.length}）</h3>
    <div class="module-grid">
      ${list.map(card).join('')}
    </div>
  `).join('');

  // 残留配置：只在技能页展示一次（两页共用 state）。
  const uninstalledHtml = (kind === 'skill' && (state.uninstalledSkills || []).length)
    ? `<h3 class="usage-h3">已配置但未安装（${state.uninstalledSkills.length}）</h3>
      <div class="hint" style="margin-bottom:6px">这些条目在配置里留着开关/设置，但 <code>skills/</code> 与 <code>plugins/</code> 目录里已经没有对应的文件夹。重装同名插件会自动恢复这些设置；确认不要了可以清理掉。</div>
      <div class="tool-meta" style="gap:6px;margin-bottom:8px">
        ${state.uninstalledSkills.map((u) => `<span class="tool-dep">${esc(u.id)}${u.enabled ? '' : '（已关）'}${u.hasSettings ? ' · 有设置' : ''}</span>`).join('')}
      </div>
      <button class="btn btn-small" id="skills-cleanup-btn">清理这些残留配置</button>`
    : '';

  const html = `<div class="usage-wrap">
      <div class="usage-head">
        <h2>${esc(meta.title)}</h2>
        <button class="btn btn-small" id="${esc(meta.tab)}-add-btn" title="查看创建指南与实际目录">＋ 添加${meta.kind === 'skill' ? '技能' : '插件'}</button>
        <input type="search" class="module-search" id="module-search-${esc(meta.tab)}"
          placeholder="搜索${meta.kind === 'skill' ? '技能' : '插件'}名称 / 简介…" autocomplete="off" />
        <div class="usage-days">
          <span class="uc-tag" title="生效中 / 这一页的总数">${mine.active} / ${mine.total} 生效</span>
          <button class="btn btn-small" id="${esc(meta.tab)}-refresh-btn">刷新</button>
        </div>
      </div>
      <div class="hint" style="margin-bottom:14px">
        ${meta.lead}<br />
        开关只有这一处 —— 停用后它注册的工具、提供的能力、提示词片段和请求改写会同时失效。
        不可用时下面会直接写明原因（未启用 / 缺依赖 / 模型不支持 / 加载失败）。
      </div>
      ${sections}
      ${uninstalledHtml}
    </div>`;

  if (box) box.innerHTML = html;
  bindModulePageEvents(kind);
  if (typeof enhanceConcept2UI === 'function') enhanceConcept2UI(box);
  return html;
}

/** 供渲染测试按名取用的两个入口（render-test 会逐个执行这些函数）。 */
function renderSkillsPage() { return renderModulePage('skill'); }
function renderPluginsPage() { return renderModulePage('plugin'); }

function bindModulePageEvents(kind) {
  const meta = MODULE_KINDS[kind];
  if (!meta) return;
  // 「＋ 添加」入口（标题旁）：打开添加模态框（创建指南）。
  // ⚠️ 这个入口曾经从模板里消失过 —— openAddModuleModal 变成没人调用的孤本，
  // 技能/插件页直接失去"添加"能力。按钮与绑定必须成对存在（2026-09-26 修复）。
  $(`#${meta.tab}-add-btn`)?.addEventListener('click', () => openAddModuleModal(kind));
  $(`#${meta.tab}-refresh-btn`)?.addEventListener('click', () => loadModulePage(kind, { rescan: true }));
  // 残留配置清理（只在技能页渲染，按钮也只在这一页出现）
  $('#skills-cleanup-btn')?.addEventListener('click', async () => {
    const btn = $('#skills-cleanup-btn');
    if (!btn || !state.uninstalledSkills?.length) return;
    const ids = state.uninstalledSkills.map((u) => u.id);
    if (!(await uiConfirm(`清理 ${ids.length} 个未安装条目的配置（${ids.join('、')}）？\n清理后重装同名插件将恢复默认设置。`))) return;
    btn.disabled = true;
    try {
      const r = await api('/api/skills/cleanup', { method: 'POST', body: JSON.stringify({ ids }) });
      if (r.config) state.config = r.config;
      await loadModulePage('skill');
    } catch (e) {
      alert(`清理失败：${e?.message || e}`);
      btn.disabled = false;
    }
  });
  // 注意这里是 $$ （返回数组）不是 $（返回单个元素）：
  // 卡片可能有多个，用 $ 会拿到一个元素然后 .forEach 报错。
  // ⚠️ 绑定范围必须限定在**本页容器内**：两个页面同时存在于 DOM 里（只是 view 切换显隐），
  // 用全局 $$ 会把另一页的卡片也绑一遍 —— 同一个开关被绑两次，一次切换会发两个请求。
  const scope = $(meta.boxSel);
  if (!scope) return;
  scope.querySelectorAll('.skill-settings-btn, .mcard-gear').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSkillSettings(btn.dataset.skillId);
    });
  });
  // 只有明确的启停按钮改变配置；整行和说明文字不承担交互。
  scope.querySelectorAll('.mcard-toggle').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.skillId;
      const cur = (state.skills || []).find((s) => s.id === id);
      if (btn.disabled || !cur || !cur.loaded) return;
      const next = !cur.enabled;
      const label = btn.textContent;
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.textContent = next ? '启用中…' : '停用中…';
      try {
        const r = await api(`/api/skills/${encodeURIComponent(id)}`, {
          method: 'POST', body: JSON.stringify({ enabled: next })
        });
        const idx = (state.skills || []).findIndex((s) => s.id === id);
        if (idx >= 0 && r.skill) state.skills[idx] = r.skill;
        if (r.config) state.config = r.config;
        await loadSkillsStatus();
        renderModulePage(kind);
        [...$(meta.boxSel).querySelectorAll('.mcard-toggle')].find((el) => el.dataset.skillId === id)?.focus({ preventScroll: true });
      } catch (err) {
        alert(`切换失败：${err.message}`);
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        btn.textContent = label;
      }
    });
  });

  // 顶部搜索：按卡片 data-search 本地过滤（不整页重绘，保留开关状态与滚动）
  const searchInput = scope.querySelector('.module-search');
  if (searchInput) {
    const applyFilter = () => {
      const q = searchInput.value.trim().toLowerCase();
      scope.querySelectorAll('.mcard').forEach((el) => {
        const hay = el.dataset.search || '';
        el.style.display = (!q || hay.includes(q)) ? '' : 'none';
      });
      // 分类标题：组内卡片被滤光则标题一并藏掉
      scope.querySelectorAll('.module-grid').forEach((grid) => {
        const any = [...grid.querySelectorAll('.mcard')].some((el) => el.style.display !== 'none');
        grid.style.display = any ? '' : 'none';
        const h = grid.previousElementSibling;
        if (h && h.classList.contains('usage-h3')) h.style.display = any ? '' : 'none';
      });
    };
    searchInput.addEventListener('input', applyFilter);
  }
}

function renderToolsSection(c) {
  // 技能失活（未启用 / 加载失败 / 依赖未就绪）时，它注册的工具整组**不再显示** ——
  // 与提示词口径一致（orchestrator 的 getToolAvailability 过滤，失活技能的工具
  // 也不会写进提示词）。"界面看得到、模型用不到"和"界面看不到、提示词却写了"
  // 都是要消灭的割裂。
  const skillActive = new Map((state.skills || []).map((s) => [s.id, s.active === true]));
  const tools = (state.toolRegistry || []).filter((t) => !t.skillId || skillActive.get(t.skillId) === true);
  const toolsCfg = c.tools || {};
  // 分类清单必须与 tool-registry 的 CATEGORY_META 同源（8 类）：
  // 曾经只列 6 类，media/knowledge 两类的工具（send_image、bili-meme 等）
  // 在设置页无卡片 → 无分类开关也无单工具开关，只能手改 JSON。
  const categories = ['messaging', 'sticker', 'query', 'memory', 'web', 'knowledge', 'media', 'system'];
  const categoryNames = {
    messaging: '消息发送',
    sticker: '表情管理',
    query: '消息查询',
    memory: '记忆系统',
    web: '联网搜索',
    knowledge: '知识库',
    media: '媒体理解',
    system: '系统反馈'
  };
  const categoryIcons = {messaging:'chat', sticker:'smile', query:'search', memory:'memory', web:'globe', knowledge:'book', media:'media', system:'settings'};

  // 按分类分组
  const byCategory = {};
  for (const t of tools) {
    if (!byCategory[t.category]) byCategory[t.category] = [];
    byCategory[t.category].push(t);
  }

  // 渐进式披露：默认折叠，点击展开
  const expandedCategories = state.expandedToolCategories || new Set(['messaging']); // 默认展开第一个

  const categoryCards = categories.map((cat) => {
    const catTools = byCategory[cat] || [];
    if (!catTools.length) return '';
    const catEnabled = toolsCfg.categories?.[cat] !== false;
    const isExpanded = expandedCategories.has(cat);

    const toolCards = isExpanded ? catTools.map((t) => {
      const enabled = toolsCfg.overrides?.[t.id] ?? t.defaultEnabled ?? true;
      const disabledByDep = (t.requiresVision && c.api?.vision === false) || (t.requiresSearch && c.webSearch?.enabled === false);
      // 功能名字 + 一句话概括（description 可能缺失，不能直接 .split）
      const funcName = String(t.id || '').split(':').pop();
      const summary = String(t.description || '（无说明）').split('。')[0] + '。';
      // send_to 的开关就是「跨会话发送」本身（tools.crossChatSend）：
      // 开关收编进消息发送分类，用户在工具卡上直接控制，不再单独设全局勾选框。
      const isSendTo = t.id === 'send_to';
      const checked = isSendTo ? (toolsCfg.crossChatSend === true) : enabled;
      const chkId = `tool-chk-${t.id.replace(/[^\w-]/g, '_')}`;
      return `
        <div class="tool-card ${checked ? 'enabled' : 'disabled'} ${disabledByDep ? 'dep-disabled' : ''}" data-tool-id="${t.id}">
          <div class="tool-header">
            <label class="switch tool-switch">
              <input type="checkbox" class="tool-checkbox" id="${chkId}" data-tool-id="${t.id}" ${isSendTo ? 'data-cross-chat="1"' : ''} ${checked ? 'checked' : ''} ${disabledByDep && !isSendTo ? 'disabled' : ''} />
              <span class="track"><span class="thumb"></span></span>
            </label>
            <span class="tool-icon">${AlcorIcons.fromLegacy(t.icon, categoryIcons[cat])}</span>
            <div class="tool-title">
              <div class="tool-name">${esc(funcName)}${t.skillId ? '<span class="tool-dep tool-skill">skill</span>' : ''}</div>
              <div class="tool-summary">${esc(summary)}</div>
            </div>
          </div>
          <div class="tool-meta">
            ${t.requiresVision ? '<span class="tool-dep">需要视觉模型</span>' : ''}
            ${t.requiresSearch ? '<span class="tool-dep">需要搜索服务</span>' : ''}
            ${disabledByDep ? '<span class="tool-dep-warn">依赖未满足</span>' : ''}
            ${isSendTo ? '<span class="tool-dep">目标须在白名单内</span>' : ''}
          </div>
        </div>`;
    }).join('') : '';

    return `
      <div class="tool-category ${isExpanded ? 'expanded' : 'collapsed'}" data-category="${cat}">
        <div class="tool-category-header" data-category="${cat}" role="button" tabindex="0">
          <span class="tool-category-arrow">${isExpanded ? '▼' : '▶'}</span>
          <span class="tool-category-name">${AlcorIcons.draw(categoryIcons[cat])}${categoryNames[cat] || cat}</span>
          <label class="tool-category-toggle switch">
            <input type="checkbox" class="category-checkbox" data-category="${cat}" ${catEnabled ? 'checked' : ''} />
            <span class="track"><span class="thumb"></span></span>
          </label>
          <span class="tool-category-count">${catTools.length} 个工具</span>
        </div>
        ${isExpanded ? `<div class="tool-list">${toolCards}</div>` : ''}
      </div>`;
  }).join('');

  // ⚠️ 必须落在顶层 setCard 里：renderSettingsSection 直接嵌这一段时，
  // autoFoldSettings 会按 h3 把整页重包成折叠卡，再把 .fold-head 绑到
  // 分类头上 —— 点分类会开合整块面板，grid-rows 折叠把下半屏撑出大片空白。
  const fold = (typeof setCard === 'function') ? setCard : (o) => `<div class="setcard">${o.body}</div>`;
  return `
    <h3 id="settings-tools">工具与技能</h3>
    <div class="hint" style="margin-bottom:12px">
      模型只能调用已启用且满足依赖的工具。列表显示内置工具和已生效技能提供的工具。
      ${toolsCfg.enabled === false ? '<span style="color:var(--red)">工具总开关已关闭</span>' : ''}
    </div>
    ${fold({
      id: 'card-tools-list',
      icon: '🛠',
      title: '工具列表',
      sub: '按分类查看，改动自动保存',
      open: true,
      body: `
        <div class="checkbox-row">
          ${switchHtml('cfg-tools-enabled', toolsCfg.enabled !== false, '启用工具调用（关闭后模型无法调用工具）')}
        </div>
        <div class="tool-actions" style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-small" id="tools-enable-all">全部启用</button>
          <button class="btn btn-small" id="tools-disable-all">全部禁用</button>
          <button class="btn btn-small" id="tools-reset">恢复默认</button>
        </div>
        ${categoryCards || '<div class="hint">当前没有可配置的工具。</div>'}`
    })}`;
}

/**
 * 完整提示词预览文本（设置-工具与技能 & 技能页右侧共用同一份）。
 * 数据来自 GET /api/prompt-preview —— 后端用运行时同一套
 * buildSystemPrompt + getToolAvailability 组装，按当前启停状态实时反映；
 * 前端不再自己拼（曾经前端复制了一份静态模板，永远是"全启用"的样子，
 * 与实际发送的提示词越漂越远）。
 * 后端返回结果缓存在 state.promptPreview；render* 渲染时同步取，
 * 开关变动后由 refreshPromptPreview() 异步拉新并原地更新 DOM。
 */
function renderPromptPreviewText() {
  const d = state.promptPreview;
  if (!d || typeof d.systemPrompt !== 'string') return '（正在加载提示词预览…）';
  const tools = d.tools || [];
  const toolLines = tools.length
    ? tools.map((t) => `- ${t.id}：${t.description}`).join('\n')
    : '（当前没有可用工具）';
  return `${d.systemPrompt}\n\n【本次可用工具清单（function calling）】\n${toolLines}`;
}

/**
 * 拉取/刷新提示词预览。
 * 实时性设计（2026-09-17）：预览读的是**后端活配置**（getConfig），而设置的
 * 自动保存有 600ms 防抖 —— 直接刷看到的是旧状态。所以本函数可带 overrides
 * （与配置同结构的临时补丁）：请求发给 /api/prompt-preview，后端先深合并补丁
 * 再组装（不落盘），预览即刻反映刚点的开关，不用等自动保存落地。
 */
async function refreshPromptPreview(overrides = null) {
  try {
    // 空对象不附 body（GET 语义）——没有补丁就按后端活配置组装
    const hasOverrides = overrides && Object.keys(overrides).length > 0;
    const d = await api('/api/prompt-preview', hasOverrides ? {
      method: 'POST',
      body: JSON.stringify(overrides)
    } : {});
    state.promptPreview = d;
  } catch {
    state.promptPreview = null;
  }
  // 两处预览 DOM（设置-工具页 / 技能页右侧）都原地换文本，不整页重渲染
  $$('.prompt-preview-content').forEach((pre) => {
    pre.textContent = renderPromptPreviewText();
  });
}
