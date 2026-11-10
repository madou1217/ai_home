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
| **agy** | `both` `G:adapters/accountauth/agyoauth/login.go`（Google 直连固定走 Go）· `N:server/oauth-strategies/agy.js`（仅 native-cli）· Go 刷新 `G:adapters/accountauth/agyoauth/refresh.go` | `go` `G:adapters/agy/codeassist` · `N:providers/defs/agy.js`（只读 Go） | `go` `G:adapters/agy/usage`；`N:providers/defs/agy.js` quota=false | `go` `G:adapters/agy/codeassist`（canonical；Node 侧 tombstone `N:server/agy-cli-transport.js` 已于 2026-11-06 删除） | `node` `N:account/account-removal.js` | `none` | `node` `N:runtime/client-terminal.js` |
| **claude** | `go` `G:adapters/accountauth/claudeoauth`（浏览器登录固定走 Go；Node 策略已删除） | `go` `G:adapters/claude/messages` · `N:providers/defs/claude.js`（只读 Go） | `both` `G:adapters/claude/usage` · `N:usage/provider-usage/claude.js` | `both` `G:adapters/claude/messages` + `G:transport/http/claudenativerelay` · `N:server/provider-protocol-routing.js` | `both` `G:adapters/accounts/deletionprojection` · `N:account/account-removal.js` | `none` | `both` `G:adapters/claude/clilaunch` + `G:runtime/providercli` · `N:runtime/client-terminal.js` `N:runtime/acp-layouts.js` |
| **cline** | `node` `N:account/cline-credentials.js` `N:account/cline-native-credential-sync.js` | `go` `G:adapters/cline/modelcatalog`（静态清单）· `N:providers/defs/cline.js`（只读 Go `account_models`） | `go` `G:adapters/cline/usage`；`N:providers/defs/cline.js` quota=false | `both` `G:transport/http/clinerelay` · `N:server/upstream-endpoints-transport-general.js` | `node` `N:account/account-removal.js` | `none` | `node` `N:runtime/acp-layouts.js`（ACP 已登记） |
| **codebuddy** | `node` `N:server/oauth-strategies/codebuddy.js` | `go` `G:adapters/codebuddyfamily/modelcatalog` · `N:providers/defs/_shared/codebuddy-family.js`（只读 Go） | `go` `G:adapters/codebuddyfamily/usage`；`N:providers/defs/_shared/codebuddy-family.js` quota=false | `both` `G:transport/http/codebuddyfamilyrelay`（仅 chat_completions）· `N:server/upstream-endpoints-transport-general.js` | `node` `N:account/account-removal.js` | `none` | `node` `N:runtime/acp-layouts.js` |
| **codebuddycn** | `node` 同上（同 `_shared` 描述符） | `both` 同上 | `go` `G:adapters/codebuddyfamily/usage` | `both` 同上 | `node` 同上 | `node` `N:account/activity-claim/workbuddy-daily.js` | `node` 同上 |
| **codex** | `go` `G:adapters/accountauth/codexoauth`（浏览器登录固定走 Go）· `N:server/oauth-strategies/codex.js`（仅 oauth-device 启动参数） | `go` `G:adapters/codex/responses` · `N:providers/defs/codex.js`（只读 Go） | `both` `G:adapters/codex/usage` · `N:usage/provider-usage/codex.js` | `both` `G:transport/http/codexresponseshttp` + `G:transport/http/codexresponsesws` · `N:server/codex-adapter.js` | `both` `G:adapters/accounts/deletionprojection` · `N:account/account-removal.js` | `none` | `both` `G:adapters/codex/clilaunch` + `G:runtime/providercli` · `N:runtime/client-terminal.js` `N:runtime/acp-layouts.js` |
| **gemini** | `node` `N:server/oauth-strategies/gemini.js`（OAuth 登录已在描述符停用；刷新 `N:server/gemini-token-refresh.js` 仍在 Node） | `go` `G:adapters/gemini/modelcatalog` · `N:providers/defs/gemini.js`（只读 Go） | `go` `G:adapters/gemini/usage`（`retrieveUserQuota`）；`N:providers/defs/gemini.js` quota=false | `node` `N:server/upstream-endpoints-transport-code-assist-gemini.js`（**provider 已 `GatewayDeprecated`**，只服务遗留账号/API Key；不迁） | `node` 同上 | `none` | `node` `N:runtime/acp-layouts.js` |
| **grok** | `node` `N:account/grok-auth-profile.js` + 通用 CLI 登录作业 | `go` `G:adapters/openaicompat/modelcatalog`（仅 API Key）· `N:providers/defs/grok.js`（只读 Go） | `go` `G:adapters/grok/usage`；`N:providers/defs/grok.js` quota=false（token 由 Node 刷新守护进程续期） | `both` `G:transport/http/grokrelay` · `N:server/upstream-endpoints-transport-general.js` | `node` 同上 | `none` | `node` `N:runtime/client-terminal.js` |
| **kimi** | `node` `N:account/kimi-auth.js` + 通用 CLI 登录作业 | `go` `G:adapters/openaicompat/modelcatalog` · `N:providers/defs/kimi.js`（只读 Go） | `go` `G:adapters/kimi/usage`；`N:providers/defs/kimi.js` quota=false | `both` `G:transport/http/kimirelay` · `N:server/upstream-endpoints-transport-general.js` | `node` 同上 | `none` | `node` `N:runtime/acp-layouts.js` |
| **kiro** | `both` `G:adapters/accountauth/kirooauth/login.go`（Builder ID 设备码固定走 Go，含 GetUsageLimits 身份证据）· `N:account/kiro-device-login.js`（CLI `--device-code`、Google/GitHub social 设备流、refreshToken 导入） | `go` `G:adapters/kiro/modelcatalog` · `N:providers/defs/kiro.js`（只读 Go） | `go` `G:adapters/kiro/usage`；`N:providers/defs/kiro.js` quota=false | `go` `G:transport/http/kirorelay`（CodeWhisperer event-stream + 事务刷新）；仅原生凭据 | `node` 同上 | `none` | `node` `N:runtime/client-terminal.js` |
| **opencode** | `go` `G:adapters/accountauth/opencodeoauth`（Console 设备码；Node 策略已删除） | `go` `G:adapters/opencode/modelcatalog`（Zen + Go 双腿）· `N:providers/defs/opencode.js`（只读 Go `account_models`） | `none` 两侧均无额度接口（`C:providers/builtins.go` 未声明 quota，Node quota=false） | `both` `G:transport/http/opencoderelay`（仅 official API Key）· `N:server/opencode-free-cli-transport.js` | `node` 同上 | `none` | `node` `N:runtime/acp-layouts.js` |
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
9. **WebUI 额度统计（`/v0/webui/accounts/:provider/:ref/quota-stats`）卡在成本口径（2026-11-06）。**
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
10. **推理前门其实已经划转，但本机流量全部交还 Node（2026-11-06 实测）。**
    manifest 里 15 个 gateway 条目全部是 `go_owned`，Go core ready 并持有 13 条路由；
    `/readyz` 的 `go_core.node_fallbacks` 可用于判断「Node 还在承接多少已划转路由」。实测：
    - 一次 `/v1/chat/completions`（model=glm-5.3-flash）走完 Node 的 zcode 重试（3 个账号
      `1005 exceed quota limit`）后落到 codebuddy 账号成功返回；
    - 同一请求前后 `usage_ledger` 保持 1 行不变，`node_fallbacks.total` +1，
      原因从 `custom_upstream_node_only` 1→2。
    结论：**本机账号大多是自定义上游（proxy.meadeo.com 这类 base_url）**，而
    `explainGoRouteDeferral` 对 custom upstream 一律交还 Node（Node 负责 403/404 与池回退语义），
    所以「Go 已划转推理」在这套部署上等于「一条也不走 Go」，`usage_ledger` 因此长期为空，
    依赖它的额度统计切流也就无从谈起。
    解锁条件：要么 Go 承接 custom upstream 的生命周期与错误语义，要么承认这类账号的用量
    继续由 Node 记账、额度页继续按两路合并。不要再拿「路由表已 go_owned」当作
    「Go 在承接流量」的证据——判据只看 `node_fallbacks` 与 `usage_ledger`。

