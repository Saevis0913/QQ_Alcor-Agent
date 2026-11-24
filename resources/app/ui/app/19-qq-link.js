// QQ 接入诊断：把「连不上 QQ」拆成能对症的原因，并在同一个卡片里给出动作。
// 判定来自 /api/qq/diagnosis（服务端与随包排查程序共用同一份 src/qq-diagnosis.js）。
(() => {
  if (typeof document === 'undefined') return;
  const SHORT = {
    ALREADY_CONNECTED: '已连接',
    RECEIVE_NOT_READY: '通道未就绪',
    QQ_LOGIN_NOT_CONFIRMED: '账号未确认',
    READY_TO_CONNECT: '可以连接',
    NO_QQ_RUNNING: 'QQ 没在运行',
    UNSUPPORTED_BUILD: 'QQ 版本未适配',
    QQ_BUILD_UNLISTED: 'QQ 未登记可试',
    HOST_PRESENT: '宿主残留',
    FOREIGN_MODULES: '其它框架残留',
    PROCESS_SCAN_FAILED: '进程扫描失败',
    PROCESS_UNREADABLE: '读不到 QQ',
    CORE_OFFLINE: '核心没运行',
    ALCOR_CONFIG_INVALID: '配置不可用',
    ALCOR_AUTH_FAILED: '核心鉴权被拒',
    ALCOR_IDENTITY_MISMATCH: '端口服务不匹配',
    ALCOR_UNAVAILABLE: '核心无响应',
    ONEBOT_AUTH_FAILED: 'OneBot 鉴权被拒',
    ONEBOT_EVENTS_UNAVAILABLE: '事件通道未连接',
    ONEBOT_ACCOUNT_OFFLINE: '账号离线',
    ONEBOT_STATUS_UNAVAILABLE: '账号状态未确认',
    ELEVATION_MISMATCH: '权限不一致',
    SESSION_MISMATCH: '会话不一致',
    ARCH_MISMATCH: 'QQ 非 64 位',
    HOST_RUNTIME_BROKEN: '注入组件缺失',
    INJECTION_BLOCKED: '连接失败',
    HOST_ALREADY_PRESENT: 'Alcor 宿主已驻留',
    PROFILE_SCANNER_MISSING: '缺适配组件',
    PROFILE_SCAN_FAILED: '版本推导失败',
    PROFILE_SCAN_MISMATCH: '扫描期间QQ变了',
    PROFILE_WRAPPER_NOT_FOUND: '找不到wrapper',
    PROFILE_VERSION_UNSUPPORTED: '版本号无法登记',
    PROFILE_PATCH_FAILED: '补丁生成失败',
    PROFILE_VERIFY_FAILED: '补丁自检失败',
    PROFILE_PACK_FAILED: '补丁包写入失败',
    HOST_START_INCOMPLETE: '注入流程没走完',
    HOST_ARTIFACT_INVALID: '宿主组件校验失败',
    HOST_TARGET_DENIED: '拒绝注入该进程',
    HOST_LOAD_BLOCKED: '加载宿主被拦',
    HOST_ENTRY_FAILED: '宿主入口执行失败',
    HOST_REFERENCE_STUCK: '加载器句柄没释放',
    HOST_THREAD_PENDING: '宿主线程未完成',
    HOST_LOADER_MISSING: '注入器缺失',
    HOST_LOADER_TIMEOUT: '注入器超时',
    HOST_LOADER_FAILED: '注入器执行失败',
    IDENTITY_SERVICE_NULL: '这版 QQ 账号读不到',
    IDENTITY_ACCOUNT_ZERO: '登录还没走完',
    IDENTITY_CALL_FAILED: '取账号调用失败',
    IDENTITY_UNREADABLE: '这版 QQ 账号读不到',
    IDENTITY_SERVICE_UNBOUND: '已连上但收发不可用',
  SERVICE_NEVER_CREATED: 'QQ 未创建消息服务对象',
    PROFILE_SCAN_LOW_CONFIDENCE: '这版 QQ 结构对不上锚点',
    POLICY_HVCI_ON: '内存完整性开着',
    POLICY_SAC_ENFORCING: '应用控制强制',
    POLICY_SAC_EVALUATION: '应用控制评估中',
    POLICY_DEFENDER_REALTIME: 'Defender 未排除',
    POLICY_ASR_RANSOMWARE: 'ASR 规则拦注入',
    POLICY_QQ_CIG: 'QQ 只认签名模块',
    POLICY_QQ_CIG_CONFIRMED_BLOCK: 'QQ 已拒未签名模块',
    POLICY_QQ_ACG: 'QQ 禁止动态代码',
    POLICY_QQ_BLOCK_REMOTE_IMAGE: 'QQ 拒网络路径模块',
    POLICY_QQ_BLOCK_LOW_LABEL: 'QQ 拒低完整性模块',
    POLICY_CODE_INTEGRITY_BLOCK: '代码完整性已拦',
    POLICY_CODE_INTEGRITY_AUDIT: '代码完整性审计',
    POLICY_AV_QUARANTINE: '安全软件处置过',
    POLICY_ARTIFACT_HASH_MISMATCH: '宿主组件被改过',
    POLICY_EVIDENCE_UNCONFIRMED: '尚未确认是它拦的'
  };
  const shortOf = (code) => SHORT[code] || '未连接';
  let busy = false;

  function rowHtml(row, flags) {
    let state = '<span class="qq-bad">版本未适配</span>';
    if (row.reason === 'PROCESS_INSPECTION_UNAVAILABLE') state = '<span class="qq-warn">无法读取版本</span>';
    else if (row.supported) {
      state = row.verification === 'live'
        ? '<span class="qq-ok">受支持 · 已实网验证</span>'
        : '<span class="qq-warn">受支持 · 静态适配</span>';
    }
    const notes = [];
    if (flags?.foreignSession?.includes(row.pid)) notes.push('其他 Windows 会话');
    if (flags?.elevatedQQ?.includes(row.pid)) notes.push('以管理员运行');
    const arch = flags?.archMismatch?.find((item) => item?.pid === row.pid)?.arch;
    if (arch) notes.push('架构 ' + arch);
    if (row.foreignModules?.length) notes.push(`外来模块：${row.foreignModules.join('、')}`);
    if (row.alcorHostLoaded) notes.push('Alcor 宿主已驻留');
    return `<li><span class="qq-pid">${esc(String(row.pid))}</span>
      <span class="qq-ver">${esc(row.version || '未知版本')}</span>${state}
      ${notes.length ? `<em>${esc(notes.join(' · '))}</em>` : ''}</li>`;
  }

  function cardHtml(v) {
    const showNative = v.backendType !== 'onebot' && !v.code?.startsWith('ALCOR_');
    const cls = v.code === 'ALREADY_CONNECTED' ? 'qq-good' : (v.code === 'READY_TO_CONNECT' ? 'qq-ready' : 'qq-bad');
    const canConnect = ['READY_TO_CONNECT', 'HOST_PRESENT', 'FOREIGN_MODULES'].includes(v.code);
    const failure = v.failure;
    const failureText = failure && [failure.code, failure.detail !== v.detail && failure.detail, failure.at].filter(Boolean).join(' · ');
    const emptyText = v.processScanError ? '读取 QQ 进程清单失败' : '没有检测到运行中的 QQ';
    const dirs = (v.frameworkDirs || []).map((d) => `<li>硬盘上还有 ${esc(d.name)}：<code>${esc(d.path)}</code></li>`).join('');
    return `
      <div class="qq-head ${cls}">
        <strong>${esc(v.title || 'QQ 未连接')}</strong>
        <span class="qq-code">${esc(v.code || '')}</span>
      </div>
      ${v.detail ? `<p class="qq-detail">${esc(v.detail)}</p>` : ''}
      ${v.hint ? `<p class="qq-hint">${esc(v.hint)}</p>` : ''}
      ${failureText ? `<p class="qq-detail">上次失败 · ${esc(failureText)}</p>` : ''}
      ${v.code === 'IDENTITY_SERVICE_UNBOUND' || v.connection?.serviceBound === false
        ? '<p class="qq-detail">消息服务未绑定：账号读到了，但收发不会生效。重启 QQ 再连一次；仍然如此就改用 OneBot 接入。</p>' : ''}
      ${showNative && v.running !== false ? `<ul class="qq-procs">${(v.processes || []).map((row) => rowHtml(row, v.compat?.flags)).join('') || `<li class="qq-empty">${emptyText}</li>`}</ul>` : ''}
      ${compatHtml(v)}
      ${policyHtml(v)}
      ${dirs ? `<ul class="qq-dirs">${dirs}</ul>` : ''}
      <div class="qq-acts">
        ${showNative ? '<button class="btn btn-primary btn-small" data-qq="auto">一键检测并连接</button>' : ''}
        ${canConnect ? '<button class="btn btn-small" data-qq="connect">只连接这一个</button>' : ''}
        ${showNative ? '<button class="btn btn-small" data-qq="restart">重启 QQ 后重试</button>' : ''}
        <button class="btn btn-small" data-qq="rescan">重新检测</button>
        ${(v.code === 'IDENTITY_SERVICE_UNBOUND' || v.code === 'SERVICE_NEVER_CREATED') ? '<button class="btn btn-small" data-policy="onebot">改用 OneBot 接入</button>' : ''}
        <span class="qq-note">排查程序（安装目录）：「控制台无法连接，显示被占用点这个，对照最后一行判定码.cmd」</span>
      </div>
      <div class="qq-switch"></div>
      <p class="qq-status" role="status"></p>`;
  }

  // 环境事实：版本与外来框架之外，真正让注入失败的东西（权限/会话/安全策略/注入器）。
  function compatHtml(v) {
    const c = v.compat;
    if (!c) return '';
    const bits = [];
    if (c.supported === false) bits.push('Windows 环境探测未完成');
    if (c.os?.version) bits.push(`系统 ${esc(c.os.version)}${c.os.arch ? ' · ' + esc(c.os.arch) : ''}`);
    if (c.self) bits.push(`Alcor 会话 ${esc(String(c.self.sessionId))} · ${c.self.elevated ? '管理员' : '普通权限'}`);
    if (c.qq?.length) bits.push(c.qq.map((q) => `QQ ${esc(String(q.pid))} · ${esc(q.arch || '未知架构')}${q.store ? ' · 商店版' : ''}`).join('；'));
    const loader = c.loader || {};
    bits.push(loader.ran ? '注入器可运行' : `注入器不可用（${esc(loader.reason || '未知')}）`);
    bits.push(c.hostDll?.ok ? '宿主 DLL 正常' : '宿主 DLL 缺失');
    const sec = c.security || {};
    if (sec.hvci === 1) bits.push('内存完整性已开启');
    if (sec.smartAppControl === 1 || sec.smartAppControl === 2) bits.push('智能应用控制已开启');
    if (sec.defender?.realtime === false) bits.push('Defender 实时保护关闭');
    const warn = (v.warnings || []).filter(Boolean);
    return `<p class="qq-compat">${bits.join(' · ')}</p>${warn.length ? `<p class="qq-warnline">注意：${esc(warn.join('、'))}</p>` : ''}`;
  }

  // 防护策略：只说两种口径——「已确认被拦」和「只是环境提示，尚未确认」。
  function policyHtml(v) {
    const p = v.policy;
    if (!p || !p.ok) return '';
    const findings = p.findings || [];
    if (!findings.length) return '<p class="qq-compat">防护策略：未发现限制</p>';
    const items = findings.map((f) => {
      const tone = f.level === 'block' ? 'qq-bad' : f.level === 'warn' ? 'qq-warn' : 'qq-ok';
      const label = f.level === 'block' ? '会拦' : f.level === 'warn' ? '可能拦' : '提示';
      return `<li><span class="${tone}">${label}</span> ${esc(f.title)}${f.detail ? `<em>${esc(f.detail)}</em>` : ''}</li>`;
    }).join('');
    const acts = [];
    if ((p.remedies || []).some((r) => r.id === 'defender-exclusion')) acts.push('<button class="btn btn-small" data-policy="defender">为 Alcor 加 Defender 排除项</button>');
    if (p.report?.self?.elevated === false) acts.push('<button class="btn btn-small" data-policy="admin">以管理员重启</button>');
    return `<div class="qq-policy"><p class="qq-compat">防护策略：${esc(p.summary || '')}</p><ul class="qq-dirs">${items}</ul><div class="qq-acts">${acts.join('')}</div></div>`;
  }

  // 原生注入拿不到消息服务的机器：在这里完成到 OneBot 的切换，用户不用自己动安装目录。
  function editionFormHtml(v) {
    const onebot = v.onebotEdition || {};
    return `<form class="qq-edition" data-edition="onebot">
      <p class="qq-detail">改用 OneBot 进程外接入：Alcor 通过本机 OneBot v11 服务收发消息，不再向 QQ 注入任何模块。需要一台正在运行的本机 OneBot 服务。</p>
      <div class="field"><label>HTTP API 地址</label><input name="httpUrl" type="url" value="${esc(onebot.httpUrl || 'http://127.0.0.1:3000')}" required></div>
      <div class="field"><label>WebSocket 事件地址</label><input name="wsUrl" type="url" value="${esc(onebot.wsUrl || 'ws://127.0.0.1:3001')}" required></div>
      <div class="field"><label>访问令牌（服务未要求可留空）</label><input name="accessToken" type="password" autocomplete="off"></div>
      <div class="qq-acts"><button class="btn btn-ghost btn-small" type="button" data-edition-test>测试连接</button><button class="btn btn-primary btn-small" type="submit">保存并启用 OneBot 接入</button></div>
      <p class="qq-status" role="status"></p>
    </form>`;
  }

  async function paint(box, { status = '' } = {}) {
    box.innerHTML = '<p class="qq-detail">正在检查连接…</p>';
    try {
      const result = await api('/api/qq/diagnosis');
      const v = result.data || {};
      box.innerHTML = cardHtml(v);
      bind(box, v);
    } catch (error) {
      box.innerHTML = `<p class="qq-hint">读取失败：${esc(String(error?.message || error))}</p>`
        + '<p class="qq-status" role="status"></p>';
    }
    if (status) setStatus(box, status);
  }

  function setStatus(box, text) {
    const node = box.querySelector('.qq-status');
    if (!node) return;
    node.textContent = text;
    node.style.whiteSpace = 'pre-wrap';
  }

  function bind(box, v) {
    box.querySelectorAll('[data-qq]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        const kind = button.dataset.qq;
        box.querySelectorAll('[data-qq]').forEach((b) => { b.disabled = true; });
        try {
          if (kind === 'auto' || kind === 'force') {
            setStatus(box, kind === 'force' ? '正在按兼容模式尝试注入（QQ 可能会重启）…' : '正在按顺序检查并连接，最长约一分钟…');
            const body = kind === 'force' ? JSON.stringify({ allowUnverified: true }) : '{}';
            const result = await api('/api/qq/autoconnect', { method: 'POST', body });
            const data = result.data || {};
            const lines = (data.steps || []).map((step) => (step.status === 'error' ? '✗ ' : step.status === 'manual' ? '! ' : step.status === 'retry' ? '↻ ' : '· ') + step.text);
            const tail = data.code === 'ALREADY_CONNECTED' ? '已连接，完成。' : data.code === 'CONNECTED' ? '注入成功，正在确认账号…' : data.code === 'WAITING_LOGIN' ? 'QQ 已打开，登录后在下面点「重新扫描」。' : '结果：' + (data.code || '未知');
            await paint(box, { status: [...lines, tail].join('\n') });
            const fresh = { ...v };
            if (data.needConsent) {
              const acts = box.querySelector('.qq-acts');
              if (acts && !acts.querySelector('[data-qq="force"]')) {
                const btn = document.createElement('button');
                btn.className = 'btn btn-primary btn-small';
                btn.dataset.qq = 'force';
                btn.textContent = '仍然尝试注入';
                acts.prepend(btn);
              }
            }
            if (data.canRelaunchAdmin) {
              const acts = box.querySelector('.qq-acts');
              if (acts && !acts.querySelector('[data-qq="admin"]')) {
                const btn = document.createElement('button');
                btn.className = 'btn btn-small';
                btn.dataset.qq = 'admin';
                btn.textContent = '以管理员重启';
                acts.prepend(btn);
              }
            }
            bind(box, fresh);
            if (typeof refreshStatus === 'function') refreshStatus();
            return;
          }
          if (kind === 'admin') {
            setStatus(box, '正在以管理员身份重启…');
            const result = await api('/api/app/relaunch-admin', { method: 'POST', body: '{}' });
            setStatus(box, result.status === 'ok' ? '已请求提权启动，稍等新窗口出现后再点「重新扫描」。' : '提权失败：' + (result.error || result.wording || '未知原因'));
            return;
          }
          let status = '';
          if (kind === 'connect') {
            setStatus(box, '正在连接 QQ…');
            const result = await api('/api/qq/connect', { method: 'POST', body: JSON.stringify({ pid: v.candidate?.pid }) });
            status = result.status === 'ok' ? '已提交连接，正在确认账号…' : `连接失败：${result.error || result.wording || '未知原因'}`;
          } else if (kind === 'restart') {
            setStatus(box, '正在关闭 QQ 并重新启动，最多等 40 秒…');
            const result = await api('/api/qq/restart', { method: 'POST', body: '{}' });
            status = result.status === 'ok' ? `QQ 已重启（${result.data?.processes ?? 0} 个进程）` : `重启失败：${result.error || result.wording || '未知原因'}`;
          } else {
            setStatus(box, '正在重新扫描…');
          }
          await paint(box, { status });
          if (typeof refreshStatus === 'function') refreshStatus();
        } catch (error) {
          setStatus(box, `操作失败：${String(error?.message || error)}`);
        } finally {
          busy = false;
          box.querySelectorAll('[data-qq]').forEach((b) => { b.disabled = false; });
        }
      });
    });
      // 防护策略的动作：加排除项 / 提权重启 / 改走 OneBot（不依赖注入）
      box.querySelectorAll('[data-policy]').forEach((button) => {
        if (!button?.dataset?.policy) return; // 选择器兜底：只接真正带 data-policy 的按钮
        button.addEventListener('click', async () => {
          if (busy) return;
          busy = true;
          const kind = button.dataset.policy;
          button.disabled = true;
          try {
            if (kind === 'defender') {
              setStatus(box, '正在请求管理员权限添加排除项（会弹一次 UAC）…');
              const result = await api('/api/policy/defender-exclusion', { method: 'POST', body: '{}' });
              const added = (result.data?.added || []).join('、');
              await paint(box, { status: result.status === 'ok' ? `已加入排除项：${added || '本来就有'}` : `添加失败：${result.error || result.wording || '未知原因'}` });
              return;
            }
            if (kind === 'admin') {
              setStatus(box, '正在以管理员身份重启…');
              const result = await api('/api/app/relaunch-admin', { method: 'POST', body: '{}' });
              setStatus(box, result.status === 'ok' ? '已请求提权启动，稍等新窗口出现。' : '提权失败：' + (result.error || result.wording || '未知原因'));
              return;
            }
            const host = box.querySelector('.qq-switch');
            if (!host) { setStatus(box, '找不到切换区域，请刷新页面重试。'); return; }
            host.innerHTML = editionFormHtml(v);
            const form = host.querySelector('form[data-edition]');
            const note = form.querySelector('.qq-status');
            const payloadOf = () => {
              const data = new FormData(form);
              return {
                httpUrl: String(data.get('httpUrl') || '').trim(),
                wsUrl: String(data.get('wsUrl') || '').trim(),
                accessToken: String(data.get('accessToken') || '')
              };
            };
            form.querySelector('[data-edition-test]')?.addEventListener('click', async () => {
              const payload = payloadOf();
              note.textContent = '正在测试连接…';
              try {
                const report = await api('/api/edition/test', { method: 'POST',
                  headers: { 'x-alcor-local-action': 'configure-onebot' }, body: JSON.stringify(payload) });
                const sides = [report.http ? (report.http.ok ? `HTTP ${report.http.ms} ms` : 'HTTP 失败：' + (report.http.error || '未知')) : '',
                  report.ws ? (report.ws.ok ? `WS ${report.ws.ms} ms` : 'WS 失败：' + (report.ws.error || '未知')) : '']
                  .filter(Boolean).join(' / ');
                note.textContent = (report.ok ? '✓ ' : '✗ ') + (report.message || '') + (sides ? '\n' + sides : '');
              } catch (error) {
                note.textContent = '测试失败：' + String(error?.message || error);
              }
            });
            form.addEventListener('submit', async (event) => {
              event.preventDefault();
              const payload = payloadOf();
              note.textContent = '正在保存…';
              try {
                const saved = await api('/api/edition/onebot', { method: 'POST',
                  headers: { 'x-alcor-local-action': 'configure-onebot' }, body: JSON.stringify(payload) });
                note.textContent = saved?.note || '已保存。重启 Alcor Agent 后启用 OneBot 接入。';
              } catch (error) {
                note.textContent = '保存失败：' + String(error?.message || error);
              }
            });
            return;
          } catch (error) {
            setStatus(box, `操作失败：${String(error?.message || error)}`);
          } finally {
            busy = false;
            button.disabled = false;
          }
        });
      });
  }

  window.renderQqLinkCard = function renderQqLinkCard() {
    const box = document.getElementById('qq-link-card');
    if (!box) return;
    paint(box);
  };

  document.addEventListener('DOMContentLoaded', () => window.renderQqLinkCard());
  window.qqShortOf = shortOf;
})();
