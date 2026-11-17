const recordId = { type: 'string', description: '通过检索得到的完整记忆编号。' };

export function setup(api) {
  function request(capability, ctx, args) {
    return api.capability(capability, { ctx, args }) ??
      { content: '长期记忆插件当前不可用。', isError: true };
  }

  api.registerTool({
    id: 'lookup',
    name: '检索长期记忆',
    description: '查找关于 QQ 账号的既有摘要。结果受来源共享设置限制，可能有遗漏或错误。私聊可省略当前联系人 QQ，群聊可省略本轮唯一发言者 QQ。',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        qq: { type: 'string', description: '明确的 QQ 号。' },
        day: { type: 'string', description: '可选归档日 YYYY-MM-DD。' },
        query: { type: 'string', description: '可选摘要关键词。' },
        limit: { type: 'integer', minimum: 1, maximum: 12 }
      },
      additionalProperties: false
    },
    execute: (ctx, args) => request('memory.lookup', ctx, args)
  });

  api.registerTool({
    id: 'delete',
    name: '删除一条长期记忆',
    description: '用户在原会话明确请求删除自己的记忆时调用。删除的是本地摘要条目。',
    category: 'system',
    parameters: { type: 'object', properties: { id: recordId }, required: ['id'], additionalProperties: false },
    execute: (ctx, args) => request('memory.change', ctx, { ...args, action: 'delete' })
  });

  api.registerTool({
    id: 'correct',
    name: '更正一条长期记忆',
    description: '用户在原会话明确请求更正自己的记忆时调用。请使用用户明确提供的事实修改摘要。',
    category: 'system',
    parameters: {
      type: 'object',
      properties: { id: recordId, summary: { type: 'string', maxLength: 320, description: '用户提供的更正摘要。' } },
      required: ['id', 'summary'],
      additionalProperties: false
    },
    execute: (ctx, args) => request('memory.change', ctx, { ...args, action: 'correct' })
  });
}
