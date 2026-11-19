# Node → Go 迁移状态（2026-11-20 更新）

历史：本文件最初是 2026-11-19 的缺口清单。2026-11-20 已继续迁移并关闭多项缺口；
下面的"历史清单"保留作证据，当前状态以本节为准。目标是 **Go 是完整服务端**：
不区分单侧归属，Node 仅作为可选兼容宿主或插件运行时存在。

## 2026-11-20 已关闭

- 会话列表 / 消息 / 事件：provider 名单由 Provider 合同的 `session_history` 能力派生，
  17 个已知载体全部走 Go（kimi/chat 为显式空结果例外）；非 codex 增量事件与 Node
  旧行为一致（空 events + 文件 cursor + requiresSnapshot）。watch 文件定位补齐
  agy/grok/kiro/zcode/chat。
- 账号行：`status`（含 Vertex 占位 up）、`authPendingStale`/`authPendingAgeMs`、
  `upstreamErrorRules`/`upstreamErrorGroupIds` 已在 Go 行/live 行补齐；编辑成功返回
  live 行，避免零值覆盖派生字段。
- 新增账号：支持 `config.loginProvider`、`replaceExisting`，409 携带现有 jobId；
  本地 directImport 同时支持内置 `<provider>-host-local` 与插件来源。
- 插件账号登录：`account.login` 状态机迁入 Go（start/poll/submit/cancel、持久化、
  success 投影注册）；HTTP 路由 `/v0/webui/accounts/plugin-login/*` 由 Go 应答；
  前端自动轮询按插件 job 分派。
- 插件运行时：manifest 支持 `runtime: node|process`；Go ProcessHost 承载任意语言插件，
  HybridHost 按 runtime 路由，process-only 代次通过 EmbeddedInvoker 不依赖 Node socket。
- CLI 登录：agy native-cli、grok、qoder/qodercn、kimi、cline、CodeBuddy 家族统一走
  Go `aihloginjob/clilogin`；codex 设备码走官方 CLI `--device-auth`；
  `/v0/webui/account-jobs/{id}` 增加 CLI 登录作业回退。
- 旧 Node 公开路径：CLI 应用高级设置、ServerSetup node-rpc、SSH 隧道、
  账号导入进度均已补 Go 兼容别名。
- 路由归属：移除两条 legacy 聚合，投影全部为 `go_owned`。
- 移除旧的「某一侧独有」命名：账号查找回退统一表述为
  「宿主台账未命中 → 统一账号库」（`ledgerBacked`），Node 同步报告用
  `unadopted`，测试名与注释同步；不再用「某一侧独有」描述账号事实。
- 账号授权作业：补 logs / lastOutputAt / callbackCaptureStatus/Error；
  Go 无 loopback 监听时明确标 unavailable / manual_only。
- 客户端版本不再写死：Claude 身份版本改由 `claudeidentity` 解析
  （编译期下限 → 本机 CLI 探测 → 学习值，Codex/Claude 共用一份版本存储），
  messages 与 usage 同源；CodeBuddy 家族 UA 与 `X-IDE-Version` 改由
  `codebuddyfamilyrelay.CLIVersion()` 从本机安装目录解析（此前两个头各自
  写死且版本不一致，已落后于真实发行版）。Claude 版本目前没有「从入站真实
  客户端学习」的来源：`/v1/messages` 的 relay token 为一次性凭据，不能在观察
  阶段消费，因此该路径只靠本机 CLI 探测与下限。

## 2026-11-20 后续补齐（已关闭）

- process 插件能力不再限制：`contributes` 的合同能力全部可由进程插件承载，
  反向调用（插件在 invoke 中回调网关的 gateway/chat/tool/approval/ui/observe）
  由 `ProcessHost` 的 call 帧实现；`pluginartifact` 里旧的白名单判定已删除。
- 账号行：`updatedAt` 改为账号行自身时间，`tokenUsageSource` 输出 `go`；
  阈值/策略/runtime 型 `schedulableStatus` 在 live 行补齐。
- 会话读取：`webuisessionslistapi` 合并 Codex `state_*.sqlite` 的 threads
  （只读 CLI 自己的状态库，不复制成第二份存储）；非 codex 增量事件与历史一致。
- 聊天：主 UI 走 canonical chat runtime，附件上传/解析（`chat_runtime_attachments`）、
  会话存储、事件流都在 Go；legacy `/v0/webui/chat` 已退役并返回 409
  `chat_harness_required` 指向 `/v0/webui/chat/sessions`。无会话直连只在未挂载
  运行时时存在，它没有附件仓库，仍显式拒绝附件而不是静默丢弃。
