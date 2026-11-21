# Alcor QQ 版本兼容设计与验收矩阵

> 本文档是「Alcor 核心如何在任意 QQ 版本下注入并工作」的**唯一依据**：后续适配 10+ 个 QQ 版本时，以本文的分层设计、版本清单、证据要求与验收矩阵为准。
> 源码快照：`D:\Alcor-源码\Alcor-Agent`（对应 Alcor Agent 0.2.9 源码期，见 `README.md`「版本」节）。本文引用的每条路径都已在快照中核实存在；命令均为可直接执行的真实命令。

---

## 1. 现状

### 1.1 已适配版本（唯一登记处）

登记表在 `resources/alcor/native-core/qq-profiles.mjs` 的 `QQ_BUILD_PROFILES`，**按 `wrapper.node` 的 SHA-256 精确匹配，不看 QQ.exe 的显示版本号**：

| QQ 版本 | wrapper.node SHA-256 | 验证等级 | 14 个 RVA | 状态 |
| --- | --- | --- | --- | --- |
| 9.9.36-53644 | `0d8b94448f4dafe7337b88d6a568b004224c37fcbe2bd1142c1af7624fbd534c` | `live`（实网收发验证） | 已登记 | ✅ 可直接连接 |
| 9.9.37-54395 | `fed532ad58d2404dcedf2858554e8fa52a5f4e65b271c008d2faca4011d7d4a2` | `static`（静态 ABI 比对，待实机） | 已登记 | ⚠️ 可连，连接后需确认收发 |

每个 profile 的 14 个 RVA 字段（见 `qq-profiles.mjs:8-12`）：`service_getter`、`release`、`string_construct`、`string_destroy`、`callback_move`、`callback_present`、`callback_destroy`、`service_global`、`core_global`、`service_vtable`、`core_vtable`、`account_pair`、`send`、`receive`。

### 1.2 识别与注入链路（现状全貌）

```
QQ.exe 进程
  └─ wrapper.node（身份 = SHA-256）
       ├─ [JS 识别层] native-core/discovery.mjs → discoverQQ()/classifyQQProcess()
       │     精确命中 → supported=true（reason: IDENTITY_REQUIRES_CONNECTION / ALCOR_HOST_PRESENT / FOREIGN_MODULES_PRESENT）
       │     家族命中 → verification:'family'，reason:'FAMILY_UNVERIFIED'（supported 仍 false）
       │     都不中 → reason:'UNSUPPORTED_BUILD'
  └─ [注入层] artifacts/native/qq-host-loader.exe（controller.mjs load()，75 s 上限）
       ├─ 先 'inspect-qq' 模式探一遍：发现 alcor-host.dll 已在 → HOST_ALREADY_PRESENT
       └─ 'qq' 模式 LoadLibrary alcor-host.dll → 宿主常驻 QQ 进程直到 QQ 退出
            └─ 命名管道 \\.\pipe\alcor-host-<pid>-<nonce>（host-client.mjs queryNativeHost()）
                 └─ [会话层] native-core/session.mjs NativeSession（frame.mjs 编解码）
                      └─ [后端层] src/native-backend.mjs NativeBackend
                           → OneBot 动作（get_status / send_private_msg / …，见 native-backend.mjs:22-27 NATIVE_ACTIONS）
```

### 1.3 兼容尝试层（未适配版本的「能试一次」）

- `qq-profiles.mjs:29-38 matchQQFamily()`：只认 `wrapper.node`、版本形如 `9.9.NN-XXXXX` 且 NN 落在 **33–45**（`FAMILY_MIN=33, FAMILY_MAX=45`）→ 返回 `{verification:'family', sha256:null, rvas:null}`，**不进白名单**。
- `resources/app/src/qq-diagnosis.js:48-53 pickRelaxedCandidate()`：未登记构建只要「确实是 QQ.exe、无外来模块、宿主不在里面」就给出可点候选，判定码 `QQ_BUILD_UNLISTED`；有外来模块时仍回 `UNSUPPORTED_BUILD` 且不给候选。
- `native-core/controller.mjs:95-98`：`connect(pid, {allowUnverified:true})` 且 reason 为 `UNSUPPORTED_BUILD`/`FAMILY_UNVERIFIED`、路径确实是 `QQ.exe` 时才放行，并记 `lastUnverified = {version, sha256, at}` 留痕。
- `resources/app/src/routes.js:135-194 autoConnect()`：`HOST_ALREADY_PRESENT`/`HOST_REFERENCE_STUCK` 纳入重试集合，先 `restartQQ()` 关干净 QQ 再开、等 10 秒继续注入——**放宽尝试失败时 QQ 至少是干净重启状态**。

