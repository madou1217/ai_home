# 🛸 ai-home (终极 AI CLI 终端劫持与多开沙箱)

> *专为硬客玩家 (Geeks/Hackers) 打造的 AI 命令行多账号轮询与并发管家。*
> [English Documentation](README_en.md)

目前市面上大部分的 AI 终端工具（如 `Gemini CLI`、`Claude Code` 和 `Codex CLI`）都存在一个局限：它们在本地是**“单例单态”**的。官方的设定通常是你只用一个账号干活。
当你在聊天时遇到 `429 Rate Limit`（限流），你的心流就被打断了；当你想开两个窗口让两个 AI 同时处理两个不同的代码库，全局配置文件就会发生冲突，导致会话污染。

`ai-home` (`aih`) 是一个轻量级、极具极客精神的 C++ PTY（伪终端）劫持器和环境多路复用工具。

它通过巧妙的底层机制将原生的 CLI 压入物理隔离的沙箱中，让你能够使用不同的账号运行**无限并发实例**。账号路由基于可信状态（包括 usage 快照），不再依赖脆弱的终端输出关键词匹配。

## 🔥 核心极客机制 (Core Hacks)

*   **零污染环境隔离 (Zero-Pollution Sandboxing)**: 运行时动态修改进程的环境树（如 `HOME`, `USERPROFILE`, 及其特定的隐藏文件夹）。`aih gemini 1` 和 `aih gemini 2` 在文件系统层面完全互不感知。
*   **深度 PTY 劫持 (Deep PTY Hijacking)**: 我们不仅是 `spawn` 进程，我们注入了 `node-pty` 层，用于终端隔离、会话连续性和账号级运行环境管理。
*   **可信耗尽路由 (Trusted Exhausted Routing)**: `aih` 不再根据运行时 stdout 关键词将账号标记为 exhausted。账号耗尽状态由可信 usage-remaining 快照与显式状态操作管理。
*   **API Key 幽灵路由 (Phantom Routing)**: 如果你在终端里 `export OPENAI_API_KEY`，`ai-home` 会自动嗅探。它会将你的 Key 和 Base URL 生成哈希签名，自动为你创建一个专属的免登沙箱，并自动路由过去。
*   **无感迁移 (Ghost Migration)**: 自动嗅探你本机已有的 `~/.gemini` 或 `~/.codex` 全局登录状态，并在你第一次使用时无损克隆进 1 号沙箱，无需重新扫码登录。
*   **自动装备 (Auto-Install)**: 如果你没有安装对应的 CLI 工具，`ai-home` 会在运行时自动为你下载安装对应的 npm 全局包。

## 🚀 极速上手

强烈建议全局安装，并使用 `aih` 这个短命令。

### 1. 初始化与迁移
```bash
aih gemini
```
*如果你本机已经登录过 gemini（如果没有会自动帮你 npm install），它会提示你将其平滑迁移为你的 1 号主账号。*

### 2. 孵化更多分身 (网页授权模式)
```bash
aih gemini add
# 或者
aih codex add
```
*自动为你分配 ID 2、ID 3，并在独立沙箱中唤起原生的网页授权流程。*

### 3. API Key 注入模式 (支持第三方中转)
与其通过浏览器登录，你可以直接注入第三方（如 OpenRouter）的 API Key。
```bash
# 方式 A：交互式输入
aih claude add api_key

# 方式 B：自动识别环境变量 (极客推荐)
export OPENAI_BASE_URL="https://api.your-server.com/v1"
export OPENAI_API_KEY="sk-xxxx"
aih codex
```
*`ai-home` 会检测到环境变量，生成唯一哈希，并自动为你分配一个专属沙箱。如果你在新窗口重新 export 相同的配置，它会自动路由回这个沙箱，防止重复创建。*

### 4. 并发多线程工作
拆分你的终端界面。
窗口 A 执行：`aih gemini 1 "帮我重构这段代码"`
窗口 B 执行：`aih gemini 2 "帮我写刚才那段代码的单元测试"`
它们同时思考，互不干扰。

### 5. 自动账号路由 (Auto Routing)
当你预感到即将触碰账号的 Token 限制时，不要硬编码 ID。
```bash
aih gemini auto "帮我开发一个 React 应用"
```
*`auto` 会在启动时选择下一个非 exhausted 账号，不会在会话中基于终端输出文本自动切号。*

### 6. 资产侦察
```bash
aih ls
```
```text
📦 AI Home Accounts Overview

▶ gemini
  - Account ID: 1  [Active] [Exhausted Limit] (example@gmail.com) 
  - Account ID: 2  [Active] (work@company.com) 
```

### 7. 手动解禁误判账号
当某个账号被误标记为 `[Exhausted Limit]` 时，可手动清除标记：
```bash
aih codex unlock 4
# 或者 ID-first 风格
aih codex 4 unlock
```

