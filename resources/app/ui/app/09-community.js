// 〔社区：提示/上传/发送配置/活跃设置/市场〕——M9 拆分第 10 段
'use strict';
/* ══════════════════════════════════════════════════════════════
   社区功能：意见收集 + 金句上传
   ══════════════════════════════════════════════════════════════
   数据流向：浏览器 → https://kondius.cn/qq-agent/api（作者自建的公开
   收件箱，静态站之外的一个小型接收服务）。不经过本地后端 ——
   本地后端只服务本机，碰不到作者的服务器；分发版用户也是这个地址
   （意见和金句本来就是发给作者看的）。
*/
const COMMUNITY_API = 'https://kondius.cn/qq-agent/api';

/** 统一的提示小模态框（替代 alert —— 原生对话框与 UI 风格割裂）。 */
function showNoticeModal(title, text) {
  const overlay = modelModalShell({
    head: title,
    body: `<div class="hint" style="font-size:13.5px;line-height:1.7">${esc(text)}</div>`,
    foot: `<button class="btn btn-primary" id="notice-ok">知道了</button>`
  });
  overlay.querySelector('#notice-ok').addEventListener('click', () => closeModelModal(overlay));
}

/**
 * 上传成功浮框（右上角）：不自动消失，只能手动关闭，带目标网址。
 * 意见收集 / 金句上传成功后调用。
 */