10c. **custom upstream 交还 Node 是**池级**决定，本机因此 100% 交还（2026-11-06 复核）。**
    `poolHasCustomUpstreamAccount` 只要池里**任意一个**账号是自定义上游，整条入口就交还 Node；
    代码注释写明理由：未钉选请求可能回落到池里任意 Provider 的账号，而划转后 Go 没有 Node 回落。
    本机实测：43 个账号里只有 4 个是自定义上游（codex 1 / claude 2 / gemini 1），
    其余 39 个（zcode 8、codebuddy 7+5、kiro 5、agy 6、cline 2…）都是官方端点——
    **却因为那 4 个账号，全部推理都留在 Node**。

    要把这 39 个账号的流量交给 Go，只能走「Go 能给自定义上游账号做透传」：
    1. Go 有一个账号级 `routing_excluded`（或 `passthrough`）事实，不进核心账号实体，
       放侧表 + 管理端点；
    2. Node 把 custom upstream 账号标上，Go 的路由索引与推理目录都跳过它们，
       这样「Go 可调度集合」里不再有它服务不了的账号；
    3. 池级判定改成看「Go 可调度集合」，而不是「池里有没有自定义上游」；
       模型只被自定义上游账号承载时，Go 目录本来就不会列它，走 `model_not_routable` 交还。

    **2026-11-06 已落地并真机验证**（`18de34f0` + `694e8f2c`）：
    - Go schema v25 `account_routing_exclusions` + `PUT /v1/management/accounts/{ref}/routing`；
      倒排索引建索引时排除，路由候选与目录同源；
    - Node 同步推 4 个 custom upstream 账号（codex 1 / claude 2 / gemini 1），签名去重；
      池级 `custom_upstream_node_only` 删除（钉选分支保留）；
    - 真机：`/v1/chat/completions` 的请求由 **Go** 承接，`usage_ledger` 1 → 5 行，
      `node_fallbacks` 只剩 `go_not_forwarding` 1 次（启动窗口）；
    - 同时修掉 Go 承接后暴露的响应保真度回归：Anthropic 上游转 OpenAI 的非流式与流式
      两条路径（model 回落请求模型、content、tool_calls、usage、[DONE]）。

    **2026-11-06 收尾：排除判据从「自定义上游」改成「Go 服务不了」**（`42c75940`）。
    - 自定义上游的 codex/claude 走 canonical 通道，适配器会用账号自己的 base_url → 交给 Go；
      只有「自定义上游 + 仅 relay 通道」才排除（relay 端点是发行版硬编码）。
    - 每进程首圈强制对齐排除表：排除是派生事实，重启后旧 `excluded=1` 必须被清掉。
    - 池门判据从「承载者全为 relay」改成「承载者全为 Go 可服务」——否则池里有一个
      gemini 账号就把 claude/codex/agy 的 canonical 模型全留在 Node。
    - 真机：`/v1/models` 回到 **205**（claude 17 / gpt-codex 17 / gemini 21）；
      `claude-sonnet-4-6` 请求由 Go 承接，`usage_ledger` 5 → 6；
      排除表只剩 1 个账号（gemini 占位账户：`VERTEX_AI_PLACEHOLDER=true`、base_url 指向
      本机 9527，本身没有真实上游）。
    - 钉选请求（`x-account-ref`）命中自定义上游时，canonical 通道也已交给 Go
      （`66e2838f`）：CLI 启动路径大量使用钉选，留在 Node 会让这批流量永远走不到 Go。
      只剩 relay 通道的自定义上游钉选仍在 Node（端点硬编码）。
      顺带修掉一个真机 400：Node 渲染 `custom_tool_call` 时沿用上游的 `fc_` id，
      客户端回传后上游按类型校验前缀（expected `ctc`）；Go 的 codex 编码器不发 item id，
      这条链路天然免疫。

