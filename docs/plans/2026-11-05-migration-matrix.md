# Provider × 能力迁移矩阵（2026-11-05）

> 只读盘点，不涉及代码改动。
> 基线：`main` @ `594da688`；工作区另有他人未提交改动（`lib/account/quota-reset-detector.js`、`lib/server/window-activation/window-ledger.js` 及两个新测试文件），与本盘点无关。
> 方法：读 Go 组合根/适配器/传输层、Node provider 描述符与 server/runtime 实现，以及 `docs/plans/2026-11-04-node-go-merge.md` §7–§9。
> 未执行：真机请求、服务重启、DB 读写、git 写操作。

## 0. 判定口径

| 标记 | 含义 |
| --- | --- |
| `go` | Go 有生产实现并已接线；Node 侧已声明关闭（如 `quota.supported=false`）或只读 Go 产物 |
| `both` | 两侧都有可运行实现（双跑/迁移中，含「Node 计算后推送给 Go」） |
| `node` | 只有 Node 有实现 |
| `none` | 两侧都没有；对该 Provider 不适用或明确不支持 |

路径前缀：`G:` = `internal/`，`A:` = `application/`，`C:` = `core/`，`N:` = `lib/`。单元格内先 Go 后 Node。
「已写代码但未接线」不记为 `go`，仍记 `node` 并在单元格注明。

## 1. 矩阵

