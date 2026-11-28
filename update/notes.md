<!-- 每次发布由 tools/publish-update.mjs 覆盖本文件，这里只保留最新一条。 -->
# Alcor Agent 更新记录

- 版本：0.3.3-as.1
- 发布时间：2026-11-28T15:15:42.000Z
- 安装包：Alcor-Agent-Setup-0.3.3-as.1-x64.exe（319468334 B）
- sha256：c248132c7b4413769bc25591b1b0265f47c788e16cd20230ae97c4cf1d4420b0
- 下载：https://github.com/Saevis0913/QQ_Alcor-Agent/releases/download/v0.3-latest/Alcor-Agent-Setup-0.3.3-as.1-x64.exe

## 本次更新

0.3.3-as.1 补丁（内核 0.4.6）

这一版补上语音发送，并把原生后端发不出语音时的原因说清楚。

新增内容：
1) 语音消息：模型可以自己合成并发送语音（send_voice）。中文用系统语音合成，上限 200 字 / 60 秒；单轮最多 2 条，preview 只合成不发送，可以先试听再决定。
2) 多个 QQ 进程时优先连接带主窗口的那一个：以前会挑到没有消息服务的子进程，连接直接报 IDENTITY_SERVICE_NULL。

修复内容：
1) 原生后端发语音不再甩裸 EPIPE：QQ 的语音上传协商被断管时给出明确错误码 NATIVE_RECORD_UNSUPPORTED 和中文说明，并停止反复打断宿主管道——同一次连接里文字、图片照常收发。
2) 更正过时的原生能力说明书：不再笼统写「媒体未完成验收」，改成按「已验证 / 依赖系统」分层说明。

从 0.3.3 与更早版本都会提示升到 0.3.3-as.1；装完自动回到界面。