10b. **`/healthz` 与 `/readyz` 应该保持 Node 所有（2026-11-06 复核）。**
    真机对比：两侧 `/healthz` 都是 200 且 body 除空白外一致；`/readyz` 都是 200，
    但 `accounts` 计数来自各自的库（Node: codex 1/gemini 1…，Go: agy 0/cline 2/codebuddy 7…）。
    即使 body 一致也**不该划转**：Node 是 Go 的监督者，若把 liveness 代理到 Go，
    Go 挂掉会让 Node 的 `/healthz` 失败，编排器进而重启 Node——把「子进程故障」
    放大成「整机重启」，且反过来杀掉 Go。这是依赖倒置，不是迁移进度问题。
    `/readyz` 的 `accounts` 字段还存在数据归属分叉，真要划转得先统一个数源。
12. **别名（model alias）所有权正在迁 Go（2026-11-06）。** 详见
    `docs/plans/2026-11-06-model-alias-ownership.md`。已完成：Go 侧 schema v22/v23
    （model_alias + generation + display_models_json）、仓储端口与落库、启动恢复、
    CRUD 用例、`/v1/management/webui/model-aliases` 契约接口、写入后立即触发目录重建、
    Node 侧影子对账（只读，不改变响应）。真机已验证：推送落库、重启恢复、CRUD 全链路 200。
    已完成（2026-11-06）：组替换（`/replace`）、目标候选（`/targets`）、目标存在性校验、
    以及**切片 C：写入口切到 Go**（Go Core 可用时列表与五个写操作全走 Go，Node 只维护
    读投影；`/targets` 仍由 Node 算）。既有 9 条 Node 路径测试原样通过，另有 8 条 Go 归属
    用例与 1 条真机用例（默认跳过）。
    待办：**重启 Node 后真机验收六个操作**；在那之前线上仍走旧实现。
