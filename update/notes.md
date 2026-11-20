<!-- 每次发布由 tools/publish-update.mjs 覆盖本文件，这里只保留最新一条。 -->
# Alcor Agent 小版本更新记录

- 版本：0.3.2
- 发布时间：2026-11-20T15:07:53.276Z
- 安装包：Alcor-Agent-Setup-0.3.2-x64.exe（319605052 B）
- sha256：ce264b58e2bbfdc8c64dd8eb5a14ee092e93e6723bc88c6becbda240a072d870
- 下载：https://github.com/Saevis0913/QQ_Alcor-Agent/releases/download/v0.3-latest/Alcor-Agent-Setup-0.3.2-x64.exe

## 本次更新

- 内置 VC++ 运行库（vcruntime140 / vcruntime140_1 / msvcp140），没装运行库的机器不再一启动就闪退
- 启动即开崩溃转储：闪退会在 data/crash-dumps 留下 .dmp，下次能定位
- 上次没走到就绪就自动进安全模式（关显卡加速与沙箱）重试一次，不再连续闪退
- 启动前清掉全局 ELECTRON_RUN_AS_NODE / NODE_OPTIONS，避免被当成纯 Node 进程秒退
- Start-Alcor-Agent.cmd 启动失败会自动回退安全模式并打印诊断日志
- 新增「收集崩溃信息.cmd」：一条命令生成可上报的环境报告
- 更新通道：小版本只换预发行通道的资产，不再占用仓库首页 Releases 位
