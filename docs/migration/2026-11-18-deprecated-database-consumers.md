# 废弃业务数据库消费者清理 — 2026-11-18

本轮目标是找全仍访问废弃 AIH 业务库的入口，并分派 10–20 个子代理迁移。
共派出 12 个不同子代理，受运行环境限制最多同时运行 3 个。
实际检查与修改超过用户要求的 10 分钟；不能把后续完成时间记作按时完成。

## 责任会话与当前状态

下列状态通过 Codex app server 的实际 thread 读取核实；历史标题不作为在运行的证据。

| 范围 | 会话 | 本轮观察 |
| --- | --- | --- |
| 原 W0–W6 / Codex 与本地 WORK 迁移 owner | `01a1d99a-db6e-7d82-b2ba-90fe5fb41e23` | `notLoaded`，最新读取 turn 为 completed；原迁移账仍明确全 W0–W6 未完成 |
| 后续监督 | `01a1df63-a386-76d0-9acf-025e5a07582d` | `notLoaded`，最新读取 turn 为 completed |
| single business DB 原实现 | `01a1dd2b-7f02-7922-87d2-cfa278ed2fe3` | `notLoaded`；其最后回执明确当时仅完成副本迁移，未激活 live |
| single DB 原协调 | `01a1db81-6373-7ba0-9fae-5fde28efad17` | `notLoaded`，最新读取 turn 为 completed |
| 本机切库/标准构件修复接续 | `01a1dd52-79e3-73d3-b500-5edfe47c0ca4` | `notLoaded`；既有单库切换报告记录了本机激活和后续构件修复 |

原验收只覆盖部分客户端和正常服务入口，未把维护、诊断、对账脚本全部纳入。
因此服务已切到单库后，这些脚本仍能默认读取封存时刻的旧数据；来源标签和大量旧注释
又继续描述双库。此次清理补上这些入口，不把它称为整个 Node→Go 迁移完成。

## 实际数据库与进程

本轮现场为本机 `/Users/model/.ai_home`，不是 AWS 或其它安装目录的验收。

- `aih.db`：975,486,976 bytes，63 张表；canonical accounts / credentials 为 34 / 34。
- 同一文件中的兼容投影 account_refs / compat_account_credentials 为 32 / 32。
  两组数量来自不同表的职责，不代表两份数据库；本轮不据数量声称投影完全一致。
- `app-state.db`：914,698,240 bytes，35 张表，保留封存数据。
- 两文件的 `app-state-to-aih-v1` 回执一致；旧库有 96 个含写入拒绝的封存触发器。
  本轮只读检查触发器，不在真实旧库尝试写入。
- `ai-home.db`、`model-usage.db` 均为 0 bytes；未发现代码将它们作为默认业务库。
- 重启前 Go PID 31835 与 Node 进程持有同一 `aih.db` inode 的业务连接；
  本轮标准重启后 Go PID 为 84956、受监督 Node 子进程为 85251，业务连接仍指向 `aih.db`。
- `/readyz` HTTP 200 / ready=true；认证后的 management accounts 与 WebUI accounts
  都返回 34 个账号，WebUI projects 返回 18 个项目。

### 旧库长期 FD 的真实原因

首次 `lsof` 没显示旧库，后续观察到旧库及 WAL/SHM 的长期只读 FD。
仅根据这些路径推断“两组数据库连接”是错误的；`lsof -nP +fg -p 31835`
显示这些 FD 全部为 `R,EVO;CX`，即 macOS `O_EVTONLY` 文件事件监听。

已用同一安装二进制、随机私有认证和无真实凭据的临时数据库复现：

1. 启动且没有 SSE 时，无旧库 FD。
2. 打开 `/v1/management/webui/accounts/watch`，HTTP 200 后出现旧库、WAL/SHM、
   两个 0-byte 旧文件的 `R,EVO;CX` FD。
3. 源码 `webuiaccountliveapi.Hub.watchTargets()` 监听 AIH 数据根；fsnotify 的
   Darwin backend 使用 `O_EVTONLY | O_CLOEXEC` 并对目录所有 child 建立监听。
4. 私有 SSE 关闭、私有服务通过自己的关闭端点正常退出 0；共享进程未收到信号。

因此这些长期句柄不是 SQLite 业务查询的证据。迁移门禁仍会短暂只读旧库 seal；
这是下面明确列出的保留行为。SSE 关闭后 0.5 秒句柄仍在，未声称监听立即回收。
标准构件更新后再次以无凭据私有实例复现该行为，实例正常退出 0；
共享服务重启后抽查 Go 及其直接子进程，5 个旧库相关 FD 全为事件监听，未见非 EVO 旧库 FD。
FD 数量随订阅变化，此数值只记录本次采样。

## 修改范围

共修改 39 个源码/脚本文件，另新增本报告；没有新增测试用例。