13. **控制面设备接口是 Node 侧新增的只读面（2026-11-06）。**
    /v0/node-rpc/device-{status,nodes,accounts,sessions,node-sessions,session-messages,node-session-messages}
    此前前端在调、后端从来没实现，导致 WebUI 连接页永远停在 404。现已用 Management Key 鉴权补齐，
    数据来自 Node 的 state / 运行时会话库。**它不是迁移产物**：等账户与会话面迁到 Go 之后，
    这些接口应当改为读 Go，届时 Node 只保留路由壳。
    真机：status/nodes/accounts/sessions 均 200，会话消息按 detail.role 映射后同一会话 9 条。

11. **删除的 `both` 只覆盖 codex/claude。** Go 的 `deletionprojection` 只处理这两家的凭据 artifact 与投影（`G:adapters/accounts/deletionprojection/resources.go` 按 provider 分支），进程/tmux/keychain/桌面 hook 仍只有 Node 有。

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

### 5.5 Chat relay 能力快照缺陷（2026-11-09，机制已修；UI 模型落库待补）

| 项 | 内容 |
| --- | --- |
| 现象 | 模型只由 relay Provider 承载的聊天会话，轮次实际由 Go 执行；但前端拿到的能力快照仍是旧 Node codex 驱动的上限，会显示 Go 轮次不产出/不执行的入口（tools、approval、reasoning、plan 等）。请求本身能成功，属于 **UI 语义与真实能力不一致**。 |
| 根因 | `lib/server/chat-runtime-composition.js` 在 chat 分支统一传 `capabilities: codexCapabilities(runtime)`；`lib/server/chat-runtime/capability-routed-driver.js` 的 `createCapabilityRoutedChatDriverEntry` 把它原样作为会话级快照返回。`lib/server/chat-runtime-actor-registry.js:168` 在 actor 解析时取一次，之后不随轮次重建。 |
| 为什么不能按模型简单切 | 同一会话可以在 canonical / relay 模型之间切换；按「当前模型」生成快照会在切模型后立即过期，而 TurnLifecycle 与前端都把 `capabilitySnapshot` 当会话级只读。 |
| 影响面 | `web/src/features/chat-runtime/composer-policy.ts` 与 `use-composer-controller.ts` 按快照渲染 `turn.steer`、`turn.queue`、`slashCommands`、审批与工具入口；Go 轮次只产出 timeline 文本增量，没有 reasoning 条目、工具调用、plan 与 compact。 |
| 为什么当时不修 | 改成「按会话当前模型选快照」只是把过期点从切模型前移到切模型后；正确做法需要把能力拆层并让投影随路由目标刷新，牵动前端与 actor 生命周期，超出该切片。 |
| 修法方向 | 能力快照拆成「会话级静态能力 + 逐轮路由目标能力」两层：静态层保留队列/中断等 Node 侧真实能力，路由层由本轮 driver 提供；或让 `capabilitySnapshot` 随模型变更重建 actor/投影，并由前端隐藏 `support=unsupported` 的条目。 |
| 修法（2026-11-09） | `createCapabilityRoutedChatDriverEntry` 增加 `capabilitiesFor(session)`：复用 `resolveChatTurnRoute` 只看当前 `policy.model` 与账号索引（附件/slash 是逐轮输入，不参与能力判定），Go 路由返回 `goChatCapabilities` 的保守子集（slash 仍由 Node 承接，命令清单沿用 canonical）。actor registry 的 record 保留求值函数，`getCapabilities` 每次按库里最新 policy 求值后 `structuredClone`，actor 不重建；`ChatRuntimeService.getSnapshot`/`getCommandCatalog` 在 actor 存在时覆盖持久化快照，前端从 `/snapshot` 读到的是当前路由能力。 |
| 验收判据 | relay-only 会话不显示 tools/approval/reasoning/plan 等 Go 不产出的入口；切回 canonical 模型后这些入口恢复；请求结果与事件流不受影响。 |
| 当前边界（2026-11-09） | WebUI 聊天流程的模型仍随 `turn.submit.payload.model` 逐轮下发，`session.policy.model` 默认不落库；因此快照按模型切换的能力只在 policy 里有 model 时生效（UI 里尚未把模型选择写成 `session.policy.set`）。服务重启后、actor 尚未建立的只读打开仍退回持久化快照，首次 dispatch 建立 actor 后纠正。 |

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

