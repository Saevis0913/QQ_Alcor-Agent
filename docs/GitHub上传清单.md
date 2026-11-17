# 第一次上传 GitHub · 需要准备什么

## 1. 账号与仓库（10 分钟）

1. GitHub 账号已登录，邮箱已验证（未验证的邮箱推不了 Pages/Release 通知）。
2. 建议先建**私有**仓库推一遍，确认没有密钥混进去，再改公开。
3. 仓库名 `Alcor-Agent`，Owner 用你的用户名（设置页更新源会写成 `https://github.com/<你>/Alcor-Agent`）。
4. 描述用 `Github描述.txt` 里那句英文简介；Topics 填 `qq-bot` `ai-agent` `llm` `nodejs` `electron`。
5. License 选 MIT（仓库里已有 `LICENSE`，保持文件名一致即可）。

## 2. 本机 git 身份与凭据（二选一）

**A. 用 Git Credential Manager（最简单，浏览器登录）**

```powershell
git config --global user.name  "你的名字"
git config --global user.email "你的邮箱"
git config --global credential.helper manager
```

第一次 `git push` 会弹浏览器授权，授权一次以后不再问。

**B. 用 Personal Access Token**

1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → New token。
2. Repository access 选 `Only select repositories` → `Alcor-Agent`。
3. Permissions：`Contents: Read and write`、`Metadata: Read-only`（要发 Release 再加 `Administration: Read and write`）。
4. 有效期建议 90 天；生成后**只显示一次**，立刻存进密码管理器。
5. 推送时用户名填 GitHub 用户名，密码填这个 token（不是账号密码）。

## 3. 推送前必查（这几项出错最难回头）

- **不要提交 `data/`**：里面有 API Key、管理员 QQ、聊天记录、访问令牌。仓库 `.gitignore` 已含 `/temp/`，还需确认 `data/`、`artifacts/`、`node_modules/`、`*.log` 被忽略。
- **不要提交 `resources/app/data`**、`temp/ui-data`、`release-manifest.json` 之外的构建产物。
- 检查一遍：

```powershell
cd D:\Alcor\development\Alcor-Agent
git status --porcelain
git ls-files | Select-String -Pattern 'data/|temp/|\.log$|release-'
```

- 如果不小心提交过密钥：**不要只删文件再提交**，历史里还在。用 `git filter-repo` 或直接删库重建；token 立即在 GitHub 撤销重发。

## 4. 首次推送命令

```powershell
cd D:\Alcor\development\Alcor-Agent
git init                                  # 若还没有仓库
git add -A
git commit -m "Alcor Agent 正式版 v0.2.1"
git branch -M main
git remote add origin https://github.com/<你>/Alcor-Agent.git
git push -u origin main
```

## 5. 发 Release（挂安装包）

1. 仓库 → Releases → **Draft a new release**。
2. Tag：`v0.2.1`，Target：`main`，标题：`Alcor Agent 正式版 v0.2.1`。
3. 说明直接粘 `Github描述.txt` 的正文（重要声明 + 开发目的 + 项目简介 + 核心特性）。
4. 上传附件：`Alcor-Agent-正式版v0.2.1-x64.exe`、`SHA256SUMS.txt`（GitHub 单文件上限 2 GB，这个 300 MB 没问题）。
5. 勾选 `Set as the latest release` → Publish。
6. 发布后把仓库地址写进 `resources/release-source.json`：

```json
{ "url": "https://github.com/<你>/Alcor-Agent" }
```

再重新出一次包，设置页「检查更新」就会指向正式发布源。

## 6. 可选但建议

- README 顶部放一张界面截图（`D:\Alcor-发布-正式版v0.2.1\记录\演示截图\` 里就有）。
- 仓库 Settings → 关闭 Wiki/Projects（不用的功能关掉更干净）。
- 开 Issue 模板（`.github/ISSUE_TEMPLATE/bug_report.md`），把「意见收集」里的反馈渠道指向它。
- 想省事可以直接用网页上传：GitHub 仓库页 → Add file → Upload files，拖整个目录（不含 `.git`），适合第一次。

## 7. 我这边已经准备好的

- 源码仓库：`D:\Alcor\development\Alcor-Agent`（含 `LICENSE`、`package.json`、`README` 素材、`docs/`）。
- 发布包：`D:\Alcor-发布-正式版v0.2.1\安装包\`（exe + SHA256SUMS + 安装与使用）。
- 发布素材：`Github描述.txt`（你给的描述）、演示截图、录制流程。
- 你要做的只有三件：**登录授权**、**建仓库**、**按下 push**。剩下的命令我可以直接执行。
