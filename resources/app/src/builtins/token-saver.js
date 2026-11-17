// This policy uses only the existing after-response/batch hooks. No prompt mutation.
const sends = new Set(['send_message', 'send_sticker', 'gengjing__send', 'admin-digest__admin_digest']);
const promised = /(?:我|再|先|稍|去|等).{0,8}(?:查|搜|看看|找找|发图|发给|补充|整理|确认)|稍等|等我|待会|马上.{0,6}(?:发|回|查)|(?:I.ll|let me|going to).{0,15}(?:check|search|look|send)/iu;

export function createTokenSaver() {
  const contexts = new Map();
  let calls = new WeakMap();
  const trim = map => { while (map.size > 128) map.delete(map.keys().next().value); };
  return {
    context(context) { contexts.set(context.sessionId, context); trim(contexts); },
    response({ session, response }) {
      for (const call of response?.message?.tool_calls || []) {
        calls.set(call, { session, message: response.message, context: contexts.get(session.id) });
      }
    },
    tool({ sessionId, result }) {
      if (result?.isError && contexts.has(sessionId)) contexts.get(sessionId).failed = true;
    },
    policy({ batch } = {}) {
      const no = { shouldEnd: false };
      if (!batch?.calls?.length || !batch.newSent?.length || batch.results?.length !== batch.calls.length) return no;
      const state = calls.get(batch.calls[0]);
      if (!state?.context || !batch.calls.every(call => calls.get(call)?.session === state.session && sends.has(call.function?.name))) return no;
      const { session, context, message } = state;
      if (context.failed) return no;
      if (session.deliveryUnknown || session.error || session.localErrors?.length || batch.results.some(result => result.isError)) return no;
      if ((context.store?.unreadCount?.(context.chatKey) || 0) > 0) return no;
      if (batch.newSent.some(row => !row.messageId || row.deduped || row.delivery === 'unknown')) return no;
      if ([message.content, message.reasoning_content, ...(session.sent || []), ...batch.newSent].some(value => promised.test(String(typeof value === 'object' ? value?.text || '' : value || '')))) return no;
      // Tool output also carries partial failure details even when a third-party wrapper forgot isError.
      for (const result of batch.results) {
        try {
          const data = JSON.parse(result.content);
          if (data.error || data.failed?.length || data.delivery === 'unknown' || data.ok === false) return no;
        } catch { return no; }
      }
      const visiblePlan = String(message.content || message.reasoning_content || '').split(/[。\n]/).map(s => s.trim());
      const summary = visiblePlan.find(s => /^[\u4e00-\u9fff]/.test(s) && /(?:打算|准备|决定|可以|直接|就).{0,10}(?:回应|回复|说|发)/.test(s) && s.length <= 60 && !/[\\/:]|token|api[_ -]?key/i.test(s));
      session.finishReason = summary ? `本轮消息已发送。${summary}` : `已发送 ${batch.newSent.length} 条消息，本轮没有待处理动作。`;
      session.optimization = { ...(session.optimization || {}), localFinish: true, avoidedFinishCalls: 1 };
      for (const call of batch.calls) calls.delete(call);
      return { shouldEnd: true };
    },
    clear() { contexts.clear(); calls = new WeakMap(); }
  };
}