### 2026-11-09：登录 / 聊天 / 工具设置三条切片

- **kiro Builder ID 设备码登录迁 Go**（`370e87f1`）：`G:adapters/accountauth/kirooauth/login.go`
  走 AWS SSO OIDC registerClient → startDeviceAuthorization → createToken 轮询，并用
  GetUsageLimits 的 userInfo.userId 生成 identityEvidence；artifact 同时带 auth_kv 的
  `database`（base64 sqlite），否则 Node 启动链路会判 missing_projection。WebUI 固定走 Go
  设备码作业；CLI `--device-code` 与 Google/GitHub social、refreshToken 导入仍在 Node。
  真机：begin 201（user_code + view.awsapps.com），cancel 200。
- **WebUI Chat turn.submit 接 Go**（`4eaac584` + `7be119d3`）：Node 保留会话/队列/202+独立 SSE，
  轮次推理按**能力**路由——只有模型候选 Provider 在 chat_completions 入口都是 relay 通道时才走
  Go 内部入口 `POST /v1/management/webui/chat/sessions/{id}/commands`；canonical（codex/claude/
  agy/gemini）、附件、slash/compact 仍走旧 Node 驱动。Go 承接账号征召、上游请求、改流、失败
  分类与用量记账。已知缺陷：relay-only 会话的能力快照仍沿用 codex 上限（UI 会显示
  reasoning/tools，但 Go 轮次不产出这些事件），根因、影响与修法见 §5.5。
- **应用启动权限设置 GET 切 Go**（`c3b88b7d`）：`GET /v1/management/webui/tool-apps/{appId}/settings`
  直接读 app-state.db 的 `toolkit:tool-permission-settings` 并组装 capability/权限目录；Node
  GET 固定代理，PUT 仍留 Node（宿主配置写入依赖 Provider 配置工作台）。真机 200；未登记 app 400。