### 1.4 诊断与恢复现状

- 判定码全表在 `resources/app/src/qq-diagnosis.js diagnoseQQ()`（`ALREADY_CONNECTED`/`READY_TO_CONNECT`/`RECEIVE_NOT_READY`/`CORE_OFFLINE`/`NO_QQ_RUNNING`/`UNSUPPORTED_BUILD`/`QQ_BUILD_UNLISTED`/`HOST_PRESENT`/`HOST_ALREADY_PRESENT`/`FOREIGN_MODULES`/`ELEVATION_MISMATCH`/`SESSION_MISMATCH`/`ARCH_MISMATCH`/`HOST_RUNTIME_BROKEN`/`HOST_TARGET_DENIED`/`HOST_LOAD_BLOCKED`/`HOST_ENTRY_FAILED`/`INJECTION_BLOCKED`/`PROCESS_UNREADABLE`）。
- 只读排查程序：`resources/app/tools/qq-doctor.mjs`（随包 .cmd 名为「控制台无法连接，显示被占用点这个，对照最后一行判定码.cmd」），报告落 `data/qq-doctor-<时间戳>.log`，退出码 0 可连 / 1 需处理 / 2 版本未适配 / 3 核心未运行 / 4 读不到 QQ。
- 环境取证：`resources/app/src/qq-compat.js`（HVCI、智能应用控制、提权、PE 架构、跨会话——全部只读）。
- 断线自动接回：`native-core/native-resume.mjs`，选择保存在 `data/alcor.config.json.native-resume.json`，「宿主已驻留」不清选择、每 30 秒轻量重试。
- UI 入口：`resources/app/ui/app/19-qq-link.js`（「一键检测并连接」「仍然尝试注入」「以管理员重启」）。

### 1.5 已实测的版本事实（docs/关键要点.md:557-579）

- `pc.qq.com` 下载页当前发 `9.9.37.54395`（= 已静态适配的 9.9.37-54395）。
- 开发机 `D:\QQ\QQ.exe` 的 FileVersion 是 `9.9.33.52230`，但它加载的 `wrapper.node` 报 `9.9.36-53644`——**QQ.exe 显示版本与 wrapper.node 版本可以不一致，识别永远以 wrapper.node 为准**。
- 真机回归基线：9.9.36-53644 第 1 次注入成功，私聊/群发 `server-confirmed`；自检台 342 项 × 10 轮全绿（3420 断言，记录于 docs/关键要点.md:594）。

---

## 2. 根因（为什么「任意 QQ 版本」不能一步到位）

1. **服务对象没有稳定 ABI**。原生接入靠读取 QQ 进程内的服务对象（vtable、transport 指针、全局变量）来收发消息；这些地址随每个 QQ 构建漂移，只能以 RVA 表逐版本登记（`docs/关键要点.md:30`：QQ 更新后需重新取 RVA 并更新 `native-core/win32/qq_host_backend.c` 与 profile）。
2. **版本号不可信**。QQ.exe 的 FileVersion 与 wrapper.node 实际版本会出现错位（见 1.5），所以精确识别必须落在 **wrapper.node 的 SHA-256** 上——文件级指纹，改名/显示版本都骗不过。
3. **「能不能试」和「试了会不会坏」是两件事**。未适配版本可能只是 RVA 漂移（试一次、失败可恢复），也可能是 32 位、跨会话、HVCI 拦截、他框架占用（试了只会更糟）——所以设计上把这两类分开：前者给 `QQ_BUILD_UNLISTED` + 用户知情后的 `allowUnverified`，后者直接 `UNSUPPORTED_BUILD`/对应环境判定码拒绝。
4. **一个 QQ 进程只能挂一个框架**。LiteLoader/NapCat/LLOneBot/SnowLuma 等注入的模块占用的是同一个服务对象（`discovery.mjs` `foreignPattern` 扫描），冲突不能靠硬注入解决。