function showUploadToast(title, url, { onClose } = {}) {
  // 同类型只留一个（连着传两次不堆叠）
  document.querySelectorAll('.upload-toast').forEach((el) => {
    el.classList.add('closing');
    setTimeout(() => el.remove(), 180);
  });
  const el = document.createElement('div');
  el.className = 'upload-toast';
  el.innerHTML = `
    <div class="ut-head">
      <span class="ut-title">${esc(title)}</span>
      <button class="ut-close" type="button" aria-label="关闭" title="关闭">×</button>
    </div>
    <a class="ut-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;
  document.body.appendChild(el);
  el.querySelector('.ut-close').addEventListener('click', () => {
    el.classList.add('closing');
    setTimeout(() => { el.remove(); onClose?.(); }, 180);
  });
}


/** 档位说明（concept2 设计稿文案：带 <b> 强调，百分比与后端判定同源）。 */
function descOf(pos) {
  const { tier, randomPercent } = sliderToTierUI(pos);
  if (tier === 1) return '只有被 @ 时才响应，其余消息标记已读、<b>不调模型</b>（最省 token）';
  if (tier === 2) return '在 1 档基础上，<b>命中关键词</b>也响应';
  if (tier === 3) return `被 @ / 命中关键词必响应；此外每批普通消息有 <b>${randomPercent}%</b> 概率响应`;
  return '任何消息都响应 —— <b>最费 token</b>';
}

/** 头部摘要文案（折叠卡 head 右侧的当前档位小结）。 */
function tierSummary(pos) {
  const { tier, randomPercent } = sliderToTierUI(pos);
  return tier === 3 ? `3 档 · ${randomPercent}%` : `${tier} 档 · ${TIER_NAME[tier]}`;
}

/**
 * 档位滑条控制器（2026-09-24 · 对齐 concept2 设计稿）：
 * 轨道/分段/拇指都是模板里的静态节点（.tier-scale / .tier-band / .tier-knob），
 * 控制器只做"值 ↔ 界面"与交互。动画契约按设计稿：
 *   · 预设 / 键盘跳档 → 拇指走 CSS 弹簧缓动（transition: left … cubic-bezier(.34,1.4,.64,1)）
 *   · 拖动中 → 临时 transition:none，帧级跟手（这是设计稿帧率正确的关键）
 *   · 松手   → 恢复过渡
 * 控制器协议与 00-core 的 createVSlider 保持一致
 * （setValues / applyValues / setDual / setDisabled / destroy / .values /
 *  onChange({low, high, byUser})）—— applyPeakPreset 等既有调用方零改动。
 * 值语义同旧协议：low = 低谷（活跃）档位点（数值大 = 档高），
 * high = 高峰（安静）档位点，恒有 low >= high；单珠模式只用 low。
 */
function createTierBar({ mount, dual = false, low = 100, high = 10, onChange = null, onInput = null } = {}) {
  // 位置保留两位小数（不取整）：整数量化会让拇指 1% 一跳（宽轨上≈6~10px 的台阶），
  // 拖起来"一段一段"且不跟手。1% 的 1/100 精度对换算毫无影响。
  const clamp = (v) => Math.min(100, Math.max(0, Math.round((Number(v) || 0) * 100) / 100));
  const st = { low: clamp(low), high: clamp(high), dual: !!dual, disabled: false };
  if (st.high > st.low) { const t = st.low; st.low = st.high; st.high = t; }

  // 档位代表位 = 区间中心（1→5、2→15、3→55、4→95）。
  // 松手吸附规则：1/2/4 档语义是离散的（档内任何位置等价）→ 弹簧回档位中心；
  // 3 档是"随机概率线性"（位置=概率）→ 保留精确位置不吸附。
  const B = TIER_SLIDER_BANDS;
  const TIER_POS = [
    B.tier1End / 2,
    (B.tier1End + B.tier2End) / 2,
    (B.tier2End + B.tier3End) / 2,
    (B.tier3End + 100) / 2
  ];
  const snapIfDiscrete = (v) => {
    const { tier } = sliderToTierUI(v);
    return (tier === 1 || tier === 2 || tier === 4) ? TIER_POS[tier - 1] : v;
  };

  // 拇指是模板里的静态节点（设计稿同款 markup）；缺了就兜底补一颗
  const knobLo = mount.querySelector('.knob-valley') || mount.querySelector('.tier-knob');
  let knobHi = mount.querySelector('.knob-peak');
  if (!knobHi) {
    knobHi = document.createElement('div');
    knobHi.className = 'tier-knob knob-peak';
    mount.appendChild(knobHi);
  }
  let knobRendered = false;   // 首帧装填不播动画（弹窗刚打开时不该有珠子弹出）
  [knobLo, knobHi].forEach((k, i) => {
    k.setAttribute('role', 'slider');
    k.setAttribute('aria-label', i === 0 ? '低谷时段档位点' : '高峰时段档位点');
    k.setAttribute('aria-valuemin', '0');
    k.setAttribute('aria-valuemax', '100');
    k.tabIndex = 0;
  });

  const fire = (byUser) => { if (onChange) onChange({ low: st.low, high: st.high, byUser }); };

  function render() {
    knobLo.style.left = st.low + '%';
    knobHi.style.left = st.high + '%';
    // 高峰珠随峰谷开关显隐（点击切换时淡入淡出）；拖动中形态不变，不触发动画
    if (st.dual) uiShow(knobHi, () => { knobHi.style.display = ''; }, knobRendered);
    else uiHide(knobHi, () => { knobHi.style.display = 'none'; }, knobRendered);
    knobLo.style.opacity = st.disabled ? '.4' : '';
    knobHi.style.opacity = st.disabled ? '.4' : '';
    knobLo.setAttribute('aria-valuenow', String(st.low));
    knobHi.setAttribute('aria-valuenow', String(st.high));
    mount.dataset.dual = st.dual ? '1' : '0';
    knobRendered = true;
  }

  const posFrom = (e) => {
    const r = mount.getBoundingClientRect();
    const w = r.width || 1;
    return clamp(((e.clientX - r.left) / w) * 100);
  };
  let dragging = null;
  const move = (which, v) => {
    if (which === 'lo') st.low = st.dual ? Math.max(v, st.high) : v;
    else st.high = Math.min(v, st.low);
    render();
    // 拖动中的高频轻量回调：读数行实时跟手（而不是松手后才变）
    if (onInput) onInput({ low: st.low, high: st.high, byUser: true });
  };
  mount.addEventListener('pointerdown', (e) => {
    if (st.disabled || dragging || (e.button != null && e.button !== 0)) return;
    e.preventDefault();
    const v = posFrom(e);
    if (st.dual) dragging = Math.abs(v - st.low) <= Math.abs(v - st.high) ? 'lo' : 'hi';
    else dragging = 'lo';
    try { mount.setPointerCapture(e.pointerId); } catch { /* 旧环境无指针捕获 */ }
    // 拖动跟手：关掉弹簧过渡，帧级直跟；松手恢复（设计稿同款手法）
    knobLo.style.transition = 'none';
    knobHi.style.transition = 'none';
    move(dragging, v);
  });
  mount.addEventListener('pointermove', (e) => { if (dragging) move(dragging, posFrom(e)); });
  const endDrag = () => {
    if (!dragging) return;
    dragging = null;
    knobLo.style.transition = '';
    knobHi.style.transition = '';
    // 松手吸附：1/2/4 档弹簧回档位中心（transition 已恢复 → 弹滑动画生效）；
    // 3 档（随机概率线性）保留精确位置。
    const lo = snapIfDiscrete(st.low);
    const hi = snapIfDiscrete(st.high);
    if (lo !== st.low || hi !== st.high) {
      st.low = lo;
      st.high = hi;
      render();
      if (onInput) onInput({ low: st.low, high: st.high, byUser: true });
    }
    fire(true);
  };
  mount.addEventListener('pointerup', endDrag);
  mount.addEventListener('pointercancel', endDrag);

  const onKey = (which) => (e) => {
    if (st.disabled) return;
    const cur = which === 'lo' ? st.low : st.high;
    let next = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - 1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + 1;
    else if (e.key === 'PageDown') next = cur - 10;
    else if (e.key === 'PageUp') next = cur + 10;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 100;
    else return;
    e.preventDefault();
    move(which, next);   // 键盘跳档保留弹簧过渡（招牌滑动动画）
    fire(true);
  };
  knobLo.addEventListener('keydown', onKey('lo'));
  knobHi.addEventListener('keydown', onKey('hi'));

  render();
  return {
    get values() { return { low: st.low, high: st.high }; },
    setValues(lo, hi) {
      st.low = clamp(lo);
      st.high = clamp(hi == null ? lo : hi);
      if (st.high > st.low) { const t = st.low; st.low = st.high; st.high = t; }
      render();
    },
    applyValues(lo, hi) { this.setValues(lo, hi); fire(false); },
    setDual(b) { st.dual = !!b; render(); },
    setDisabled(b) { st.disabled = !!b; render(); },
    destroy() {
      mount.removeEventListener('pointerdown', () => {});
      knobLo.removeEventListener('keydown', onKey('lo'));
      knobHi.removeEventListener('keydown', onKey('hi'));
    }
  };
}

/**
 * 「活跃设置」编辑器（2026-09-24 改版：从两级模态框整体搬进聊天设置的
 * 「活跃设置」折叠卡内联展示 —— 「打开活跃设置编辑器」按钮与两个模态框取消，
 * 原「档位设置」子模态框的内容（各档条数 / 关键词表 / 被召唤后持续参与 /
 * 活跃期）一并摊平进折叠卡）。
 *
 * 布局：左侧一条**竖向**档位滑条（1 档在下、4 档在上，轨道下蓝上黄渐变），
 *       右侧是开关与参数。统一/分群**共用同一条滑条** —— 分群模式下它编辑
 *       当前选中的群（群按钮列表选择），从结构上消灭了
 *       "两套滑条 id + 按元素存在性猜象限"这一类 bug。
 * 峰谷：同一条滑条上两颗珠 —— 上面那颗（档位更高）= 低谷时段档位，
 *       下面那颗 = 高峰时段档位，互不交叉；两珠之间画一条半透明区间带。
 * 保存语义与原模态框一致：改动先落草稿，点「保存」整体提交
 * （store / chatActive 一次写盘），「取消」放弃未保存的改动。
 * 「每个群聊单独设置」开关在折叠卡头部；「指令禁言」已独立成自己的折叠卡
 * （走设置页自动保存），不再进这里的草稿。峰谷的启用开关在「峰谷设置」按钮内。
 *
 * 用法：renderChatSection 渲染 `<div id="ac-editor"></div>` 占位，
 *      bindSettingsEvents 每次重渲染后调 mountActiveConfigEditor(root) 挂载。
 */
function policyFromLegacy(store, pos) {
  const value = sliderToTierUI(pos ?? sliderToTierUI_tierToSlider(store));
  return { mode: value.tier < 3 ? 'mentions' : value.tier === 3 ? 'probability' : 'all', probability: Math.min(99.9, Math.max(.1, value.randomPercent || 10)) };
}
function replyPolicySummary(policy) {
  return ({off:'1 档 · 停止自动回复',mentions:'2 档 · 仅在被 @ 时回复',probability:`3 档 · ${policy?.probability}% 概率`,all:'4 档 · 回复所有消息'})[policy?.mode] || '未设置';
}
function mountActiveConfigEditor(root) {
  const st = state.config?.store || {}, schedule = st.peakSchedule || {};
  const draft = {
    global: structuredClone(st.replyPolicy || policyFromLegacy(st)),
    peak: structuredClone(schedule.peak?.replyPolicy || policyFromLegacy(st, schedule.peak?.sliderPos ?? 10)),
    valley: structuredClone(schedule.valley?.replyPolicy || policyFromLegacy(st, schedule.valley?.sliderPos ?? 100)),
    start: schedule.peak?.start || '09:00', end: schedule.peak?.end || '18:00'
  };
  const head = root.closest('.setcard'), peakToggle = head.querySelector('#ac-peak-enabled');
  const choices = [['off','1 档','关闭自动回复'],['mentions','2 档','仅在被 @ 时回复'],['probability','3 档','按概率回复'],['all','4 档','对每条消息尝试回复']];
  const field = (key, name) => `<fieldset class="reply-policy" id="ac-policy-${key}"><legend>${name}</legend>
    <div class="reply-options">${choices.map(([mode,tier,text]) => `<label class="reply-option"><input type="radio" name="reply-${key}" value="${mode}" ${draft[key].mode === mode ? 'checked' : ''}><span><strong>${tier}</strong><span>${text}</span></span></label>`).join('')}</div>
    <div class="reply-probability" ${draft[key].mode === 'probability' ? '' : 'hidden'}><label for="reply-prob-${key}">回复概率</label><input id="reply-prob-${key}" type="number" min="0.1" max="99.9" step="0.1" value="${esc(draft[key].probability)}" aria-describedby="reply-range-${key}"><span>%</span><span class="hint" id="reply-range-${key}">0.1–99.9</span></div></fieldset>`;
  root.innerHTML = `<div id="ac-single">${field('global','回复模式')}</div><div id="ac-scheduled" hidden>${field('peak','高峰时段')}${field('valley','其余时段')}</div>
    <p class="hint">策略适用于白名单允许的群聊和私聊。第 2 档只处理 @，私聊不会自动回复。第 3 档对每条消息独立判断是否回复。</p>
    <div class="reply-actions"><button class="btn" id="ac-cancel" type="button">取消</button><button class="btn btn-primary" id="ac-save" type="button">保存</button><span class="hint" id="ac-save-status" role="status">选择「保存」后应用改动。</span></div>`;
  // This editor owns an explicit save boundary, independent of the surrounding auto-save form.
  root.addEventListener('input',e=>e.stopPropagation());
  root.addEventListener('change',e=>e.stopPropagation());
  function sync() {
    const enabled = peakToggle.checked;
    root.querySelector('#ac-single').hidden = enabled;
    root.querySelector('#ac-scheduled').hidden = !enabled;
    const summary = head.querySelector('.sc-val');
    if (summary) summary.textContent = enabled ? `峰 ${replyPolicySummary(draft.peak)} / 谷 ${replyPolicySummary(draft.valley)}` : replyPolicySummary(draft.global);
  }
  for (const key of ['global','peak','valley']) {
    const fieldset = root.querySelector(`#ac-policy-${key}`);
    fieldset.addEventListener('change',event=>{
      if (event.target.type === 'radio') {
        draft[key].mode = event.target.value;
        fieldset.querySelector('.reply-probability').hidden = event.target.value !== 'probability';
      }
      sync();
    });
    fieldset.querySelector('input[type=number]').addEventListener('input',event=>{
      draft[key].probability = event.target.value === '' ? '' : Number(event.target.value); sync();
    });
  }
  peakToggle.addEventListener('change',event=>{event.stopPropagation();sync();});
  async function save() {
    for (const key of peakToggle.checked ? ['peak','valley'] : ['global']) {
      const input = root.querySelector(`#ac-policy-${key} input[type=number]`);
      if (draft[key].mode === 'probability' && (!input.value || !input.checkValidity())) { input.reportValidity(); input.focus(); throw new Error('请输入 0.1% 到 99.9% 的回复概率，最多一位小数。'); }
    }
    const next = { replyPolicy: draft.global, unifiedTier: true, peakSchedule: { ...schedule, enabled: peakToggle.checked,
      peak: { ...schedule.peak, start:draft.start, end:draft.end, replyPolicy:draft.peak }, valley:{ ...schedule.valley, replyPolicy:draft.valley } } };
    const result = await api('/api/config',{method:'POST',body:JSON.stringify({store:next})});
    if(result.config) state.config=result.config;
  }
  const peakButton = head.querySelector('#ac-peak-btn');
  function openPeakSettings() {
    const modal = modelModalShell({head:'峰谷时段',body:`<div class="field-row"><div class="field"><label for="cfg-peak-start">高峰开始</label><input type="time" id="cfg-peak-start" value="${esc(draft.start)}" required></div><div class="field"><label for="cfg-peak-end">高峰结束</label><input type="time" id="cfg-peak-end" value="${esc(draft.end)}" required></div></div><p class="hint">高峰可以跨零点。高峰以外使用「其余时段」的回复模式。开始和结束时间相同时，全天使用「其余时段」。</p><div class="field"><label for="cfg-peak-preset">预设时段</label><select id="cfg-peak-preset"><option value="">选择预设</option><option value="09:00,18:00">工作时间 09:00–18:00</option><option value="22:00,07:00">夜间 22:00–07:00</option></select></div><p id="ac-peak-error" class="hint" role="alert"></p>`,foot:'<button class="btn" id="ac-peak-cancel">取消</button><button class="btn btn-primary" id="ac-peak-save">保存</button>'});
    modal.querySelector('#cfg-peak-preset').addEventListener('change',event=>{if(event.target.value){const [start,end]=event.target.value.split(',');modal.querySelector('#cfg-peak-start').value=start;modal.querySelector('#cfg-peak-end').value=end;}});
    modal.querySelector('#ac-peak-cancel').onclick=()=>closeModelModal(modal);
    modal.querySelector('#ac-peak-save').onclick=async()=>{
      const start=modal.querySelector('#cfg-peak-start'),end=modal.querySelector('#cfg-peak-end');
      if(!start.reportValidity()||!end.reportValidity())return;
      const previous=[draft.start,draft.end];draft.start=start.value;draft.end=end.value;
      try{await save();closeModelModal(modal);await loadSettings();}catch(error){[draft.start,draft.end]=previous;modal.querySelector('#ac-peak-error').textContent=error.message;}
    };
  }
  peakButton.addEventListener('click',e=>{e.stopPropagation();if(!e.target.closest('.switch,input'))openPeakSettings();});
  peakButton.addEventListener('keydown',e=>{if(e.target===peakButton&&['Enter',' '].includes(e.key)){e.preventDefault();openPeakSettings();}});
  root.querySelector('#ac-cancel').onclick=()=>renderSettings();
  root.querySelector('#ac-save').onclick=async()=>{const button=root.querySelector('#ac-save');button.disabled=true;try{await save();await loadSettings();}catch(error){root.querySelector('#ac-save-status').textContent=error.message;}finally{button.disabled=false;}};
  sync();
}