- `aih server serve --codex-models` 已映射：Go 账号发现器追加静态模型名。
- 插件控制面写入：`application/plugincontrol` + `plugincontrolapi`
  （install/uninstall/state/instances/{id}/enable|disable）由 Go 执行 revision CAS，
  状态写 aih.db `app_kv/plugins.control.v1`；`pluginapi` 清单是同一事实的只读视图。
- 插件 CLI：`aih plugin` 全部子命令由 Go CLI（`cmd/aih/plugin.go`）实现：
  validate（含一次性宿主试加载）、pack（含 Ed25519 签名）、keygen、trust/untrust/trusted，
  以及 install/list/enable/disable/uninstall/call/doctor 的 Go Server 调用；
  Node 的 `lib/plugins/control/cli.js` 只剩进程转交，旧打包/签名实现已删除。
  已用真实插件包跑通安装→启用→调用→停用→卸载（process 与 canonical 两种包）。
- 账号列表 CLI：`aih ls` / `aih <provider> ls` 由 Go 处理，支持 `--scope`、
  provider 名/glob、数字 ID 过滤，并新增 Node 没有的 `--json`（稳定脚本接口，
  不输出凭据）；`sessions`/`ss` 也直接由 Go 输出。
- 备份 CLI：根命令与 Provider 限定的 `aih export` / `aih import`（含 `--dry-run`
  与原生 help）都由 Go 直接执行；请求按 Provider 过滤，不再从旧 CLI 规划器绕行。
- Provider 动作：`ls`、`usage`、`home`、`version`、`sessions`、`policy`、
  `terminal-icon` 等只读命令，以及 `login`、`delete/deleteall`、
  `set-default/unset-default`、`auto-switch`、`detect` 和家族
  `--restart-client/--force-quit-client` 都由 Go 直接执行
  （`delete`/`auto-switch` 增加原生 help）；CLI 启动时从 `config:server`
  注入管理密钥，不再依赖旧宿主包装。终端会话内的 `aih` shim 也已固定
  exec 同目录 Go CLI。
- 账号活动（签到/领取/探测）由 `accountactivity.NativeExecutor` 原生 Go 执行，
  验证码走 Go 自带浏览器解算端口，不再逐账号调用 Node。
- OAuth loopback 回调监听：新增 `internal/adapters/accountauth/oauthloopback`，
  账号新增与重新认证在等待授权时由 Go 监听 localhost:1455/54545（只绑回环、
  路径精确匹配、作业结束/取消/过期即释放），收到回调直接调用作业的 Complete；
  端口被占用时降级为手动粘贴回调。已用真实作业验证监听→回调→换码失败→释放端口。
- 字段级响应对拍（真实响应）：
  - accounts：`account-row-sources.js` 的 39 个字段中，无条件字段全部由 Go 响应覆盖；
    仅 `runtimeStatus/runtimeUntil/runtimeReason/loginType` 在确有运行态或 Kiro 身份时
    出现（无事实时前端按 healthy 处理）；Go 另多出 displayId/enabled/modelCount/
    vendor/tokenUsageSource，属超集。
  - sessions/projects：Session 必填字段齐全，model/preview 由 previews 接口按需补齐；
    chat-sessions 返回 Session 的全部字段。
  - models / openai-models：覆盖 `WebUiModelsResponse` 与 `WebUiOpenAIModelsResponse`
    的键，并在 data 项上多出 account_refs/aih_modalities/providers。
  - auth job：覆盖 `AccountAddJob` 的必需字段，并多出 logs/exitCode/pid/
    verificationUri/lastOutputAt 等运行态键。
- Server CLI：`aih server start|stop|restart|status|config|env|profiles|serve|
  autostart|sync-codex|add|ls|use|remove` 与 `aih serve` 均由 Go 执行；
  只有未知子命令继续走旧入口。
- Desktop CLI：`aih desktop status [--json]` 由 Go 采集 canonical/影子副本/
  运行中实例/漂移；JSON 与旧输出逐字段一致（`checkedAt` 除外），human 表格不变。
- Agent CLI：`aih agent adapters|capabilities|probe` 由 Go 输出 harness/adapter
  登记表、交互能力与降级探测；JSON 与旧输出逐字段一致。