| Provider | 登录/OAuth 作业 | 模型目录发现 | 额度采集 | 推理 relay | 账号删除/宿主清理 | 活动签到 | 会话/PTY/SSH |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **agy** | `node` `N:server/oauth-strategies/agy.js`；Go 仅刷新 `G:adapters/accountauth/agyoauth/refresh.go` | `go` `G:adapters/agy/codeassist` · `N:providers/defs/agy.js`（只读 Go） | `go` `G:adapters/agy/usage`；`N:providers/defs/agy.js` quota=false | `go` `G:adapters/agy/codeassist`（canonical；Node 侧 tombstone `N:server/agy-cli-transport.js` 已于 2026-11-06 删除） | `node` `N:account/account-removal.js` | `none` | `node` `N:runtime/client-terminal.js` |
| **claude** | `both` `G:adapters/accountauth/claudeoauth` · `N:server/oauth-strategies/claude.js` | `go` `G:adapters/claude/messages` · `N:providers/defs/claude.js`（只读 Go） | `both` `G:adapters/claude/usage` · `N:usage/provider-usage/claude.js` | `both` `G:adapters/claude/messages` + `G:transport/http/claudenativerelay` · `N:server/provider-protocol-routing.js` | `both` `G:adapters/accounts/deletionprojection` · `N:account/account-removal.js` | `none` | `both` `G:adapters/claude/clilaunch` + `G:runtime/providercli` · `N:runtime/client-terminal.js` `N:runtime/acp-layouts.js` |
| **cline** | `node` `N:account/cline-credentials.js` `N:account/cline-native-credential-sync.js` | `go` `G:adapters/cline/modelcatalog`（静态清单）· `N:providers/defs/cline.js`（只读 Go `account_models`） | `go` `G:adapters/cline/usage`；`N:providers/defs/cline.js` quota=false | `both` `G:transport/http/clinerelay` · `N:server/upstream-endpoints-transport-general.js` | `node` `N:account/account-removal.js` | `none` | `node` `N:runtime/acp-layouts.js`（ACP 已登记） |
| **codebuddy** | `node` `N:server/oauth-strategies/codebuddy.js` | `go` `G:adapters/codebuddyfamily/modelcatalog` · `N:providers/defs/_shared/codebuddy-family.js`（只读 Go） | `go` `G:adapters/codebuddyfamily/usage`；`N:providers/defs/_shared/codebuddy-family.js` quota=false | `both` `G:transport/http/codebuddyfamilyrelay`（仅 chat_completions）· `N:server/upstream-endpoints-transport-general.js` | `node` `N:account/account-removal.js` | `none` | `node` `N:runtime/acp-layouts.js` |
| **codebuddycn** | `node` 同上（同 `_shared` 描述符） | `both` 同上 | `go` `G:adapters/codebuddyfamily/usage` | `both` 同上 | `node` 同上 | `node` `N:account/activity-claim/workbuddy-daily.js` | `node` 同上 |
| **codex** | `both` `G:adapters/accountauth/codexoauth` · `N:server/oauth-strategies/codex.js` | `go` `G:adapters/codex/responses` · `N:providers/defs/codex.js`（只读 Go） | `both` `G:adapters/codex/usage` · `N:usage/provider-usage/codex.js` | `both` `G:transport/http/codexresponseshttp` + `G:transport/http/codexresponsesws` · `N:server/codex-adapter.js` | `both` `G:adapters/accounts/deletionprojection` · `N:account/account-removal.js` | `none` | `both` `G:adapters/codex/clilaunch` + `G:runtime/providercli` · `N:runtime/client-terminal.js` `N:runtime/acp-layouts.js` |
| **gemini** | `node` `N:server/oauth-strategies/gemini.js`（OAuth 登录已在描述符停用；刷新 `N:server/gemini-token-refresh.js` 仍在 Node） | `go` `G:adapters/gemini/modelcatalog` · `N:providers/defs/gemini.js`（只读 Go） | `go` `G:adapters/gemini/usage`（`retrieveUserQuota`）；`N:providers/defs/gemini.js` quota=false | `node` `N:server/upstream-endpoints-transport-code-assist-gemini.js`（**provider 已 `GatewayDeprecated`**，只服务遗留账号/API Key；不迁） | `node` 同上 | `none` | `node` `N:runtime/acp-layouts.js` |
| **grok** | `node` `N:account/grok-auth-profile.js` + 通用 CLI 登录作业 | `go` `G:adapters/openaicompat/modelcatalog`（仅 API Key）· `N:providers/defs/grok.js`（只读 Go） | `go` `G:adapters/grok/usage`；`N:providers/defs/grok.js` quota=false（token 由 Node 刷新守护进程续期） | `both` `G:transport/http/grokrelay` · `N:server/upstream-endpoints-transport-general.js` | `node` 同上 | `none` | `node` `N:runtime/client-terminal.js` |
| **kimi** | `node` `N:account/kimi-auth.js` + 通用 CLI 登录作业 | `go` `G:adapters/openaicompat/modelcatalog` · `N:providers/defs/kimi.js`（只读 Go） | `go` `G:adapters/kimi/usage`；`N:providers/defs/kimi.js` quota=false | `both` `G:transport/http/kimirelay` · `N:server/upstream-endpoints-transport-general.js` | `node` 同上 | `none` | `node` `N:runtime/acp-layouts.js` |
| **kiro** | `node` `N:account/kiro-device-login.js` `N:account/kiro-native-login.js` | `go` `G:adapters/kiro/modelcatalog` · `N:providers/defs/kiro.js`（只读 Go） | `go` `G:adapters/kiro/usage`；`N:providers/defs/kiro.js` quota=false | `go` `G:transport/http/kirorelay`（CodeWhisperer event-stream + 事务刷新）；仅原生凭据 | `node` 同上 | `none` | `node` `N:runtime/client-terminal.js` |
| **opencode** | `node` `N:server/oauth-strategies/opencode.js`（设备码） | `go` `G:adapters/opencode/modelcatalog`（Zen + Go 双腿）· `N:providers/defs/opencode.js`（只读 Go `account_models`） | `none` 两侧均无额度接口（`C:providers/builtins.go` 未声明 quota，Node quota=false） | `both` `G:transport/http/opencoderelay`（仅 official API Key）· `N:server/opencode-free-cli-transport.js` | `node` 同上 | `none` | `node` `N:runtime/acp-layouts.js` |
| **qoder** | `node` `N:account/qoder-auth-metadata.js` + 通用 CLI 登录作业 | `go` `G:adapters/qoder/modelcatalog`（wasm 签名）· `N:providers/defs/qoder.js`（只读 Go） | `go` `G:adapters/qoder/usage`；`N:providers/defs/qoder.js` quota=false | `go` `G:transport/http/qoderrelay`（WASM 签名 + zstd；排队 → 429 + `Retry-After`，SSE 首帧记账前判定）；静态凭据/CLI 账号交还 Node | `node` 同上 | `node` `N:account/activity-claim/qoder-daily.js` | `node` `N:runtime/acp-layouts.js` |
| **qodercn** | `node` 同上（CN 变体） | `go` `G:adapters/qoder/modelcatalog`（CN 区域）· `N:providers/defs/qodercn.js`（只读 Go） | `go` `G:adapters/qoder/usage` | `go` 同上（同一 Handler，按账号选 CN 端点） | `node` 同上 | `node` 同上（区域主机不同） | `node` 同上 |
| **workbuddy** | `node` 家族宿主扫描 `N:account/host-account-sync/` | `go` `G:adapters/codebuddyfamily/modelcatalog` · `N:providers/defs/workbuddy.js`（只读 Go） | `go` `G:adapters/codebuddyfamily/usage` | `both` `G:transport/http/codebuddyfamilyrelay` | `node` 同上 | `none`（国际站无签到） | `node` `N:runtime/acp-layouts.js` |
| **workbuddycn** | `node` 同上 | `both` 同上 | `go` 同上 | `both` 同上 | `node` 同上 | `node` `N:account/activity-claim/workbuddy-daily.js` | `node` 同上 |
| **zcode** | `node` `N:server/oauth-strategies/zcode.js`（cli-flow / custom-scheme） | `go` `G:adapters/zcode/modelcatalog` · `N:providers/defs/zcode.js`（只读 Go） | `go` `G:adapters/zcode/usage`；`N:providers/defs/zcode.js` quota=false | `go` `G:transport/http/zcoderelay`（harness + 双鉴权）；静态凭据/CLI 账号交还 Node | `node` 同上 | `node` `N:account/activity-claim/zcode-plan.js` | `node` `N:runtime/client-terminal.js` |