---

## 3. 方案（分层设计）

### 3.1 四级验证等级（从严到宽）

| 级别 | 判定依据 | 行为 | 登记内容 |
| --- | --- | --- | --- |
| `live` | wrapper.node SHA-256 精确命中 + 实网收发验证过 | 直接「连接 QQ」 | SHA-256 + 14 RVA |
| `static` | SHA-256 精确命中 + 静态 ABI 比对完成、未实机 | 可连，连接后确认账号与收发（qq-diagnosis.js:191 文案） | SHA-256 + 14 RVA |
| `family` | 版本号落 9.9.33–9.9.45 窗口（`matchQQFamily`） | 判定 `QQ_BUILD_UNLISTED`，标题「同系列未逐字节验证，可以试一次」；须用户点「仍然尝试注入」 | 无（sha256/rvas 均为 null） |
| 未登记 | 都不中 | `UNSUPPORTED_BUILD`；若进程干净仍给放宽候选（`pickRelaxedCandidate`），仍需 `allowUnverified` | 无 |

精确 SHA-256 永远优先：名单内的两版不受家族层任何影响（`classifyQQProcess` 先 `findQQBuildProfile` 再 `matchQQFamily`）。

### 3.2 适配一个新版本的标准流程

1. **取证**：在目标版本 QQ 上跑排查（见 §6 命令 A2/A8），从进程清单拿 wrapper.node 的 SHA-256 与 FileVersion。
2. **人工 RE**：对 wrapper.node 定位 14 个 RVA（对照相邻已适配版本做 diff；原生侧消费方是 C 后端，登记表经 `qq-profiles.mjs renderQQProfilesHeader()` 生成 C 头文件——见 §4）。
3. **登记**：在 `qq-profiles.mjs` 的 `profiles` 数组追加条目（version / sha256 / 14 个 RVA / verification 先写 `static`）。`renderQQProfilesHeader()` 内建登记校验：SHA-256 必须 64 位十六进制、版本格式 `^\d+.\d+.\d+-\d+$`、RVA 必须是 1–0x10000000 的安全整数、字段数与第一条完全一致、SHA-256 不得重复——**任何一条不满足直接抛 `INVALID_QQ_PROFILE`/`INVALID_QQ_RVA`/`DUPLICATE_QQ_BUILD`**。
4. **重建原生件**：用生成的头文件重建 `alcor-host.dll` / `qq-host-loader.exe` / `alcor-runtime-<64hex>.dll`（⚠️ 受 §7 R1 阻塞：本快照内无 C 源码与构建链）。
5. **静态验收**：`renderQQProfilesHeader()` 无异常 + 诊断判定从 `QQ_BUILD_UNLISTED` 变为 `READY_TO_CONNECT`（verification=static）。
6. **实网升级**：真机连接 + 私聊/群发 `server-confirmed` 后，把 verification 改为 `live`。

### 3.3 兼容尝试的安全边界（写死，不放宽）

- `allowUnverified` 必须是用户显式动作（UI「仍然尝试注入」→ `POST /api/qq/autoconnect` body 带 `allowUnverified:true`，`routes.js:488-490`）。
- 只对「构建未适配」放宽；外来模块、宿主已在、进程读不到、非 QQ.exe 路径一律继续拒绝（`controller.mjs:95`）。
- 失败自动恢复：`autoConnect()` 命中 `HOST_ALREADY_PRESENT`/`HOST_REFERENCE_STUCK` 先 `restartQQ()` 再试；宿主 DLL 只随 QQ 退出消失，不会留下半截状态。
- 放宽尝试留痕：`controller.mjs` `lastUnverified = {version, sha256, at}` 进快照，可审计。

### 3.4 代码不能绕的硬边界（只能检测 + 指路）