/**
 * 「创建技能 / 创建插件」引导模态框（技能页与插件页标题旁的 ＋ 按钮）。
 *
 * 定位：**引导**而不是代写 —— 控制台无法安全地往磁盘写任意代码，这个弹窗
 * 把用户带到正确的三样东西上：项目自带的脚手架脚本、开发文档、AI 桌面工具
 * 工作流。技能（LLM 型）与插件（确定性型）的文档路径不同，按 kind 切换。
 */
/* ═══ 社区市场：添加模态框 + 口令安装 ═══
   2026-09-19 新增。所有网络请求走本地后端代理（/api/market/*），
   浏览器不直连官网（CORS 边界 + 凭据不进前端 localStorage）。 */

/**
 * 「添加技能 / 添加插件」入口模态框。
 * 创建入口保持固定标签，悬停只改变背景颜色。
 */
function openAddModuleModal(kind) {
  const isSkill = kind === 'skill';
  const name = isSkill ? '技能' : '插件';
  const overlay = modelModalShell({
    head: `添加${name}`,
    body: `
      <div class="hint" style="margin-bottom:12px">查看创建指南，生成包含实际目录的开发提示词。</div>
      <div class="addmod-stack">
        <button class="addmod-big addmod-diy" id="addmod-diy">
          <span class="addmod-label">创建${name}</span>
        </button>
      </div>`,
    foot: `<button class="btn" id="addmod-cancel">取消</button>`
  });
  overlay.querySelector('#addmod-diy')?.addEventListener('click', () => {
    closeModelModal(overlay);
    openCreateModuleGuide(kind);
  });
  overlay.querySelector('#addmod-cancel')?.addEventListener('click', () => closeModelModal(overlay));
  return overlay;
}

