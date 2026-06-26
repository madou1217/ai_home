# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

`ai-home`（`aih`）管理 Codex / Claude / Gemini / Antigravity(agy) 的多账号沙箱运行，并统一暴露为一个 OpenAI/Anthropic 兼容网关。核心能力：按 (账号, 模型) 粒度路由与熔断、模型别名降级、持久 tmux CLI 会话、React WebUI。

## 命令速查

```bash
# 安装
npm install

# 运行所有测试
npm test                              # node --test test/*.test.js

# 运行单个测试文件
node --test test/backup.router.test.js

# 验证 CLI 启动
node bin/ai-home.js --help

# Web UI 开发服务器
npm run web:dev                       # cd web && npm run dev (Vite)

# Web UI 构建
npm run build                         # cd web && tsc && vite build

# Web UI lint
cd web && npm run lint
```

## 代码风格

- **主体 `lib/`**：Node.js CommonJS（`require` / `module.exports`），2空格缩进，分号，单引号，kebab-case 文件名
- **`cli/`**：TypeScript ESM，由 Bun 运行（vendored Claude Code 源码，勿修改除非必要）
- **`web/`**：TypeScript + React 18 + Ant Design + Vite，ESM

## 架构分层

```
bin/           CLI 可执行入口（ai-home.js → lib/cli/app.js）
lib/
  cli/
    app.js             组合根：导入所有 bootstrap wiring，分发命令
    commands/          命令路由（root, ai-cli, backup）
    services/          业务逻辑（PTY, 账号编排, 导入导出, server daemon）
    bootstrap/         依赖注入：显式工厂函数，无 IoC 容器
    config/            常量、路径、Feature flags
  server/              网关引擎（143 个文件）：请求摄取 → 协议翻译 → 提供商路由 → 熔断
  account/             账号域：加载、身份标识、状态缓存、跨机同步
  sessions/            会话读取：session-reader.js 解析各 provider 历史
  runtime/             平台抽象：persistent-session.js（tmux）、pty-launch.js
  usage/               用量追踪、定价、周期调度
  protocol/            SSE 解析、工具调用适配、token 计数
web/src/               React WebUI（页面 + hooks + services）
cli/src/               Vendored Claude Code（Bun/TypeScript，独立技术栈）
test/                  所有测试文件（*.test.js，约 155 个）
```

## 核心架构决策

### Agent Runtime 兼容与 advisor 语义

跨 Claude Code / Antigravity(agy) / Gemini / Codex 迁移 prompt 时，`advisor` 必须被视为“独立审查意图”，不是必然存在的工具。

- 不因为 `advisor` 工具缺失直接停工；先执行能力解析。
- 解析顺序：`reviewer_subagent` → `native_review` → `self_review` → `plan_check` → `warning_noop`。
- `warning_noop` 必须显式说明，不允许静默跳过审查语义。
- 高风险操作（commit、push、删除/批量改动、生产 API、权限/配置修改）在 reviewer/advisor 缺失时必须要求人工确认或记录明确 bypass。
- 兼容逻辑应集中在 adapter/resolver 层；不要在 provider 启动代码、协议路由或 prompt 模板里散落 `advisor`/`review` 字符串替换。
- 工具别名只处理可执行 tool；`plan`、`review`、`self_verify`、`advisor` 这类阶段性能力应映射为 workflow intent。

### 交付报告约束

完成非平凡优化、兼容性、架构或运行时行为变更后，必须在最终报告中列出：`文件/模块 -> 使用的设计模式 -> 使用原因 -> 验证证据`。如果没有使用设计模式，必须说明 KISS/YAGNI 为什么拒绝新增抽象。

本节只定义报告规则，不记录具体任务的模式清单或完成结果；具体清单只写在最终回复或 PR 说明中，除非用户明确要求更新文档。

### 持久 tmux 会话
每个 CLI 会话默认包裹在 `tmux -L <socket> new-session -A -D -s <session>`：
- **socket = per-account**：`aih-<provider>-<id>`，账号间凭据完全隔离
- **session = per-project**：默认 `p-<basename>-<hash(cwd)>`，关终端后可重新 attach
- 凭据只通过进程 env 传递，**绝不通过 tmux `-e`/argv**（防 `ps` 泄露）
- 降级：检测不到 tmux 时退化为直接 spawn，`AIH_NO_PERSIST=1` 强制跳过

### 网关路由（`lib/server/`）
请求进入 → `router.js`（账号选择 + 失败/成功记账）→ `capability-router.js`（按 provider 能力路由）→ `protocol-*.js`（OpenAI/Anthropic/Gemini 协议翻译）→ upstream

### 账号唯一标识
`accountId` 仅为 CLI 内部可变索引；持久化真相是 `unique_key`（OAuth 账号用 email，API Key 账号用 url+keyhash），单一来源：`lib/account/account-identity.js`

### 模型别名 + 熔断
- 别名在运行时感知 fallback，`/v1/models` 不暴露通配 `claude-*`
- 429 按 `(account, model)` 粒度熔断，不锁整号

### WebUI 实时推送
`session-event-bus.js` → `webui-sse-broadcaster.js` → 浏览器 SSE 连接

## 测试规范

- 框架：Node.js 内置 `node:test` + `assert/strict`，无 Jest/Mocha
- 测试文件平铺于 `test/`，命名对应模块（如 `account.state-index.test.js`）
- 测试命名格式：`test('runGlobalAccountImport reports provider progress callback', ...)`
- 每次行为变更须同步更新测试，包括 fallback 和错误路径
- 提交前：先跑目标文件，再跑全量 `npm test`

## PR 规范

Commit 格式：`feat(...)` / `fix(...)` / `refactor(...)`，一个 commit 一个逻辑变更。

PR 描述须包含：目的与范围、关键变更文件、测试命令 + 结果、CLI/UI 变更附截图或日志片段。