32 位 QQ（宿主是 x64）、跨 Windows 会话、HVCI/智能应用控制/EDR 拦 `LoadLibrary`、一个号一个框架——对应判定码 `ARCH_MISMATCH`/`SESSION_MISMATCH`/`HOST_LOAD_BLOCKED`/`INJECTION_BLOCKED`/`FOREIGN_MODULES`，处置文案在 `qq-diagnosis.js FAILURE_TEXT` 与 `describeQQFailure()`。

---

## 4. 哪些能自动推导、哪些必须人工 RE

### 4.1 可自动推导（脚本/代码完成，不需要人看反汇编）

| 项 | 机制 | 位置 |
| --- | --- | --- |
| wrapper.node 的 SHA-256 | PowerShell 遍历 QQ 进程模块算哈希 | `discovery.mjs` 内嵌脚本（`discoverQQ()`） |
| wrapper.node 的 FileVersion / 模块路径 | 同上，进程模块清单 | `discovery.mjs` |
| PE 架构（x64/x86/arm64） | 只读 PE 头 4 KB，不执行文件 | `qq-compat.js peArchitecture()` |
| 家族归属（9.9.33–9.9.45） | 版本号正则 + 窗口判断 | `qq-profiles.mjs matchQQFamily()` |
| 精确构建匹配 | SHA-256 查表 | `qq-profiles.mjs findQQBuildProfile()` |
| 外来框架识别 | 模块名 `foreignPattern` 正则 + 硬盘落点扫描 | `discovery.mjs isForeignQQModule()`、`qq-diagnosis.js scanFrameworkDirs()` |
| 环境风险（HVCI/提权/会话/运行库） | 只读取证 | `qq-compat.js` |
| 判定码汇总 | 规则引擎 | `qq-diagnosis.js diagnoseQQ()` |
| 登记表 → C 头文件 + 登记合法性校验 | 生成器即校验器 | `qq-profiles.mjs renderQQProfilesHeader()` |
| 随包运行时件存在性（`alcor-runtime-<64hex>.dll`） | 文件名正则 `^alcor-runtime-[a-f0-9]{64}\.dll$` | `resources/app/src/environment-check.mjs:154` |

### 4.2 必须人工 RE（无法从既有数据推导）

| 项 | 为什么 | 产物 |
| --- | --- | --- |
| **14 个 RVA 逐个定位** | 服务对象地址随构建漂移，只能对 wrapper.node 反汇编定位：`service_getter`（服务获取入口）、`service_vtable`/`core_vtable`（vtable 布局校验）、`service_global`/`core_global`（全局对象）、`account_pair`（账号对）、`send`/`receive`（收发入口）、`string_construct`/`string_destroy`/`release`（字符串/引用生命周期）、`callback_move`/`callback_present`/`callback_destroy`（回调三件套） | 每版一张 RVA 表 |
| 相邻版本 ABI diff | 判断改动是「纯地址漂移」还是「布局重构」——后者不能只抄表 | 差异结论（进每版证据文档） |
| 新回调/新字段语义 | QQ 新增消息类型时 protobuf/段结构变化 | `native-core/protobuf-fields.mjs`、`outgoing-segments.mjs` 等的扩展 |
| 实网收发确认 | 静态比对证明「地址对」，只有真实账号收发证明「能用」 | `server-confirmed` 记录 |

**判据一句话**：哈希、版本号、架构、环境——机器来；**地址和布局——人来**。`renderQQProfilesHeader()` 是两边的接缝：人工 RE 产出 RVA 表 → 登记进 `qq-profiles.mjs` → 生成器校验并产出 C 头 → 原生构建消费。

---

## 5. 版本适配清单（13 个版本，每版所需证据）

窗口取家族判定范围 9.9.33–9.9.45。每版升到 `supported` 需要的证据编号：**E1** wrapper.node SHA-256（机器取证）；**E2** 14 RVA 表（人工 RE）；**E3** 登记进 `qq-profiles.mjs` 且 `renderQQProfilesHeader()` 校验通过；**E4** 原生三件重建（alcor-host.dll / qq-host-loader.exe / alcor-runtime-<hash>.dll，当前受 R1 阻塞）；**E5** 静态 ABI diff 结论（一版一文档，落 `docs/`）；**E6** 实网验证（identity flags=15 + 私聊/群发 server-confirmed，媒体按 capabilityScope 逐项记录）。

