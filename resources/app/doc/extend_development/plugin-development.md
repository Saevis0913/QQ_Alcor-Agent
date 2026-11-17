# Alcor Agent 插件开发

插件由程序按既定能力或钩子调用，适合确定性的流程处理。希望模型理解意图后选择调用时，应使用技能；不要靠给模块换目录来让一个未接入调用点的函数自动执行。

使用界面返回的 `pluginsDir/<id>/`。清单名为 `plugin.json`，入口默认 `index.js`；两类扩展共用 Skill API 1 和清单规范。

```json
{"id":"text-normalizer","name":"文本规范化","version":"1.0.0","apiVersion":1,"entry":"index.js","category":"utility","description":"提供文本规范化能力","capabilities":["example.normalize"],"enabledByDefault":true}
```

```js
export const providers = {
  'example.normalize': ({text}) => String(text ?? '').trim()
};
```

示例只提供可调用能力，不会自动处理消息。实际插件应先阅读目标调用点：`src/skills/manager.js`、`src/app.js`、`src/orchestrator.js`、`src/llm.js`。只有程序实际调用的能力名或 hook 名才有运行效果；不要编造 `api.onMessage`、`api.send` 等不存在的方法。

可选导出 `setup(api)`、`available(ctx)`、`activate(ctx)`、`deactivate(ctx)`、`dispose()`、`hooks`、`providers`、`promptSections`。在 `activate` 中申请的监听器或定时器要在 `deactivate` 清理，`dispose` 负责卸载资源；不要仅在页面上关开关而保留后台副作用。

插件内容遵循技能说明中的相同要求：避免涉政、色情及有害内容；允许普通粗口、吐槽等语言风格，不把它们自动视为禁止开发的功能。

完成后点击“刷新”，分别验证加载、启停、配置保存、重复加载与卸载。缺少能力时给出具体原因，不静默失败。真实消息与第三方模型调用须使用用户授权的测试对象和范围。接口详情见 `skill-reference.md`，原生能力边界见 `alcor-capabilities.md`。