## 2. 规模与分布

矩阵 16 Provider × 7 能力 = **112 格**：

| 能力 | go | both | node | none |
| --- | ---: | ---: | ---: | ---: |
| 登录/OAuth 作业 | 0 | 2 | 14 | 0 |
| 模型目录发现 | 14 | 2 | 0 | 0 |
| 额度采集 | 13 | 2 | 0 | 1 |
| 推理 relay | 5 | 10 | 1 | 0 |
| 账号删除/宿主清理 | 0 | 2 | 14 | 0 |
| 活动签到 | 0 | 0 | 5 | 11 |
| 会话/PTY/SSH | 0 | 2 | 14 | 0 |
| **合计** | **32** | **20** | **48** | **12** |

## 3. 关键观察

1. **Go 强在账号面，弱在宿主面。** 模型发现 16/16（14 go + 2 both）、额度 15/16 已由 Go 产出；删除清理、活动、PTY/SSH 几乎仍全在 Node。迁移的主战场已经从「协议适配」转到「宿主交互」。
2. **额度是唯一出现 `go`-only 的能力（13 个）。** 模式已经跑通：Go 写 `account_usage` / `account_usage_snapshots`，Node 描述符 `quota.supported=false` 只读文档。新增 Provider 应直接复制这条链路，不要再写 Node 探针。
3. **relay 只有 gemini 还是 `node`（2026-11-06）。** kiro / zcode / qoder / qodercn 已全部由 Go 承接；gemini 是 Go 确实没有上游适配器的一家（`C:providers/builtins.go` 里带 reason 的 node-only），且 `gemini-*` 模型多经 agy 的 Code Assist 线路可用。
4. **登录的 14 个 `node` 不等于 14 套实现。** Node 侧是通用 CLI 作业框架（`N:server/web-account-auth.js` + `N:server/oauth-strategies/*`），Provider 只提供策略/提示词。迁移时应拆成「作业框架持久化」与「Provider 策略」两块，而不是逐家搬。
5. **活动与会话的 `node` 是设计选择，不是欠账。** 活动依赖本机 Chrome + 阿里云验证码（强风控），PTY/SSH 是宿主级能力（计划 P5）。短期迁 Go 的收益低于风险。
6. **模型目录已 16/16 由 Go 产出**（2026-11-05）：所有内置 Provider 的 descriptor 都只声明一条 `transport: local` 的 `go-account-models` 策略，Node 不再有任何出网/CLI 探测策略（见 `lib/providers/model-ownership.js`）。
7. **Node-only Provider 不再拖垮 Go 路由目录（2026-11-06 修复）。** kiro 这类
   `RelayHosts[Go].Supported=false` 的 Provider，其模型曾因缺 Factory 让整个
   `inferencecatalog.Build` 失败（启动日志 `Provider 路由 Factory 不存在: kiro`）。
   现在 `WithNodeOnlyProviders`（名单从 Catalog 派生）会跳过它们，请求按「模型不可路由」
   交还 Node；未声明的 Provider 缺 Factory 仍是硬错误。
8. **`gateway.models.list` 是最后一个 `node_owned` 的数据面条目（2026-11-06）。**
   其余 gateway 条目（responses / chat_completions / messages / gemini / images / blobs）
   都已是 `go_owned`，`resolveGoOwnedEntryIds` 的「目录必须等全部推理条目」前置条件已满足，
   但**不能据此直接划转**：Go 的目录只含 Go 能路由的模型，而 `relayHosts[go].supported=false`
   的 Provider（当前只有 gemini）以及自定义账号的模型仍只在 Node 侧。
   划转判据用 `node scripts/compare-model-catalog.js --go <go url> --allow-node-only gemini`：
   退出码 0 才可以改 manifest，2 表示存在未预期的 node-only 模型。
   **2026-11-06 已做真机差集并划转**：Node 215 / Go 215，双向差集为空，退出码 0
   （`catalog_can_move`）。字段级也一致：`data[].{id,object,created,owned_by,aih_modalities}`、
   顶层 `{object,data}`。manifest 已把 `gateway.models.list` 改为 `go_owned`、清空 blockers。
   两端 key 来自运行中的 Go 进程环境（`AIH_SERVER_API_KEY` / `AIH_SERVER_MANAGEMENT_KEY`），
   不再需要人工提供。
   **同时发现**：Go 的推理前门在这套部署里没有接管任何路由——直连 Go 的
   `/v1/chat/completions` 返回 503 `inference_unavailable`，所以 `usage_ledger` 一直是 0，
   `account_outcomes` 最新桶也停在两小时前。要让用量/额度真正落到 Go，必须先给
   `AIH_GO_CORE_ROUTES` 分配推理入口；在那之前所有「Go 承接流量」的验证都只能靠单测。