| # | 版本 | 现状 | 升级到 supported 需要 | 到 live 还需要 |
| --- | --- | --- | --- | --- |
| 1 | 9.9.33（实测样本 9.9.33.52230） | family 窗口内，未登记 | E1 E2 E3 E4 E5 | E6 |
| 2 | 9.9.34 | family 窗口内，未登记 | E1 E2 E3 E4 E5 | E6 |
| 3 | 9.9.35 | family 窗口内，未登记 | E1 E2 E3 E4 E5 | E6 |
| 4 | 9.9.36-53644 | **已适配 `live`** | —（保持） | —（已达成；回归基线见 1.5） |
| 5 | 9.9.37-54395 | **已适配 `static`** | —（已登记） | **仅 E6**：实机连接 + 收发确认 |
| 6 | 9.9.38 | 将来版本，family 窗口内 | E1 E2 E3 E4 E5 | E6 |
| 7 | 9.9.39 | 将来版本，family 窗口内 | E1 E2 E3 E4 E5 | E6 |
| 8 | 9.9.40 | 将来版本，family 窗口内 | E1 E2 E3 E4 E5 | E6 |
| 9 | 9.9.41 | 将来版本，family 窗口内 | E1 E2 E3 E4 E5 | E6 |
| 10 | 9.9.42 | 将来版本，family 窗口内 | E1 E2 E3 E4 E5 | E6 |
| 11 | 9.9.43 | 将来版本，family 窗口内 | E1 E2 E3 E4 E5 | E6 |
| 12 | 9.9.44 | 将来版本，family 窗口内 | E1 E2 E3 E4 E5 | E6 |
| 13 | 9.9.45 | family 窗口上界；再往上（9.9.46+）出窗 | E1 E2 E3 E4 E5，**且先扩 `FAMILY_MAX`** | E6 |

窗口外（8.9.x、9.9.99 等）永远 `UNSUPPORTED_BUILD`（单测已覆盖：`matchQQFamily` 对 `9.9.99-60000`/`8.9.30-1` 返回 null，记录于 docs/关键要点.md:576）。

**每版证据的落位**：E1/E6 落 `data/qq-doctor-<时间戳>.log` 与会话日志；E2/E3 落 `qq-profiles.mjs` 提交；E5 落 `docs/qq-<版本>-compatibility.md`（每版一份，命名对齐 `qq-profiles.mjs:2` 注释里已引用的 `docs/qq-9.9.37-compatibility.md`——该文件在本快照缺失，见 R2，补齐时按此命名）。

---

## 6. 验收矩阵

验收命令前置：控制台地址以 `data/config.json` 为准（README 记 `http://127.0.0.1:5320`）；源码树直跑用系统 Node 22+。