| 类别 | 已完成的迁移 |
| --- | --- |
| Node 业务读取 | 4 个 Go account reader、runtime reader、账号模型补全统一走 getBusinessDatabasePath；迁移门禁失败明确向上传递 |
| 运维脚本 | prune、backfill、AWS AGY verifier 默认读唯一 aih.db；显式离线源保持只读 |
| 对账脚本 | model aliases、WebUI accounts、account rows、usage ledgers、token usage、quota stats 默认读 aih.db |
| 聊天诊断 | 5 个 browser 诊断入口、chat-e2e-turn、gateway-account-auth-smoke、real-codex-smoke 及 web e2e metrics 去掉旧库路径 |
| 统一根目录 | JS 默认路径调用 resolveAiHomeDir，覆盖 AIH_HOME_DIR / AI_HOME / AIH_HOST_HOME；显式离线参数仍优先 |
| 配置读取 | 新 scripts/lib/business-database-reader.js 只读配置，缺失/非法 JSON/缺密钥明确报错，不输出密钥 |
| 显示来源 | Node 账号/状态/用量/5 类 token refresh 与 Go AGY metadata、账号凭据配置详情显示 aih.db |
| 安装器 | canonical 存在或路径异常时不再回退 app-state.db / server-config.json；坏配置、缺密钥、坏链接、非法端口明确失败；8 个使用点先处理配置错误再探测/停止/验证服务 |

Go 凭据用 canonical 表，Node 兼容凭据用 compat_account_credentials。修复 backfill 的
离线旧 links 可能覆盖有效 canonical ref 的问题：
先保留已存在原 ref，再使用 canonical links，最后仅接受仍存在的离线源映射候选。

### 完整文件清单

```text
internal/adapters/agy/authmeta/metadata.go
internal/transport/http/webuiaccountconfigapi/service.go
internal/runtime/distributioninstall/health.go
internal/runtime/distributioninstall/install.go
internal/runtime/distributioninstall/service.go
internal/runtime/distributioninstall/stop.go
internal/runtime/distributioninstall/recovery_health.go
lib/account/go-bridge/go-account-store-reader.js
lib/account/go-bridge/go-runtime-state-reader.js
lib/cli/complete/candidates.js
lib/server/accounts.js
lib/server/agy-token-refresh.js
lib/server/claude-token-refresh.js
lib/server/codex-token-refresh.js
lib/server/grok-token-refresh.js
lib/server/kimi-token-refresh.js
lib/account/agy-auth-metadata.js
lib/cli/services/account/status.js
lib/cli/services/usage/snapshot.js
lib/cli/services/usage/usage-snapshot-codex.js
scripts/prune-usage.js
scripts/backfill-usage-ledger.js
scripts/verify-aws-agy-migration/main.go
scripts/compare-model-aliases.js
scripts/compare-webui-accounts.js
scripts/compare-account-rows.js
scripts/compare-usage-ledgers.js
scripts/parity-token-usage.js
scripts/compare-quota-stats.js
scripts/chat-approval-restored.js
scripts/chat-runtime-diagnose.js
scripts/chat-switch-model.js
scripts/chat-selector-inspect.js
scripts/chat-approval-switch.js
scripts/chat-e2e-turn.js
scripts/gateway-account-auth-smoke.js
scripts/chat-runtime-real-codex-smoke.js
scripts/lib/business-database-reader.js
web/scripts/e2e-chat-metrics.cjs
```

## 旧库迁移逻辑已删除

2026-11-18 后续按单库要求删除了离线 db-unify 与所有运行时旧库门禁：

- 删除 `cmd/aih-db-unify` 与 `internal/runtime/dbunify`（迁移、封存、回执、触发器）。
- `businessdb` 不再定义 `LegacyFileName`/`MigrationID`/`SealTable`；`CheckReady` 只接受非空数据库路径。
- `distributiondata` 只准备、备份、核对 `aih.db`，不再复制、封装或合并旧库。
- `distributioninstall` 的数据备份、发布和健康检查只认 `aih.db`；已删除 legacy idle 探测。
- `lib/server/business-database.js` 只返回 `aih.db`，不再读旧库回执。

仍保留的只有历史注释、错误文案、测试夹具和离线对账/backfill 工具中操作者显式传入的历史材料路径；它们不参与默认业务开库。
provider 原生 Kiro / OpenCode / CodeBuddy / WorkBuddy / ZCode / Codex state/history/log/goals
数据库与 run/maintenance/access.sqlite 的文件锁协调数据不属于 AIH 业务数据库迁移。

## 子代理分派回执

| 序号 | 任务名 | 结果 |
| --- | --- | --- |
| 1 | db_core_paths | 核验中央路径与 seal gate；真实临时 SQLite 四状态通过，无需改中央模块 |
| 2 | db_go_audit | Go 路径审计，修复 2 处来源标签 |
| 3 | db_node_consumers | 修复 Node reader / completion 门禁 |
| 4 | db_scripts_operations | 维护/backfill/AWS verifier 迁移；真实临时库写入验证 |
| 5 | db_compare_scripts | 五个对账入口默认路径迁移与只读验证 |
| 6 | db_source_labels | 修复 10 个 Node 文件的旧库来源标签 |
| 7 | db_chat_scripts | 八个聊天相关脚本与共享只读 helper |
| 8 | db_web_quota_scripts | quota stats 与 web e2e metrics |
| 9 | db_backfill_review | 独立发现并复核 backfill P1、安装器失败处理；最终无阻断 |
| 10 | db_readers_review | 独立发现根目录解析和缺配置吞错，均已修复 |
| 11 | db_final_inventory | 全仓残留清单、真实 FD/SSE 归因及纠正 |
| 12 | db_home_resolution | 统一完整 home resolver，修复 backfill 原 ref/映射优先级 |