10. **WebUI 额度统计（`/v0/webui/accounts/:provider/:ref/quota-stats`）卡在成本口径（2026-11-06）。**
    Go 侧的窗口重建、维度选择、汇总全部已就绪（`application/accountusage/quota_stats.go`），
    唯一缺口是 `cost_usd`：Node 的成本来自 `model_usage_pricing` 表 +
    `lib/usage/model-usage-{identity,pricing,resolver}.js`，而 Go 的 `usage_ledger` 只有 token 明细。
    已完成：计费归属 + 定价引擎迁到 `internal/adapters/usagepricing`（18 条归属 + 126 条成本
    由 Node 出真值的对照夹具，变异验证过）。
    已完成（2026-11-06）：① `sqliteaccount.LoadModelPricing` 读表，`model_usage_pricing` 不存在时
    fail-soft 返回空目录（全新安装不该 500）；`reasoning_output_token_cost` 的 0 还原成「未声明」。
    ② `usagestatsapi` 的 models 响应补 `cost_usd`/`cost_known`/`cost_supported`，成本计算器通过
    接口注入；目录按 5 分钟缓存，读表失败只降级成本、不影响统计。
    ③ 已完成（2026-11-06）：`QueryQuotaWindowUsage` 改为按 (窗口, Provider, 模型) 聚合并保留
    明细，`QuotaStatsService` 接 `QuotaWindowPricer` 逐模型计价；窗口内任一模型无定价即整窗
    「未知」，空窗口是确定的 0 元。定价快照与模型用量接口共用同一份缓存，两个页面口径一致。
    ④ **切流已回滚（2026-11-06），原因是数据面还没就位。**
    切过去的实现做过一轮：Node 只保留账号校验、参数翻译与 snake→camel 契约映射，
    Go 不可用返回 503（不留第二套算法）。但真机核对发现 **Go 的 `usage_ledger` 是空的**：
    `aih.db` 里 `usage_ledger` = 0 行，而 Node 的 `app-state.db.model_usage_records` 有
    1,229,000+ 行（codex 7.6e5 / claude 1.6e5 …）。照此切换，额度页的 tokens 与成本会
    全部变成 0——比不切更糟，所以整条切流（含门面项 `getQuotaStats`）已回滚。
    解锁条件：Go 每个成功推理都真正写 `usage_ledger`。已定位到根因（2026-11-06）：
    **透传通道（relaycore）从来没有上报过用量**——`recordSuccess` 只记「成功」，
    `NewAttemptSuccess(clock)` 不带 `WithUsage`，所以 cline/grok/kimi/opencode/qoder/
    zcode/kiro 全部不落账。修复：relaycore 在响应交付时挂一个旁路解析（`usageTee`），
    流结束/关闭时结算一次；用量只解析 OpenAI 与 Anthropic 两种主流形态，
    多帧取最大值、缓存大于输入时并入输入，解析不到就**不记**（不猜）。
    仍需验证：重建 Go 二进制并重启 core 后，`usage_ledger` 应开始增长。
    **部署要点（踩过）**：必须用 `npm run go:build`（`node scripts/build-go-server.js`）。
    直接 `go build -o bin/native/...` 出来的二进制没有 build stamp，supervisor 会以
    `go_core_build_mismatch` 拒绝启动，表现为「杀掉 core 后一直起不来」。
    2026-11-06 已用官方脚本重建并重启成功（healthz 200）。
    **真机已验证**：直连 Go 发一次 `glm-5.3-flash`（zcode）后，`usage_ledger` 立刻出现一行
    `zcode / 1083 input / 1 output`——旁路解析、记录构造、账号校验、SQL 写入整条链路通。
    **kiro 没有账本行不是 bug**：它的上游（二进制 AWS event-stream）只给 `meteringEvent`
    的 credits，**没有任何 token 用量帧**——`kirorelay/sse.go` 的注释写明了「usage 只能按字符
    估算，这里不算，宁可不给也不编造」。所以 kiro 的 token 统计在 Go 侧天然缺失，
    要补只能做估算，那会污染成本口径；当前决定是**保持不记**。
    需要 token 的 Provider 必须自己在上游响应里带用量（SSE/JSON 由旁路扫描器解析）。
    校验判据（可直接跑）：
    ```bash
    sqlite3 ~/.ai_home/aih.db "select count(*) from usage_ledger;"
    sqlite3 ~/.ai_home/app-state.db "select provider, count(*) from model_usage_records group by provider;"
    ```
    切流前两边的量级必须可比，否则先补账本再谈前门。
    遗留：`lib/account/quota-window-stats.js` 与 `quota-window-reconstruction.js` 现在
    **只剩 `test/quota-window-reconstruction.test.js` 一个调用方**；Go 的窗口重建已经在跑，
    等切流落地后这两个文件与那份测试可以一起删（约 988 行）。
