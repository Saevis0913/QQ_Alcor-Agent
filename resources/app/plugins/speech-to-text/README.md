# 本地语音转文字

Windows x64 运行时放在安装目录的 `resources/media-runtime`。开发副本也会查找仓库旁边的 `media-runtime`，可用 `ALCOR_AGENT_MEDIA_RUNTIME_DIR` 显式指定路径。部署时按 `runtime-manifest.json` 校验 Whisper 文件和模型的 SHA-256，并随运行时附带两个上游 MIT 许可证。

插件通过 OneBot `get_record` 下载语音，在本地识别。SILK 使用 silk-wasm，其他支持的音频格式由 PATH 中的 FFmpeg 转为单声道 PCM。模型支持自动识别多种语言。单条语音上限为 8 MiB 和 120 秒，识别超时为 120 秒。插件关闭、依赖缺失或识别失败时，消息保留 `[语音]` 标记。临时音频和转写文件在处理完成后从 Agent 数据目录清理。
