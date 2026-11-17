# Alcor Agent 技能开发

这是当前程序的开发说明，遵循现有加载器与 Skill API 1，不另建扩展格式。

## 选择技能还是插件

让模型根据对话意图决定是否调用的功能使用技能，例如文本整理、计算或查询。每次满足固定条件都要执行的处理使用插件。先确认功能、触发条件和所需输入；用户选错入口时解释区别后选择正确类型。

## 路径和清单

程序界面读取 `/api/extensions/workspace` 的实际路径。技能放在返回的 `skillsDir/<id>/`，不要从用户数据目录或当前命令行目录推算。此安装版默认是程序内部的 `resources/app/skills/`，移动安装目录后会重新计算路径。

每个技能提供 `skill.json` 和 `index.js`。示例清单：

```json
{"id":"text-helper","name":"文本助手","version":"1.0.0","apiVersion":1,"entry":"index.js","category":"utility","description":"按需整理文本","enabledByDefault":true,"permissions":[],"settings":{}}
```

```js
export function setup(api) {
  api.registerTool({
    id: 'trim_text', name: '整理空白', description: '移除文本两端空白', category: 'system',
    parameters: {type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},
    execute: async (_ctx, args) => ({content:String(args.text).trim(),isError:false})
  });
}
```

仅在清单写 `tools` 不会注册工具，必须调用 `api.registerTool`。模型仍可能决定不调用技能；不要把这一点误判为加载失败。

## 安装和检查

先校验 JSON 与 JavaScript 语法，再写入实际目录。在技能页面点击“刷新”进行真实重扫，确认已加载、已启用、依赖已就绪。定时热重载状态以界面报告为准，不能无条件承诺写入后立即可用。用本地无副作用输入验证工具结果；不要自动发送真实 QQ 消息。

若存在同名技能，先保留原文件，避免覆盖用户内容。入口文件只能位于自身目录，禁止路径穿越。只修改本扩展需要的文件。

## 内容要求

按产品要求避免涉政、色情及有害内容，不制作教唆违法、欺骗或伤害他人的功能。普通口头禅、吐槽或包含脏话的表达风格可以按用户偏好设置，不因出现粗口就拒绝整个需求。不要把风格设置扩展成针对个人或群体的骚扰。

API 和生命周期见 `skill-reference.md`；QQ 能力边界见 `alcor-capabilities.md`。源码事实以 `src/plugin-loader.js`、`src/skills/manifest.js`、`src/tool-registry.js` 为准。