9. **删除的 `both` 只覆盖 codex/claude。** Go 的 `deletionprojection` 只处理这两家的凭据 artifact 与投影（`G:adapters/accounts/deletionprojection/resources.go` 按 provider 分支），进程/tmux/keychain/桌面 hook 仍只有 Node 有。

## 4. nextSlices（4 条，按 价值÷风险 排序）

排序口径：价值 = 解除 Node 依赖的覆盖面 + 对矩阵格子的推进；风险 = 真机不可验证性 + 回滚成本 + 对现有路由的破坏面。

### Slice 1（价值最高 / 风险中）：qoder/qodercn relay 接线并验收

- **目标**：把已完成的 `G:transport/http/qoderrelay` 接进 chat completions 入口的 ProviderChain 与账号来源；`C:providers/builtins.go` 的 qoder/qodercn 从 `relayHostsNodeOnly` 改为 `relayHostsGoRelay("gateway.openai.chat_completions")`；Node 的 `qoder_http_sse` 保留为回落，不删。
- **为什么现在做**：传输核心（body/SSE/wasm 签名/zstd）与单测已完成（`7e35dcce`），但组合根没挂链，收益为零；这是矩阵里唯一「Go 有实现却完全用不上」的 Provider。越晚接线，Node 侧 qoder CLI 依赖越难拆。
- **涉及文件**：`G:host/aihserver/composition.go`（`familyRelayHandler` 的 ExtraProviders / AccountSourceChain）、`G:host/aihserver/qoder_relay_account_source.go`、`G:transport/http/qoderrelay/{provider,body,sse}.go`、`G:host/aihserver/relay_providers.go`、`C:providers/builtins.go`、`N:providers/defs/{qoder,qodercn}.js`。
- **可验证方式**：先跑 `go test ./internal/transport/http/qoderrelay/...`（假 signer + httptest）；接线后用 `GET /v1/management/status` 的路由观察，再对**付费**账号发一次 `/v1/chat/completions`，确认命中 Go 通道且上游 200。Free 账号的 500 不作为判据。
- **风险**：Free 账号 500 无法区分套餐与线协议；`Cosy-MachineToken/MachineType` 覆盖依赖 umid-cache.json，缺失即 500；接线后失败会被记成账号失败并污染调度。缓解：用配置文件开关默认关闭，真机通过后再开；失败路径先只回退、不写失败事实。

### Slice 2（价值中 / 风险极低）：cline 模型目录迁 Go

- **目标**：把 `N:server/cline-models.js` 的静态清单落到 Go 的模型发现（新增 `G:adapters/cline/modelcatalog`），让 cline 账号的 `account_models` 由 Go 产出；Node 的 `models.supported` 改为 false 或只保留公共目录投影。
- **为什么现在做**：cline 是矩阵里唯一 `models=node` 的格子；纯静态数据、不联网、不依赖客户端、无风控成本。更关键的是 `relay_providers.go` 已经给 cline 建了模型刷新队列，但 `newModelDiscovery` 没有对应策略——队列空转，正是 `composition.go` 注释里点名的「账号在池里、目录永远为空」静默失效。做完后 16/16 的账号级模型发现都在 Go 内有实现。
- **涉及文件**：新增 `G:adapters/cline/modelcatalog/`；`G:host/aihserver/composition.go`（`newModelDiscovery` 策略表）；`C:providers/builtins.go`；`N:server/cline-models.js`（对照源）；`N:providers/defs/cline.js`（能力声明）。
- **可验证方式**：Go 表驱动单测，用固定清单断言模型集合与 Node 清单逐条一致（同源守卫）；真机 `POST /v1/management/accounts/{ref}/models/refresh` 后查 `account_models`。前置：先启用一个 cline 账号（当前两个 `enabled=0`）。
- **风险**：静态清单随 Cline 版本漂移，没有同源守卫会静默分叉；账号 disabled 导致真机验收缺口，首轮只能靠单测 + 清单比对。

### Slice 3（价值中高 / 风险中低）：gemini、grok、kimi 额度采集迁 Go