| # | 验收项 | 命令（真实可执行） | 通过条件 |
| --- | --- | --- | --- |
| A1 | 登记表自洽 | `node -e "import('file:///<仓库>/resources/alcor/native-core/qq-profiles.mjs').then(m=>{m.renderQQProfilesHeader();console.log('OK',m.QQ_BUILD_PROFILES.length)})"` | 输出 `OK 2`，无 `INVALID_QQ_PROFILE`/`INVALID_QQ_RVA`/`DUPLICATE_QQ_BUILD` 抛错 |
| A2 | 精确匹配分类 | 9.9.36-53644 机器上 `GET /api/qq/diagnosis`（`routes.js:457`） | `code:READY_TO_CONNECT`，candidate.verification=`live` |
| A3 | 家族分类 | 9.9.33–9.9.45 未登记版机器上同上 | `code:QQ_BUILD_UNLISTED`，带 `candidate.pid`，标题含「同系列未逐字节验证」 |
| A4 | 出窗拒绝 | 伪造版本行喂 `classifyQQProcess()`（`discovery.mjs`）或 9.9.46+ 实机 | `supported:false`、非 `FAMILY_UNVERIFIED`；`matchQQFamily` 返回 null |
| A5 | 未适配尝试 + 恢复 | `POST /api/qq/autoconnect` body `{"allowUnverified":true}`（`routes.js:488`） | 成功 → `CONNECTED`；失败 → QQ 被干净重启、无半截宿主、`lastUnverified` 有留痕 |
| A6 | 实网收发（live 的定义） | 连接后真机发私聊 + 群消息 | 两侧均 `server-confirmed`；`GET /api/qq/diagnosis` → `ALREADY_CONNECTED` |
| A7 | 外来框架拒绝 | 装 LiteLoader 后 `GET /api/qq/diagnosis` | `FOREIGN_MODULES`（或带外来模块时 `UNSUPPORTED_BUILD` 且无候选） |
| A8 | 只读排查可用 | 双击随包「控制台无法连接，显示被占用点这个，对照最后一行判定码.cmd」（包 `resources/app/tools/qq-doctor.mjs`） | 报告落 `data/qq-doctor-<时间戳>.log`，末行判定码与 UI 一致 |
| A9 | 断线自动接回 | 连接后退出 QQ 再登录，不动 UI | 30 秒级自动接回（`native-resume.mjs` 重试梯度 1s→30s） |
| A10 | 新版本登记生效 | 完成某版 E1–E4 后重复 A2 | 该版判定变 `READY_TO_CONNECT`（verification=`static`），`supportedVersions` 含新版本 |
| A11 | 回滚可用 | 见 §8 各级回滚动作 | 回滚后旧版本判定/连接行为与回滚前一致，`data/` 无损 |

---

## 7. 风险

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R1 | **原生构建链缺失**：`docs/关键要点.md` 记录原生 C 仓在 `D:\Alcor\development\Alcor`（含 `native-core/win32/qq_host_backend.c`），本机已丢失，且本快照内**没有任何 .c/.h 源文件**，只剩编译产物（`artifacts/native/` 下 qq-host-loader.exe、alcor-host.dll、alcor-runtime-1d6387f8….dll） | 新版本无法完成 E4（重建原生件）→ §3.2 流程断在第 4 步，只能停留在 family/放宽层 | 找回或重建原生仓；短期先做 JS 侧（family 窗口、放宽判定），登记表只做前瞻记录 |
| R2 | 文档指针断裂：`qq-profiles.mjs:2` 引用 `docs/qq-9.9.37-compatibility.md`，该文件在本快照 `docs/` 不存在 | 9.9.37 静态适配的原始比对记录不可考 | 按 §5 命名补写该文档（E5 要求本就如此） |
| R3 | 家族窗口硬过期：QQ 出 9.9.46+ 后 `matchQQFamily` 直接 null → `UNSUPPORTED_BUILD` 且无家族候选（进程仍干净时可走 `pickRelaxedCandidate` 的未登记分支） | 「99% 机器能试一次」承诺收窄 | 每逢大版本发布评估扩 `FAMILY_MIN/FAMILY_MAX`（一行改动 + 单测：docs/关键要点.md:576 的 `matchQQFamily` 用例照跑） |
| R4 | 版本号错位：QQ.exe FileVersion ≠ wrapper.node 版本（已实测 9.9.33.52230 vs 9.9.36-53644） | 按显示版本沟通/记录会产生误判 | 一切识别与文档记录以 wrapper.node SHA-256 + 其 FileVersion 为准（本文 §1.1 表即此口径） |
| R5 | 能力边界随版本漂移：视频发送在 9.9.36 实测 `VIDEO_NATIVE_UNSUPPORTED`（宿主协商断管道，docs/关键要点.md:589） | 每版 E6 必须逐媒体项实测，不能默认继承 | E6 明确要求按 `capabilityScope`（`native-backend.mjs:32`，现为 `private-group-text-and-media-receive`）记录文本/图片/表情/拍一拍/视频/语音各项结论 |
| R6 | 安全环境拦截：HVCI、智能应用控制、EDR 拦 `LoadLibrary`（判定码 `HOST_LOAD_BLOCKED`/`INJECTION_BLOCKED`） | 与版本无关但常被误报为「版本不兼容」 | `qq-compat.js` 只读检测 + `qq-diagnosis.js` 处置文案；验收时先排除环境项再谈版本 |
| R7 | 放宽尝试的原生侧行为不可考：`allowUnverified` 注入未登记构建时宿主拿不到该构建的 RVA 表（哈希查 `lb_qq_profile_for_hash` 落空），其降级行为由 C 侧决定，而 C 源不在本快照（同 R1） | 「试一次」的成功率与失败形态无法从本仓推导 | 依赖 A5 的失败可恢复保证兜底；找回原生仓后补记其降级策略到本文 §3.3 |
| R8 | 双表一致性：JS 侧 `qq-profiles.mjs` 与原生侧编译进 DLL 的登记表是两份（后者由 `renderQQProfilesHeader()` 生成） | 只改 JS 侧会让「UI 认为已适配、原生注入仍按旧表」 | §3.2 步骤 3+4 必须同次交付；A1 只验 JS 侧，A10 才验端到端 |
| R9 | QQ 自动更新静默断连：更新后哈希落空 → `UNSUPPORTED_BUILD`（这是设计行为，非故障） | 用户侧表现为「突然连不上」 | 判定码 + 文案已指路（换回适配版或走放宽尝试）；长期靠 §5 清单滚动适配 |
| R10 | 一号一框架：与其他框架并发注入必然冲突 | 无法共存 | `FOREIGN_MODULES` 检测 + 明确文案，不做硬注入 |