/**
 * 口令安装模态框：逐行输入口令，失焦校验；
 * 「就这些吧」批量下载解压到对应目录（类型由服务器决定）。
 */
function openInstallCodeModal() {
  let codeRows = [];   // [{ code, status: 'idle'|'checking'|'ok'|'bad', entry }]
  const overlay = modelModalShell({
    head: '口令安装',
    body: `
      <div class="hint" style="margin-bottom:10px">
        在市场页找到想要的技能/插件，点「复制口令！」，把得到的口令填进来。
        每行一个；填完一行会自动校验。输完点「就这些吧」批量安装。
        <span class="muted">（技能口令和插件口令都行 —— 类型由服务器决定，会装进各自的页签）</span>
      </div>
      <div id="ic-rows"></div>
      <div class="hint" id="ic-status" style="margin-top:10px"></div>`,
    foot: `
      <button class="btn btn-primary" id="ic-confirm">就这些吧</button>
      <button class="btn" id="ic-cancel">算了算了</button>`
  });
  const rowsBox = overlay.querySelector('#ic-rows');
  const statusBox = overlay.querySelector('#ic-status');

  const renderRows = () => {
    rowsBox.innerHTML = codeRows.map((r, i) => {
      const cls = r.status === 'ok' ? ' ok' : (r.status === 'bad' ? ' bad' : (r.status === 'checking' ? ' checking' : ''));
      const dim = r.status === 'ok' ? ' dim' : (r.status === 'bad' ? '' : '');
      const badge = r.status === 'ok'
        ? `<span class="ic-check">✅</span><span class="ic-meta">${esc(r.entry?.name || '')}<span class="muted"> · ${esc(r.entry?.author || '')} · ${r.entry?.type === 'plugin' ? '插件' : '技能'}</span></span>`
        : '';
      return `<div class="ic-row${cls}${dim}">
        <input type="text" class="ic-input" data-idx="${i}" value="${esc(r.code)}"
          placeholder="${r.status === 'ok' ? '已匹配' : '输入 6 位口令'}"
          autocomplete="off" spellcheck="false" ${r.status === 'ok' ? 'readonly' : ''} />
        <button class="ic-del" data-idx="${i}" title="删除这行" aria-label="删除第 ${i + 1} 行">🗑</button>
        ${badge}
      </div>`;
    }).join('');
    // 绑定输入：失焦且有内容 → 触发校验 + 追加新行
    rowsBox.querySelectorAll('.ic-input').forEach((inp) => {
      inp.addEventListener('blur', async () => {
        const idx = Number(inp.dataset.idx);
        const code = inp.value.trim().toUpperCase();
        if (!code) return;
        if (codeRows[idx]?.code === code && codeRows[idx]?.status === 'ok') return;
        codeRows[idx] = { code, status: 'checking', entry: null };
        renderRows();
        try {
          const r = await api('/api/market/verify', { method: 'POST', body: JSON.stringify({ codes: [code] }) });
          const hit = (r.results || [])[0];
          if (codeRows[idx]?.code !== code) return;   // 期间被删/改过，丢弃结果
          if (hit?.ok) {
            codeRows[idx] = { code, status: 'ok', entry: hit };
            // 失焦且有内容 → 下一行出现（只在没有空行时追加）
            if (!codeRows.some((x) => !x.code)) codeRows.push({ code: '', status: 'idle', entry: null });
          } else {
            codeRows[idx] = { code, status: 'bad', entry: null };
          }
        } catch (e) {
          if (codeRows[idx]?.code === code) codeRows[idx] = { code, status: 'bad', entry: null };
          statusBox.textContent = `校验失败：${e?.message || e}`;
        }
        renderRows();
      });
    });
    rowsBox.querySelectorAll('.ic-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        codeRows.splice(Number(btn.dataset.idx), 1);
        if (!codeRows.length) codeRows.push({ code: '', status: 'idle', entry: null });
        renderRows();
      });
    });
  };
  codeRows.push({ code: '', status: 'idle', entry: null });
  renderRows();

  overlay.querySelector('#ic-cancel')?.addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#ic-confirm')?.addEventListener('click', async () => {
    const btn = overlay.querySelector('#ic-confirm');
    const ready = codeRows.filter((r) => r.status === 'ok' && r.entry);
    if (!ready.length) {
      statusBox.textContent = '还没有成功对接的口令（先把口令填对，等它变绿带 ✅）。';
      return;
    }
    btn.disabled = true;
    let installed = 0;
    const notes = [];
    for (const r of ready) {
      statusBox.textContent = `正在安装 ${installed + 1}/${ready.length}：${r.entry?.name || r.code}…`;
      try {
        const res = await api('/api/market/install', {
          method: 'POST',
          body: JSON.stringify({ code: r.code, entry: r.entry })
        });
        installed++;
        notes.push(`${res.kind === 'plugin' ? '插件' : '技能'} ${res.id} 已安装`);
      } catch (e) {
        notes.push(`${r.entry?.name || r.code} 安装失败：${e?.message || e}`);
      }
    }
    statusBox.textContent = installed
      ? `安装完成：${installed} 个。${notes.join('；')}`
      : `全部失败。${notes.join('；')}`;
    btn.disabled = false;
    if (installed) {
      // 刷新两个页签（安装的类型可能在另一页）
      await loadModulePage('skill', { rescan: true }).catch(() => {});
      await loadModulePage('plugin', { rescan: true }).catch(() => {});
      setTimeout(() => closeModelModal(overlay), 1200);
    }
  });
  return overlay;
}