- **目标**：新增三个额度策略（gemini `refreshUserQuota`、grok billing、kimi `/usages`），登记 coordinator 队列与 `RefreshStrategy`，把 Node 的 `quota.supported` 从 true 改为 false。
- **为什么现在做**：额度是 Go 最成熟的一条链（10 个 go-only）；三家都是 HTTP + 归一化，复用现有 `usageapp` 框架即可。做完后 Node 的定时额度探针从 5 个降到 2 个（codex/claude 仍双跑）；额度面实现覆盖变为 15 go + 1 none（opencode 无额度接口）。
- **涉及文件**：新增 `G:adapters/gemini/usage/`、`G:adapters/grok/usage/`、`G:adapters/kimi/usage/`（或复用 `G:adapters/openaicompat/usage`）；`G:host/aihserver/usage.go`（策略 + ProviderConcurrency）；`G:host/aihserver/composition.go`（`staticCredentialProviders` / RefreshStrategy）；`N:providers/defs/{gemini,grok,kimi}.js`。
- **可验证方式**：`httptest` 固定响应单测覆盖窗口/余额/错误码；gemini 真机 refresh 一次；grok/kimi 本机无账号，只能标「待真机」，不得写成「已验证」。
- **风险**：漏登记 `RefreshStrategy` → `ResolveCredential` 直接 500（已有教训）；grok 账单接口可能只认 API Key（`/models` 对 OAuth 403 已证实）；kimi/grok 无样本，口径无法证伪。

### Slice 4（价值高 / 风险高）：OAuth 作业持久化 + agy 登录迁 Go

- **目标**：把 OAuth Job 从内存 map 落到 `aih.db`（15m TTL、重启恢复、同 Provider 单活），并把 agy 的 Google OAuth 登录流程接进 `accountauth`（refresh 已有），Node 只保留浏览器/CLI 交互壳。
- **为什么现在做**：登录是 Node 剩下的最大单点（14/16 node）；两侧 Job 都在内存（Node 15m TTL，Go `map[string]*jobRecord`），重启即丢，已经是可感知的体验缺陷；agy 是唯一「Go 有 refresh、无 login」的 Provider。
- **涉及文件**：`A:accountauth/service.go`（jobs/activeJobs → store）、`G:adapters/accountauth/agyoauth/`（新增 flow/callback）、`G:transport/http/accountauthapi/`、`G:host/aihserver/composition.go`（Providers 表）、`aih.db` schema/migration、`N:server/web-account-auth.js`、`N:server/oauth-pending-state.js`。
- **可验证方式**：表驱动状态机（start/callback/expire/restart）+ 同 Provider 并发单活；真机 agy 登录一次后查 `account_ui_state.oauth_pending` 与凭据入库，重启 Go 后 Job 仍可查。
- **风险**：回调端口/协议处理器、CLI PTY 交互；agy 六个账号全部 `enabled=0` 且 token 自 2026-10-24 过期，真机验收成本高；Job 表迁移需要回滚方案。

## 5. blockers

### 5.1 账号不可用（本机无可用样本）

| Provider | 现状 | 卡住的能力 | 解除条件 |
| --- | --- | --- | --- |
| agy | 6 个账号 `enabled=0`，token 自 2026-10-24 过期（plan §9） | 额度、模型、relay、登录全部无法真机验收 | 重新授权一个 agy 账号 |
| qoder | 唯一账号是 Free（`total=0`，落 `notApplicable`） | 付费档额度口径、relay 线协议 | 换付费账号，且每轮只打 1–2 次 |
| cline | 两个账号 `enabled=0`（plan §9） | 额度、模型刷新无真机 | 启用一个 cline 账号 |
| kimi / grok | 本机无账号（plan §9） | 额度、模型目录无法验收 | 导入账号（grok 需 API Key 才能发现目录） |

### 5.2 风控与上游限制

| 项 | 现象 | 约束 |
| --- | --- | --- |
| 阿里云验证码（zcode 活动） | 连续解算会把风控分推高，`verifyResult:false` 比例上升 | 同机单次验证间隔数分钟、一天总量克制；活动签到不能当作常规验证手段 |
| qoder 签名请求 | 连续重试上游 500，无法判断是套餐还是协议 | 一次改动只跑 1–2 次；失败先看单测与假 HTTP |
| grok 目录发现 | OAuth 账号打 `GET /models` 返回 403 | Go 只对 API Key 账号开放目录发现（`composition.go` 的 `SupportsCredential`） |
| zcode 活动 | 每个账号过一次无痕验证码，10–20s/账号 | 活动作业必须后台串行；不适合搬进 Go 的同步请求路径 |

### 5.3 协议未知 / 明确走不通

