import { modelOptions } from './policy.js';

const OWNER_IDLE_MS = 10 * 60_000;
const numberOnly = /^([1-9][0-9]?)(?:\s+(minimal|low|medium|high|xhigh|max|ultra))?$/i;
const confirm = /^(?:确认|开始|确认开始)$/;
const cancel = /^(?:取消|\/cancel)$/;

export class WorkQueue {
  #task = null;
  #timer = null;

  constructor(dependencies) {
    this.deps = dependencies;
  }

  stop() {
    clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#task) {
      this.#task.context.signal?.removeEventListener('abort', this.#task.stopOnScopeAbort);
      this.#task.controller.abort(new Error('订阅工作已停止。'));
    }
    this.#task = null;
  }

  #idle(task) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      if (this.#task === task) this.stop();
    }, OWNER_IDLE_MS);
    this.#timer.unref();
  }

  async #reply(ctx, text, signal, extraScope) {
    signal?.throwIfAborted();
    if (!ctx.scopeValid() || (extraScope && !extraScope())) throw new Error('工作会话已失效。');
    try { await ctx.reply(text, signal, extraScope); }
    catch (cause) {
      throw Object.assign(new Error('QQ 工作提示发送失败。', { cause }), { replyFailed: true });
    }
  }

  #prompt(task) {
    return '将使用 ' + task.selection.model + ' / ' + task.selection.effort +
      '。回复「确认」开始，回复「取消」结束。';
  }

  async receive(ctx) {
    const { catalog, quota, run, archive, getChoice, saveChoice, onError } = this.deps;
    const user = String(ctx.senderId || '');
    const self = String(ctx.selfId || '');
    const text = String(ctx.text || '').trim().slice(0, 12_000);
    if (!text || !/^[1-9]\d{0,14}$/.test(user) || !/^[1-9]\d{0,14}$/.test(self) || ctx.signal?.aborted || !ctx.scopeValid()) return;
    const key = self + ':' + user;
    let task = this.#task;
    let runningTask = null;
    try {
      if (task && (task.key !== key || task.chatKey !== ctx.chatKey)) {
        return await this.#reply(ctx, '工作模式目前正在服务另一位用户或另一个会话，请稍后再试。');
      }
      if (task && cancel.test(text)) {
        if (task.stage === 'running') {
          task.controller.abort(new Error('用户取消了本次工作。'));
          await this.#reply(ctx, '已请求取消本次工作。');
          return;
        }
        this.stop();
        return await this.#reply(ctx, '已取消本次工作。');
      }
      if (!task) {
        if (confirm.test(text) || cancel.test(text) || numberOnly.test(text)) return;
        task = { key, chatKey:ctx.chatKey, request:text, context:ctx, stage:'loading', controller:new AbortController() };
        this.#task = task;
        task.stopOnScopeAbort = () => { if (this.#task === task) this.stop(); };
        ctx.signal?.addEventListener('abort', task.stopOnScopeAbort, { once:true });
        this.#idle(task);
        const models = await catalog(task.controller.signal);
        task.controller.signal.throwIfAborted();
        const list = modelOptions(models, ctx.isAdmin());
        if (!list.length) throw new Error('这位用户在当前账号下没有可用的工作模型。');
        const saved = getChoice(key);
        if (saved && list.some(row => row.model === saved.model && row.efforts.includes(saved.effort))) {
          task.selection = saved;
          task.stage = 'confirm';
          return await this.#reply(ctx, this.#prompt(task), task.controller.signal);
        }
        task.menu = list;
        task.stage = 'select';
        const menu = list.map((row,index) => (index + 1) + '. ' + row.model + ' [' + row.efforts.join('/') + ']');
        return await this.#reply(ctx, '请选模型。回复序号及档位，例如「1 medium」。只发序号使用该模型的默认可用档位。\n' + menu.join('\n'), task.controller.signal);
      }
      const signal = task.controller.signal;
      if (task.stage === 'loading' || task.stage === 'running') return;
      if (task.stage === 'select') {
        const match = numberOnly.exec(text);
        const selected = match && task.menu[Number(match[1]) - 1];
        const effort = match?.[2]?.toLowerCase() || selected?.defaultEffort;
        const current = selected && modelOptions([{ model:selected.model, defaultReasoningEffort:effort,
          supportedReasoningEfforts:selected.efforts.map(reasoningEffort=>({reasoningEffort})) }], ctx.isAdmin())[0];
        if (!current?.efforts.includes(effort)) {
          return await this.#reply(ctx, '这个模型或档位不可选。请使用上面菜单里的序号和档位。', signal);
        }
        task.selection = { model:selected.model, effort };
        saveChoice(key, task.selection);
        task.stage = 'confirm';
        this.#idle(task);
        return await this.#reply(ctx, this.#prompt(task), signal);
      }
      if (!confirm.test(text)) return;
      task.stage = 'running';
      runningTask = task;
      clearTimeout(this.#timer);
      this.#timer = null;
      const models = await catalog(signal);
      const authorized = () => modelOptions(models, ctx.isAdmin())
        .some(row => row.model === task.selection.model && row.efforts.includes(task.selection.effort));
      if (!authorized()) {
        throw new Error('模型权限或目录已变化，请重新发起任务。');
      }
      const remaining = await quota(signal);
      if (!task.context.scopeValid()) throw new Error('原始工作请求已撤回或会话失效。');
      const originalRequestStillValid = task.context.scopeValid;
      await this.#reply(ctx, '已确认开始。\n' + remaining, signal, originalRequestStillValid);
      signal.throwIfAborted();
      const beforeTurn = () => {
        if (!authorized() || !task.context.scopeValid() || !ctx.scopeValid()) throw new Error('工作请求的权限已变化。');
      };
      beforeTurn();
      const result = await run(task.selection, task.request, signal, beforeTurn);
      signal.throwIfAborted();
      if (!originalRequestStillValid() || !ctx.scopeValid()) return;
      const zip = await archive(result.files, signal);
      const summary = String(result.summary || '本次工作已完成。').trim().slice(0, 1000);
      if (!originalRequestStillValid() || !ctx.scopeValid()) return;
      await this.#reply(ctx, zip ? summary + '\nZIP 已保存在本机（' + zip + '）。当前 QQ 核心缺少文件上传能力。' : summary,
        signal, originalRequestStillValid);
    } catch (error) {
      if (!task?.controller.signal.aborted) {
        onError?.(error);
        if (!error.replyFailed && ctx.scopeValid()) {
          await this.#reply(ctx, '工作请求处理失败。请在 Alcor 插件日志中查看原因。').catch(() => {});
        }
      }
      if (this.#task === task && task?.key === key && task?.chatKey === ctx.chatKey && (task.stage !== 'running' || runningTask)) this.stop();
    } finally {
      if (runningTask && this.#task === runningTask) this.stop();
    }
  }
}
