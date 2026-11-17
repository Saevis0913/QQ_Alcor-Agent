const QQ = /^[1-9]\d{4,10}$/;
const CATEGORIES = { send: '消息发送', tool: '工具', run: '会话运行', status: '状态' };
// Copy only known, fixed labels into the ring. Even exception codes can contain credentials.
const CODES = new Map([
  ['DELIVERY_UNKNOWN', '送达未知'],
  ['SENDER_BOOKKEEPING_FAILED', '发送后本地记录异常'],
  ['AGENT_ACCOUNT_CHANGED', '发送时账号变化'],
  ['AGENT_OPERATION_FAILED', '操作失败'],
  ['BACKEND_UNREADY', '原生服务未就绪'],
  ['BACKEND_DISCONNECTED', 'QQ 连接断开'],
  ['RECEIVE_UNREADY', 'QQ 收件未就绪'],
  ['BUILTIN_USAGE_SAVE_FAILED', '扩展用量记录失败'],
  ['BUILTIN_DAILY_LIMIT', '扩展模型用量达到上限'],
  ['BUILTIN_MODEL_FAILED', '后台模型任务失败'],
  ['REPLY_MODE_OFF', '会话回复已关闭'],
  ['HTTP_401', '身份验证失败'],
  ['HTTP_403', '服务拒绝请求'],
  ['HTTP_429', '服务限流'],
  ['HTTP_500', '服务异常'],
  ['HTTP_502', '网关异常'],
  ['HTTP_503', '服务暂不可用'],
  ['HTTP_504', '网关超时']
]);
const SEND_TOOLS = new Set(['send_message', 'send_to', 'send_sticker', 'send_image', 'send_forward',
  'send_poke', 'poke', 'gengjing__send', 'profile-like__send_profile_like']);
const DIGEST_TOOL = 'admin-digest__admin_digest';
const MAX_ROWS = 32;
const COALESCE_MS = 300000;
const MIN_REPORT_DELAY = 10000;
const failure = (code, message) => Object.assign(new Error(message), { code });

function privatePeer(ctx) {
  const [, peer] = /^private:([1-9]\d{4,10})$/.exec(String(ctx?.chatKey ?? '')) ?? [];
  if (!peer || ctx.proactive === true || (ctx.kind && ctx.kind !== 'private') ||
      (ctx.chatId && String(ctx.chatId) !== peer)) return '';
  return peer;
}

export function canReadAdminErrors(ctx, admins) {
  const peer = privatePeer(ctx);
  return Boolean(peer && Array.isArray(admins) && admins.some((value) => String(value) === peer));
}

function statusText(state) {
  const native = state.backendReady === true ? '正常' : '未就绪';
  const qq = state.connected === true ? '已连接' : '未连接';
  const receive = state.receiveReady === true ? '就绪' : '未就绪';
  return `QQ ${qq}，原生服务${native}，收件${receive}${state.paused === true ? '，回复已暂停' : ''}`;
}

function errorLines(rows, limit) {
  return rows.slice(-limit).reverse().map((row) =>
    `${CATEGORIES[row.category]} · ${CODES.get(row.code) ?? '操作失败'} · ${row.count} 次`);
}