/**
 * 「自己造个技能/插件」引导（2026-09-19 零门槛版）。
 *
 * 面向完全非技术人员：没有命令行、不用找文件夹、不用懂"放进目录"。
 * 全部工作交给一段**复制出去的提示词**：用户把它粘进任意 AI 桌面工具
 * （ZCode / WorkBuddy / Qoder / DeepSeek Harness…），AI 会自己——
 *   ① 找到项目里的开发文档并读懂
 *   ② 通过提问确认用户想要什么、并判定该做成技能还是插件（多数人分不清）
 *   ③ 按文档规范生成 skill.json/plugin.json + index.js
 *   ④ 直接把文件写进 skills/<id>/ 或 plugins/<id>/（热重载自动生效）
 *
 * 提示词里写死了"三步自检"（类型判定 → 文档路径 → 落盘位置），
 * 用户不需要理解其中任何一个术语。
 */
/** Build a prompt only from the running application's verified extension paths. */
function buildModuleCreationPrompt(kind, workspace) {
  const name = kind === 'skill' ? '技能' : '插件';
  const documents = workspace.documents.map(doc => `- ${doc.path}`).join('\n');
  return `我使用 Alcor Agent，希望你帮我开发一个${name}。我不会写代码，请完成需求确认、实现、文件放置和本地验证。

【实际安装位置】
以下位置由当前运行的 Alcor Agent 根据应用文件自动识别；不是示例路径，也不是从聊天数据目录推算的：
应用资源目录：${workspace.appRoot}
技能目录：${workspace.skillsDir}
插件目录：${workspace.pluginsDir}
开发说明目录：${workspace.docsDir}
如果你所在的电脑无法访问这些路径，先确认是否在同一台电脑，不要猜测另一个盘符或目录。

【先阅读当前规范】
${documents}
使用现有 Skill API 1、清单格式和加载器，不重写框架。需要进一步核对时，阅读应用资源目录中的 src/plugin-loader.js、src/skills/manifest.js、src/skills/manager.js 和 src/tool-registry.js。先确认接口存在再调用，不编造方法。

【确认需求和类型】
先询问：需要什么功能、何时触发、输入与输出是什么？
模型根据意图选择调用的功能使用技能；固定条件下执行的流程处理使用插件。我从“${name}”入口进入，但如果选错类型，请解释后采用适合的目录。

【内容偏好】
避免涉政、色情及有害内容，不生成教唆违法或伤害他人的功能。普通口头禅、吐槽、包含脏话的表达风格可按我的喜好配置，不因粗口就拒绝整个需求；不要转变为针对个人或群体的骚扰。

【实现和放置】
1. 先读取已有同名目录，有文件时保留备份，避免覆盖我的配置。
2. 技能写入“${workspace.skillsDir}”下面的 <id> 文件夹，包含 skill.json 和 index.js；插件写入“${workspace.pluginsDir}”下面的 <id> 文件夹，包含 plugin.json 和 index.js。<id> 使用简短的小写英文标识。
3. 只修改这个扩展需要的文件，保留原有功能。检查依赖、配置字段、注册入口和禁用/卸载时的资源清理。
4. 当前自动重载${workspace.hotReload ? '已开启，可观察加载结果' : '未开启'}；完成后在对应页面点击“刷新”进行真实重扫，并确认已加载、已启用、依赖已就绪。不要仅凭写入文件就宣称生效。
5. 先用本地模拟输入验证，不默认发送真实 QQ 消息或调用付费模型。需要实际测试时，确认测试对象和范围；核心暂不支持的能力须明确告知，不能伪造成功。

【交付】
说明生成了什么、文件实际放在哪、怎样在 Alcor Agent 中启用，以及已验证和未验证的部分。若加载失败，检查页面原因并修复，不把无法执行的命令或不存在的路径交给我。

现在先简短地问我想实现什么功能。`;
}

