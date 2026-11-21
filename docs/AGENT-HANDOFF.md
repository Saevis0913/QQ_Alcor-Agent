# Alcor Agent · 完整工作交接（HANDOFF）

> 读者：下一个接手这个项目的 AI agent。
> 目标：读完这份文件 + 跑一遍第 12 节的验证，你就应当能在不追问历史的情况下改代码、打包、发版、回滚。
> 最近更新：2026-11-21（agent `0.3.2-as.2` / Alcor 核心 `0.3.1`）。历史细节见 `docs/关键要点.md`（1000+ 行）与 `docs/试错记录.md`。

---

## 0. 60 秒速读

- 这是什么：一个 Windows 桌面程序（Electron 外壳 `Alcor Agent.exe` + 内置 HTTP 服务 127.0.0.1:5320），把 QQ 变成 OneBot v11 机器人；同时带一个叫 **Alcor 核心** 的原生注入层（`resources/alcor`，Node 0.2.x → 0.3.1），负责把宿主 DLL 注进 `QQ.exe` 收发消息。
- 两个版本号：**外壳 agent**（`resources/app/package.json`）与 **Alcor 核心**（`resources/alcor/package.json`）。一个安装包同时带两者，装一次两个一起更新。
- 版本分层：**大版本**（`0.3.2`）发 GitHub Releases 正式版；**小版本**（`0.3.2-as.N`）只换滚动预发行 `v0.3-latest` 的资产并覆盖仓库里的 `update/manifest.json` 与 `update/notes.md`，不占侧边栏。
- 现在的状态：任意 9.9.33–9.9.45 的 QQ 构建都能注（未登记版本现场扫描推导 + 成对补丁 DLL/loader）；更新有 9 条清单源、4 层下载镜像、装完自动重启；安装器不再误杀别的副本；崩溃能取证（crashReporter + 安全模式）；411 项自检全绿。
- 一句话开工：`cd /d/Alcor && node D:/Alcor-audit/audit.mjs` 应输出 `总计 411 项，失败 0 项`；`curl http://127.0.0.1:5320/api/version` 应返回当前版本。

---

## 1. 五个目录，各管什么

