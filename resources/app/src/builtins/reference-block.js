// 参考资料注入：把「记忆摘要 / 话题候选」这类块插到**最后一条真实用户消息之前**。
//
// 为什么不 push 到末尾：两个扩展都往 messages 尾部追加 role:'user' 的参考资料，
// 同时开启时最后一条 user 就变成了参考资料，真正的用户消息退到倒数第三位 ——
// 模型会把参考资料当成最新发言来回答，@ 它的那句话反而被忽略。插在最后一条用户
// 消息之前，既保留了"最后一条是用户发言"的顺序，也让参考块紧邻本轮输入。

const REFERENCE = Symbol.for('alcor.referenceBlock');

function isReference(message) {
  return Boolean(message && message[REFERENCE]);
}

function mark(message) {
  Object.defineProperty(message, REFERENCE, { value: true, enumerable: false, configurable: true });
  return message;
}

/**
 * 插一条参考块。同内容已存在则不重复插入（钩子可能被同轮调多次）。
 * @param {Array<object>} messages 待发送消息（会被就地修改）
 * @param {{ role?: string, content: string }} block
 * @returns {boolean} 是否插入了
 */
export function insertReferenceBlock(messages, block) {
  if (!Array.isArray(messages) || !block?.content) return false;
  if (messages.some((message) => String(message?.content ?? '') === String(block.content))) return false;
  const message = mark({ role: block.role || 'user', content: String(block.content) });
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user' && !isReference(messages[i])) { at = i; break; }
  }
  if (at < 0) messages.push(message);
  else {
    // 已经插过参考块时排到它们后面：钩子按注册顺序跑，读起来也就按注册顺序。
    while (at < messages.length && isReference(messages[at])) at += 1;
    messages.splice(at, 0, message);
  }
  return true;
}