### 8. 查看账号剩余额度快照（OAuth / Token）
`aih` 只使用可信接口刷新并缓存“剩余额度”（支持 Gemini / Codex / Claude）。
```bash
aih gemini usage 1
aih codex usage 2
aih claude usage 1
aih gemini usages
aih codex usages
aih claude usages
# 或者 ID-first 风格
aih gemini 1 usage
aih codex 2 usage
aih claude 1 usage
```
若提示无快照：
- `gemini`: 确认该账号已 OAuth 登录后重试
- `codex`: 确认该账号已 OAuth 登录（必要时在沙箱执行 `codex login`）后重试
- `claude`: 若提示本地 provider 未启动，请先启动对应 provider；或切换为 Claude OAuth 登录

### 9. 加密导出 / 导入（支持 age + SSH key）
```bash
# 导出（可选 selectors：codex:1,2 gemini）
aih export backup.aes

# 导入：默认同账号跳过
aih import backup.aes

# 导入：同账号强制覆盖
aih import -o backup.aes
```

说明：
- 密码模式：使用 `AES-256-GCM`
- SSH Key 模式：使用 `age`，仅列出本机 `~/.ssh/id_*.pub` 中可用的 `ssh-ed25519` / `ssh-rsa` 密钥
- 若系统未安装 `age`，CLI 会先给出平台安装命令，并支持交互式自动安装
- `-o` 未指定时，若目标账号已存在则跳过该账号；指定 `-o` 时覆盖该账号目录

### 10. 批量导入账号（自动扫描 accounts/<provider>）
```bash
# 推荐：自动扫描 accounts/codex、accounts/gemini...
aih account import accounts

# 预览不落盘
aih account import accounts --dry-run

# 指定 provider 也支持
aih codex account import accounts/codex --dry-run
```
说明：
- 顶层命令按 `accounts/<provider>` 自动发现并导入
- 当前未实现的 provider 会跳过并提示
- 并发默认按本机 CPU 线程自动设置（macOS / Windows / Linux）

### 11. 本地账号能力代理（OpenAI 兼容）
`aih` 现在内置本地 server，默认使用 provider 专属适配链路：
- `codexBaseUrl`（默认 `https://chatgpt.com/backend-api/codex`）
- `geminiBaseUrl`（默认 `https://generativelanguage.googleapis.com/v1beta/openai`）
- `claudeBaseUrl`（默认 `https://api.anthropic.com/v1`）

补充：当 Gemini 账号是 `oauth-personal`（Gemini CLI 的 Google 登录）时，server 会自动走 Gemini Code Assist 链路（`cloudcode-pa.googleapis.com`），不再按 OpenAI 兼容 URL 直通。

```bash
# 启动后台 server（默认 127.0.0.1:8317）
aih serve

# 查看状态 / 重启 / 停止
aih server status
aih server restart
aih server stop
```

在调用方里填写：
- `base_url`: `http://127.0.0.1:8317/v1`
- `api_key`: `dummy`

管理鉴权（可选）：
- `AIH_SERVER_MANAGEMENT_KEY`：用于 `/v0/management/*` 接口鉴权（仅此变量，已不兼容旧前缀）。

高级可选：
```bash
# 前台调试运行
aih server serve --port 8317 --provider auto

# 开机自启（macOS launchd）
aih server autostart install
aih server autostart status
aih server autostart uninstall
```

管理接口：
- `GET /v0/management/status`
- `GET /v0/management/metrics`（成功率、超时率、最近错误）
- `GET /v0/management/accounts`
- `GET /v0/management/models`
- `POST /v0/management/reload`
- `POST /v0/management/state-index/upsert`
- `POST /v0/management/state-index/set-exhausted`
- `POST /v0/management/state-index/prune-missing`

状态索引写入策略：
- 采用单写者模型：CLI 不再直接写 `account_state.db`，统一由 server 通过 management API 执行写入，降低 SQLite 锁冲突。

Windows 说明（`aih codex usages`）：
- 已兼容 `codex.cmd/.bat` 启动方式。
- 若仍提示无 usage 快照，先在对应沙箱执行一次 `codex login`，再重试 `aih codex usages`。

TTY 智能体验（Codex）：
- 交互键（上下选择/确认）走原生 PTY 透传，`aih` 不拦截。
- 运行中自动阈值切号（默认开启，交互会话生效）：
  - 当当前账号 usage 达到阈值（读 `~/.ai_home/usage-config.json` 的 `threshold_pct`）时，会在 TTY 通知后自动热切到下一个可用账号。
  - 会话存储保持共享（通过 session store 链接），尽量保证 session 连续。
- 默认会为 `codex` 注入 `--skip-git-repo-check`，减少首次项目确认提示。

可选开关：
- `AIH_RUNTIME_AUTO_SWITCH=0` 关闭运行中阈值自动切号
- `AIH_RUNTIME_THRESHOLD_CHECK_MS=<毫秒>` 设置阈值检查周期（默认 60000，最小 30000）
- `AIH_CODEX_AUTO_SKIP_REPO_CHECK=0` 关闭自动注入 `--skip-git-repo-check`

联调用 mock 命令：
```bash
aih dev mock-usage codex 888 --remaining 4 --duration-sec 60
```
会临时把 `codex#888` usage 快照写到低阈值，持续 60s 后自动回退并回读校验。
