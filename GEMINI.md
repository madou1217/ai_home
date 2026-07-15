# ai-home (aih) 项目上下文

## 项目概述
`ai-home` (`aih`) 是一个基于 Node.js 的 CLI 工具和本地网关，旨在管理多个 AI 账号（支持 Codex、Claude、Gemini、Antigravity 等提供商）。它将这些账号统一为一个兼容 OpenAI/Anthropic 格式的本地端点 (`http://127.0.0.1:9527/v1`)，并提供诸如基于配额的自动路由、模型别名降级链以及账号级额度管理等功能。该项目的一个核心特性是“持久化 CLI 会话”，底层依赖 `tmux` 确保会话在关闭终端或 SSH 断开连接后依然能够存活和续接。

## 架构与模块组织
- **语言/运行环境:** Node.js，采用 CommonJS 模块规范 (`require`, `module.exports`)。
- **目录结构:**
  - `lib/`: 核心运行时、CLI 命令、服务器逻辑和服务模块。
    - `lib/cli/commands/`: 命令路由和入口逻辑。
    - `lib/cli/services/`: 业务逻辑（导入/导出、PTY 管理、账号编排等）。
    - `lib/cli/bootstrap/`: 依赖注入与组装。
  - `test/`: 覆盖各项行为的 Node 测试文件。
  - `bin/ai-home.js`: CLI 的可执行入口文件。
- **设计原则:**
  - 强制分离关注点 (Separation of Concerns)：每个模块应只负责一项明确的职责。
  - 将编排逻辑与业务逻辑分离；流程控制模块应将具体行为委托给职责单一的服务模块。
  - 依赖倒置：向内依赖抽象，避免模块间的循环依赖。
  - 通过扩展和新增单一职责模块来添加新功能，避免产生庞大臃肿的“上帝文件 (god files)”。
- **持久化会话 (tmux 集成):**
  - 通过 `tmux` 包装器管理会话 (`lib/runtime/persistent-session.js`)。
  - **Socket 隔离:** 每个账号拥有独立的 tmux server socket (`aih-<provider>-<id>`)，确保凭据仅在各自的进程环境变量中隔离，绝不跨越账号边界。
  - **会话寻址:** 根据项目目录 (`cwd`) 或显式标签 (`-S <label>`) 区分会话，允许同一账号在不同项目中并发运行且互不干扰。
  - 跨平台支持：原生支持 macOS 和 Linux；Windows 系统通过探测并使用兼容 tmux 的引擎（如 `psmux` 或 MSYS2 的 `tmux.exe`）提供支持。

## 开发约定
- **代码风格:** 2 个空格缩进，使用分号，使用单引号。
- **文件命名:** 使用 kebab-case 短横线命名法 (例如 `account-import-orchestrator.js`)。
- **函数设计:** 倾向于编写小型、可组合的函数，避免编写庞大且功能繁杂的单一函数。
- **提交规范:** 遵循约定的 Commit 格式 (例如 `feat(...)`, `fix(...)`, `refactor(...)`)。保持每次提交逻辑单一且聚焦。

## 构建与运行
- **安装依赖:** `npm install` (安装完成后会自动触发 `postinstall` 脚本，修复可执行文件权限和钩子)。
- **手动运行 CLI:** `node bin/ai-home.js --help`
- **运行 Web UI 开发服务:** `npm run web:dev`
- **构建 Web UI:** `npm run build`

## 测试指南
- **测试框架:** 使用 Node.js 内置的测试运行器 (`node:test`) 搭配 `assert/strict` 断言。
- **运行全部测试:** `npm test`。
- **针对性测试:** 在开发迭代期间，可以通过指定文件运行单一测试，例如 `node --test test/backup.router.test.js`。
- **期望要求:** 根据行为来命名测试用例。每次更改行为（包括错误处理路径）都必须添加或调整相应的测试。在提交更改前务必运行完整的测试套件。

## 安全须知
- **绝对不要将真实的 token、API 密钥或导出的凭据文件提交到版本库中。**
- 校验所有导入路径，防范目录遍历漏洞 (Directory Traversal Vulnerabilities)。
- 敏感的运行时配置请优先使用环境变量进行管理。