export function createAdminErrors({ runtime, isEnabled, getAdmins, getSettings }) {
  const attempts = new WeakSet();
  const pendingReports = new Map();
  const controller = new AbortController();
  let current = runtime.account();
  let statusCode = '';
  let rows = [];
  let timer;
  let lastReportAt;
  let autoInFlight = false;
  let epoch = new AbortController();
  const active = () => !controller.signal.aborted && isEnabled();
  const delay = () => Math.max(60, Math.min(3600, Number(getSettings().intervalSeconds) || 300)) * 1000;
  const enabledReport = () => active() && getSettings().autoReport === true;
  const isCurrent = account => active() && QQ.test(account) && runtime.isCurrent(account);
  const admins = () => {
    const values = getAdmins();
    return Array.isArray(values) ? values.map(String).filter(id => QQ.test(id)) : [];
  };

  function target() {
    const configured = String(getSettings().reportToQQ ?? '').trim();
    const list = admins();
    return configured ? (list.includes(configured) ? configured : '') : (list[0] || '');
  }

  function cancelPending() {
    pendingReports.clear();
    clearTimeout(timer);
    timer = undefined;
    epoch.abort();
    epoch = new AbortController();
  }

  function reset(next) {
    current = next;
    rows = [];
    statusCode = '';
    lastReportAt = undefined;
    cancelPending();
  }

  function schedule() {
    if (timer || autoInFlight || !pendingReports.size || !enabledReport() || !target()) return;
    const wait = Math.max(MIN_REPORT_DELAY, lastReportAt === undefined ? 0 : lastReportAt + delay() - runtime.now());
    timer = setTimeout(async () => {
      timer = undefined;
      const account = current;
      const peer = target();
      if (!enabledReport() || !isCurrent(account) || !peer) {
        pendingReports.clear();
        return;
      }
      const batch = [...pendingReports.values()];
      pendingReports.clear();
      if (!batch.length) return;
      autoInFlight = true;
      lastReportAt = runtime.now();
      const signal = epoch.signal;
      try {
        const state = await runtime.status();
        const guard = () => {
          signal.throwIfAborted();
          if (!enabledReport() || !isCurrent(account) || peer !== target()) {
            throw failure('ADMIN_REPORT_CANCELLED', '管理员提醒已取消');
          }
        };
        guard();
        if (state?.connected !== true || state.paused === true || String(state.selfId) !== account) return;
        const text = ['Alcor 异常提醒', ...errorLines(batch, 3)].join('\n');
        await runtime.sender.sendTextBatch(`private:${peer}`, [text], {
          expected_self_id: account, signal, beforeDispatch: guard
        });
        guard();
      } catch {
        // A failure to notify is never itself a report candidate.
      } finally {
        autoInFlight = false;
        schedule();
      }
    }, wait);
    timer.unref?.();
  }

  function append(category, code, notify) {
    if (!Object.hasOwn(CATEGORIES, category)) category = 'status';
    code = CODES.has(code) ? code : 'AGENT_OPERATION_FAILED';
    const now = runtime.now();
    const match = rows.findIndex((row) => row.category === category && row.code === code && now - row.at <= COALESCE_MS);
    const prior = match >= 0 ? rows.splice(match, 1)[0] : null;
    rows.push({ category, code, at: now, count: Math.min(9999, (prior?.count || 0) + 1) });
    if (rows.length > MAX_ROWS) rows.shift();
    if (!notify || !enabledReport() || !target()) return;
    const key = category + '/' + code;
    const count = Math.min(9999, (pendingReports.get(key)?.count || 0) + 1);
    pendingReports.delete(key);
    pendingReports.set(key, { category, code, count });
    if (pendingReports.size > MAX_ROWS) pendingReports.delete(pendingReports.keys().next().value);
    schedule();
  }

  function record({ account, category, code, notify = true } = {}) {
    const owner = String(account ?? '');
    if (!isCurrent(owner)) return;
    if (current !== owner) reset(owner);
    append(category, code, notify);
  }

  const subscriptions = [
    runtime.subscribe('error', (event) => record({ account: event?.selfId || event?.account || runtime.account(),
      category: event?.category, code: event?.code })),
    runtime.subscribe('session-end', (event) => {
      const session = event?.session || event;
      if (!session) return;
      const account = session.selfId;
      const digestCall = (Array.isArray(session.messages) ? session.messages : [])
        .some((row) => row?.toolCall?.name === DIGEST_TOOL);
      if (session.deliveryUnknown) record({ account, category: 'send', code: 'DELIVERY_UNKNOWN', notify: !digestCall });
      if (session.status === 'error' && !session.deliveryUnknown) {
        record({ account, category: 'run', code: session.errorCode, notify: !digestCall });
      }
      for (const error of (Array.isArray(session.localErrors) ? session.localErrors : []).slice(0, 12)) {
        record({ account, category: 'send', code: error?.code, notify: !digestCall });
      }
    }),
    runtime.subscribe('status', (state) => {
      if (!active()) return;
      const account = String(runtime.account() || '');
      if (account && account !== current) reset(account);
      if (!account || state?.paused === true) cancelPending();
      if (!enabledReport()) {
        clearTimeout(timer);
        timer = undefined;
        pendingReports.clear();
      }
      const code = state?.connected === false ? 'BACKEND_DISCONNECTED'
        : state?.backendReady === false ? 'BACKEND_UNREADY'
          : state?.receiveReady === false ? 'RECEIVE_UNREADY' : '';
      if (code !== statusCode) {
        statusCode = code;
        if (code && QQ.test(current)) append('status', code, Boolean(account) && state?.paused !== true);
      }
    })
  ];

  async function sendDigest(ctx, { signal: externalSignal } = {}) {
    const account = String(ctx?.selfId ?? '');
    const peer = privatePeer(ctx);
    const session = ctx?.session;
    if (isCurrent(account) && current !== account) reset(account);
    const signal = externalSignal ? AbortSignal.any([epoch.signal, externalSignal]) : epoch.signal;
    const guard = () => {
      signal.throwIfAborted();
      if (!isCurrent(account)) throw failure('ADMIN_REPORT_CANCELLED', '管理员摘要已取消，QQ 账号或扩展状态发生变化');
      if (!canReadAdminErrors(ctx, admins()) || peer !== privatePeer(ctx)) {
        throw failure('ADMIN_PRIVATE_ONLY', '仅当前管理员私聊可查看错误摘要');
      }
    };
    guard();
    if (!session || typeof session !== 'object') throw failure('ADMIN_REPORT_CONTEXT_REQUIRED', '缺少管理员私聊会话');
    if (attempts.has(session) || session.sent?.some((item) => item.adminDigest === true)) {
      return { sent: false, duplicate: true };
    }
    attempts.add(session);
    const state = await runtime.status();
    guard();
    if (state?.connected !== true || state.paused === true || String(state.selfId) !== account) {
      throw failure('ADMIN_REPORT_CANCELLED', '管理员摘要已取消，QQ 状态未确认');
    }
    const lines = errorLines(rows, 5);
    const text = ['Alcor 管理员摘要', statusText(state), ...(lines.length ? lines : ['当前没有记录到异常。'])].join('\n');
    const result = await runtime.sender.sendTextBatch(`private:${peer}`, [text], {
      expected_self_id: account, signal, beforeDispatch: guard
    });
    const confirmed = (result?.sent ?? []).filter((receipt) => receipt?.confirmed === true);
    for (const receipt of confirmed) {
      (session.sent ??= []).push({ type: 'text', text: receipt.text, at: receipt.at,
        messageId: receipt.messageId, adminDigest: true });
      if (receipt.bookkeepingWarning) {
        (session.localErrors ??= []).push({ code: 'SENDER_BOOKKEEPING_FAILED', message: '管理员摘要已发送，本地记录异常。' });
      }
    }
    guard();
    if (result?.failed?.some((item) => item.delivery === 'unknown')) {
      throw Object.assign(failure('DELIVERY_UNKNOWN', '管理员摘要的部分送达状态未知'), { delivery: 'unknown', nonretryable: true });
    }
    if (!confirmed.length && result?.deduped?.length) return { sent: false, duplicate: true };
    if (!confirmed.length || result?.failed?.length) throw failure('ADMIN_REPORT_SEND_FAILED', '管理员摘要发送未完整确认');
    return { sent: true, confirmed: true };
  }

  return {
    record,
    recordTool({ result, session, toolName }) {
      if (!result?.isError || toolName === DIGEST_TOOL) return;
      const category = SEND_TOOLS.has(toolName) ? 'send' : 'tool';
      if (category === 'send' && session?.deliveryUnknown) return; // This is recorded once at session end.
      record({ account: session?.selfId, category, code: result.code });
    },
    sendDigest,
    close() {
      controller.abort();
      reset('');
      subscriptions.forEach((unsubscribe) => unsubscribe());
    }
  };
}