## 验证与交付边界

- 最终 `go build -mod=readonly ./...` 通过。
- Go authmeta / accountconfigapi / distributioninstall / AWS verifier 的 `go vet` 通过。
- 31 个修改后的 JS/CJS `node --check` 全通过，40 文件限定 `git diff --check` 通过。
- 真实临时 SQLite：门禁四状态；reader 正常与拒绝读取；裁剪、回填实际执行；
  FK 违规 0 / integrity_check=ok / 不生成旧库 / 只备份 canonical 一份。
- 十个脚本的 --help 在未迁移临时目录中退出 0，没有开库；15 组 home 解析场景通过。
- 使用 Go overlay 调用实际生产 Busy，真实临时 SQLite 与私有 HTTP 验证 canonical
  自定义端口、legacy-only；非法 JSON、缺配置、坏链接、null、空对象、无效端口、数字溢出
  都明确失败，不请求旧配置端口；错误不包含密钥或数字原值。未创建仓库测试文件。
- 真实本机 dry-run prune 成功读 aih.db，未删除数据；backfill dry-run 成功；最近一天
  usage 对账 `ledgers_comparable`，相对差异 0.0089。
- alias 对账真实退出 2：同一个 aih.db 内 model_aliases 与 model_alias 各 1 行，
  ID 不同，业务字段比对也不一致，不能将差异仅归因为 ID。
  未把该项记作通过，也未写真实库消除既有投影差异；这不构成两份数据库。
- 本轮没有执行浏览器/计费脚本，没有手工写真实业务数据库或复制真实凭据。
  本机标准服务已重启并完成下述验收；正常服务启动本身会产生运行记录和业务状态写入。
- 实施和本机验收阶段没有创建分支/worktree，没有修改主索引，也未提交/推送。
  后续用户已授权提交推送；提交使用独立临时索引及 41 个明确路径，仅包含本轮源码和本报告。
  其它会话原有的 35 文件、168 additions / 1294 deletions 不纳入本次提交。
- 已执行 `npm run go:build` 更新本机标准 Go server / CLI，随后执行
  `node bin/ai-home.js server restart` 装载新服务；没有执行远端发布。
  本轮只完成废弃业务库默认消费者清理，整个 Node→Go W0–W6 以及 Node 退役仍未完成。

### 本机标准构件与运行装载

2026-11-18 01:34:41 构建，01:41:39 服务发布运行身份；01:43:37 起完成重启后接口验收
（时间为 Asia/Shanghai，运行记录原值使用 UTC）。

| 构件 | SHA-256 |
| --- | --- |
| `bin/native/darwin-arm64/aih-server` | `9916c2222ab53916a694e9f9602fc30f9a6a9d591698278dc26dd9ee6951cbf1` |
| `bin/native/darwin-arm64/aih-go` | `62ade2667a5f63fea300a75d389ecb6f45b5d4c67f3e161609d5b2f4f35f44b6` |

- 旧标准构件与 stamp 已备份到系统临时目录 `aih-db-cutover-native-preimage-jc7yb0lq`。
- 新构件先用无真实凭据私有 home 实际启动：两个账号接口 HTTP 200、空列表；
  `/readyz` HTTP 200、ok=true、ready=false，空账号时 ready=false 符合实现。
  私有实例通过自己的管理关闭端点退出 0。
- 共享运行身份 `go-server-runtime.json` 的 PID 为 84956，server SHA 与新构件一致；
  原 Go 31835 与 Node 31954 均已退出。
- 标准 `server status` 显示 running、ready=true，未再显示 native binary stale。
- `/readyz` HTTP 200、ready=true、232 个模型；认证后的 management accounts / WebUI
  accounts 各 34 个，projects 18 个，tasks / chat runs 均 0。
- 重启前 14 个真实 tmux pane 全部保留，逐项核对 socket、PID、进程启动时间、父进程和
  进程组一致，pane_dead 均为 0。独立复核确认标准停服仅关闭 attach 客户端。
- 两个 Web 终端的 durable probe 均 HTTP 200 / alive；重启后终端列表暂为 12 个 native
  连接，两个 Web 客户端需要页面重连。没有声称这两个浏览器连接已经恢复，也未操作浏览器。

运行前后完整非凭据证据保存在系统临时目录 `aih-db-runtime-activation-nkicgpaw` 的
`before.json`、`preflight.json`、`after.json` 和 `fds-after.json`。

临时实测材料位于系统临时目录的 aih-script-cutover-iz4j2k、aih-install-config-2q9kk4yw、
aih-sse-evo-audit-0uamtkxk 等私有任务目录，均未含真实账号凭据。