| 路径 | 角色 | 规则 |
| --- | --- | --- |
| `D:\Alcor` | **现役安装**（用户正在跑的那一份） | 可以直接改，改完重启生效；`D:\Alcor\data` 是用户数据，**不要**打进包 |
| `D:\Alcor-源码\Alcor-Agent` | **Git 仓库 / 唯一真源** | 所有要发布的改动先在这里落地，再同步到 `D:\Alcor`；远端 `Saevis0913/QQ_Alcor-Agent` |
| `D:\Alcor-pkg\<版本>\` | 打包工作区：`payload/`（待装文件）、`installer/`（iss 等）、`out/`（exe） | 每次重新生成，不提交 |
| `D:\Alcor-audit\audit.mjs` | 自检台（411 项断言，含 QQ 兼容、注入、更新、安装器、活跃期） | 改完必跑；连跑 10 轮确认无抖动 |
| `D:\Alcor-work` | 临时脚本与样本（不进包、不提交） | 里面有大量一次性工具，可参考第 11 节 |

外部工具（固定路径，别去找别的版本）：

- Inno Setup 6.7.4：`D:\QQBot-Rebuild\tools\InnoSetup\ISCC.exe`
- rcedit 2.0：`D:\QQBot-Rebuild\tools\rcedit-x64.exe`（`--set-icon` / `--set-file-version`）
- 7-Zip 独立版：`D:\Alcor-work\qq-dl\7zr.exe`（解 QQ 安装包用）
- 打包用 Python（含 Pillow）：`C:\Users\admin\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`

---

## 2. 从 codex 接手时的状态（你不需要再修一遍，但要知道为什么有这些代码）

接手时是 agent `0.2.9` / 核心 `0.2.1`，主要问题：

1. **换 QQ 版本就注不进去**：`alcor-host.dll` 里只编进两个版本的 RVA 表，且 `qq-host-loader.exe` 里内嵌了「宿主 DLL 的 SHA256」白名单（文件偏移约 142767）与「目标 wrapper.node 的版本+哈希」槽位（约 0x2303D）。换版本 → `HOST_LOAD_BLOCKED`，用户只看到一句「加载失败」。
2. **安装目录含中文/空格就失败**：loader 走 `LoadLibrary`，非 ASCII 路径直接挂。
3. **安装器会误杀**：`StopLockingProcesses()` 无条件 `taskkill /IM "Alcor Agent.exe"`、`/IM QQ.exe`，装到新目录也会把正在跑的另一份 + 用户的 QQ 全杀掉。
4. **更新通道脆弱**：只有 3 条清单源；大文件用 undici 流式上传经常 `fetch failed`；发布脚本先删旧资产再上传，失败就把通道清空；jsDelivr 缓存 7 天导致改了清单客户端看不到；安装器静默升级后不重启。
5. **闪退查不出来**：`0x80000003`（INT3）没有 dump、没有启动兜底、没带 VC++ 运行库。
6. **策略被架空**：界面保存的是 `replyPolicy`，`prompt.js` 却优先读遗留的 `contextTier=4`，导致「四档优先于策略」永远生效。

这些都已修，对应实现在第 4–6 节。

---

## 3. 运行时结构（进程 / 端口 / 数据）

```
Alcor Agent.exe (Electron main, electron/main.js)
 ├─ 启动内核：resources/app/src/app.js  → HTTP 服务 127.0.0.1:5320
 ├─ 窗口：ui/index.html + ui/app/*.js（无打包，直接 <script> 加载）
 ├─ 托盘：nativeImage.createFromPath(resources/app/assets/icon.png)
 └─ 崩溃取证：crashReporter → data/crash-dumps；启动 marker data/.starting + crash-count.json

内核 (5320)
 ├─ /api/* 路由：src/routes.js（约 1400 行，所有 HTTP 入口）
 ├─ 编排：src/orchestrator.js（收消息 → 选人格/档位 → 模型 → 发送）
 ├─ OneBot：src/onebot.js（对外 v11 接口，默认端口 5310）
 └─ Alcor 原生层：resources/alcor/src/management.mjs → native-core/controller.mjs
      └─ qq-host-loader.exe <pid> <parentPid> <nonce32hex> qq <startedAt FILETIME>
           └─ 手工映射 alcor-host.dll 进 QQ.exe（QQ 侧收发由宿主 DLL 完成）
```

- 数据目录：`D:\Alcor\data`（`config.json`、`sessions`、`logs`、`crash-dumps`、`updates`、`qq-profiles`、`host`）。
- 端口：5320 控制台/API；5310 OneBot（可在设置改）。
- 单实例：`src/instance-lock.js`；曾观测到一次「端口只接受 TCP、HTTP 不响应」，杀干净重启即恢复（疑似双实例抢端口，未复现，见第 10 节）。

---

## 4. 机制 A：QQ 任意版本自适应注入（核心 0.3.0 → 0.3.1）

### 4.1 三层身份校验（为什么必须成对打补丁）

| 层 | 位置 | 内容 | 不匹配时 |
| --- | --- | --- | --- |
| 宿主 DLL 版本表 | `alcor-host.dll` 内 `lb_qq_profiles`（2 槽，每槽 version + sha256 + digest[32] + 14×RVA） | 只有 `9.9.36-53644`、`9.9.37-54395` | 找不到槽 → 拒绝 |
| loader 的宿主自校验 | `qq-host-loader.exe` 偏移 ~142767 的 ASCII sha256 | 必须等于随包 DLL 的 sha256 | `stage=artifact_identity` |
| loader 的目标校验 | 偏移 ~0x2303D 的「版本+哈希」表 | 必须包含目标 `wrapper.node` 的 sha256 | `stage=target_identity` |

结论：**只改 DLL 一定失败**（实验证过：`stage=artifact_identity`）；必须 DLL + loader 成对生成。

### 4.2 出货链路（`resources/alcor/native-core/host-profiles.mjs`）

`ensureProfilePack({ moduleName, sha256, version, wrapperPath, qqExePath, packRoot })`：

1. `findQQBuildProfile` 命中内建表 → 返回 `{staged:false, derived:false}`，用随包原件（零改动，回归安全）。
2. 未命中 → 找缓存 `<packRoot>/<wrapperSha>/profile.json`；`readValidPack` 四道校验（版本格式 ≤12、14 个 RVA 值域、调用方版本一致、DLL 里目标 digest 槽与版本对得上、loader 内嵌 DLL sha 一致、`scannerSha256` 一致）。
3. 扫描：`resources/alcor/tools/qq-profile-scan.mjs <wrapper.node> --json`（异步 `spawn`，不阻塞事件循环；300 s 上限）。扫描器用 9.9.36 的 14 个 RVA 反推字节模式，掩掉地址后在本机 `wrapper.node` 上 14/14 精确复原。
4. 成对补丁：`buildPairedArtifacts` 把 slot1 写成新版本（slot0 保留 9.9.36），再改 loader 的 artifact 哈希与目标哈希槽；产物落 `<packRoot>/<sha>/{alcor-host.dll,qq-host-loader.exe,profile.json}`，原子 rename。
5. 并发：同 sha 三路并发只构建一次（进程内 `inFlight` + 跨进程 `<sha16>.building.json` O_EXCL 锁，5 s 心跳，`ALCOR_PROFILE_BUILD_STALE_MS` 默认 360000 接管）。
6. 自愈：扫描/构建前重读盘上 wrapper 重算 sha，不一致重扫一次；仍不一致抛 `PROFILE_SCAN_MISMATCH`（带两个 sha8）。
7. 失败码：`PROFILE_SCANNER_MISSING / PROFILE_SCAN_FAILED / PROFILE_SCAN_MISMATCH / PROFILE_WRAPPER_NOT_FOUND / PROFILE_VERSION_UNSUPPORTED / PROFILE_PATCH_FAILED / PROFILE_VERIFY_FAILED / PROFILE_PACK_FAILED`。**任何失败都不碰 QQ**。

### 4.3 接线与判定码

- `controller.mjs:98` 才允许「放宽注入」：`allowUnverified===true && (reason==='UNSUPPORTED_BUILD'||reason==='FAMILY_UNVERIFIED')`，否则 `UNSUPPORTED_QQ`；`:104` 调 `ensureProfilePack`，`:105` 用 `pack.loader` 注入。
- 宽松候选：`qq-diagnosis.js` 的 `pickRelaxedCandidate`（未登记但无外来模块）→ `QQ_BUILD_UNLISTED`；同系列窗口 `9.9.33–9.9.45` 由 `qq-profiles.mjs` 的 `matchQQFamily` 给出 `FAMILY_UNVERIFIED`。
- 有外来框架（NapCat 等）先报 `FOREIGN_MODULES`，不给候选（顺序在版本判定之前）。
- UI 三按钮：`ui/app/19-qq-link.js` 的「一键检测并连接」(`data-qq="auto"`)、「仍然尝试注入」(`force` → `allowUnverified:true`)、「以管理员重启」(`admin`)。判定码短标签表在同文件 `SHORT`（33 条）。

### 4.4 已验证的真实构建

| QQ 构建 | wrapper sha256 前 12 | 结论 |
| --- | --- | --- |
| 9.9.33-51802 | `929b59467fdd` | derived（成对补丁成功） |
| 9.9.33-52230 | `63112ab9161e` | derived |
| 9.9.35-52892 | `e698a0abb086` | derived |
| 9.9.36-53644 | `0d8b94448f4d` | builtin 槽 0（本机现装） |
| 9.9.37-54395 | `fed532ad58d2` | builtin 槽 1 |

工具：`resources/alcor/tools/qq-version-matrix.mjs <wrapper.node|QQ根目录> [--version V] [--json]`，结论 `builtin|derived|unsupported|rejected`，只读、不注入。

---

## 5. 机制 B：更新通道（大版本 / 小版本 / 自动装 / 自动重启）

### 5.1 版本语义

- `compareVersion`（`src/update-feeds.js`）：数字段相同后比 `-as.N` 后缀；`0.3.1-as.2 > 0.3.1-as.1 > 0.3.1`，`0.3.2 > 0.3.1-as.9`。
- `release-update.js` 的 `version()` 同样识别 `asPatch`，资产名正则 `-Setup-(\d+\.\d+\.\d+(?:-as\.\d+)?)-x64\.exe$`。
- `isPatchUpdate`：major/minor 相同即视为小版本 → 自动下载 + 自动安装；跨大版本只提示。

### 5.2 清单（`update/manifest.json`）

- 9 条来源（`manifestSources`）：自定义 URL → raw main → jsDelivr → fastly.jsDelivr → statically → raw.gitmirror → gh-proxy → ghfast → raw master → `<owner>.github.io`。
- `fetchManifest` 用 `Promise.any` 竞速（单源 6 s，一轮 12 s）；`newestOf` **先比 `publishedAt`，时间缺失/相同才比版本**——这是为了绕开 CDN 把旧清单缓存成「版本更高」的 as.N 的问题。
- `normalizeManifest` 校验：版本语义、`urls[]` https、sha256 64 hex、bytes>0、fileName 以 `.exe` 结尾。
- 清单里 `full.urls[]` 是下载候选，`downloadUpdate` 会再展开镜像（原始 → ghfast → gh-proxy → ghproxy），下载完按清单 sha256 校验，`.part` 改名。
- `repairUpdate`（`POST /api/update-repair`）：让已配置的模型输出 `{"urls":[...]}`，再走同一个下载校验；`filterRepairUrls` 只放行 https + 白名单主机 + `.exe`，最多 5 条。

### 5.3 自动安装与重启

- `startUpdateWatcher` 启动 8 s 后首查，之后每 **30 分钟**（`CHECK_EVERY_MS`，原来 6 小时）。
- 小版本：`downloadUpdate()` → `installUpdate({onQuit})` → 退出 → 静默安装 → 安装器 `ShouldRelaunchAfterSilent()` 重新拉起 `{app}\Alcor Agent.exe`。
- 安装参数：`/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS /RELAUNCH=1 /LOG=<data>/updates/install.log` + `installDirArg(installRoot)`。
- `installDirArg`：**不能**写成 `/DIR="..."`（Windows spawn 会把引号转义成 `\"`，Inno 报「文件夹名不能包含 "」并中止）；无空格直接 `/DIR=D:\Alcor`，有空格取 8.3 短路径，取不到就不传。

### 5.4 发布（`resources/app/tools/publish-update.mjs`）

- 用法：`GITHUB_TOKEN=... node tools/publish-update.mjs --file <exe> --version x.y.z [-as.N] [--dry] [--notes "…"]`。
- 环境变量：`TAG`（默认 `v<major.minor>-latest`）、`PRERELEASE=0` 发正式版、`RELEASE_NAME` 自定义名称。
- 顺序：算 sha256/bytes → 取或建 release → **先上传新资产** → 再删旧资产 → 补 `SHA256SUMS.txt` → 覆盖 `update/manifest.json` 与 `update/notes.md` → purge jsDelivr。
- 大文件必须用 **curl** 上传（undici 传 305 MB 会 `fetch failed`；curl `--http1.1 --data-binary @file` 实测 60 s / 5.3 MB/s）。
- 同版本重发（如本次换图标但版本号不变）会撞名：先传临时名 `.icon.tmp.exe` → 删旧资产 → `PATCH /releases/assets/<id>` 改名回正式名。参考 `D:/Alcor-work/publish-icon2.mjs`。

---

## 6. 机制 C：安装器（`installer/Alcor-Agent.iss`）

- `StopLockingProcesses()` 只在**原地升级**时清理：`IsUpgradeInstall()` 要求目标目录已有 `Alcor Agent.exe`，全新安装只写一行日志 `fresh install ... - no process cleanup`。
- 清理范围：`StopByPath('qq-host-loader.exe'|'Alcor Agent.exe'|'node.exe', AppRoot())`（`Get-CimInstance Win32_Process` + `ExecutablePath.StartsWith(root)`）；仍被占用才 `taskkill /IM` 兜底；QQ 仅在「装了 loader 且宿主 DLL 被占用」时按文件锁逐个结束，解锁即停。
- `IsFileLocked()` 用 PowerShell `[IO.File]::Open(path,'Open','ReadWrite','None')` 探测；探测失败按「被锁」处理（保守）。
- 自动重启：[Run] `Filename: "{app}\Alcor Agent.exe"; Flags: nowait runascurrentuser; Check: ShouldRelaunchAfterSilent`；`ShouldRelaunchAfterSilent := WizardSilent() and (WasInstalled or param RELAUNCH=1)`；`CurStepChanged(ssInstall)` 先记 `WasInstalled` 再清理。
- 真机验收：现役 6 个 Alcor + 8 个 QQ 在跑时，静默装到新目录 → 前后进程数不变（修复前 16 个全灭）。

---

## 7. 机制 D：活跃期加成（0.3.2-as.1 起）

- 配置：`config.js:38` `behavior: { mentionWarmMinutes: 8, mentionWarmBoost: true, mentionWarmBonus: 10 }`。
- 语义（`prompt.js:296` 起）：被 @ / 拍一拍后 8 分钟内，**只做同档位内加成**——1/2 档不升档；3 档回复概率 +10 个百分点（0–100 制，夹紧）；4 档不变；表情冒泡只在 4 档放行。`mentionWarmBoost:false` 整块失效。
- 档位权威：`tierOfConfig()` 优先 `replyPolicy.mode`（1–4），只有缺 mode 才回落 `contextTier`；旧代码「四档优先于策略」的提前返回已删。
- UI：`ui/app/06-settings-render.js:950` 的 `#sc-warm-boost`（聊天设置 → 模型运行与消息发送）；保存 `ui/app/08-modals.js:1469`。
- 验证：`D:/Alcor-work/warmtest.mjs`（19 项，含 roll 29.5 命中 / 30.5 不命中）、`D:/Alcor-work/warmchain.mjs`（10 项，真 `Orchestrator.onIncoming`）；自检台 `suiteWarmBoost` 21 项。

---

## 8. 文件地图（改哪里 / 存哪里）

### 8.1 仓库根

| 路径 | 作用 |
| --- | --- |
| `resources/app/package.json` | **外壳版本号**（发布时改这里） |
| `resources/app/package-lock.json` | 同上，两处 `"version"` 都要改 |
| `resources/app/src/environment-check.mjs:197` | 第三处版本号（`version:`） |
| `resources/alcor/package.json` | **核心版本号**（本次 0.3.1） |
| `installer/Alcor-Agent.iss` | 安装器脚本（版本六处、图标、清理与重启逻辑） |
| `update/manifest.json` | 客户端读的更新清单（发布时覆盖，不手工改） |
| `update/notes.md` | 小版本更新记录（同上） |
| `docs/关键要点.md` | 设计/实现长文档（每次改动追加一节） |
| `docs/试错记录.md` | 踩坑清单 |
| `docs/alcor-qq-version-compat.md` | 注入兼容性方案与风险（222 行） |

### 8.2 外壳（`resources/app`）

| 路径 | 关键点 |
| --- | --- |
| `electron/main.js` | 单实例、窗口、托盘、`ICON_PATH`（:192）、crashReporter、启动 marker/安全模式 |
| `src/app.js` | HTTP 服务装配、`MAX_BODY_BYTES`(2 MB)、更新 watcher 的 `onQuit` |
| `src/routes.js` | 所有 `/api/*`；`autoConnect`(:135)、`/api/qq/diagnosis`(:457)、`/api/qq/autoconnect`(:488)、`/api/update-*`(:1352/:1376/:1389) |
| `src/update-feeds.js` | 9 源清单、`newestOf`(:170)、`fetchManifest`(:186)、`compareVersion`(:226)、`TRUSTED_UPDATE_HOSTS`(:22) |
| `src/update-manager.js` | `localCoreVersion`(:16)、`CHECK_EVERY_MS`(:26)、`checkForUpdate`(:302)、`downloadUpdate`(:395)、`installDirArg`(:436)、`installUpdate`(:448)、`repairUpdate`(:533)、`startUpdateWatcher`(:578) |
| `src/release-update.js` | GitHub 兜底：`releases?per_page=30` 找最高版本资产（滚动通道是预发行，`/releases/latest` 看不到） |
| `src/safe-fetch.js` | SSRF 防护；`isFakeIp`(:121)、`resolveSafeHost`(:131)、`trustedHosts` 放行（:149/:160） |
| `src/qq-diagnosis.js` | `SUPPORTED_QQ_VERSIONS`(:6)、`pickCandidate`(:41)、`pickRelaxedCandidate`(:48)、`diagnoseQQ`(:104)、`formatReport`(:220) |
| `src/prompt.js` | 档位与活跃期策略（:296 起） |
| `src/orchestrator.js` | 收消息主流程；`#isWarm/#markWarm` 开关短路 |
| `src/config.js` | 默认配置（`behavior`、`update`、`replyPolicy`） |
| `ui/app/06-settings-render.js:950` | 活跃期复选框 |
| `ui/app/18-updates.js` | 更新横幅（当前版本 + 核心版本） |
| `ui/app/19-qq-link.js` | 连接按钮与 33 条判定码短标签 |
| `assets/icon.png` / `icon.ico` | 窗口/托盘/安装包图标（本次换成金色 A） |
| `tools/publish-update.mjs` | 发布脚本（正式版与滚动小版本共用） |
| `tools/crash-collect.mjs` | 只读取证（系统信息/环境变量/安全软件/崩溃痕迹/事件日志） |
| `tools/qq-doctor.mjs` | 命令行诊断，判定码 → 退出码 |
| `tools/compat-matrix.mjs` | 28 项环境矩阵自测 |

### 8.3 核心（`resources/alcor`）

| 路径 | 关键点 |
| --- | --- |
| `native-core/controller.mjs` | `:8` import `ensureProfilePack`；`:98` 放宽条件；`:104` 出包；`:105` 用 `pack.loader` |
| `native-core/host-profiles.mjs` | 出包全流程（`:376 ensureProfilePack`；内部 `deriveWrapperPath`:123、`locateProfileTable`:177、`buildPairedArtifacts`:288、`readValidPack`:323、`defaultScanNow`:363） |
| `native-core/discovery.mjs` | 进程发现；`deriveQQBuildVersion`:37（`versions/<build>` 目录名优先）、`classifyQQProcess`:45、`discoverQQ`:60 |
| `native-core/qq-profiles.mjs` | 2 条内建 profile（14 RVA）、`matchQQFamily`（9.9.33–45）、C 头渲染 |
| `tools/qq-profile-scan.mjs` | 从 wrapper 推导 14 RVA（18053 B，无依赖） |
| `tools/profile-pack.mjs` | 独立成对补丁包生成器（内建直通时逐字节不改） |
| `tools/qq-version-matrix.mjs` | 逐份 wrapper 体检（builtin/derived/unsupported/rejected） |
| `tests/host-profiles.selftest.mjs` | 7 项自测（含 live probe） |
| `artifacts/native/alcor-host.dll` / `qq-host-loader.exe` | 随包原件（182272 / 178176 B），不要手改 |

---

## 9. 常见改动 Recipe（照抄即可）

### 9.1 只改代码，不发版

```bash
# 在仓库改 → 同步到现役 → 重启
cp D:/Alcor-源码/Alcor-Agent/resources/app/src/xxx.js D:/Alcor/resources/app/src/xxx.js
taskkill //IM "Alcor Agent.exe" //F
env -u ELECTRON_RUN_AS_NODE cmd //c "D:\Alcor\Start-Alcor-Agent.cmd"
curl -s http://127.0.0.1:5320/api/version
```

### 9.2 发一个小版本（`0.3.2-as.3` 为例）

1. 三处版本号：`resources/app/package.json`、`package-lock.json`（2 处）、`src/environment-check.mjs:197`。
2. 打包：
```bash
rm -rf /d/Alcor-pkg/0.3.2-as.3/payload
MSYS2_ARG_CONV_EXCL='*' robocopy "D:\Alcor" "D:\Alcor-pkg\0.3.2-as.3\payload" /E \
  /XD data electron-user-data /XF unins000.dat unins000.exe release-manifest.json *.log
rm -f "/d/Alcor-pkg/0.3.2-as.3/payload/Diagnose-Alcor.cmd"
```
3. 版本资源与清单：
```bash
/d/QQBot-Rebuild/tools/rcedit-x64.exe "/d/Alcor-pkg/0.3.2-as.3/payload/Alcor Agent.exe" \
  --set-icon "resources/app/assets/icon.ico" --set-file-version 0.3.2.3 --set-product-version 0.3.2.3
node D:/Alcor-work/mkmanifest.mjs "D:/Alcor-pkg/0.3.2-as.3/payload" 0.3.2-as.3
```
4. 安装器：`mkdir installer`，从上一版复制 `Alcor-Agent.iss` / `INSTALLATION.txt` / `ChineseSimplified.isl`，改 iss 六处（`AppVersion` / `AppVerName` / `VersionInfoVersion` / `AppComments` / `UninstallDisplayName` / `OutputBaseFilename`）。
5. 编译（**约 150–190 s，必须后台**，否则工具超时会把 exe 杀在半截）：
```bash
cd /d/Alcor-pkg/0.3.2-as.3/installer && MSYS2_ARG_CONV_EXCL='*' \
  /d/QQBot-Rebuild/tools/InnoSetup/ISCC.exe Alcor-Agent.iss
```
6. 全新目录验收（**必须带 /DIR，Inno 会记住上次目录**）：
```bash
MSYS2_ARG_CONV_EXCL='*' "/d/Alcor-pkg/0.3.2-as.3/out/Alcor-Agent-Setup-0.3.2-as.3-x64.exe" \
  /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR="D:\Alcor-验收-as3" /LOG="D:\Alcor-验收-as3.log"
```
7. 发布：`GITHUB_TOKEN=... node tools/publish-update.mjs --file <exe> --version 0.3.2-as.3`；同版本重发用 `publish-icon2.mjs` 的「临时名 → 删旧 → 改名」流程。

### 9.3 发一个大版本（`0.3.3` 为例）

同上，但：`TAG=v0.3.3 PRERELEASE=0 RELEASE_NAME="Alcor Agent 正式版 v0.3.3"` 传给 publish 脚本；确认 `releases/latest` 变成新版本；滚动通道 `v0.3-latest` 保持预发行且名称固定「更新下载通道（自动更新用，请勿手动下载）」，别让它在侧边顶掉正式版。

### 9.4 加一条判定码

1. `src/qq-diagnosis.js`（或对应模块）产出新 `code`。
2. `ui/app/19-qq-link.js` 的 `SHORT` 加中文短标签（自检 `suiteCodeLabels` 会查缺失/重复）。
3. `tools/qq-doctor.mjs` 的退出码表加映射。
4. 跑 `node D:/Alcor-audit/audit.mjs`。

### 9.5 换图标

1. 用 `D:/Alcor-work/icon/make-icon.py`（Pillow）：四角白底 flood fill → 透明 → 边缘去白边（把灰边按 `alpha=255-v` 压成黑色抗锯齿）→ 裁到内容 → 1024 主图 + ICO（256/128/64/48/32/24/16）。
2. 覆盖 `resources/app/assets/icon.png` 与 `icon.ico`（仓库与现役各一份）。
3. 装包时用 `rcedit --set-icon resources/app/assets/icon.ico` 写 `Alcor Agent.exe`（否则 exe 图标还是旧的）；iss 的 `SetupIconFile` 指向 payload 里的 ico，编译时自动带入。

---

## 10. 试错记录（血泪版，按主题）

**MSYS / shell**

- 所有安装器开关都要 `MSYS2_ARG_CONV_EXCL='*'`，否则 `/VERYSILENT` 被当成路径，弹 GUI 挂住。
- `/LOG=D:\...` 在 bash 单引号里写双反斜杠会丢日志；用单反斜杠。
- MSYS 没有 `split/stat/tee/nohup/setsid/chmod/du`；统计与分片用 Node。
- `python` 不在 PATH；用第 1 节的 bundler python。
- `.cmd` 里写中文必须 **GBK(cp936) + CRLF**，UTF-8 会被 cmd 当命令执行。

**Node / JS**

- 替换串里出现 `$'` 或 `$&` 会被 `String.replace` 当特殊模式吃掉整行——用函数式替换 `s.replace(a, () => b)`。
- 模板字符串会吃掉正则的一层转义（`\d` → `d`），写完必须 `grep` 确认源码。
- 文件是 CRLF 时，`includes('...\n')` 的 LF 锚点匹配不到。
- Windows 动态 import 要 `pathToFileURL()`，否则 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
- `spawnSync` 扫描 wrapper 会冻结事件循环 2.7 s（慢盘几十秒）——已改异步 `spawn`。

**Windows / Electron**

- 环境里有 `ELECTRON_RUN_AS_NODE` 时，Electron 会以纯 Node 启动、界面不出现、boot-diag 不写；启动脚本与测试都要 `env -u ELECTRON_RUN_AS_NODE`。
- 缺 `vcruntime140.dll`/`msvcr140.dll` 的机器启动即崩；已把三个运行库随包放安装根目录。
- `0x80000003` 是 INT3：V8 致命 CHECK 或安全软件强杀都长这样，无 dump 无法区分；现在的做法是 crashReporter + 启动 marker 安全模式 + `收集崩溃信息.cmd`。

**Inno Setup 6.7.4**

- 没有 `AllowDowngrades` 指令，写了直接编译失败。
- iss 里的相对路径全部相对 **installer 目录**（`..\payload`、`..\out`、`INSTALLATION.txt`、`ChineseSimplified.isl`），所以必须在 `<pkg>\installer\` 里编译。
- 不传 `/DIR` 会装到上次用过的目录（0.3.1 第一次「覆盖升级」实际装进了验收目录）；`/LOG` 里搜 `Dest filename` 可核实。
- `[Run]` 带 `skipifsilent` 时静默安装不会重启（as.1 的坑）；改用 `Check: ShouldRelaunchAfterSilent`。
- 编译耗时 145–190 s，工具默认 120 s 会杀掉进程，只剩半截 exe。

**GitHub / 网络**

- undici 流式上传 305 MB 会 `fetch failed`；curl `--http1.1 --data-binary @file` 才稳（60 s / 5.3 MB/s）。Node 的 https 在代理环境还会 `ECONNRESET`，curl 同刻 200。
- 发布脚本先删资产再上传会把通道清空 → 改成先传后删；同版本重发要「临时名 → 删旧 → PATCH 改名」。
- jsDelivr 按路径缓存 7 天，`?t=` 不换键；raw 是 `max-age=300`。所以清单择优必须看 `publishedAt`，不能只看版本号。
- 滚动 release 要 `prerelease: true` + 中性名称，否则占侧边、显示「最新」。
- Clash 等代理会把域名解析到 `198.18.0.0/15`，SSRF 防护会全拦；用 `trustedHosts` + `isFakeIp` 只对更新白名单放行。

**QQ / 注入**

- loader 参数必须精确：`pid parentPid nonce(32 hex) mode startedAt`，`startedAt` 必须等于 `进程 StartTime.ToFileTimeUtc()`（差 1783 tick 都报 `process_creation`）。
- 只改 DLL 会卡 `artifact_identity`；必须同时改 loader 内嵌的 DLL sha 与目标哈希槽。
- QQ 安装包是 7z SFX：`Offset=132120 / Physical Size=28447`，追加归档从 160567 起；用 `carve.mjs` 切 tail 再 `7zr e tail.bin "Files\versions\<ver>\resources\app\wrapper.node"`。
- 安装器结束 QQ 后，用户必须重新扫码；`/api/qq/autoconnect` 会报 `QQ_LOGIN_NOT_CONFIRMED`。

**DSH 任务板（如果你也用 agent_teams）**

- `create_task` 的 `inScope` 必须是**创建时**就写好的工作区相对路径；写绝对路径的任务永远结不了单（`changedPaths` 会被判 illegal/undeclared）。
- 结单三件套：`acceptanceResults` 覆盖每条 acceptance、`commandsRun` 覆盖每条 verify、`changedPaths` 用相对 POSIX 路径；绝对 inScope 的老任务只能 `changedPaths: []`。
- `claim_task` 只给成员自己；captain 派活必须 `reassign_task`，且目标必须空闲。
- `kind:"implementation"` 必须有非空 inScope；`kind:"review"` 必须带 `reviewedTaskId`。
- 本 shell 的 git 会报 `missing config key GIT_CONFIG_KEY_0`，先 `unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0`。

---

## 11. 已修 / 待修 / 可能残留

### 11.1 已修（有实测证据）

| 问题 | 修法 | 证据 |
| --- | --- | --- |
| 未登记 QQ 版本注不进 | 扫描 + 成对补丁 + 缓存（核心 0.3.0/0.3.1） | 5 个真实构建矩阵；未登记模拟 2.9 s 出包、真机注入 `stage=started`、`loaded:true` |
| launcher 布局找不到 wrapper | `deriveQQBuildVersion` + `deriveWrapperPath`（`versions/*`） | `modulePath=D:\QQ\versions\9.9.36-53644\...` |
| 中文安装目录注入失败 | ASCII 中转 `%ProgramData%\Alcor\host\<sha8>` | 中文目录副本实测中转、178176/182272 B 齐全 |
| 安装器误杀别的副本与 QQ | path-scoped 清理 + 仅升级时清理 | 6 Alcor + 8 QQ 在跑时安装，前后计数不变 |
| 自动更新装完不回来 | `/RELAUNCH=1` + `ShouldRelaunchAfterSilent` | 静默升级日志出现 Run entry，进程回 6 个 |
| 更新被代理 fake-ip 拦死 | `isFakeIp` + `trustedHosts` | `/api/update-check` ok；非白名单仍拦 |
| 点更新安装器一闪而过 | `installDirArg` 去掉引号 | as.1→as.2、0.3.0→as.2 全自动成功 |
| 清单被 CDN 缓存成旧版 | `newestOf` 比 `publishedAt`；30 分钟轮询 | 6 源实测；11.2 s 发现新版本 |
| 缓存被篡改仍命中 | 四道校验 + 换绑检测 + 自愈 | `tamper2.mjs` 两条重建 |
| 多进程重复构建 | 跨进程 `.building.json` 锁 | 3 路并发 2861 ms 一次扫描 |
| 策略被 contextTier 架空 | 删提前返回 + `tierOfConfig` | 19 + 10 项探针；真机 |
| 崩溃查不出来 | crashReporter + marker 安全模式 + 取证脚本 + 运行库 | 手动写 `.starting` → 日志「安全模式」、marker 消失 |
| 图标旧 | 新图标 + rcedit 写 exe | 安装后 `ExtractAssociatedIcon` 见金色 A |

### 11.2 已知未修（低优先，别当回归）

- **F10 杀软首扫余量**：首次注入被 Defender 扫描拖慢时，loader 超时偏紧；未加自适应等待。
- **独立补丁器 `host-profile-patch.mjs`**（只在 `D:/Alcor-work/patch`，**未随包**）RVA 永远写 entry1、不写 digest；出货走 `profile-pack.mjs`，不受影响。
- **缓存键只有 sha**：wrapper 不变而版本号变化时会复用旧缓存（行为可接受，文档已注明）。
- **同版本重发不会触发更新**：按用户要求 as.2 换图标但版本号不变，已装 as.2 的机器不会提示更新。
- **旧版 0.3.0 客户端**的更新代码源少，可能需手动装一次（0.3.1 起才完整）。

### 11.3 可能残留 / 下次重点观察

- 单实例竞态：曾出现 5320 端口只接 TCP 不回 HTTP，杀干净重启恢复；怀疑双实例抢端口，未复现。
- QQ 升级后 `versions/` 目录可能保留多份；`deriveWrapperPath` 按 sha 匹配，若两份同 sha 会取第一个。
- 安装器在「QQ 已注入宿主」时仍会结束 QQ（设计如此，为了替换 DLL）；用户需重新扫码。
- `qq-profiles.mjs` 头部注释引用了不存在的 `docs/qq-9.9.37-compatibility.md`（应指向 `docs/alcor-qq-version-compat.md`）。
- 核心 DLL 无源码：任何需要新增内建版本的改动只能走「扫描 + 补丁」，不能重编译。

---

## 12. 验证清单（改完必跑）

```bash
# 1) 语法
for f in resources/app/src/update-manager.js resources/alcor/native-core/host-profiles.mjs; do node --check "$f"; done

# 2) 自检台 411 项（连跑 10 轮）
cd /d/Alcor && node D:/Alcor-audit/audit.mjs

# 3) 核心注入自测（含 live probe）
node D:/Alcor/resources/alcor/tests/host-profiles.selftest.mjs

# 4) 活跃期
node D:/Alcor-work/warmtest.mjs && node D:/Alcor-work/warmchain.mjs

# 5) 环境矩阵（28 项）
node D:/Alcor/resources/app/tools/compat-matrix.mjs

# 6) 现役健康
curl -s http://127.0.0.1:5320/api/version
curl -s http://127.0.0.1:5320/api/update-status
curl -s http://127.0.0.1:5320/api/qq/diagnosis

# 7) 真机闭环（需用户扫码）
curl -s -X POST http://127.0.0.1:5320/api/qq/autoconnect
```

预期：`总计 411 项，失败 0 项`；`hasUpdate:false`；诊断 `READY_TO_CONNECT` 或 `CONNECTED`。

---

## 13. 发布记录（最近）

| 版本 | 类型 | 资产 / 哈希 | 备注 |
| --- | --- | --- | --- |
| `0.3.2` | 大版本（正式 release） | `Alcor-Agent-Setup-0.3.2-x64.exe` 319,637,463 B / sha256 `ce264b58…`（以 release 页为准） | 核心 0.3.1 首次随包 |
| `0.3.2-as.1` | 小版本（滚动 `v0.3-latest`） | 319,631,700 B / `5f750582…c7d` | 活跃期加成 |
| `0.3.2-as.2` | 小版本（同号重发） | **319,270,415 B / `13e2c90a78454e6ef454ddae56863569d42d10b0608d25c7fa1615c59635a77f`** | 自动重启 + **新图标** |
| `0.3.1` | 大版本 | 319,598,889 B / `71619deb…` | 核心 0.3.0/0.3.1 基线 |

滚动通道：`v0.3-latest`（release id `453663725`，预发行，名称固定「更新下载通道（自动更新用，请勿手动下载）」）。

---

## 14. 给下一个 agent 的开工模板

> 任务：把 `<要改的行为>` 改掉并验证，不发大版本。
> 边界：只改 `resources/app/src/<file>.js` 与对应 UI；不动安装器、不动核心 DLL。
> 验收：`node D:/Alcor-audit/audit.mjs` 411 项 0 失败；`/api/version` 正常；给出改前/改后证据。
> 交付：仓库改动 + 同步到 `D:/Alcor` + 一段变更说明（含文件:行）。

先读第 1 节确认目录，再读第 8 节定位文件，改完按第 12 节跑验证，发版按第 9 节。遇到注入问题看第 4 节，更新问题看第 5 节，安装器看第 6 节，踩坑先搜第 10 节。

## 17. 当前状态快照（2026-11-21 09:55）

- 现役 `D:/Alcor`：Agent `0.3.2-as.2`（FileVersion `0.3.2.2`）+ 核心 `0.3.1`，窗口/托盘/exe 图标已是新的金色星耀 A；`/api/version` = `0.3.2-as.2`，`/api/update-status` = `core 0.3.1 / hasUpdate false`。
- 新安装包已构建但**没有上传**：`D:/Alcor-pkg/0.3.2-as.2/out/Alcor-Agent-Setup-0.3.2-as.2-x64.exe`，319,270,415 B，sha256 `13e2c90a78454e6ef454ddae56863569d42d10b0608d25c7fa1615c59635a77f`。
- 更新通道 `v0.3-latest`（release id 453663725）里仍是**旧图标**的同版本包：资产 id 775555180，319,630,898 B，sha256 `6bcb56b0…1021`；`update/manifest.json` 仍指向它，所以已装用户不会看到更新提示（版本号没变）。
- 为什么没上传：上行被限速到 50–190 KB/s（同一文件早些时候能跑到 5.27 MB/s），319 MB 需要一到两小时；两次传完后 GitHub 侧资产停在 `starter` 不 finalize，脚本里已含「传完才删旧资产」的保护，中断时通道保持可用。
- 想发布这个图标包时（网络好时再跑，一条命令）：
  ```bash
  cd /d/Alcor-源码/Alcor-Agent/resources/app
  GITHUB_TOKEN=<PAT> node tools/publish-update.mjs --file "D:/Alcor-pkg/0.3.2-as.2/out/Alcor-Agent-Setup-0.3.2-as.2-x64.exe" --version 0.3.2-as.2 --notes "新图标"
  ```
  或直接用 `D:/Alcor-work/finish-icon.mjs`（`wait` / `rename` / `sums` / `manifest` / `purge` 五步，已实测语法与顺序）。
- 仓库 `D:/Alcor-源码/Alcor-Agent` 工作树干净，远端 `main = e881f97`。