---

## 8. 回滚

按影响半径从小到大，全部动作都**不动 `data/`**（配置、会话、记忆、令牌）：

| 级别 | 场景 | 动作 | 依据 |
| --- | --- | --- | --- |
| L0 会话 | 单次连接异常 / 想立刻换宿主 | `POST /api/qq/restart`（`routes.js:510`，内部 `restartQQ()`）；或完全退出 QQ 重登——宿主 DLL 只随 QQ 进程退出消失 | `controller.mjs` 注释与 `native-resume.mjs:11-12` |
| L1 放宽尝试 | `allowUnverified` 试失败 | 无需人工回滚：`autoConnect()` 已自动 `restartQQ()` 后重试/收尾，QQ 处于干净重启态；审计留痕 `lastUnverified` 不会残留任何注入 | `routes.js:194`、`controller.mjs:96-98` |
| L2 版本登记 | 新登记版本出问题 | 从 `qq-profiles.mjs` `profiles` 数组删掉该条 → 判定回落 family/unlisted；**注意 R8：原生 DLL 内仍是旧表，彻底回滚需随包回退 artifacts**（覆盖安装旧版安装包，`data/` 保留） | §3.1 分级本身即回落机制 |
| L3 家族窗口 | 扩窗后出问题 | 还原 `FAMILY_MIN/FAMILY_MAX`（qq-profiles.mjs:28）为 33/45，跑 §6 A4 用例 | 单点常量改动 |
| L4 断线接回 | 不想自动接回旧选择 | 删 `data/alcor.config.json.native-resume.json`（或 UI 断开） | `native-resume.mjs clear()` |
| L5 整包 | 版本级回退 | 用上一个安装包覆盖安装（原地升级机制，`data/` 不动）；卸载亦保留 `data` | `docs/关键要点.md` 打包红线与 0.2.4 打包记录 |

**回滚验证**：每次回滚后跑 §6 的 A2（或对应判定码用例）确认行为回到回滚前；`GET /api/qq/diagnosis` 的 `supportedVersions` 应与回滚目标版本的登记表一致。

---

## 9. 维护规矩（给后续适配者）

1. 登记只改 `qq-profiles.mjs` 一处（JS 侧）；改完必须过 A1，且与原生重建同次交付（R8）。
2. 每版一份 `docs/qq-<版本>-compatibility.md`（E5），含 RVA diff 结论与实网记录；本文 §5 清单同步更新该版状态。
3. 判定码文案改动只动 `qq-diagnosis.js`；新增判定码必须同步 README 判定码表与 `qq-doctor.mjs`。
4. 识别口径永远是 wrapper.node SHA-256，禁止按 QQ.exe 显示版本放行（R4）。
5. 任何「让未验证构建直接连」的提议都违反 §3.3 安全边界，除非走 `allowUnverified`。