- Claim CLI：`aih claim` 由 Go 选择 Provider/账号并驱动 Go Server 的活动作业；
  活动选择新增 `dryRun`，预览不再依赖旧 Node 执行器。
- Edge CLI：`aih edge status|plan|apply|remove` 由 Go `edgeproxy` 服务执行；
  status JSON 与旧输出一致，frp 移除使用 Go 的受管条目逻辑。
- Skill CLI：`aih skill list|doctor|install|enable|disable|remove` 由 Go
  `nativeresources` 服务执行；list/doctor JSON 与旧输出一致（Go 不保留显式
  `removed:false` 存储标记，语义相同）。
- MCP CLI：`aih mcp list|add|test|tools|call|enable|disable|remove|doctor`
  由 Go `nativeresources` 服务执行；list/doctor JSON 与旧输出逐字段一致。
- Native plugin CLI：`aih native plugin list|install|enable|disable|remove|
  inspect|project|doctor` 由 Go `nativeresources` 服务执行；list/doctor JSON
  与旧输出逐字段一致。
- Update CLI：`aih update --check|--dry-run|--force` 由 Go 执行；
  区分 source-link/package/npm 安装源，source-link 给出 git 手动更新提示。
- 远端节点交互端点（device-node-session-start/input/stream、
  device-node-session-run-events、device-session-stream）：WebUI 客户端有此调用，
  但本仓库的 Node 与 Go 服务端都从未实现过，它们是发往远端 node agent 的契约，
  不是迁移丢失；服务端侧的 device-sessions/device-session-messages 已由 Go 承载。

## 2026-11-20 仍需验证 / 迁移

- 真机对拍：canonical 会话的附件上传 → turn.submit → timeline 回读（上传/落盘/
  删除已实测），以及账号行 status/updatedAt/tokenUsageSource 的 UI 呈现。
- 路由级对拍已完成：从 `web/src/services` 提取 211 个 method+path，GET 全部命中
  Go 路由（唯一 404 是 job 不存在时的正常领域错误）；对 88 条非危险写路由做了
  空载荷探针，全部命中（`projects/pick` 会等待系统文件夹对话框，按预期阻塞）。
- 字段级响应对拍已按上面的字段清单完成；剩余是真实 Edge 页面上的可视化确认
  （账号行、会话列表、模型选择器、auth job 进度），不是响应键缺失。
- 旧 CLI 动作迁移：上述只读/备份/登录/启停/Server/Desktop/Agent/Claim/Edge/
  Skill/MCP/Native plugin/Update 命令已是 Go；`cmd/aih` 仍有顶层
  ssh/shell/harness/backup 走旧入口。下一步按命令逐个迁到 Go 并真机对拍。

---

**单库原则：所有缺口只补进 aih.db，不新增第二个数据库。** 文中出现的 `state*.sqlite` 是 Codex CLI 自己的本地文件，不是 aih 的库，也不是要接入的存储；需要的会话元数据应落到 aih.db 的索引表。

## 已关闭

- `aih server serve` Node 常驻入口已切到 Go 适配器（`af264cf9`）。
- 会话元数据已物化到 aih.db：schema v32 新增 `session_index` / `session_index_state`；列表优先读索引，30 秒 TTL，扫描结果回填。**不读取、不新增 Codex 的 `state*.sqlite`。**

## 清单：2026-11-19 快照（以下均已关闭）

1. **已关闭：会话列表 provider 名单** — 由 Provider 合同 `session_history` 能力派生，
   17 个载体全部走 Go；不再有 501 "请走 Node 网关"。
2. **已关闭：会话增量事件** — 非 codex 与历史行为一致（空事件 + 文件 cursor）；
   codex 事件与 state 库索引都由 Go 读取。
3. **已关闭：会话消息** — provider 名单同样由合同派生，不再返回 501。
4. **已关闭：Codex 会话元数据** — 列表合并 `state_*.sqlite` 的 threads（只读，
   不复制成第二份存储），会话元数据仍落 aih.db。
5. **已关闭：账号新增/本机导入模式** — OAuth、Kiro refresh_token、
   agy/grok/qoder/qodercn/kimi/cline/CodeBuddy 家族 CLI 登录、codex 设备码
   与插件 `account.login` 均由 Go 承接。
6. **已关闭：聊天附件仓库** — canonical runtime 的 `/sessions/{id}/attachments`
   与 `chat_runtime_attachments` 就在 Go；旧无会话直连明确拒绝附件只是降级语义。
