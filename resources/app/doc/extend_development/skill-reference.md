# Skill API 1 参考

以随程序提供的 `src/plugin-loader.js` 中 `createSkillApi` 为准。两类扩展使用相同加载器。

| 接口 | 用途 |
| --- | --- |
| `api.registerTool(def)` | 注册工具并返回完整 ID。需要 `id`、`name`、`execute`，通常还应有 `description`、`parameters`。 |
| `api.config()` | 读取当前模块合并后的配置。 |
| `api.isSkillActive(id, ctx)` | 查询其他模块是否可用。 |
| `api.capability(name, args)` | 调用首个生效的能力提供者；不存在时返回 undefined。 |
| `api.hasCapability(name)` | 查询是否有对应能力。 |
| `api.log / warn / error(...args)` | 带模块前缀的日志。不要记录令牌和用户私聊正文。 |
| `api.fetch(...)` | 仅声明 `permissions: ["web_fetch"]` 后可用。 |
| `api.utils.sleep(ms)` | 异步等待。 |
| `api.utils.safeJsonParse(text, fallback)` | 安全解析 JSON，失败返回 fallback。 |

工具函数签名为 `execute(ctx, args)`，返回 `{content, isError}`。工具 ID 会加模块前缀并按函数名规则规范化；完整长度最多 64，不要假定清单中的短 ID 就是模型收到的名称。

清单字段见 `src/skills/manifest.js`：`id`、`name`、`version`、`apiVersion`、`entry`、`enabledByDefault`、`category`、`description`、`requires`、`capabilities`、`configSchema`、`settings`、`prompt`、`permissions`。`requires` 是硬依赖；可选增强使用 `api.capability`，不要把不存在的能力写成必需依赖。

启停和依赖统一由 `src/skills/manager.js` 管理，不能单独维护一个与系统开关相冲突的状态。配置界面来自清单 schema；修改配置后应读取 `api.config()`，不要假定 setup 时取到的对象永不变化。

扩展根目录取 `/api/extensions/workspace` 的 `skillsDir` 与 `pluginsDir`。`appRoot` 为真实应用资源目录，`docsDir` 为这套说明的位置，`hotReload` 为当前启用状态。该接口不返回模型密钥或 Alcor 访问令牌。

修改源码后要验证 manifest、导入入口、实际注册、依赖检查、开关与清理。扩展执行的是本机 JavaScript，并非安全沙箱；不要让模型生成与请求无关的文件操作。