- **账号额度重置历史 GET 切 Go**（`fb601436`）：`GET /v1/management/webui/accounts/{provider}/{ref}/quota-reset-events`
  由 Go 直接读 Node 的 app-state.db（`account_quota_reset_events`），并用同一份库的
  `account_refs` 校验账号归属；Node 路由改为代理，无本地回退。特意不复用 Go 的 accounts 表做
  存在性校验——真机 13 个事件账号里有 4 个不在 Go 账号投影中，用 Go 表会误判 404。
  真机：200（真实事件）/ 404（未知 ref）/ 401（无密钥）。
- **别名池设置 GET 切 Go**（`62d65d0c`）：`GET /v1/management/webui/accounts/{provider}/{ref}/alias-pool`
  读取 app-state.db 的 `account:alias-pool:<ref>`，并用同一份库的 `account_refs` 校验归属；
  POST（写设置 + 运行池重载）仍在 Node。顺手抽出共享只读包 `internal/adapters/appstate`
  （只读打开 / app_kv / 账号归属），并删除 Node 里已被 Go 取代的 `listAccountQuotaResetEvents`。
  真机：显式 false → 200、无记录 → true、Provider 不匹配 → 409、未知账号 → 404、无密钥 → 401。
- **WebUI 终端切 Go**（`59311dfb`）：`open/attach/mux/input/resize/close` 六端点 + clipboard-image
  全部由 `G:transport/http/webuiterminalapi` 驱动真实 PTY；Node `webui-terminal-routes` 只做管理密钥后的
  反代，删除了 terminal-output-batcher / replay / persistence / clipboard 四个 Node 模块；tmux 持久化
  socket 语义原样搬到 Go。真机：open → input `echo A11H_OK` → mux 收到输出 → close 全 200。
  边界：Go Core 未就绪时终端一律 503（无 Node 本地回退）。
- **插件信任根切 Go**（`df9626ef`）：`GET /v1/management/plugins/trusted` 与 `POST .../trust|untrust`
  读写 `<aiHomeDir>/plugins/trusted-keys.json`（SPKI PEM 归一、keyId=sha256 前 24、0600/0700、原子写）；
  Node 三路由改代理并保留 audit；CLI `aih plugin trust` 仍直写同一文件。真机 trust→list→untrust 通过。
- **Chat 能力快照机制修复**（`d4175129`）：能力按当前 `policy.model` 的路由目标动态求值，`/snapshot`
  与命令目录都读动态值；真实 UI 仍需把选中的模型写进 `session.policy.set` 才能完整生效（见 §5.5）。
- **插件安装/卸载切 Go**（`c42d2c02`）：`G:adapters/pluginartifact` 解析 .aih-plugin、逐文件 sha256、
  Ed25519 签名与信任根、清单校验（schema 由 `contracts/plugins` 生成）；`G:adapters/pluginstatestore`
  在 maintenance 读租约下对 app-state 的 `plugins.control.v1` 做 CAS 写入并保留未建模字段；
  `G:transport/http/plugincontrolapi` 暴露 install/uninstall；Node 两路由改代理，audit 仍 Node。
  已知收窄：内置 JSON Schema/semver 子集，插件 configSchema 用到未实现关键字会 fail closed。
- **插件 enable/disable 状态写入切 Go**（`447bf882` + `2939883e`）：Node 保留 runtime 的
  prepare→commit→activate 编排；Go 新增 `POST /v1/management/plugins/state/commit`，按候选原文做
  CAS + 结构/operation 边界校验（enable/disable 不得改 installed、install 不得改 instances 等），
  并在 maintenance 租约下原样落盘。Node `state-store.commitRemote` 固定调 Go，Go 不可用即
  `plugin_state_unavailable`，不本地兜底写。候选语义（configSchema、权限指纹）仍在 Node。