function openCreateModuleGuide(kind) {
  const name = kind === 'skill' ? '技能' : '插件';
  let prompt = '';
  const overlay = modelModalShell({
    head: `创建${name}`,
    body: `
      <p class="hint">将下方提示词交给能够读取本机文件的 AI 工具，说明需要的功能。程序会提供实际目录和当前开发说明。</p>
      <pre class="guide-code" id="cmg-paths" style="white-space:pre-wrap;overflow-wrap:anywhere">正在读取扩展目录…</pre>
      <pre class="guide-code" id="cmg-prompt" style="max-height:260px;overflow:auto;user-select:all;white-space:pre-wrap;overflow-wrap:anywhere" aria-label="开发提示词"></pre>
      <p class="hint" id="cmg-error" role="alert" hidden></p>
      <p class="hint" id="cmg-copied" role="status" style="min-height:18px"></p>`,
    foot: `<button class="btn btn-primary" id="cmg-copy" disabled>复制开发提示词</button>
           <button class="btn" id="cmg-retry" hidden>重新读取路径</button>
           <button class="btn" id="cmg-close">关闭</button>`
  });
  const copyButton = overlay.querySelector('#cmg-copy');
  const retryButton = overlay.querySelector('#cmg-retry');
  const errorBox = overlay.querySelector('#cmg-error');
  async function loadWorkspace() {
    copyButton.disabled = true; retryButton.hidden = true; errorBox.hidden = true;
    try {
      const workspace = await api('/api/extensions/workspace');
      if (!overlay.isConnected || overlay.classList.contains('closing')) return;
      if (!workspace.appRoot || !workspace.skillsDir || !workspace.pluginsDir || !Array.isArray(workspace.documents) || workspace.documents.length !== 4) throw new Error('路径信息不完整');
      prompt = buildModuleCreationPrompt(kind, workspace);
      overlay.querySelector('#cmg-paths').textContent = `技能目录：${workspace.skillsDir}\n插件目录：${workspace.pluginsDir}\n开发说明：${workspace.docsDir}`;
      overlay.querySelector('#cmg-prompt').textContent = prompt;
      copyButton.disabled = false;
    } catch {
      if (!overlay.isConnected || overlay.classList.contains('closing')) return;
      prompt = '';
      overlay.querySelector('#cmg-paths').textContent = '尚未取得当前安装路径';
      errorBox.textContent = '无法读取扩展目录。若刚更新程序，请从托盘退出并重新启动 Alcor Agent，再点击“重新读取路径”。不会用猜测的目录生成提示词。';
      errorBox.hidden = false; retryButton.hidden = false;
    }
  }
  copyButton.addEventListener('click', async () => {
    if (!prompt) return;
    let ok = false;
    try { await navigator.clipboard.writeText(prompt); ok = true; }
    catch {
      const range = document.createRange(); range.selectNodeContents(overlay.querySelector('#cmg-prompt'));
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      try { ok = document.execCommand?.('copy') || false; } catch { ok = false; }
    }
    if (overlay.isConnected) overlay.querySelector('#cmg-copied').textContent = ok ? '已复制开发提示词。请粘贴到能够访问本机文件的 AI 工具。' : '已选中提示词，请按 Ctrl+C 手动复制。';
  });
  retryButton.addEventListener('click', loadWorkspace);
  overlay.querySelector('#cmg-close').addEventListener('click', () => closeModelModal(overlay));
  loadWorkspace();
  return overlay;
}
