# AI Home 当前功能矩阵

> 快照日期：2026-08-13
> 用途：作为逐功能重构、技术栈迁移与回归验收的基线；本文件描述“当前真实存在什么”，不代表这些能力都已达到同一成熟度。
> 本轮范围：仅盘点功能，不实施 Go/Rust/TypeScript 迁移，不修改运行时，不调整数据结构。

## 1. 盘点口径

本矩阵以当前仓库的 CLI 路由、HTTP 路由、WebUI 页面与服务、Tauri 命令、后台服务、测试文件和发布脚本为依据。入口包括：

- `aih` CLI 与 provider 原生 CLI 启动链。
- OpenAI/Anthropic/Gemini 兼容网关、Management API、WebUI API、Fabric/Node RPC。
- React WebUI、响应式移动端视图、PWA manifest 和 Tauri 桌面壳。
- tmux/PTY、会话读取、账号隔离、后台刷新、诊断及发布工具。
- 同级 `../clawdcodex` 只做只读可复用性核对，不计入 AI Home 已交付功能。

以下内容不计为 AI Home 自研功能：

- `cli/` 中 vendored Claude Code 上游内部的所有命令和工具；只记录 AI Home 对它提供的源码启动、账号隔离、会话接入和兼容能力。
- `node_modules/`、`reference/` 或外部工具自身提供但 AI Home 未暴露的能力。
- 只有计划文档、没有执行入口或当前代码接线的设想。

### 1.1 状态图例

| 状态 | 含义 |
|---|---|
| 稳定 | 有明确用户入口、当前实现与自动化测试，是现有主链能力 |
| 受限 | 用户可见，但只支持部分 provider、平台、认证类型或浏览器能力 |
| 高级 | 已有入口和实现，主要面向运维、远程节点或高级用户 |
| 实验 | 有真实实现/测试，但仍处在 Fabric、canonical chat 或新链路演进中，不应直接当作稳定兼容承诺 |
| 兼容 | 为旧命令、旧协议、旧数据或上游差异保留的入口 |
| 内部 | 仅后台、子进程、诊断或开发流程使用，没有普通用户入口 |
| 废弃 | 代码仍可被显式触达或用于迁移，但已经退出默认主链 |
| 未暴露 | 实现或测试仍在仓库中，但当前没有确认到公开路由/命令 |

### 1.2 当前产品表面

| 表面 | 当前职责 | 状态 | 主要证据 |
|---|---|---|---|
| `aih` CLI | 账号、导入导出、provider 启动、持久会话、Server、Usage、Node/Fabric、SSH 工具 | 稳定/高级混合 | `bin/ai-home.js`、`lib/cli/app.js`、`lib/cli/commands/` |
| 统一 API 网关 | OpenAI Chat/Responses、Anthropic Messages、Gemini generateContent、模型目录与 Codex app-server | 稳定/受限混合 | `lib/server/server.js`、`lib/server/v1-router.js` |
| WebUI | 仪表盘、账号、AI 会话、用量、模型、Server、SSH、设置 | 稳定/实验混合 | `web/config/routes.ts`、`web/src/pages/` |
| 移动端/PWA | 响应式卡片/抽屉/底部导航与 standalone manifest；未发现离线 service worker | 受限 | `web/src/components/mobile/`、`web/public/manifest.json` |
| Tauri 桌面端 | Server profile、系统 Keyring、原生 HTTP/SSE/blob、LAN 发现、托盘与打包 | 受限 | `src-tauri/src/`、`scripts/desktop/` |
| 后台服务 | Server daemon、自启、账号/用量/模型刷新、会话恢复、hook、自愈与日志 | 稳定/内部混合 | `lib/cli/services/server/`、`lib/server/` |

## 2. Provider 覆盖矩阵

“模型目录”表示当前 catalog 能力成员；“额度”表示原生额度快照能力；“会话同步”按真实实现区分 hook、轮询和不可用。