7. **已关闭：聊天会话存储** — canonical runtime 持有会话、轮次与事件流；
   legacy `/v0/webui/chat` 返回 409 并指向 `/v0/webui/chat/sessions`。
8. **已关闭：auth-job 进度字段** — logs / lastOutputAt /
   callbackCaptureStatus/Error 已补齐；无 loopback 监听时明确标 unavailable / manual_only。

## 清单：接口能返回 200，但字段/诊断被留空

2026-11-20 逐条核对后的实际状态（代码证据见后）：

1. **已关闭：账号行的调度规则** — `webuiaccountsapi/source.go:239-242` 把
   `upstreamErrorRules` / `upstreamErrorGroupIds` 从 aih.db 读出并落到行上；
   `row.go` 里的 `[]any{}` 只是无规则时的占位。
2. **已变更：tokenUsageSource** — 历史 Node 实现没有这个字段；Go 读模型现在显式
   输出 `go`，前端可据此区分事实来源，不再照抄历史空串。
3. **已关闭：派生 status** — `row.go:234` `resolveAccountStatus`（含 Vertex 占位
   账号保持 up）。
4. **刻意最小：启停接口视图** — `webuiaccountstatusapi/handler.go:112-127`
   只回 `accountRef/provider/status/configured`，注释写明不返回 displayName /
   updatedAt：它们不是启停事实，回空值会覆盖前端已有展示字段。
5. **已关闭：调度状态** — `webuiaccountsapi/row.go:294` `resolveSchedulableStatus`
   在 无台账投影账号上算 `blocked_by_quota`；`webuiaccountliveapi/hub.go:721-738`
   补 `runtimeModels` 与 `blocked_by_runtime_status` / `blocked_by_policy`。

仍未承接的只剩：`tokenUsage` 的实际计量投影在无用量记录的账号上为 null（与无快照
时的历史行为一致，不是字段丢失）。插件宿主 / CLI 登录作业 / 聊天附件均已在 Go。

## 清单：`aih server serve` 参数缺口（当前 fail-closed）

已映射到 Go flag/env：
`host`、`port`、`client-key/api-key`、`management-key`、`proxy-url`、`no-proxy`、`strategy`、`codex-client-version`、`cooldown-ms`、`failure-threshold`、`upstream-timeout-ms`、`max-attempts`、`models-cache-ttl-ms`、`models-probe-accounts`、`codex/gemini/claude/agy/opencode-max-concurrency`、`queue-limit`、`session-affinity-ttl-ms`、`session-affinity-max`、`model-usage-scan*`、`no-request-log`、`backend`、`provider`、`provider-cli-auto-upgrade*`、`window-activation*`、`strict-port`、`allow-multi`；hooks 与 web-dir 由适配器自动传。

已映射到 Go flag/env（2026-11-20 补齐）：`--codex-models`、`--codex-base-url`、
`--claude-base-url`、`--agy-base-url`、`--gemini-base-url`。`--codex-models`
以 `AIH_SERVER_CODEX_MODELS` 下发给 Go 账号模型发现器，与官方目录合并去重；
四个上游兜底由 `internal/runtime/upstreamdefaults` 统一解析（env > `config:server` >
官方默认），推理侧、出口裁决（egress）与图片子系统读同一份值；CLI 适配器只在用户
显式传参时下发给 Go，避免 args.js 的官方默认值压掉 `config:server`。

当前没有未移植的 serve 选项。

行为差异：
- `--host` 非 loopback 现在显式拒绝（Go 只允许 loopback）。
- Node 默认单实例锁/端口占用处理与 Go 的严格 bind 不同；`--allow-multi` 只是不再探测已运行实例。
- 删除了 Node 启动前的 usage scheduler / state-index 预热；Go 自己启动刷新，需用真实数据对拍确认无缺口。

## 清单：合同/文档残留

- 路由归属：两条 legacy aggregate 已移除，投影全部为 `go_owned`。
- `webui.static_shell` 注释已改为缺失时由前置门返回明确错误。
- `docs/testing/autostart-*.md` 保留 `--front-door --supervise-node` 历史参数，属历史证据，不应作为当前启动模板。

## 下一轮对拍建议

1. 逐个 `/v0/webui/*` 端点核对 Go 响应键与前端消费字段（尤其 accounts、sessions、chat、models、auth jobs），缺失即读模型缺口。
2. 逐字段核对 account/session row builder，优先补 P0/P1 的空字段。
3. serve 选项新增时同步补 Go flag/env 与文档，不再保留 fail-closed 清单。