- **插件 enable/disable 入口切 Go**（`489dedd3` + `8481131f` + `c768ac3b`）：Go 新增
  `POST /v1/management/plugins/instances/{id}/enable|disable`，按「读 revision → Node prepare 票据 →
  Go CAS commit → Node activate」编排；Node `/v0/plugins/enable|disable` 改为代理，内部
  prepare/activate/discard 只接受回环 + 引导密钥，30s TTL 单发布锁。Node 侧不保留本地写入兜底。
  同日删除 `control.install/uninstall` 的本地实现（安装/卸载唯一写者已在 Go），控制面只剩
  enable/disable、诊断与期望状态；`state-store.update` 仅作为无 Go 依赖的单测回退保留。
- **会话框大段粘贴阈值 GET 切 Go**：Go 新增 `GET /v1/management/webui/chat/paste-settings`，
  只读 app-state.db 的 `config:server`（与 `aih server config set --large-paste-chars` 同键），
  默认值/上下限与 `contracts/chat-attachments.json` 同源；Node GET 固定代理、Go 不可用 503，
  POST（写配置）仍在 Node。
- **全局用量配置 GET 切 Go**：Go 新增 `GET /v1/management/webui/config`，只读 app-state.db 的
  `config:usage`，复刻 Node `normalizeConfig`（间隔白名单、阈值 1..100、自动换号开关与剩余
  百分比夹取）；Node GET 固定代理、Go 不可用 503，POST 写配置仍在 Node。
- **SSH 连接/工作区/终端状态 GET 切 Go**：Go 新增 `GET /v1/management/webui/ssh-connections`、
  `GET /v1/management/webui/ssh-workspaces` 与 `GET .../ssh-workspaces/sessions`。连接列表只读
  `ssh_connections` 并复刻 Node 脱敏（password/privateKey 有值 → `******`，无值 → 空串，其它
  字段含 identityFile 与未知字段原样保留）；工作区列表只读 `ssh_workspaces`，`ws_<16hex>`
  远端工作区补 `run/remote-workspaces/<id>` 影子目录；终端状态在 Go 内按 `remote-ws:<id>`
  探测同一个 tmux store，不再由 Node 逐个 workspace 发 N 次请求。Node 三条 GET 固定代理、
  Go 不可用 503，增删改与终端创建仍在 Node。
- **server 配置 GET 切 Go**：Go 新增 `GET /v1/management/webui/server-config`，只读
  app-state.db 的 `config:server`，复刻 Node `sanitizeServerConfig` 的默认值/夹取/归一化，并按
  `toPublicServerConfig` 隐藏 apiKey/managementKey（保留 configured 标志）。两侧共用
  `test/fixtures/server-config-sanitize-cases.json` 对拍；Node GET 固定代理、Go 不可用 503，
  POST 写配置仍在 Node。
- **toolkit 执行目标 GET 切 Go**：Go 新增 `GET /v1/management/webui/toolkit/environments/targets`，
  只读 `ssh_connections`，复刻 Node `listToolkitTargets`：固定本机目标 + 仅保留
  `conn_<16hex>` 的 SSH 连接，`label` 回落 `host`，展示为 `user@host`。Node GET 固定代理、
  Go 不可用 503；本地 `listToolkitTargets` 已删除，远端执行仍在 Node。
- **账号配置文件查看 GET 切 Go**：Go 新增 `GET /v1/management/webui/accounts/{provider}/{ref}/config-files`，
  读 `account_credentials` 与 `run/auth-projections/<provider>/<ref>`，候选路径由 Go 的 Provider
  合同（`core/providers`）+ 与 Node 相同的凭据布局生成。脱敏：JSON/JSONC 结构遍历逐键匹配
  （与 Node 的 `redactConfigContent` 共用夹具对拍），TOML/YAML/INI 走保守行级脱敏（不解析
  重排、绝不返回未脱敏秘密值），SQLite 导出 key/value 表，kiro 的 base64 `data.sqlite3` 解码
  成 JSON 视图。Node GET 固定代理、Go 不可用 503；Node 侧 `account-config-view.js` 与其测试已删除。
- **基线注意**：HEAD 树缺 `internal/adapters/accounts/nativeaccount/cline_document.go`（主工作区
  为未跟踪文件，另一条线 WIP），从 HEAD 新建 worktree 全量 `go build ./...` 会红在
  `deletionprojection/credential.go:540`；本次未修、未提交该文件。