| Provider | 用户认证入口 | API Key/Token | 模型目录 | 原生额度 | 会话读取/同步 | 网关状态 | 关键限制 |
|---|---|---|---|---|---|---|---|
| Codex / ChatGPT (`codex`) | Browser OAuth、device auth | `OPENAI_API_KEY`、`OPENAI_BASE_URL` | 支持 | 支持 | 官方 hook；Codex event 可增量读取 | 默认主链 | Codex App 账号只允许 ChatGPT OAuth；临时凭据投影与共享 session/config 分离 |
| Claude (`claude`) | Claude Code 原生登录 | `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、Base URL | 支持 | 支持 | 官方 hook；JSONL transcript | 默认主链 | Claude Desktop web 账号与 Claude Code OAuth 是不同认证域；Desktop 另有 web/api 隔离 profile |
| Gemini (`gemini`) | Google OAuth | `GEMINI_API_KEY`、`GOOGLE_API_KEY` | 支持 | 支持 | 官方 hook | **自动网关路由已废弃**，显式 provider/账号/CLI 仍可用 | `gemini-*` 默认应由 `agy` 承载；不能把“账号存在”误判为默认网关仍支持 |
| Antigravity (`agy`) | 原生 Google/OAuth | 无 WebUI API Key 模式 | 支持 | 支持，且有 model-scoped quota | 官方 hook | 默认网关候选 | 导出 Antigravity Manager 格式只适用于 AGY OAuth 账号 |
| OpenCode (`opencode`) | `opencode auth login` | 由 OpenCode 原生 auth store 管理 | 支持 | 不支持统一额度快照 | 官方插件 hook | 默认网关候选 | 凭据投影隔离，配置/cache/原生 DB 仍为 host 共享资源 |
| Grok (`grok`) | Grok CLI OAuth | `XAI_API_KEY`、Base URL | 支持 | 不支持统一额度快照 | 官方 hook | 默认网关候选 | OAuth 依赖原生 CLI/订阅；API Key 与 OAuth 两种模式并存 |
| Qoder Global (`qoder`) | Browser login | `QODER_PERSONAL_ACCESS_TOKEN` | 支持 | 不支持统一额度快照 | 文件轮询 | 默认网关候选 | 独立 `qodercli`、`--config-dir` 投影；与 CN 是不同 provider |
| Qoder CN (`qodercn`) | Browser login | `QODER_PERSONAL_ACCESS_TOKEN` | 支持 | 不支持统一额度快照 | 文件轮询 | 默认网关候选 | 独立 `qoderclicn`、认证端点与 host home；不能与 Global 混用 |
| Kimi (`kimi`) | Kimi Code OAuth/device flow | `MOONSHOT_API_KEY`、`KIMI_BASE_URL` | 当前不在通用 model-catalog capability 成员中 | 不支持统一额度快照 | 不可用 | 默认网关候选 | 支持 Moonshot CN/Global API Key；当前网页无法同步原生会话 |
| Kiro (`kiro`) | AWS Builder ID device flow | 内部保留 `KIRO_API_KEY` 环境入口 | 支持 | 不支持统一额度快照 | SQLite 会话读取 + 文件轮询 | 默认网关候选 | 原生登录可经 Google/GitHub/AWS Builder ID；session store 位于 Kiro SQLite |

证据：`lib/provider-catalog-data.json`、`lib/provider-catalog.js`、`lib/cli/services/ai-cli/provider-registry.js`、`lib/provider-native-capability-registry.js`、`lib/server/provider-session-hook-config.js`、`lib/sessions/session-reader.js`、`web/src/pages/Accounts.tsx`。

## 3. 账号管理功能矩阵

### 3.1 账号查询、身份与状态

| 编号 | 功能点 | 入口 | 当前行为/边界 | 状态 | 主要证据 |
|---|---|---|---|---|---|
| ACC-001 | 全局账号列表 | `aih ls`、`aih account list`、Web `/accounts` | 旧入口聚合运行态；Go 入口通过当前目标 Server 的 Management API 使用 AccountRef keyset 分页，只读基础信息、认证类型和公开资料，不加载凭据正文、模型、usage 或运行态 | 稳定/单控制面 | `cmd/aih/account_list.go`、`internal/adapters/accounts/managementapi/catalog.go`、`lib/cli/commands/root/router.js`、`web/src/pages/Accounts.tsx` |
| ACC-002 | Provider 账号列表/单 ID 过滤 | `aih <provider> ls [id]` | 只列指定 provider；可进一步只看一个数字别名，支持列表帮助与分页行为 | 稳定 | `lib/cli/commands/ai-cli/router.js` |
| ACC-003 | 账号详情/配置状态 | Web 账号表、Management API | 展示公开身份、认证类型、配置、调度、额度、模型探测和最后使用时间，不回传原始 secret | 稳定 | `lib/server/webui-account-live.js`、`lib/server/management-router.js` |
| ACC-004 | 稳定账号身份 | 全链路 | `accountRef` 是 DB/Server/Web/runtime/event/usage 唯一身份；`cliAccountId` 只是可变 CLI 数字别名 | 稳定 | `lib/account/account-registration.js`、`lib/server/account-ref-store.js` |
| ACC-005 | 账号显示身份 | CLI/Web | OAuth 优先邮箱/账号信息，API Key 优先 Base URL/安全标签，避免暴露密钥 | 稳定 | `lib/account/display-identity.js`、`test/account-display-identity.test.js` |
| ACC-006 | 账号运行态 | Web/Management/Dashboard | 区分 healthy、rate limited、auth invalid、overloaded、network、service unavailable、cooldown 等 | 稳定 | `lib/account/runtime-state-builders.js`、`web/src/pages/Accounts.tsx` |
| ACC-007 | 调度/额度派生状态 | Web/Server | 展示 schedulable、exhausted、policy blocked、Free/Team 待确认等原因，而非单一启停布尔值 | 稳定 | `lib/account/derived-state.js`、`lib/server/account-usage-view.js` |
| ACC-008 | OAuth 套餐 badge | `aih ls`、Web | Codex/Claude 读取缓存 metadata 显示已知付费 plan；Free/unknown/API Key 不虚构套餐 | 稳定 | `lib/cli/services/profile/account-plan-badge.js` |
| ACC-009 | 账号实时更新 | Web SSE | 账号 snapshot、单账号变化、删除、hydration、auth/import/refresh job 通过 watch 推送；异常时可请求 snapshot | 稳定 | `lib/server/webui-sse-broadcaster.js`、`web/src/services/api.ts` |

### 3.2 添加、认证、编辑与删除

| 编号 | 功能点 | 入口 | 当前行为/边界 | 状态 | 主要证据 |
|---|---|---|---|---|---|
| ACC-010 | Browser OAuth 添加 | `aih <provider> login`、Web“添加账号” | 启动原生 provider 授权；Web 展示授权 URL/日志并等待回调 | 稳定/受限 | `lib/server/web-account-auth.js`、`web/src/pages/Accounts.tsx` |
| ACC-011 | Device auth 添加 | Codex CLI/Web | 适合无浏览器/远程环境；仅支持有 device flow 的 provider/账号 | 受限 | `lib/cli/commands/ai-cli/router.js`、`lib/server/oauth-loopback-callback.js` |
| ACC-012 | API Key 添加 | Web、环境变量、导入 | Codex/Claude/Gemini/Grok/Qoder/Qoder CN/Kimi 按 provider 绑定 key/token 与可选 Base URL | 稳定 | `web/src/pages/Accounts.tsx`、`lib/account/account-registration.js` |
| ACC-013 | Claude auth-token 添加 | Web | 单独使用 `ANTHROPIC_AUTH_TOKEN`，不与 `ANTHROPIC_API_KEY` 混为同一 credential type | 稳定 | `lib/profile/credential-config.js`、`web/src/pages/Accounts.tsx` |
| ACC-014 | OAuth 授权作业状态 | Web | 查询 job、实时日志、已完成/失败/等待用户/等待安装等状态 | 稳定 | `lib/server/webui-account-routes.js` |
| ACC-015 | 取消授权作业 | Web | 显式取消当前作业并清理本次 artifacts | 稳定 | `POST /v0/webui/accounts/add/jobs/:id/cancel` |
| ACC-016 | 安装缺失原生 CLI 后继续 | Web | 明示安装确认，安装完成后继续同一授权作业；不静默全局安装 | 受限 | `POST /v0/webui/accounts/add/jobs/:id/install`、`lib/runtime/native-cli-installer.js` |
| ACC-017 | 手工提交 Browser callback | Web | OAuth 自动回调不可用时粘贴 callback URL 完成作业 | 受限 | `POST /v0/webui/accounts/add/jobs/:id/callback` |
| ACC-018 | 重新认证 | Web、Fabric 远程账号命令 | 对已有账号启动新的 auth job，保留稳定 `accountRef` | 稳定/高级 | `POST /v0/webui/accounts/:provider/:accountRef/reauth` |
| ACC-019 | 编辑密钥/Token/Base URL | Web、Go Management API | 静态账号原地轮换并保持 `accountRef`、数字别名和用户启停；OAuth 账号必须重新登录 | 稳定/重构中 | `POST /v0/webui/accounts/:provider/:accountRef/update`、`PUT /v1/management/accounts/{account_ref}/credential` |
| ACC-020 | 编辑 Claude credential type | Web、Go Management API | API Key 与 auth-token 可显式双向切换；Go 路径同步刷新模型、清理旧 usage/runtime 派生状态并保留人工模型策略 | 稳定/重构中 | `lib/server/webui-account-routes.js`、`application/accounts/static_credential_rotation.go` |
| ACC-021 | 启用/关闭账号 | Web | 修改账号可调度状态；关闭后不进入正常路由选择 | 稳定 | `POST /v0/webui/accounts/:provider/:accountRef/status` |
| ACC-022 | 删除单账号 | Web/CLI | Web 按 `provider + accountRef`；CLI 可按数字别名 | 稳定 | `DELETE /v0/webui/accounts/:provider/:accountRef` |
| ACC-023 | 批量 selector 删除 | `aih <provider> delete <selectors>` | 支持 `1,2,3`、`1-9` 等选择器 | 稳定 | `lib/cli/commands/ai-cli/router.js` |
| ACC-024 | 删除 provider 全部账号 | `aih <provider> deleteall` | 针对单 provider 清理全部账号，属于高风险数据动作 | 稳定 | `lib/cli/commands/ai-cli/router.js` |
| ACC-025 | 环境变量账号自动识别 | CLI 启动 | 从 provider 对应 key/base URL 环境变量创建或复用 API Key sandbox | 受限 | `lib/cli/services/ai-cli/runtime.js`、`lib/profile/credential-config.js` |

### 3.3 默认账号、额度、配置与原生工具

| 编号 | 功能点 | 入口 | 当前行为/边界 | 状态 | 主要证据 |
|---|---|---|---|---|---|
| ACC-026 | 设置默认账号 | `aih <provider> set-default <id>`、Web、桌面托盘 | provider 级默认；Web/托盘使用 `accountRef`，CLI 接受数字别名 | 稳定 | `lib/cli/commands/ai-cli/router.js`、`src-tauri/src/tray.rs` |
| ACC-027 | 取消默认账号 | `aih <provider> unset-default`、Web | 清除 provider 默认指针 | 稳定 | `unset-default`、`clear-default` route |
| ACC-028 | 设置 Codex App 账号 | `aih codex set-mobile`、Web | 仅 ChatGPT OAuth 账号；供 Codex App/desktop hook 使用 | 受限 | `lib/cli/commands/ai-cli/router.js`、`webui-account-routes.js` |
| ACC-029 | 取消 Codex App 账号 | CLI/Web | 清除 mobile/Codex App 指针 | 受限 | `unset-mobile`、`clear-mobile` route |
| ACC-030 | 设置默认后重启/启动桌面客户端 | CLI `--restart-client` | 使用已学习的桌面路径；默认不重启，需显式参数 | 受限 | `lib/cli/services/ai-cli/desktop-client-restart.js` |
| ACC-031 | 强制退出桌面客户端 | CLI `--force-quit-client` | 仅和显式 restart/launch 工作流组合使用 | 受限 | `lib/cli/commands/ai-cli/router.js` |
| ACC-032 | Claude Desktop 隔离 profile | `set-default --desktop-mode web\|api --restart-client` | 创建/复用隔离 user-data profile；支持 web 或 AI Home API 模式与会话迁移判定 | 受限 | `lib/cli/services/ai-cli/claude-desktop-session.js`、`desktop-client-profile.js` |
| ACC-033 | 单账号额度刷新 | Web、`aih <provider> usage <id>` | 可使用缓存或 `--refresh` 强制探测；支持 `--preflight` | 稳定/受限 | `webui-account-routes.js`、`lib/cli/services/usage/` |
| ACC-034 | Provider 全账号额度扫描 | `aih <provider> usage` | 并发扫描，`-j N` 限制 worker；支持 refresh/preflight | 稳定/受限 | `lib/cli/commands/ai-cli/router.js` |
| ACC-035 | 额度后台刷新调度 | Server/background | 活跃与后台刷新间隔、阈值由 Usage 配置驱动 | 稳定 | `lib/usage/scheduler.js`、`lib/cli/services/usage/account-runtime.js` |
| ACC-036 | Host config/session store 同步 | 默认账号/启动链 | 将允许共享的配置与 session store 接到 host；认证仍按账号隔离 | 稳定 | `lib/cli/services/ai-cli/host-sync.js`、`config-sync.js` |
| ACC-037 | 临时凭据投影 | Codex/原生运行时 | DB-backed credential 在系统临时目录形成 marker/lease，进程退出后回收；不把长期 session/config 当 credential 删除 | 稳定 | `lib/runtime/transient-auth-projection.js` |
| ACC-038 | Provider resource reconcile | 启动/后台 | 核对 projection、session/config/store 等资源，清理可证明为临时的遗留项 | 内部 | `lib/runtime/provider-resource-reconciliation.js` |
| ACC-039 | 原生 CLI 检测与安装 | 登录/启动/Web chat | 查找 provider binary，必要时请求确认安装；支持官方脚本/npm 等 provider 策略 | 受限 | `lib/runtime/native-cli-resolver.js`、`native-cli-installer.js` |
| ACC-040 | 原生二进制修复 | postinstall/启动 | 修复执行权限、shim 或已知损坏 binary 状态 | 内部/受限 | `lib/runtime/native-binary-repair.js`、`scripts/postinstall.js` |
| ACC-041 | Provider skill 安装 | 启动/能力初始化 | 将 AI Home provider skill 安装到目标工具支持的目录 | 受限 | `lib/cli/services/ai-cli/provider-skill-installer.js`、`assets/provider-skills/` |
| ACC-042 | 会话 hook 状态与修复 | Settings/Web API | 显示全部 provider 的 hook/轮询/不可用三态；支持一键安装/修复官方 hook | 稳定/受限 | `web/src/components/settings/RealtimeSyncCard.tsx` |
| ACC-043 | Provider HOME/config 诊断 | `aih <provider> home [id]` | 不启动 CLI，只显示实际 HOME、config 与账号投影路径 | 稳定 | `lib/cli/commands/ai-cli/router.js` |
| ACC-044 | Go 账号物化模型列表 | `aih account models list <account_ref\|provider:id>` | 只读目标 Server 已物化的模型正排，展示上游可见性、人工策略和最终有效性；CLI 不打开本地 `aih.db`，不实时请求 Provider、不读取凭据或运行态 | 已实现（单控制面） | `cmd/aih/account_models.go`、`internal/adapters/accounts/managementapi/catalog.go` |
| ACC-045 | Go 单账号模型刷新 | `aih account models refresh <account_ref\|provider:id>` | 由目标 Server 使用当前规范凭据读取完整 Provider 模型目录；成功后原子替换上游发现部分并保留人工策略，发现失败时保留旧快照 | 已实现（单控制面） | `application/accounts/model_management.go`、`cmd/aih/account_models.go` |
| ACC-046 | Go 单模型人工策略 | `aih account models set-policy <target> <model_id> <policy>` | 通过目标 Server 精确设置 `inherit`、`force_enable` 或 `force_disable`，原子更新物化正排/倒排并返回完整快照；CLI 不访问 Provider | 已实现（单控制面） | `application/accounts/model_management.go`、`internal/adapters/accounts/managementapi/catalog.go` |
| ACC-047 | Go 账号启用/停用 | `aih account enable\|disable <account_ref\|provider:id>`、`PATCH /v1/management/accounts/{account_ref}` | 数字别名在目标 Server 通过唯一索引解析；启停事务、账号模型正排/倒排和 `/v1/models` 刷新在同一进程提交，不由独立 CLI 直写 SQLite | 已实现（重构路径） | `cmd/aih/account_state.go`、`internal/adapters/accounts/managementapi/client.go`、`internal/transport/http/accountsapi/account_alias.go` |
| ACC-048 | Go 单账号额度查看/刷新 | `aih account usage show\|refresh <account_ref\|provider:id>`、`GET/POST /v1/management/accounts/{account_ref}/usage[/refresh]` | `show` 只读取 Go Server 的 last-known-good 快照；`refresh` 使用 Server 当前规范凭据真实访问 Provider 并持久化。CLI 不直读 SQLite、不输出凭据，百分比按整数基点精确展示 | 已实现（重构路径） | `cmd/aih/account_usage.go`、`internal/adapters/accounts/managementapi/usage.go`、`application/accountusage/service.go` |
| ACC-049 | Go 单账号删除 | `aih account delete <account_ref\|provider:id> --yes`、`DELETE /v1/management/accounts/{account_ref}` | 必须显式 `--yes`；数字别名在目标 Server 解析为稳定 `AccountRef`。Server 级联删除凭据、资料、模型、usage、默认关系，并立即清理额度任务、运行状态和路由候选；CLI 不直写 SQLite、不访问 Provider | 已实现（重构路径） | `cmd/aih/account_delete.go`、`internal/adapters/accounts/managementapi/client.go`、`application/accounts/deletion.go` |
| ACC-050 | Go Provider 默认账号管理 | `aih account default show\|set\|clear ...`、`GET/PUT/DELETE /v1/management/account-defaults/{provider}` | 数字别名在目标 Server 解析；只允许 Codex/Claude 已启用且有凭据的同 Provider 账号。关系跨重启持久化，clear 幂等且不影响账号模型、usage 或 Gateway 公平征召 | 已实现（重构路径） | `cmd/aih/account_default.go`、`internal/adapters/accounts/managementapi/defaults.go`、`application/accounts/provider_defaults.go` |
| ACC-051 | Go 静态凭据更新 CLI | `aih account credential update <account_ref\|provider:id> --from-env` | CLI 只从 Codex/Claude 官方环境变量读取新 Key/Token，经目标 Server 原地轮换；不直写 SQLite、不回显凭据。保持 AccountRef、数字别名、启停和默认关系，刷新模型并清理旧 usage/runtime/cooldown 派生状态；OAuth 账号明确拒绝 | 已实现（重构路径） | `cmd/aih/account_credential.go`、`internal/adapters/accounts/managementapi/transfer.go`、`application/accounts/static_credential_rotation.go` |
| ACC-052 | Go 官方登录态导入 | `aih account import <codex\|claude>` | 本机只读 Codex `auth.json`；Claude 在 macOS 优先读取官方 Keychain、其他平台或缺失时读取 `.credentials.json`，并与 `.claude.json` 的 `oauthAccount` 组合；随后通过 Management API 提交到目标 Server 并物化真实模型，不修改官方登录态、不创建 Provider HOME | 已实现（单控制面） | `cmd/aih/account_import.go`、`internal/adapters/accounts/managementapi/catalog.go`、`internal/adapters/accounts/nativeartifact/` |

## 4. 导入、导出与迁移

| 编号 | 功能点 | 入口 | 当前行为/边界 | 状态 | 主要证据 |
|---|---|---|---|---|---|
| XFER-001 | 全量 ZIP 导出 | `aih export [file.zip]` | 写出扁平、标准命名的账号 JSON，再构建 ZIP | 稳定 | `lib/cli/commands/backup/router.js` |
| XFER-002 | selector 导出 | `aih export [file.zip] [selectors...]` | 只导出指定 provider/账号选择器 | 稳定 | `parseExportArgs`、`stageSelectedAccounts` |
| XFER-003 | Provider scoped ZIP | `aih <provider> export [file.zip]` | 只导出该 provider；不支持的 provider 明确报错 | 稳定/受限 | `buildProviderScopedExportArgs` |
| XFER-004 | sub2api 迁移 JSON | CLI、Web“导出为迁移 JSON” | 当前标准迁移 shape；`format=aih/ai-home/aihome` 只是历史 alias，不再维护私有 payload | 稳定/兼容 | `lib/account/standard-transfer.js` |
| XFER-005 | CLIProxyAPI JSON | CLI、Web | 支持 OAuth 与适用 API Key provider 的 CLIProxyAPI-compatible 数据 | 稳定 | `lib/cli/services/backup/cliproxyapi-export.js` |
| XFER-006 | Antigravity Manager JSON | CLI、Web | 只导出 AGY OAuth 账号；旧 Antigravity 参数被拒绝 | 稳定/受限 | `standard-format-export.js` |
| XFER-007 | 不导出本机数字别名 | 所有标准迁移导出 | payload 不携带无跨机意义的 `cliAccountId/account_id`；导入侧重新分配 | 稳定 | `lib/account/standard-transfer.js` |
| XFER-008 | 混合目录导入 | `aih import [provider] [sources...]` | 自动识别 provider 目录与嵌套目录 | 稳定 | `lib/cli/services/import/unified-import.js` |
| XFER-009 | ZIP/嵌套 ZIP 导入 | CLI/Web 文件或文件夹 | 支持 ZIP、目录内 ZIP、缓存解压和 hash 复用 | 稳定 | `archive-import.js`、`unified-import.js` |
| XFER-010 | JSON/JSONL 导入 | CLI/Web 粘贴或文件 | 支持标准 bundle、单账号 JSON、JSONL、迁移 JSON | 稳定 | `unified-import.js`、`Accounts.tsx` |
| XFER-011 | Web 文件/文件夹/粘贴 | `/accounts` 导入弹窗 | 文件、目录、文本三种输入；提供迁移/Antigravity/JSONL 模板 | 稳定 | `web/src/pages/Accounts.tsx` |
| XFER-012 | CLIProxyAPI 本地来源导入 | Web/CLI | 可从本地 CLIProxyAPI 数据源发现并导入 | 受限 | `unified-import.js`、`Accounts.tsx` |
| XFER-013 | Provider scoped 导入 | `aih <provider> import` | 只允许目标 provider；复用统一 importer | 稳定 | `lib/cli/commands/ai-cli/router.js` |
| XFER-014 | 并发导入 | `-j N` | 限制并发 worker，避免无界并行 | 稳定 | `parseUnifiedImportArgs` |
| XFER-015 | ZIP 子目录选择 | `-f <folder>` | 从归档指定子目录导入；不存在时明确报错 | 稳定 | `resolveImportSourceRoot` |
| XFER-016 | Dry-run | `--dry-run` | 扫描、校验和报告，不写入账号 | 稳定 | `unified-import.js` |
| XFER-017 | 身份去重 | 所有导入 | OAuth 按 provider+identity，API Key 按 provider+normalized URL+key 等规则去重 | 稳定 | `lib/account/standard-transfer.js`、`unified-import.js` |
| XFER-018 | 保留迁移 metadata | 标准导入 | 保留可迁移的 provider/OAuth metadata，但不复用来源机器本地 ID | 稳定 | `importStandardAccountRecords` |
| XFER-019 | 后台导入作业 | Web | 返回 job、SSE 推送进度；已有作业时接管当前进度而非重复启动 | 稳定 | `webui-account-routes.js`、`accountsAPI.getImportJob` |
| XFER-020 | 导入分阶段进度 | CLI/Web | hash、解压、provider/account 处理和汇总均有可观察进度 | 稳定 | `renderStageProgress`、`unified-import.js` |
| XFER-021 | Codex bulk token/importer | 统一导入内部路径 | 支持 Codex 特定批量源并并入统一统计 | 受限 | `lib/cli/services/ai-cli/codex-bulk-import.js` |
| XFER-022 | age/RSA/password/legacy crypto | 当前只有 service 与测试接线 | 加解密函数、age 安装提示和旧 envelope 解密存在，但普通 export 当前只生成 ZIP，未确认公开参数入口 | 未暴露/兼容 | `lib/cli/services/backup/crypto.js`、`test/backup.crypto.password-file.test.js` |
| XFER-023 | Go 单账号 sub2api 导出 | `GET /v1/management/accounts/{account_ref}/export` | 只导出 Codex/Claude 当前账号凭据和可选公开资料；固定 `version: 1`，不含本地 ID、模型、usage 或运行态 | 已实现（重构路径） | `application/accounts/export.go`、`internal/adapters/accounts/sub2api/`、`internal/transport/http/accountsapi/handler.go` |
| XFER-024 | Go 单账号 sub2api 导入 | `POST /v1/management/account-imports/sub2api` | 直接接收一个 `sub2api-data` 文档；只允许 Codex/Claude，接受现行版本与已确认的 snake/camel 同义字段，忽略同组空值并拒绝非空冲突；Claude 三种 expiry 统一为毫秒，last-refresh 只校验不持久化；不接受未知版本、字段、批量、代理或本地身份，并复用统一原子注册与模型维护链 | 已实现（重构路径） | `internal/adapters/accounts/sub2api/decoder.go`、`internal/adapters/accounts/sub2api/credential_input.go`、`internal/transport/http/accountsapi/sub2api_import.go` |
| XFER-025 | Go 单账号 CLIProxyAPI auth 导出 | `GET /v1/management/accounts/{account_ref}/export/cliproxyapi` | 直接输出可放入 CPA `auth-dir` 的 Codex/Claude 单 OAuth JSON；API Key 属于 CPA 配置而非 auth 文件，Claude setup-token/Auth Token 也不伪装成该格式 | 已实现（重构路径） | `internal/adapters/accounts/cliproxyapi/`、`internal/transport/http/accountsapi/handler.go` |
| XFER-026 | Go CLI 单账号 sub2api 导出 | `aih account transfer export <target> --format sub2api --output <file>` | 账号目标在目标 Server 解析；必须显式输出文件，使用 `O_EXCL + 0600`，不覆盖、不走 stdout、不打印凭据 | 已实现（重构路径） | `cmd/aih/account_transfer.go`、`cmd/aih/account_transfer_file.go`、`internal/adapters/accounts/managementapi/transfer.go` |
| XFER-027 | Go CLI 单账号 sub2api 导入 | `aih account transfer import --format sub2api --input <file>` | 只接受一个最大 `1 MiB` 的显式 JSON 文件并提交目标 Server；不接受 stdin、批量 envelope 或 AIH 私有格式 | 已实现（重构路径） | `cmd/aih/account_transfer.go`、`cmd/aih/account_transfer_options.go`、`internal/adapters/accounts/managementapi/transfer.go` |
| XFER-028 | Go CLI 单账号 CPA auth-file 导出 | `aih account transfer export <target> --format cliproxyapi --output <file>` | 只导出官方单 OAuth auth-file；与 sub2api 共用安全文件写入策略，不制造 CPA 批量 envelope 或有损导入 | 已实现（重构路径） | `cmd/aih/account_transfer.go`、`internal/adapters/accounts/cliproxyapi/` |

Go 重构路径实时核对的外部合同基准为 sub2api
`1e618dbc299fc0a82e9a690bcf2d5843be817113` 与 CLIProxyAPI
`bd34ceca04209ef0460f4b05e3a1a047fb7fad2a`（`v7.2.128`）。CPA 官方交换单位是一个
`auth-dir` JSON 文件而非批量 envelope。当前只暴露无损的 CPA OAuth 导出；Codex
文件可从 ID Token 恢复稳定身份；当前 CPA Claude 文件已保存 `account_uuid`、
`organization_uuid` 和 `organization_name`，缺失 `claude_device_ids` 时 CPA 会自行生成并
持久化。它仍不保存 AIH Claude OAuth 领域要求的原始 `scopes`，因此本阶段不猜测权限，
也不提供可能丢失权限语义的 CPA Claude 导入。

## 5. CLI 启动、PTY 与持久会话

| 编号 | 功能点 | 入口 | 当前行为/边界 | 状态 | 主要证据 |
|---|---|---|---|---|---|
| CLI-001 | 内置 AIH Server profile 启动 | `aih codex [args...]`、`aih claude [args...]` | 使用 `.aih-server` profile，经统一网关启动，并透传原生参数 | 稳定 | `lib/cli/commands/ai-cli/router.js` |
| CLI-002 | 指定账号启动 | `aih <provider> <id> [args...]` | 解析数字别名到 `accountRef`，构建隔离 env 后启动原生 CLI | 稳定 | `lib/cli/services/ai-cli/runtime.js` |
| CLI-003 | 默认账号启动 | `aih <provider>` | 非 Codex/Claude 使用 provider 默认账号；缺少默认时给出明确引导 | 稳定 | `ai-cli/router.js` |
| CLI-004 | 原生参数透传 | provider 启动命令 | 保留 provider 原生命令参数，不把未知参数吞掉 | 稳定 | `provider-args.js`、`provider-launch-strategy.js` |
| CLI-005 | 裸启动严格 fresh | 所有持久化 CLI 启动 | cwd 只用于项目分组，绝不隐式 reattach；每次裸启动创建新 exact session | 稳定 | `lib/runtime/persistent-session.js` |
| CLI-006 | 全局会话列表/选择器 | `aih sessions`、`aih ss` | 按项目聚合 live sessions 并交互选择 | 稳定 | `persistent-session-list.js` |
| CLI-007 | 会话预览 | `aih ss --list` | 只列出，不进入会话 | 稳定 | `persistent-session-list.js` |
| CLI-008 | Provider/账号会话列表 | `aih <provider> sessions [id]` | 列出指定账号 socket 下可恢复会话 | 稳定 | `ai-cli/router.js` |
| CLI-009 | 精确 attach | picker/`AIH_SESSION_TARGET` | exact identity 已知时只 attach；健康探测确认不存在/不兼容则失败，不偷建 sibling | 稳定 | `persistent-session.js` |
| CLI-010 | Named session upsert | `-S/--session <label>` | `s-<label>` 缺失时创建，兼容时进入，不兼容时创建 replacement sibling | 稳定 | `persistent-session.js` |
| CLI-011 | Latest takeover | `-R/--aih-resume` | 选择当前项目 prefix 最新 session，并 detach 其他 client 后接管 | 稳定 | `persistent-session-runtime.js` |
| CLI-012 | Latest mirror | `-M/--aih-mirror` | 选择当前项目最新 session，共享 attach | 稳定 | `persistent-session-runtime.js` |
| CLI-013 | Remote attach 意图 | `--remote/--aih-remote` | 显式远程会话进入路径，不依赖 cwd 猜测 | 高级 | `ai-cli/router.js` |
| CLI-014 | 会话关闭/退出识别 | sessions picker/runtime | 区分 live、completed/dead、legacy；dead/legacy 选择会新建兼容 replacement | 稳定 | `persistent-session-list.js` |
| CLI-015 | 每账号 tmux socket | 自动 | `socket = provider + accountRef`，账号环境和凭据不跨 socket | 稳定 | `persistent-session.js` |
| CLI-016 | 每项目 session 分组 | 自动 | `p-<basename>-<hash(cwd)>` 只是稳定 prefix；并行 sibling 有唯一 exact name | 稳定 | `persistent-session.js` |
| CLI-017 | tmux 透明配置 | 自动 | status off、latest window size、escape-time 0；前台 create 不使用 `-A/-D` | 稳定 | `persistent-session.js` |
| CLI-018 | 重启恢复 registry | 自动、Server 启动、`aih ss` | 只记录 addressing metadata；重启后 detached 重建并复用正常启动链和 provider-native resume | 稳定 | `persistent-session-registry.js`、`persistent-session-restore.js` |
| CLI-019 | 持久化 gate/逃生开关 | 自动、`AIH_NO_PERSIST=1` | 仅 tmux 可用、TTY、非登录流、非嵌套时启用；否则 direct spawn | 稳定 | `persistent-session-runtime.js` |
| CLI-020 | Windows tmux-compatible 探测 | Windows | 优先 psmux，其次 MSYS2/Cygwin/Path tmux；无引擎时降级并显示安装提示 | 受限，待 Windows 真机验证 | `persistent-session.js` |
| CLI-021 | Provider PTY runtime | 本地 CLI/Web legacy chat | 双向输入、resize、退出码、运行状态、环境隔离 | 稳定 | `lib/cli/services/pty/runtime.js`、`lib/runtime/pty-launch.js` |
| CLI-022 | 底部 Shell drawer/terminal | CLI overlay、Web workbench | 启动独立 shell PTY；Web 支持多 tab、重启、resize、共享 mux SSE | 稳定 | `web/src/components/chat/ShellTerminalPanel.tsx` |
| CLI-023 | CLI 交互观察 | Claude/Codex | 识别 thinking/tool/prompt/retry/usage/完成等事件供 Web/诊断消费 | 稳定/受限 | `codex-interaction-observer.js`、`claude-retry-observer.js` |
| CLI-024 | Codex sandbox policy | `aih codex policy [set ...]` | 查看或设置 workspace-write/read-only/danger-full-access | 稳定 | `runtime.permission-policy.cli` tests |
| CLI-025 | Terminal provider 图标 | `aih <provider> terminal-icon [--install] [--all]` | 显示/安装真实 provider icon 与 terminal profile mapping | 受限 | `lib/cli/services/terminal-icons.js` |
| CLI-026 | SSH 包装启动 | `aih ssh ... -- aih ...` | 非零客户端图片粘贴 fallback，包装远程命令 | 高级 | `lib/cli/services/ssh/` |
| CLI-027 | SSH clipboard probe | `aih ssh-clipboard probe` | 探测 OSC 5522/52、paste event、data URL，支持 JSON 输出 | 高级/受限 | `lib/cli/services/ssh-clipboard.js` |
| CLI-028 | Clipboard agent | `aih clip-agent start` | 通过 RemoteForward/socket 提供非零客户端图片 clipboard fallback | 高级 | `lib/cli/services/clip-agent.js` |
| CLI-029 | 图片粘贴与 tmux passthrough | PTY/SSH | 支持 OSC 52/5522，终端能力不足时明确降级 | 受限 | `test/ssh-clipboard.test.js` |
| CLI-030 | `claudecodex` 源码启动入口 | `bin/claudecodex.js` | 启动 vendored `cli/` 源码；只算 AI Home 集成/兼容入口，不把上游内部功能计入本矩阵 | 兼容 | `bin/claudecodex.js`、`cli/src/` |
| CLI-031 | 选择器关闭会话 | `aih sessions`/`ss`、provider sessions picker | `x` 只关闭选中 tmux session；`X` 关闭当前列表全部 idle session，不关闭 live session | 稳定 | `persistent-session-list.js`、`closePersistentSession` |
| CLI-032 | 全局数字 ID 快捷路由 | `aih <id>`、`aih usage <id>` | 仅当该数字别名在所有 provider 中唯一时，自动解析到对应 provider；有歧义时不猜测 | 稳定/受限 | `resolveUniqueCliForAccountId`、`root/router.js` |

## 6. 统一 API 网关与协议

### 6.1 对外协议/健康入口

| 编号 | HTTP 入口 | 功能 | 状态 | 主要证据 |
|---|---|---|---|---|
| GW-001 | `GET /v1/models` | 聚合启用账号模型、能力过滤、cache/SWR；不暴露通配 alias | 稳定 | `lib/server/v1-router.js` |
| GW-002 | `GET /v1/models/:id` | 查询单模型可见性/描述 | 稳定 | `getModelIdFromModelsPath` |
| GW-003 | `POST /v1/chat/completions` | OpenAI Chat Completions，支持 stream/tool/usage 适配 | 稳定 | `v1-router.js`、`protocol-openai-*` |
| GW-004 | `POST /v1/responses` | OpenAI Responses/Codex adapter 路径，支持 stream 与 canonical bridge | 稳定/受限 | `v1-router.js`、`codex-adapter.js` |
| GW-004-WS | `GET /v1/responses` + WebSocket Upgrade | Go Gateway 原生 Codex Responses-over-WebSocket：首帧按真实模型公平征召账号，单连接固定 `(accountRef, model)`，文本帧双向原样转发，支持同连接 `previous_response_id` 双轮、`generate:false` 预热、permessage-deflate、16 MiB 消息上限、终态/cooldown 旁路观察和 Server.Close 清理；模型别名需要改写时明确拒绝并要求使用精确模型 | 已实现（重构路径） | `application/codexwebsocket`、`internal/adapters/codex/responseswebsocket`、`internal/transport/http/codexresponsesws` |
| GW-005 | `POST /v1/messages` | Anthropic Messages，按 provider 能力直通或跨协议适配 | 稳定 | `protocol-anthropic-*` |
| GW-006 | `POST /v1/messages/count_tokens` | 本地 token count 响应，不发起上游推理 | 稳定 | `detectClientProtocol`、`createAnthropicTokenCountResponse` |
| GW-007 | `/v1beta/models/*:generateContent` | Gemini generateContent | 稳定/受限 | `protocol-gemini-*`、`v1-router.js` |
| GW-008 | `/v1beta/models/*:streamGenerateContent` | Gemini streaming generateContent | 稳定/受限 | `protocol-gemini-*` |
| GW-009 | `GET /v1/props` | Codex-compatible properties/model metadata | 兼容 | `v1-router.js` |
| GW-010 | `GET /v1/blobs/:id` | 读取暂存的图像 blob | 受限 | `lib/server/image-blob-store.js` |
| GW-011 | `/v0/codex/app-server` | Codex app-server WebSocket/stdio 代理与 canonical 消息适配 | 受限 | `codex-app-server-*` |
| GW-012 | `GET /healthz` | 进程健康 | 稳定 | `lib/server/server.js` |
| GW-013 | `GET /readyz` | 账号池或 Fabric gateway 可服务状态 | 稳定 | `lib/server/server.js` |
| GW-014 | `/ui`、`/ui/*` | 内置 WebUI 静态资源/SPA fallback | 稳定 | `lib/server/web-ui-router.js` |

### 6.2 路由、容错与协议能力

| 编号 | 功能点 | 当前行为/边界 | 状态 | 主要证据 |
|---|---|---|---|---|
| GW-015 | Canonical 协议图 | client protocol → canonical request/intent → provider adapter → canonical result/event → client renderer | 稳定/演进中 | `lib/server/protocol-graph.js`、`provider-protocol-plan.js` |
| GW-016 | OpenAI 请求/响应转换 | Chat/Responses 间按明确 bridge 转换，保留 stream/tool/usage 语义 | 稳定/受限 | `protocol-openai-*-adapters.js` |
| GW-017 | Anthropic 请求/响应转换 | content blocks、tool history、SSE、usage 与 OpenAI/canonical 互转 | 稳定 | `protocol-anthropic-*` |
| GW-018 | Gemini 请求/响应转换 | Gemini tools、generateContent、stream、Code Assist wrapper 与 canonical 互转 | 稳定/受限 | `protocol-gemini-*`、`code-assist-*` |
| GW-019 | Tool call 配对/参数校验 | 校验 tool call/result、argument shape，防止孤立或错误配对 | 稳定 | `lib/protocol/tool-call-pairing.js`、`tool-call-validation.js` |
| GW-020 | 图像/vision guard | 校验输入图像、媒体引用与目标模型 modality | 稳定/受限 | `vision-image-guard.js`、`model-modality-index.js` |
| GW-021 | Provider capability routing | 根据目标协议、模型、provider 能力选择 direct route 或 bridge | 稳定 | `capability-router.js`、`provider-protocol-routing.js` |
| GW-022 | Provider 显式选择 | 优先 `x-provider`，其次 request `provider`，再用 Server config/模型可用性/模型族 | 稳定 | `provider-routing.js` |
| GW-023 | Account pin | `x-account-ref` 精确固定账号；固定后不应用全局 alias 跨 provider 改写 | 稳定/高级 | `v1-router.js` |
| GW-024 | 模型族推断 | GPT/o 系列→Codex、Claude→Claude、Gemini→Gemini/AGY 等；未知回落 Codex | 稳定/兼容 | `providers.js`、`provider-routing.js` |
| GW-025 | 模型 alias | exact/wildcard alias，支持 provider scope、target provider、priority、enable 与 description | 稳定 | `model-alias-resolver.js`、`model-alias-store.js` |
| GW-026 | Alias fallback 链 | 同一 alias 多规则按优先级尝试，运行失败可切换下一个 target | 稳定 | `v1-router.js`、`model-alias-resolver.js` |
| GW-027 | Disabled model gate | 账号级模型关闭后从模型目录和调度候选中剔除 | 稳定 | `model-catalog-settings-store.js` |
| GW-028 | 模型 catalog SWR | 有缓存先返回并后台刷新；全局与账号级 job 可观察 | 稳定 | `webui-model-cache.js`、`webui-model-refresh-scheduler.js` |
| GW-029 | 默认 round-robin | 正常账号池默认按游标轮转 | 稳定 | `account-selector.js` |
| GW-030 | 可选额度加权 random | `strategy=random` 时按账号权重/剩余额度随机选择 | 高级 | `pickWeightedRandomAccount` |
| GW-031 | Sticky session | 从 session/conversation/thread/previous response 等 ID 建立 TTL 账号亲和 | 稳定 | `session-key.js`、`account-selector.js` |
| GW-032 | Provider 并发队列 | 每 provider 独立并发上限和有界 queue，满载返回明确错误 | 稳定 | `lib/server/local.js`、`server-runtime.js` |
| GW-033 | `(account, model)` 熔断 | 429/配额/容量按模型冷却，不把账号所有模型一并锁死 | 稳定 | `account-model-cooldown.js`、`upstream-failure-policy.js` |
| GW-034 | Account-wide hard block | auth invalid、整体 runtime 不健康、全账号 cooldown/策略阻塞仍会阻止调度 | 稳定 | `account-selector.js`、`account-capabilities.js` |
| GW-035 | 失败分类 | Node 主链区分 rate limit、quota、overload、network、auth、location、server error；Go 已具备 Codex/Claude 有界 HTTP/SSE/transport Observer，但尚未接入 Go 上游执行器 | 稳定/迁移中 | `upstream-failure-policy.js`、`internal/adapters/{codex,claude}/upstreamfailure` |
| GW-036 | Retry/换账号 | 按 failure policy 决定当前账号重试、换账号、alias fallback 或停止 | 稳定/需持续回归 | `upstream-endpoints.js`、`codex-adapter.js` |
| GW-037 | Token refresh daemon | Codex/Claude/AGY/Gemini 等按支持情况刷新 OAuth token | 稳定/受限 | `token-refresh-daemon.js`、provider token refresh modules |
| GW-038 | 请求/诊断日志 | 记录 request id、route、provider、失败类别和低敏诊断；带轮转 | 稳定 | `diagnostic-log.js`、`log-rotation.js` |
| GW-039 | 敏感诊断清洗 | canonical error 不记录 token、Authorization、正文等敏感值 | 稳定 | `canonical-diagnostic-sanitizer.js` |
| GW-040 | 反向 gateway | 本地 Server 主动连公网 broker；公网 Server 本地无可用账号时可转发 allowlist 请求 | 实验/高级 | `fabric-gateway-*`、`fabric-broker-*` |

## 7. Server 生命周期、配置与运维

| 编号 | 功能点 | 入口 | 当前行为/边界 | 状态 | 主要证据 |
|---|---|---|---|---|---|
| SRV-001 | 后台启动 | `aih server start`、`aih serve` | `start` 启 daemon；`serve` 为前台本地 Server；`daemon` 是生命周期 alias | 稳定/兼容 | `lib/server/command-handler.js` |
| SRV-002 | 状态 | `aih server status` | PID、ready、base URL、API Key 配置、source stale、日志/entry、自启状态 | 稳定 | `command-handler.js` |
| SRV-003 | 重启 | `aih server restart` | graceful stop + start；Windows 权限不足时走 UAC elevation | 稳定/受限 | `server-lifecycle.js`、`windows-restart-elevation.js` |
| SRV-004 | 停止 | `aih server stop` | 停止受管 Server，报告 not running/forced 等结果 | 稳定 | `server-daemon-service.js` |
| SRV-005 | 自启动安装/状态/卸载 | `aih server autostart ...` | macOS LaunchAgent、Linux user systemd、Windows Startup cmd | 稳定/受限 | `server-autostart.js`、`macos-launch-agent-transaction.js` |
| SRV-006 | 旧 macOS 服务迁移 | 更新/启动 | 识别并迁移旧 service layout | 兼容 | `legacy-macos-service-migration.js` |
| SRV-007 | Server config 查看/取值/设置 | `aih server config show\|get\|set` | 单一配置存储；secret 默认脱敏，显式选项才显示 | 稳定 | `server-config-command.js`、`server-config-store.js` |
| SRV-008 | 监听配置 | CLI/Settings | host、port、`open-network`/`local-only`；开放网络映射 `0.0.0.0` | 稳定 | `lib/server/args.js`、`web/src/pages/Settings.tsx` |
| SRV-009 | Client API Key | CLI/Settings | 保护 `/v1` 客户端入口；支持设置/清除/生成 | 稳定 | `server-config-command.js` |
| SRV-010 | Management Key | CLI/Settings/Tauri | 保护 Management/WebUI/Fabric；支持生成、清除和旋转 | 稳定 | `management-key-auth.js`、`management-key-rotation.js` |
| SRV-011 | Proxy/no-proxy | CLI config/serve | 配置上游代理与 bypass | 稳定 | `lib/server/args.js`、`http-utils.js` |
| SRV-012 | 模型探测账号数 | CLI config | 配置 catalog probe 的账号范围 | 高级 | `models-probe-accounts` config |
| SRV-013 | 输出客户端环境变量 | `aih server env` | 输出 OpenAI-compatible base URL/key 环境设置 | 稳定 | `command-handler.js` |
| SRV-014 | 同步 Codex 账号 | `aih server sync-codex` | 显式同步 Codex 账号到 Server 索引 | 兼容/高级 | `command-handler.js`、`server.sync` tests |
| SRV-015 | Remote Server profile 添加 | `aih server add`、Web/桌面 | 保存 URL + Management Key，并可设为当前 | 稳定/受限 | `profile-command.js`、`server-profile-repository.ts` |
| SRV-016 | Server profile 列表/选择/删除 | `ls/use/remove`、Web | secret 不回显；切换 active profile 改变 Web/desktop 请求目标 | 稳定 | `control-plane-profiles`、`active-control-plane` |
| SRV-017 | LAN/mDNS Server 发现 | Settings/Tauri | 搜索 `_ai-home._tcp`，发现 route 不自动获得凭据 | 受限 | `src-tauri/src/server_discovery.rs` |
| SRV-018 | LAN profile 授权与 route refresh | Tauri | Management Key proof 后提交可信 route；支持刷新与健康排序 | 受限 | `commands.rs`、`server_route_runtime.rs` |
| SRV-019 | Source stale 检测/自动重启辅助 | status/background | source fingerprint 变化标为 stale，提示或后台重启 | 内部/受限 | `source-fingerprint.js`、`source-auto-restart.js` |
| SRV-020 | 自更新检查 | `aih update --check` | 检查 npm/source install 更新，不改代码 | 稳定 | `lib/cli/services/update/self-update.js` |
| SRV-021 | Dry-run/强制更新 | `aih update --dry-run\|--force` | npm 安装可自动更新；source-linked 安装只给安全的手工提示 | 稳定/受限 | `self-update.js` |
| SRV-022 | Management status/metrics/accounts | `/v0/management/*`、Web proxy | 状态、指标、账号、模型和 usage 只读视图 | 稳定 | `management-router.js` |
| SRV-023 | Management SSE/snapshot | `/v0/management/watch` | Dashboard 实时状态；支持显式 snapshot | 稳定 | `management-router.js`、`web-ui-router.js` |
| SRV-024 | Reload/clear cooldown/restart | Management API/Dashboard/Settings | 显式 reload、清空冷却、重启 | 稳定/高级 | `management-router.js` |
| SRV-025 | State index upsert/prune | Management/internal | 跨 host/remote state index 更新与缺失项修剪 | 内部 | `state-index-client.js`、`management-router.js` |
| SRV-026 | 内置 Management 状态页 | `GET /v0/management/ui` | 提供轻量 HTML 状态页，前端读取 status/metrics/accounts；受 Management Key 或 loopback 管理鉴权保护 | 稳定/高级 | `management-router.js`、`status-page.js` |

## 8. WebUI 页面功能

### 8.1 仪表盘、用量、模型与设置

| 编号 | 页面/功能点 | 当前行为/边界 | 状态 | 主要证据 |
|---|---|---|---|---|
| WEB-001 | 仪表盘健康总览 | Server 连接、运行时长、总请求、成功率、账号健康/降级/critical | 稳定 | `web/src/pages/Dashboard.tsx` |
| WEB-002 | Provider 运行卡 | 账号 active/total、running/queued/concurrency、请求/成功/失败 | 稳定 | `Dashboard.tsx` |
| WEB-003 | 最近错误 | 只在有错误时显示最近低敏错误 | 稳定 | `Dashboard.tsx` |
| WEB-004 | 热点路由 | 按 route count 排序展示 | 稳定 | `Dashboard.tsx` |
| WEB-005 | 运行参数 | 折叠展示 Server 静态/低频运行参数 | 稳定 | `Dashboard.tsx` |
| WEB-006 | 实时刷新与降级 | Management SSE 为主，snapshot/轮询为 fallback；支持手工刷新 | 稳定 | `managementAPI.watch` |
| WEB-007 | 清空 cooldown | Dashboard 显式操作 | 稳定/高级 | `Dashboard.tsx` |
| WEB-008 | 用量时间范围 | 1 小时、今天、近 7 天、一个月、自定义 | 稳定 | `ModelUsage.tsx` |
| WEB-009 | 用量筛选 | provider、model、session 与时间范围 | 稳定 | `ModelUsage.tsx` |
| WEB-010 | 用量总览 | 总调用、运行会话、总 token、估算 USD 成本 | 稳定 | `ModelUsage.tsx` |
| WEB-011 | 按模型统计 | 调用、input/output/cache token、成本 | 稳定 | `ModelUsage.tsx` |
| WEB-012 | 按会话统计/明细 | 项目、调用、token、成本、更新时间；可打开单会话模型/Reasoning 细分 | 稳定 | `ModelUsage.tsx` |
| WEB-013 | Usage scan job | 手工扫描、SSE job 进度、重复任务复用 | 稳定 | `modelUsageAPI.scan/watchScan` |
| WEB-014 | CLI Usage 报表 | `stats/models/sessions/session-detail/scan`、日期/provider/model、`--json` | 稳定 | `lib/usage/model-usage.js`、root router |
| WEB-015 | 历史成本重算（`aih usage recalculate-costs`） | 使用当前 pricing catalog 显式重算 | 高级 | `lib/usage/model-usage.js` |
| WEB-016 | Codex fork 用量重建（`scan --reindex-codex-forks`） | 显式重建 deferred fork usage | 高级 | `model-usage-reindex-scheduling.js` |
| WEB-017 | 全局模型目录 | 按模型聚合启用账号去重合集，搜索/筛选/复制 ID | 稳定 | `web/src/pages/Models.tsx` |
| WEB-018 | 账号模型管理 | `/accounts/:provider/:accountRef/models`，独立模型开关、默认与手动补充 | 稳定 | `Models.tsx` |
| WEB-019 | 模型探测与缓存 | 读取 cache、后台 refresh、job 状态、失败账号提示 | 稳定 | `webui-openai-model-routes.js` |
| WEB-020 | 手动添加模型 | 仅 API Key/Token 账号；OAuth 账号禁止 | 稳定/受限 | `Models.tsx` |
| WEB-021 | 启用/停用模型 | 每账号独立控制 | 稳定 | `modelsAPI.updateModel` |
| WEB-022 | 设置每账号默认模型 | 只允许已启用模型；每账号一个默认 | 稳定 | `Models.tsx` |
| WEB-023 | 删除手动模型 | 只删除 manual model，不删除上游探测模型 | 稳定 | `modelsAPI.deleteModel` |
| WEB-024 | 模型 alias CRUD | 新增、编辑、删除、启停 | 稳定 | `web/src/pages/ModelAliases.tsx` |
| WEB-025 | Alias 规则字段 | alias、target、provider scope、target provider、priority、备注、enabled | 稳定 | `ModelAliases.tsx` |
| WEB-026 | 基础 Usage 设置 | 自动切换阈值、活跃刷新间隔、后台刷新间隔、保存/重置 | 稳定 | `web/src/pages/Settings.tsx` |
| WEB-027 | Server 设置 | open network、host、port、API Key、Management Key、保存与一键重启 | 稳定 | `Settings.tsx` |
| WEB-028 | Server profile 管理 | 添加、授权、设为当前、单个刷新、全部刷新、删除、LAN 发现 | 稳定/受限 | `Settings.tsx`、`ControlPlaneServerList.tsx` |
| WEB-029 | 公网 outbound relay | 选择 1 个本地 Server + 1–5 个公网 Server，让本地主动建立入口 | 实验/高级 | `PublicServerEntryCard.tsx` |
| WEB-030 | 无新增端口 FRP 入口 | 选择连接同一 FRPS 的 Server，配置并逐一验证 visitor | 实验/高级 | `PublicServerEntryCard.tsx`、`webui-frp-config-routes.js` |
| WEB-031 | 会话实时同步设置 | 展示 hook/轮询/不可用，支持一键启用/修复 hook | 稳定/受限 | `RealtimeSyncCard.tsx` |

### 8.2 页面路由与历史入口

| 编号 | 路由 | 当前页面/行为 | 状态 |
|---|---|---|---|
| WEB-032 | `/dashboard` | 仪表盘 | 稳定 |
| WEB-033 | `/accounts` | 账号管理 | 稳定 |
| WEB-034 | `/chat` | AI 会话与项目工作台 | 稳定/实验混合 |
| WEB-035 | `/usage` | 模型用量 | 稳定 |
| WEB-036 | `/models` | 全局模型目录 | 稳定 |
| WEB-037 | `/fabric/servers` | Server 管理 | 稳定/高级 |
| WEB-038 | `/fabric/ssh-hosts` | SSH 开发机 | 高级 |
| WEB-039 | `/settings` | 基础、别名、Server、SSH 设置 | 稳定/高级混合 |
| WEB-040 | `/server-setup` | 无可用 Server profile 时的引导/授权页 | 稳定/受限 |
| WEB-041 | `/accounts/:provider/:accountRef/models` | 账号模型管理 | 稳定 |
| WEB-042 | `/fabric/control-planes`、`/fabric/remote-nodes`、`/fabric/nodes`、`/fabric/webrtc-diagnostics` | 旧页面路径重定向到 `/fabric/servers` | 兼容/废弃 |

### 8.3 响应式与 PWA

| 编号 | 功能点 | 当前行为/边界 | 状态 | 主要证据 |
|---|---|---|---|---|
| WEB-043 | 响应式应用外壳 | 桌面侧栏；移动端固定底部 TabBar、安全区适配，Chat 沉浸态自动隐藏跨页导航 | 稳定/受限 | `web/src/app.tsx`、`web/src/components/mobile/MobileTabBar.tsx`、`mobile-shell.css` |
| WEB-044 | 移动端专用视图 | 账号卡片/统计格/横向筛选、项目会话分层导航、底部抽屉、Files/Review 单页返回等，不只是桌面表格缩放 | 稳定/受限 | `web/src/components/mobile/`、`Accounts.tsx`、`Chat.tsx`、`ProjectWorkbench.tsx` |
| WEB-045 | PWA standalone metadata | manifest 提供图标、start URL、portrait 与 standalone 安装外观；当前未发现离线 service worker/cache 能力 | 受限 | `web/public/manifest.json`、`web/index.html` |

## 9. AI 会话、Canonical Runtime 与项目工作台

### 9.1 项目与会话目录

| 编号 | 功能点 | 当前行为/边界 | 状态 | 主要证据 |
|---|---|---|---|---|
| CHAT-001 | 项目自动发现 | 聚合各 provider 原生项目/session store | 稳定/受限 | `lib/sessions/session-reader.js` |
| CHAT-002 | 手动打开项目 | 输入路径/名称或目录选择器登记项目 | 稳定 | `OpenProjectDialog.tsx`、`webui-project-routes.js` |
| CHAT-003 | 目录浏览/选择 | POSIX/Windows 路径导航，选择目录后打开 | 稳定/跨平台受限 | `DirectoryPickerDialog.tsx` |
| CHAT-004 | 移除项目 | 只移除 AI Home 登记，不删除物理项目文件 | 稳定 | `ProjectList.tsx`、`projects/remove` |
| CHAT-005 | 项目懒加载 session | 先加载聚合项目，再按展开项目 hydration sessions | 稳定 | `use-project-catalog.ts` |
| CHAT-006 | 项目/session watch | SSE snapshot + runtime keys；断线可刷新 | 稳定 | `sessionsAPI.watchProjects`、`sessions/watch` |
| CHAT-007 | 会话选择记忆 | 按 active Server、project、provider/session 记住当前选择 | 稳定 | `chat-selection-state.js` |
| CHAT-008 | 新建 draft 会话 | 从项目选择 provider/account 创建 draft，首次发送后绑定 native session | 稳定/受限 | `Chat.tsx`、native session adoption |
| CHAT-009 | 恢复/adopt 原生会话 | 将已发现 native session 解析成 canonical session/runtime binding | 实验 | `use-native-session-adoption.ts`、`chat runtime session resolve` |
| CHAT-010 | 历史消息分页 | bundle 带 cursor/start/total/hasMore，前端窗口化加载 | 稳定 | `webui-session-history-pagination.js` |
| CHAT-011 | 会话预览 | 惰性批量取模型和最后消息预览 | 稳定 | `sessions/previews` |
| CHAT-012 | 增量 events | Codex 原生增量 event；其他 provider 文件 cursor 变化时回退 snapshot | 稳定/受限 | `readSessionEvents` |
| CHAT-013 | 归档 | 当前原生稳定策略是 Codex app-server archive；其他 provider 受 capability gate | 受限 | `session-lifecycle/codex-native-strategy.js` |
| CHAT-014 | 已归档列表 | 合并原生 Codex archive 与 Claude/Gemini 历史 archive 发现 | 受限/兼容 | `session-lifecycle/index.js`、`legacy-archive-recovery.js` |
| CHAT-015 | 恢复归档 | Codex 原生 unarchive；Claude/Gemini 只恢复受支持的 legacy archive | 受限/兼容 | `webui-session-lifecycle-routes.js` |

### 9.2 消息、运行、交互与队列

| 编号 | 功能点 | 当前行为/边界 | 状态 | 主要证据 |
|---|---|---|---|---|
| CHAT-016 | Canonical/legacy 双运行面 | 按 session/account capability 选择 canonical runtime，否则进入 legacy runtime | 实验/兼容 | `ChatRuntimeBoundary.tsx`、`session-surface-policy.ts` |
| CHAT-017 | Provider/account/model 选择 | 新会话和已有会话按 capability/账号状态/模型目录筛选 | 稳定/受限 | `use-account-model-catalog.ts`、`account-model-selection.js` |
| CHAT-018 | Approval mode | Full access (`bypass`)、Approve for me (`confirm`)、Plan mode (`plan`)；按会话记忆 | 稳定/受限 | `ComposerApprovalMenu.tsx`、`use-session-approval-mode.ts` |
| CHAT-019 | Reasoning effort | 仅展示当前模型声明支持的 effort，并清理不适用旧值 | 受限 | `ComposerModelMenu.tsx`、`composer-model-policy.ts` |
| CHAT-020 | 文本发送 | 创建 turn/command，保留 idempotent command identity | 稳定 | `session-runtime-actions.ts` |
| CHAT-021 | Slash commands | 读取 provider runtime catalog，提交 `/...` 命令 | 稳定/受限 | `native-slash-commands.js`、chat runtime command routes |
| CHAT-022 | 图片附件 | 最多 8 张、单张 10 MiB、总计 20 MiB；上传后用 attachment ID 提交 | 稳定/受限 | `use-composer-attachments.ts`、`chat-runtime-attachments.js` |
| CHAT-023 | 语音听写 | 浏览器 `SpeechRecognition/webkitSpeechRecognition`，`zh-CN` continuous/interim；不支持的浏览器不显示能力 | 受限 | `useDictation.ts`、`dictation-session.js` |
| CHAT-024 | 停止当前运行 | 显式 abort 才终止 provider run；仅关闭 SSE 是 detach，不 kill 长任务 | 稳定 | `chatAPI.abortRun`、`runs/:id/abort` |
| CHAT-025 | Mid-run steer | provider 支持时向当前 turn 插话；不支持时返回明确 unsupported | 受限 | `composer-policy.ts`、`chatAPI.steerRun` |
| CHAT-026 | Tool boundary 投递 | 支持时在当前 tool boundary 后投递；可能为 emulated | 实验/受限 | `composer-policy.ts` |
| CHAT-027 | After-turn queue | 当前 turn 完成后自动发送 | 稳定/实验 | `automatic-queue-coordinator.js` |
| CHAT-028 | 队列新增/编辑/删除 | Canonical queue 支持 CRUD | 实验 | `QueueDock.tsx`、`chat-runtime/queue-repository.js` |
| CHAT-029 | 队列重排/立即派发 | move、dispatch，显示 queued/leased/running/completed/failed | 实验 | `capability-command-catalog.js` |
| CHAT-030 | Legacy 消息队列 | sessionStorage 保留，支持编辑、删除、send now、可用时 steer | 兼容 | `legacy-message-queue-store.js`、`queue-state.js` |
| CHAT-031 | Detached run 恢复 | 页面刷新/断连后列出 active runs，恢复运行态和 active prompt | 稳定/受限 | `chatAPI.listActiveRuns`、`chat-runtime-recovery.js` |
| CHAT-032 | Run input/resize | 对原生 PTY run 发送输入、换行、prompt id 与终端大小 | 稳定/受限 | `runs/:id/input`、`runs/:id/resize` |
| CHAT-033 | 权限审批 | 后端挂起 approval，前端 allow/deny，可带补充消息 | 稳定/受限 | `ApprovalInteractionCard.tsx`、approval routes |
| CHAT-034 | 问题回答 | 支持多字段、选择项、跳过/未回答确认与自动 resolution timer | 实验 | `QuestionInteractionCard.tsx`、`use-question-auto-resolution.ts` |
| CHAT-035 | Plan 确认/实现 | 当前会话实现、或把 plan 投递到 fresh context；失败可用同 command identity 重试 | 实验 | `PlanImplementationPrompt.tsx`、fresh plan workflow |
| CHAT-036 | CLI 安装确认 | chat 运行时发现缺 CLI 时弹出确认，confirm/cancel 继续同一流程 | 受限 | `cli-install-confirmation-registry.js` |
| CHAT-037 | 完成通知 | assistant run 完成时触发浏览器/页面通知 | 受限 | `use-assistant-completion-notification.ts` |
| CHAT-038 | Provider hook 实时同步 | hook event 进入 event bus/Web SSE；无 hook provider 轮询文件 | 稳定/受限 | `provider-session-hook-sender.js`、`session-event-bus.js` |

### 9.3 消息展示与项目工具

| 编号 | 功能点 | 当前行为/边界 | 状态 | 主要证据 |
|---|---|---|---|---|
| CHAT-039 | 结构化消息渲染 | user/assistant/system、Markdown、metadata | 稳定 | `MessageBubble.tsx`、`TimelineItemView.tsx` |
| CHAT-040 | Thinking/reasoning | 折叠展示 reasoning，不和最终 answer 混排 | 稳定/受限 | `ThinkingBlock.tsx` |
| CHAT-041 | Tool/terminal 事件 | 工具调用、结果、shell 命令、文件路径和图片结果 | 稳定 | `MessageBubble.tsx` |
| CHAT-042 | Plan/goal/task | 计划步骤、状态、goal、任务通知与交互 dock | 稳定/受限 | `PlanBlock.tsx`、`GoalBlock.tsx`、`TaskDock.tsx` |
| CHAT-043 | Subagent thread | 解析 `spawn_agent`，按 child session 加载子线程 | 稳定/受限 | `SubagentThreadBlock.tsx`、`session-reader.js` |
| CHAT-044 | Memory citation | 解析 `<oai-mem-citation>`，按受控 memory source 打开引用 | 稳定/受限 | `MemoryCitationBlock.tsx`、`oai-mem.parser.ts` |
| CHAT-045 | 图片/文件引用 | 显示 inline/data/local image，文件引用可打开 preview drawer | 稳定/受限 | `MessageImages.tsx`、`FileReferenceButton.tsx` |
| CHAT-046 | 文件安全读取 | 只允许已登记项目/已授权 trust root，阻止 path escape | 稳定 | `webui-file-routes.js`、`webui-file-tree-routes.js` |
| CHAT-047 | 文件树 | lazy directory tree、刷新、移动端单页预览 | 稳定 | `FilesPanel.tsx` |
| CHAT-048 | 文件预览 | 源码高亮/软换行、Markdown 渲染、图片/媒体 | 稳定/受限 | `FilePreviewPane.tsx` |
| CHAT-049 | HTML 独立预览 | PC/手机尺寸新窗口预览，经 normalize 处理 | 受限 | `html-preview-window.ts` |
| CHAT-050 | Git summary | branch、upstream、ahead/behind、staged/unstaged/untracked | 稳定 | `ReviewPanel.tsx`、`webui-git-routes.js` |
| CHAT-051 | 单文件 diff | staged 或 unstaged diff；大结果标记 truncated；只读，不提供 stage/commit | 稳定 | `ReviewPanel.tsx` |
| CHAT-052 | Browser preview | iframe 地址栏、reload、桌面/手机宽度、外部打开；back/forward 当前禁用 | 受限 | `BrowserPanel.tsx` |
| CHAT-053 | Workbench tabs | Chat 固定 tab，可添加/关闭 Terminal、Files、Review、Browser；按 project 保存布局 | 稳定/受限 | `ProjectWorkbench.tsx`、`workbench-persistence.ts` |
| CHAT-054 | 多终端 tabs | 每 tab 独立 PTY/xterm，共用一条 mux SSE，支持重启、关闭、拖拽高度 | 稳定 | `ShellTerminalPanel.tsx` |

Canonical chat HTTP 面包括：`/v0/webui/chat/sessions`、session resolve/snapshot/timeline、command/composer catalog、commands、attachments、events，以及 `/v0/webui/chat/artifacts/*`。Legacy 面仍使用 `/v0/webui/chat`、active runs、run input/resize/abort/approval 等路由。

## 10. SSH 开发机、Server Profile 与桌面端

### 10.1 SSH 开发机

| 编号 | 功能点 | 当前行为/边界 | 状态 | 主要证据 |
|---|---|---|---|---|
| SSH-001 | SSH connection 列表/新增/编辑/删除 | host、port、user、label、认证信息；删除连接会删除其工作区登记，不删除远端文件 | 高级 | `webui-ssh-host-routes.js`、`FabricSshHosts.tsx` |
| SSH-002 | Key path 认证 | 保存 identity file 路径并校验可读/安全边界 | 高级 | `webui-ssh-identity-file.js` |
| SSH-003 | 粘贴私钥 | 后端创建受控 identity file，不在普通列表回显 key | 高级/受限 | `webui-ssh-host-routes.js` |
| SSH-004 | 密码认证 | 支持密码连接测试/配置 | 高级/受限 | `webui-ssh-host-routes.js` |
| SSH-005 | 连接测试/系统诊断 | 返回 SSH、Node/OS/路径等诊断结果 | 高级 | `sshHostsAPI.testConnection` |
| SSH-006 | SSH workspace CRUD | connection + remote root + label，独立登记工作空间 | 高级 | `/v0/webui/ssh-workspaces` |
| SSH-007 | 远端目录浏览 | 在选定连接上浏览目录和 parent/children | 高级 | `/v0/webui/ssh-hosts/browse` |
| SSH-008 | 项目与连接绑定 | workspace 记录项目逻辑与物理 SSH connection | 高级 | `FabricSshHosts.tsx` |

### 10.2 Tauri 桌面端

| 编号 | 功能点 | 当前行为/边界 | 状态 | 主要证据 |
|---|---|---|---|---|
| DESK-001 | Profile list/upsert/remove | 桌面原生 profile store；endpoint 改变时要求重新授权 | 受限 | `src-tauri/src/profile_store.rs` |
| DESK-002 | Active profile get/set | 桌面启动与请求统一跟随 active Server | 受限 | `commands.rs` |
| DESK-003 | Secret Keyring | Management Key 只在系统 Keyring，profile JSON 不保存原值 | 受限/安全关键 | `secret_store.rs` |
| DESK-004 | Browser profile secret store | 浏览器版使用受信浏览器 storage；与桌面 Keyring 是两种实现 | 稳定/受限 | `server-profile-repository.ts` |
| DESK-005 | 原生 JSON HTTP adapter | Web renderer 经 Rust 发请求，统一注入 profile credential | 受限 | `server_http.rs`、`tauri-adapter.ts` |
| DESK-006 | HTTPS 边界 | 远程 endpoint 必须 HTTPS；HTTP 只允许 loopback | 稳定/受限 | `src-tauri/src/endpoint.rs` |
| DESK-007 | Blob 下载与 `aihblob` | 原生下载到 blob store，以本地协议读取并显式 release | 受限 | `blob_store.rs`、blob commands |
| DESK-008 | Native SSE/stream | open/cancel registry，Web renderer 接收原生 stream event | 受限 | `stream_registry.rs`、stream commands |
| DESK-009 | mDNS 发现/授权/route refresh | 发现 LAN Server，proof 后保存可信 route | 受限 | `server_discovery.rs`、`commands.rs` |
| DESK-010 | Route 健康排序 | health、RTT、sticky hysteresis、失败惩罚，避免 route 抖动 | 受限 | `server_route_runtime.rs` |
| DESK-011 | Outbound relay 配置 | 为本地 profile 配置多个公网 Server relay | 实验/高级 | `desktop_outbound_relays_configure` |
| DESK-012 | FRP route 配置 | 配置无新增端口 visitor 并验证 | 实验/高级 | `desktop_frp_route_configure` |
| DESK-013 | Relay route trust | 将验证通过的 route 纳入可信请求候选 | 实验/高级 | `desktop_relay_route_trust` |
| DESK-014 | Management Key rotate | 原生安全替换 Keyring secret 并刷新 profile/tray | 受限 | `desktop_management_key_rotate` |
| DESK-015 | 系统托盘 | 打开、刷新、退出；macOS/Windows 关闭窗口隐藏到托盘 | 受限 | `tray.rs`、`main.rs` |
| DESK-016 | 托盘账号切换 | 显示 Codex/Claude 等允许 provider 的账号、default 与 usage，点击设默认 | 受限 | `tray.rs`、`desktop-menu-model.js` |
| DESK-017 | 托盘刷新 | 启动立即加载并约 20 秒刷新；profile 变化主动刷新 | 受限 | `tray.rs` |
| DESK-018 | 多平台打包/smoke/evidence | 构建 Web/Tauri、安装包、packaged smoke、manifest 和 release evidence | 开发/发布 | `scripts/desktop/`、`docs/release/` |

## 11. Fabric、Remote Worker 与网络实验面

本节均不应与普通本机账号/网关能力混为一谈。当前 Web 顶级旧 Node 页面已重定向到 Server 管理，但 CLI、RPC 与实验实现仍大量存在。

用户入口分别为 `aih fabric ...` 与 `aih node ...`；表内省略重复的 `aih` 前缀。

### 11.1 Fabric CLI

| 编号 | 功能组 | 细粒度能力 | 状态 | 主要证据 |
|---|---|---|---|---|
| FAB-001 | Closure | `status`、`audit`、`verify`、`resume-check`；聚合 node/transport/provider/session proof 与 handoff | 实验/高级 | `lib/cli/commands/fabric-router.js` |
| FAB-002 | 远程 provider 账号 | `audit`、显式 `revalidate --yes`、`reauth`、auth-job get/cancel/callback | 实验/高级 | `services/fabric/provider-accounts.js` |
| FAB-003 | Node inventory | 列出 node 的 server/relay/project/runtime/SSH action gate | 实验/高级 | `fabric nodes` |
| FAB-004 | 远程 session start | node + provider + prompt，可带 accountRef/project id/path | 实验 | `fabric session start` |
| FAB-005 | 远程 session attach/events | run cursor attach 与增量 events | 实验 | `session-control-client.js` |
| FAB-006 | 远程 message/slash/stop | 向 run 发消息、slash command、停止 | 实验 | `fabric session message/slash/stop` |
| FAB-007 | Registry publish | 发布 server/node/project/runtime snapshot；`--from-server` 从真实管理账号派生 | 实验 | `registry-publish.js` |
| FAB-008 | Registry heartbeat | 更新 node/relay/transport liveness，不替换项目/runtime | 实验 | `registry-heartbeat.js` |
| FAB-009 | Registry agent/service | 前台 heartbeat/probe loop；install/status/uninstall 登录服务，密钥一次导入 DB | 实验/高级 | `registry-agent*.js` |
| FAB-010 | Broker connect | 一个本地 Server 对一个或多个公网 Server 建 outbound link、自动重连 | 实验 | `broker-connect.js` |
| FAB-011 | Transport probe | TCP/HTTP/WS endpoint 只读探测 | 高级 | `transport-probe.js` |
| FAB-012 | WebSocket echo | echo client/server、count、payload size、TLS | 实验/诊断 | `transport-echo.js` |
| FAB-013 | TCP echo | 区分 TCP connect 与应用数据 echo；含 client/server | 实验/诊断 | `transport-tcp-echo.js` |
| FAB-014 | Readiness/status | profile/node readiness 与聚合 transport closure | 实验/诊断 | `transport-readiness-client.js`、`transport-status.js` |
| FAB-015 | Prerequisites/promotion gate | TURN/WebTransport/multipath 外部前提与发布 gate | 实验 | `transport-prerequisites.js`、`transport-promotion-gate.js` |
| FAB-016 | Cloud edge | AWS UDP 到达、host firewall、cloud credential readiness 只读检查 | 实验 | `transport-cloud-edge.js` |
| FAB-017 | TURN relay | relay-only WebRTC readiness，不打印原始 TURN credential | 实验 | `transport-turn-relay.js` |
| FAB-018 | WebTransport | 浏览器 H3/WebTransport probe 与 blocker 报告 | 实验 | `transport-webtransport.js` |
| FAB-019 | Relay durability | 多轮 echo 稳定性 gate | 实验 | `transport-relay-durability.js` |
| FAB-020 | Transport config | `show/set/clear` 保存外部 probe 输入，不因保存而宣称 ready | 实验/高级 | `transport-config.js` |
| FAB-021 | FRP reconcile/route proof | 公网 route 配置、状态、移除与真实性证明 | 实验/高级 | `webui-frp-config-routes.js`、`fabric-route-proof.js` |
| FAB-022 | Reverse gateway | WebSocket gateway session、hop/concurrency guard、fallback | 实验 | `fabric-gateway-*` |
| FAB-023 | WebRTC signaling/datachannel | 房间、消息、node connect、DataChannel management RPC | 实验 | `fabric-router.js`、`node-webrtc-client.js` |

### 11.2 Node CLI 与 RPC

| 编号 | 功能组 | 细粒度能力 | 状态 | 主要证据 |
|---|---|---|---|---|
| NODE-001 | Join | 一次性 invite，默认 relay，可显式 endpoint/transport/name/id | 实验/高级 | `lib/cli/services/node/join.js` |
| NODE-002 | Doctor | control URL、node id 与本机/远端前提诊断 | 高级 | `node/doctor.js` |
| NODE-003 | Bootstrap plan/script | Linux/macOS/Windows 目标、repo/subdir、script-only/JSON | 高级 | `node/bootstrap.js` |
| NODE-004 | Bootstrap probe | 并行 SSH/TCP/HTTP/端口/ingress 只读探测 | 高级 | `node/bootstrap-probe.js` |
| NODE-005 | Bootstrap apply | script/local asset mode，默认 dry-run；`--execute --yes` 才执行，可限并发 | 高级/高风险 | `node/bootstrap-apply.js` |
| NODE-006 | Supervised service | 汇总 relay、registry agent、WebRTC 的 install/status/uninstall | 实验/高级 | `node/supervisor-service.js` |
| NODE-007 | Relay connect/service | 前台 outbound relay；登录服务 install/status/uninstall | 实验 | `node/relay-client.js`、`relay-service.js` |
| NODE-008 | WebRTC connect/service | signaling 后保持 DataChannel；登录服务 install/status/uninstall | 实验 | `node/webrtc-client.js`、`webrtc-service.js` |
| NODE-009 | Device profile/status/accounts | RPC 读取设备资料、运行态、账号 | 实验 | `node-rpc-router.js` |
| NODE-010 | 远程 reauth/auth job | device provider account reauth、get/cancel/callback | 实验 | `node-rpc-router.js` |
| NODE-011 | Device session read | sessions、messages、events、stream | 实验 | `node-rpc-router.js` |
| NODE-012 | Device-node session control | catalog、start、attach、command、ack、run events、artifact、run input/abort | 实验 | `node-rpc-router.js` |
| NODE-013 | Node inventory | device nodes 与服务端 nodes | 实验 | `node-rpc-router.js` |

### 11.3 Web 中仍存在但不在主菜单的 Remote Node API

`remoteNodesAPI` 与 `webui-remote-node-routes.js` 仍支持 defaults、invite 列表/创建、bootstrap plan/probe/apply、node list/save/test、以及代理远端 management status/metrics/accounts/usage。由于 `/fabric/remote-nodes` 与 `/fabric/nodes` 已重定向到 `/fabric/servers`，这些应标为实验/兼容 API，而不是当前一级 UI 承诺。

## 12. 后台、诊断、开发与发布工具

| 编号 | 功能组 | 细粒度能力 | 状态 | 主要证据 |
|---|---|---|---|---|
| OPS-001 | Background supervisor | 内部 `__background run`，驱动后台刷新/恢复/自愈 | 内部 | `root/router.js`、`background-supervisor.js` |
| OPS-002 | Usage probe 子进程 | 内部 `__usage-probe <provider> <id>` 输出 JSON，隔离 probe | 内部 | `root/router.js` |
| OPS-003 | SSH MCP server loop | 内部 `__ssh_mcp__ --target --remote-root` | 内部/实验 | `root/router.js` |
| OPS-004 | Runtime recovery daemon | 恢复中断 runtime、清理失联状态 | 内部 | `runtime-recovery-daemon.js` |
| OPS-005 | Orphan/session cleanup | 查找并清理可证明为 orphan 的 session/runtime 资源 | 内部/运维 | `scripts/ops/session-orphan-cleaner.sh` |
| OPS-006 | Runtime metrics/health sweep | 收集 runtime 指标、批量 health check | 运维 | `scripts/ops/collect-runtime-metrics.sh`、`healthcheck-sweep.sh` |
| OPS-007 | Release gate report | 汇总发布前 gate/evidence | 发布 | `scripts/ops/release-gate-report.js` |
| OPS-008 | Chat runtime smoke | real Codex、interaction、secret probe、evidence | 开发/验收 | `scripts/chat-runtime-*` |
| OPS-009 | Fabric real smoke | broker/relay/mobile PWA/profile switch/recovery/readiness/VPS/WebRTC/WebTransport | 开发/验收 | `scripts/fabric-real-*` |
| OPS-010 | Fabric preflight/gates | cloud edge、UDP、daemon、M6 prerequisite/promotion/durability、multipath | 开发/验收 | `scripts/fabric-*preflight*`、`*gate*` |
| OPS-011 | Desktop build/package/smoke | Web desktop build/dev、package install、fixture server、packaged smoke | 发布 | `scripts/desktop/` |
| OPS-012 | Desktop release evidence | prepare/collect/validate manifest 与 evidence | 发布 | `scripts/desktop/*release*`、`docs/release/` |
| OPS-013 | Codex session provider 对齐 | 修复/核对 session provider metadata | 运维/兼容 | `scripts/align-codex-session-providers.js` |
| OPS-014 | UI delegation | 启动/协调 UI delegate 流程 | 开发/实验 | `scripts/ai-ui-delegate.js` |
| OPS-015 | Provider hook sender | provider 官方 hook 调用的低依赖 sender | 内部 | `scripts/aih-provider-session-hook-sender.js` |
| OPS-016 | Test runner cleanup | 全量 test 分片/清理与 focused Node test | 开发 | `scripts/run-tests.js`、`test/test-runner-cleanup.test.js` |
| OPS-017 | Postinstall | 修复权限/hooks/本地可执行项 | 内部 | `scripts/postinstall.js` |
| OPS-018 | models.dev 异步同步 | GitHub Actions 每两小时后台检查上游；有变化时原子更新固定子模块指针与 Go 快照，验证成功后直接提交主分支。Server 启动和推理请求始终读取最后一次已验证的本地快照，不等待 GitHub 或上游 Git | 运维/稳定 | `.github/workflows/models-dev-sync.yml`、`scripts/sync-models-dev.js` |

## 13. 兼容、废弃与未公开能力清单

| 编号 | 能力 | 当前结论 | 状态 | 证据 |
|---|---|---|---|---|
| LEG-001 | `aih daemon` | Server daemon 生命周期 alias | 兼容 | `lib/cli/commands/root/args.js` |
| LEG-002 | `aih proxy` | 已替换为 `aih server`/`aih serve`，调用会明确失败 | 废弃 | `root/router.js` |
| LEG-003 | `format=aih/ai-home/aihome` | 统一映射到 sub2api，不再有独立格式 | 兼容 | `standard-transfer.js` |
| LEG-004 | Gemini gateway auto route | 账号、CLI、显式 provider 保留；默认自动网关已废弃 | 废弃/受限 | `provider-catalog-data.json`、`providers.js` |
| LEG-005 | Legacy chat runtime | canonical capability 不可用时继续工作，不能视为目标架构 | 兼容 | `features/legacy-chat/` |
| LEG-006 | Legacy Claude/Gemini archive | 可发现/恢复 `.archived` 历史文件 | 兼容 | `legacy-archive-recovery.js` |
| LEG-007 | 旧 Fabric 页面 URL | control-planes/remote-nodes/nodes/webrtc-diagnostics 均重定向到 Server 管理 | 兼容/废弃 | `web/config/routes.ts` |
| LEG-008 | 旧 macOS service | 更新/启动时迁移 | 兼容 | `legacy-macos-service-migration.js` |
| LEG-009 | Backup crypto service | age/RSA/password/legacy 逻辑存在，当前普通 export 无公开选项 | 未暴露/兼容 | `backup/crypto.js` |
| LEG-010 | Vendored Claude Code | 只保留 AI Home 集成边界；上游内部功能不进入本矩阵 | 外部/兼容 | `cli/`、`bin/claudecodex.js` |
| LEG-011 | CLI 拼写别名 | `list→ls`、`delete-all→deleteall`、`terminal-icons→terminal-icon`、`server list/rm/sync_codex` 等继续映射到同一实现 | 兼容 | `root/router.js`、`ai-cli/router.js`、`server/command-handler.js` |
| LEG-012 | 已移除 provider 子命令 | `auto`、`count`、`cleanup`、`up`、`down` 被保留在拒绝集合中并明确报 unknown，不再执行旧逻辑 | 废弃 | `REMOVED_ACTIONS`、`ai-cli/router.js` |

## 14. 当前重复实现与重构前风险提示

本节只标记事实，不在本轮给出大重构方案。

| 重叠/风险 | 当前事实 | 后续迁移必须守住的回归边界 |
|---|---|---|
| Canonical chat 与 legacy chat 并存 | 两套 state、queue、run、projection、composer 和 HTTP 面同时存在 | 先按 provider/session capability 建契约测试，再逐条切流；不能直接删 legacy |
| 账号状态有多个投影视图 | DB identity、runtime state、quota、Web live、CLI badge、Management view 分层派生 | `accountRef` 必须继续是唯一身份；不得恢复 profile-directory/数字 ID 真值 |
| Provider 能力分散 | catalog、native capability、session reader、hook、model capability、protocol route 各有 registry | 迁移时先建立单一 capability contract，不能仅凭“provider 在列表里”判断所有能力 |
| Server profile 有浏览器与 Tauri 两套存储 | 浏览器 trusted storage；桌面 profile JSON + Keyring | 新实现要保持 credential 不进 URL、DOM、普通 JSON/日志 |
| 会话系统同时含 native store、tmux registry、chat-runtime DB | 三者身份和生命周期不同 | 不得把“CLI 持久会话”“原生对话历史”“Web canonical session”合并成一个模糊 ID |
| 网关协议路径多 | OpenAI、Anthropic、Gemini、Codex app-server、direct passthrough、bridge 并存 | 固定 client→canonical→adapter→canonical→renderer 方向；避免 provider if/else 再扩散 |
| Fabric 面积大但一级 UI 收缩 | CLI/RPC/测试仍多，旧 Web Node 页面已重定向 | 先区分“产品稳定面”和“实验控制面”，迁移顺序不能由文件数量决定 |
| JavaScript 与 TypeScript 混用 | 主体 `lib/` 为 CommonJS JS，Web 同时有 TS/TSX 与 legacy JS/d.ts，Tauri 已是 Rust | 未来保留 JS 的部分转 TS 时要按模块边界逐个完成，不做一次性机械全仓改名 |

## 15. `clawdcodex` 可复用性初判

### 15.1 结论

**可以拿来用，但只能作为 Rust 核心迁移的候选底座/代码来源，不能整体替换当前 AI Home。**

`../clawdcodex` 是 Rust workspace，不是只有研究文档。当前 workspace 包含 `accounts`、`providers`、`config-sync`、`context`、`hooks`、`policy`、`sessions`、`runtime`、`terminal`、`storage`、`node`、`server`、`cli`，另有 TypeScript Web。它已具备账号维护、ai_home 导入、SQLite repository、Codex/Claude session discovery/sync/snapshot，以及 OpenAI Chat、OpenAI Responses、Claude Messages 的 API Key relay 最小闭环。

但它当前明确没有覆盖 AI Home 的完整能力：10 provider 全链、tmux 精确会话语义、完整 Web 会话工作台、桌面托盘/route、Fabric 大量控制面、完整 usage/billing，以及多种 OAuth/协议 bridge。其验收文档还明确列出 OAuth bridge streaming、完整 typed event timeline、Gemini Native、native session usage、完整 billing 与多 agent 等未完成项。

### 15.2 候选复用矩阵

| `clawdcodex` 模块/能力 | 可复用方向 | 复用判断 | 必须先补的契约 |
|---|---|---|---|
| `crates/storage` | SQLite repository、migration、transaction 边界 | 高候选 | 对齐 AI Home `accountRef`、现有数据导入/回滚与并发语义 |
| `crates/accounts` | 账号 CRUD、软停用、API Key rotate、公开 DTO | 高候选 | 不能用其账号 ID 替换 `accountRef`；补齐 OAuth、default/mobile、额度与 provider metadata |
| `crates/providers` + `server` relay adapter | typed provider/target protocol、OpenAI/Claude API Key relay | 高候选 | 用 AI Home 现有协议 fixture 做等价验证；补齐 OAuth、AGY/OpenCode/Grok/Qoder/Kimi/Kiro 与现有 fallback |
| `crates/sessions` | Codex/Claude 发现、索引、canonical snapshot | 中高候选 | 对齐 9 provider 可读 session、subagent/tool/image/memory citation、archive 与 live event |
| `crates/runtime` | typed process/runtime pipeline | 中候选 | 先证明 tmux fresh/attach/named/latest/reboot 语义完全不回退 |
| `crates/config-sync` | Native config 投影与 provider config 边界 | 中候选 | 对齐共享 session/config 与 credential isolation，特别是 Claude/Codex 差异 |
| `crates/hooks` | Provider hook adapter | 中候选 | 对齐当前 hook/polling/unavailable 三态与 self-heal |
| `crates/terminal` | 终端抽象 | 中候选 | 对齐 PTY、Windows、SSH clipboard、tmux passthrough 与 Web mux SSE |
| `web/` | 账号维护 UI 中的局部实现参考 | 低候选 | 当前只覆盖最小账号维护，不应替换 AI Home 完整 WebUI |
| 整仓替换 | 直接用 `ccx` 替换 `aih` | 不可取 | 功能缺口、ID/状态/命令/API 契约均不兼容 |

### 15.3 安全吸收原则

1. 以本功能矩阵中的单个 capability ID 为迁移单位，不以目录或语言为迁移单位。
2. 先写现有 Node/TS 行为的黑盒契约测试，再让 Rust/Go 新实现通过同一组测试。
3. 优先旁路/Strangler：同一输入可 shadow 到新实现，比较 canonical 输出、状态变更和性能，再切换单项流量。
4. 数据层先做只读/双读验证；任何写路径切换都必须有明确回滚和旧版本可读性。
5. Go 更适合独立 daemon、网络/并发运维组件；Rust 更适合本地核心、协议、存储、runtime 与 Tauri 共享库。具体归属要在下一阶段逐能力评估，不能先按语言偏好硬拆。
6. 保留 WebUI 的部分统一为 TypeScript，但先消除 canonical/legacy 重复职责，再做语言迁移；机械 `.js → .ts` 不等于重构完成。

证据：`../clawdcodex/Cargo.toml`、`../clawdcodex/docs/planning/current-acceptance.md`。核对时该仓库已有用户未提交文档修改，本次未修改、未清理这些内容。

## 16. 后续维护规则

后续每完成一个功能迁移或重构，必须同步更新本矩阵：

1. capability ID 不复用；删除能力改为“废弃”，保留迁移/替代入口。
2. 状态从实验/受限升级到稳定时，必须附契约测试和真实 smoke 证据。
3. 新 provider 必须同时回答：认证、账号状态、模型目录、额度、session、hook、protocol、failure policy、导入导出九个维度。
4. 新入口必须区分普通用户、运维高级、内部和开发工具，避免再次把实验实现当产品承诺。
5. 技术栈迁移报告至少记录：旧实现、目标实现、数据兼容、回滚、性能对比、测试命令和真实运行证据。
6. 根路由、Web 路由、Tauri commands、provider catalog、test 文件发生变化时，应进行一次矩阵防漏回扫。

## 17. 本次盘点的核心证据索引

- CLI：`lib/cli/commands/help/messages.js`、`lib/cli/commands/root/router.js`、`lib/cli/commands/ai-cli/router.js`、`lib/cli/commands/backup/router.js`、`lib/cli/commands/node-router.js`、`lib/cli/commands/fabric-router.js`。
- 账号与 runtime：`lib/account/`、`lib/profile/`、`lib/runtime/`、`lib/cli/services/ai-cli/`。
- 网关：`lib/server/server.js`、`lib/server/v1-router.js`、`lib/server/router.js`、`lib/server/capability-router.js`、`lib/server/protocol-*.js`。
- Web API：`lib/server/web-ui-router.js`、`lib/server/webui-*-routes.js`、`lib/server/management-router.js`、`lib/server/node-rpc-router.js`。
- WebUI：`web/config/routes.ts`、`web/src/pages/`、`web/src/features/`、`web/src/components/`、`web/src/services/api.ts`。
- 桌面：`src-tauri/src/commands.rs`、`profile_store.rs`、`secret_store.rs`、`server_http.rs`、`server_discovery.rs`、`server_route_runtime.rs`、`tray.rs`。
- 会话：`lib/sessions/session-reader.js`、`lib/server/session-lifecycle/`、`lib/server/chat-runtime/`。
- 验证面：`test/*.test.js`、`web/src/**/*.test.ts`、`scripts/desktop/`、`scripts/fabric-*`、`scripts/chat-runtime-*`。