| 项 | 现状 | 结论 |
| --- | --- | --- |
| qoder relay | 传输代码与单测完成，真机 Free 账号 3 次 500 后停手；`decrypt`/`sign` 必须分 wasm 实例，否则 trap；推理端点必须是 `api3.qoder.sh` / `gateway.qoder.com.cn` | 未接线；先用付费账号验证一次，再挂链 |
| zcode 刷新 | OAuth 计划账号无 refresh token，jwt 过期只能重登 | 「zcode token 刷新迁 Go」不是可做项；只能做额度/目录/relay |
| gemini relay | Go 无直连上游；`gemini-*` 模型经 agy 的 Code Assist 服务 | gemini 账号的推理仍是 Node 专属路径（`C:providers/builtins.go:144`） |
| kiro / zcode relay | Go 无上游适配器，`C:providers/builtins.go` 显式 node-only 并带 reason | 需要先写上游协议适配器，不是接线问题 |
| opencode relay | Go 只承接 official API Key；OAuth/free-tier 依赖 Node 客户端 | free-tier 账号不能切 Go（`composition.go` 注释） |
| 会话/PTY/SSH | Go 只有 `aih run` 的前台 PTY（codex/claude，`G:runtime/providercli` + `G:runtime/pty`）；WebUI 终端、持久会话、SSH 远端监督都在 Node（`N:runtime/persistent-session.js`、`N:server/ssh-remote-supervisor.js`） | 宿主级能力，P5 前不建议动 |
| 账号删除 | Go 只删 codex/claude 的凭据 artifact 与投影；进程、tmux、keychain、桌面 hook 仍只有 Node | 「删除迁 Go」必须先把宿主清理定义成可调用契约，否则会留下孤儿进程/凭据 |

### 5.4 结构性阻塞

| 项 | 说明 | 影响 |
| --- | --- | --- |
| OAuth Job 无持久化 | Node Job 在内存（15m TTL，无重启持久化）；Go 也是 `map[string]*jobRecord`（`application/accountauth/service.go:35`） | 切读/切写前必须先落库，否则重启即丢 |
| 公共模型目录仍归 Node | Node 在 `v1-router.js` 把完整投影 `PUT /v1/management/model-catalog` 给 Go；Go 的 `account_models` 只是可路由索引 | 「模型目录迁 Go」要区分「账号级发现」与「公共投影」两条链，不能一次切 |
| 凭据策略必须成对登记 | 每个 Provider 都要有 `RefreshStrategy`，否则 `ResolveCredential` 报「账号凭据刷新策略不存在」，额度 refresh 与后台协调器都 500 | 新增 Go 额度策略时必须同时登记 `staticcredential`（cline/kiro/zcode/qoder 的既有教训） |
| Node 写入仍是账号主入口 | WebUI/CLI 登录、导入、删除仍走 Node，经 `go-account-sync` 15s 对账进 Go | 任何「Go 直写账号」的改动都要考虑与同步器的代次仲裁 |

## 6. 证据边界

- 本矩阵按**代码路径与接线**判定，不以单测通过或计划文档的「已完成」字样替代。
- 未做真机调用；账号状态引用 `docs/plans/2026-11-04-node-go-merge.md` §9 的既有结论，未重新读库核对。
- Node 的 relay 判定以 `provider-protocol-routing.js` 与各 `*-transport.js` 的存在为准；通用网关 `upstream-endpoints-transport-general.js` 覆盖未单列协议的 Provider。
- 若后续新增/删除 Provider 适配器，本表需要同步更新；建议只改对应行，并在提交说明里写明「矩阵哪一格变了」。


## 附：2026-11-05 当日进度

- OAuth 作业快照：Go 持久化（aih.db v17）+ Node 推送 + WebUI 读取回落，已真机验证
  （PUT → 重启 → WebUI 200 recovered=true）。
- qoder 凭据解密 / 模型目录、cline 静态目录、§7 状态转移纯函数均已落 Go。
- 下一批候选：qoder relay 接线（需付费账号验收）、gemini/kimi 额度（本机无可用账号）、
  P3 静态托管、§7-d 读路径切换。

## 附：两个候选切片的复核结论（2026-11-05）

### §7-d 状态读路径切 Go：现在没有收益，先别做

Go 的 `account_ui_state.status` 就是 Node 每轮同步推上去的副本（`lib/server/go-account-sync.js`
的 `syncUIStates`，周期约 15s）。**切读只会把「本进程即时值」换成「≤15s 前的副本」**，
在线/离线判定、可调度性、WebUI 状态条都会引入延迟，语义收益为零。

Node 侧读点（切换时必须逐条改，供以后做「推导迁 Go」时对照）：
- `lib/account/state-service.js:180`、`lib/account/query-service.js:28`
- `lib/server/webui-account-live.js:1268`、`:1561`；`webui-account-routes-state.js:103`
- 热路径：`lib/server/account-selector.js:70`、`lib/account/healthy-account-selector.js:151`、
  `lib/server/accounts.js:415`
- 进程外：`lib/cli/services/usage/account-runtime.js:74`、`profile/list.js:280`

结论：先迁**推导**（§7-c 的 `core/accounts/status_transition.go` 已就绪），再做双读比对，
最后才切读。

### P3 静态托管：`/ui/*` 可以迁，但前置是前门切流

