<!-- 每次发布由 tools/publish-update.mjs 覆盖本文件，这里只保留最新一条。 -->
# Alcor Agent 小版本更新记录

- 版本：0.3.1
- 发布时间：2026-11-20T15:26:16.962Z
- 安装包：Alcor-Agent-Setup-0.3.1-x64.exe（319598889 B）
- sha256：71619deb278bcb6f4a065ce4dde506c765e61cf760685142808f50df02030292
- 下载：https://github.com/Saevis0913/QQ_Alcor-Agent/releases/download/v0.3.1/Alcor-Agent-Setup-0.3.1-x64.exe

## 本次更新

正式大版本 0.3.1：修复「装好了双击闪退 / 事件日志 0x80000003」

- 内置 VC++ 运行库（vcruntime140 / vcruntime140_1 / msvcp140），没装运行库的机器不再一启动就闪退
- 启动即开崩溃转储：闪退在 data/crash-dumps 留下 .dmp，下次能直接定位
- 上次没走到就绪就自动进安全模式（关显卡加速与沙箱）重试一次
- 启动前清掉全局 ELECTRON_RUN_AS_NODE / NODE_OPTIONS，避免被当成纯 Node 秒退
- Start-Alcor-Agent.cmd 启动失败自动回退安全模式并打印诊断日志；新增「收集崩溃信息.cmd」
- 获取更新：9 条清单通路 + 先清单后官方 API 的兜底，CDN 缓存旧版本时也能报出新版本
- 大版本走仓库 Releases，小版本只覆盖 update/manifest.json 与 update/notes.md