Node 的静态实现很简单（`lib/server/web-ui-router.js` 的 `serveStaticFile`）：读 `web/dist`、
目录补 `index.html`、`/assets/` 或已知扩展名缺失返回 404、其余 SPA fallback、
带内容哈希的资源 `immutable`、其余 `no-store`，无 gzip/ETag。

Go 用 `http.FileServer` + SPA fallback 复刻不难。但当前前门是 Node（9527），
把 `/ui/*` 交给 Go 只会在 Node 上多一跳，**没有收益**；真正该做的是 P4/P5 的前门切流，
到那时静态托管跟着一起搬。

### §7-d 双读比对已就绪（2026-11-05）

- Node 真值：`scripts/status-dual-read-capture.js` 用真实的 `touchAccountFailureState` /
  `clearRuntimeBlock` / `deriveAccountRuntimeStatus` 回放 10 组事件（失败 / 清除 / 整份替换），
  冻结每步结果到 `testdata/status-dual-read.json`。
- Go 执行器：`core/accounts/status_dual_read_test.go` 重放同一组事件，逐步比较
  规范化运行态（逐字段，`DisallowUnknownFields`）与派生状态；当前 10 组 / 20 步全一致。
- 漂移守卫：`test/status-dual-read-fixture.test.js`，Node 行为一变夹具就过期报红。
- 已验证断言有效：把夹具里一个时间戳改 1ms，Go 测试立刻报字段级差异。
- 下一步：把线上账号的真实事件序列接进同一比对（观察期），再切 §7-d 读路径。

### 线上事件接入（2026-11-05）

- Node 生产侧把三类状态事件写成 JSONL：`<aiHomeDir>/observability/status-events.jsonl`
  （失败策略 / 清除证据 / 整份替换），5MiB 轮转、best-effort、`AIH_STATUS_EVENT_JOURNAL=0` 可关。
- `cmd/status-oracle` 是 Go 侧的 JSONL oracle（复用 `ApplyStatusEvent`），
  `scripts/status-dual-read-replay.js` 按账号分组后用 Node 真值与 oracle 逐步比对。
- 用法：`node scripts/status-dual-read-replay.js --fail-on-divergence`（观察期可挂定时任务）。
- 真机链路已验证：合成 journal（2 账号 4 步）→ `divergences=0`。

### 2026-11-05 晚：并行团队合入结果

- **gemini 额度已迁 Go 并接线**（`internal/adapters/gemini/usage`，Node descriptor 改
  `quota.supported:false`；本机账号 enabled=0，§9 待真机）。
- **kimi 额度包已实现但未接线**：Go 侧没有 kimi token 刷新，且 kimi 未登记凭据刷新策略；
  直接接会让过期 token 从「Node 刷新成功」退化成「Go 每次失败」。待刷新迁移后与
  `staticcredential` 一起接。
- **qoder relay 两个接线前缺陷已修**：relaycore 不再丢弃 `TransformResponse` 的 error
  （未写 header → 429/502 JSON；已写 header 流式 → error 帧 + [DONE]）；qoder 对非 2xx
  返回 `false,nil` 交回 Handler 原样转发错误正文。
- **qoder relay 契约测试**：httptest 假上游端到端覆盖 zstd/签名头/umid/推理主机/SSE 拆包/
  非流式聚合/错误信封/非 2xx 原样转发，coverage 76.6%（含 -race）。
- **回归体检**：HEAD 全绿（Go 61 包 / Node 1556 用例）；工作区红点均为当时的在途改动。

### 2026-11-05 深夜：额度面收口（grok）

- **grok 额度迁 Go**：`G:adapters/grok/usage` 注册进 `usageProviderModules`；Node 描述符改
  `goOwnedQuota('grok')`，`GO_QUOTA_OWNERS` 登记 `v1/billing?format=credits`。
- **凭据刷新按既有口径处理**：Go 没有 grok OAuth 刷新实现，grok 与 kiro/zcode/cline 一样登记
  `staticcredential`（声明「永不刷新」）。token 由 Node 的 `token-refresh-daemon`
  （`token-refresh-strategies.js` 的 `grok` 策略）续期，经 `go-account-sync` 推进 Go；
  缺这条策略时凭据解析会直接 `ErrRefreshStrategyNotFound`，额度与 relay 都跑不起来。
- **矩阵同步**：kimi 行一并更正（早已是 Go 采集，此前漏改）；统计表按 16 行重新核对。
- **验证**：`go test ./internal/adapters/grok/usage/...`、
  `go test ./internal/host/aihserver -run TestUsageProviderRegistryCoversExpectedProviders`、
  `node --test test/quota-ownership.test.js` 全绿。
- **待真机**：本机无 grok 账号（§5.1），额度采集只能用 httptest 固定响应验证，不能写成「已真机验收」。
