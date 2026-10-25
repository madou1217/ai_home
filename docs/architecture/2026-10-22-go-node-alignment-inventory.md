# Go / Node 对齐盘点（2026-10-22）

> 目标：把「Go 要对齐哪些地方」一次性列全，作为后续工作的清单。
> 数据来源：`npm run gateway:routes`（本次实跑）、`contracts/route-ownership/manifest.json`（baseline 2026-10-22）、
> `npm run chat:legacy-readiness`、`npm run providers:audit`。**不凭印象，全部来自工具输出。**

## 0. 结论速览

| 面 | 现状 | 差距 |
|---|---|---|
| **推理数据面**（`/v1/*`） | Go 已实现全部 capability route；12 条已 `go_owned` | **剩余 3 个 blocker：health/readiness、models.list** |
| **控制面 / 管理面**（`/v0/management/*`） | Node 30 条，Go 0 | **usage 查询合同尚未迁移；Go 只有 Node 消费的增量事件 feed** |
| **WebUI 面**（`/v0/webui/*`） | Node 203 条，Go 0 | 官方标记 `out_of_scope`（Node 专有） |
| **Node RPC**（`/v0/node-rpc/*`） | Node 63 条，Go 0 | 官方标记 `out_of_scope` |
| **Fabric**（`/v0/fabric/*`） | Node 9 条，Go 0 | 官方标记 `out_of_scope` |
| **PTY / 终端 / 持久会话** | Node ~28 个文件，Go **零依赖、零实现** | **最大的未覆盖能力面** |
| **Provider 层** | 两侧 16 个 provider，采集面完备 | 已对齐 ✅ |
| **geo（本次新增）** | Node + Go 双实现，结论一致 | 已对齐 ✅ |

路由总数：**Node 356 条 / Go 33 条**（`/v0` 是 336 : 1）。

---

## 1. 推理数据面（`/v1/*`）—— 功能已齐，缺的是「切换所有权」

`contracts/route-ownership/manifest.json` 的 15 条 `cutover_blocking` entry 中，12 条已经是
`production_owner: go` / `migration_state: go_owned`，3 条仍由 Node 持有。公开 9527 仍由
Node 宿主监听；Node 按 manifest 将已切换能力透明转发到 Go。

| entry | Go 状态 | 切生产还缺什么 |
|---|---|---|
| `gateway.health` / `gateway.readiness` | Node-owned | 宿主健康与就绪边界保留在 Node |
| `gateway.models.list` | Node-owned | 当前 live shadow 仍显示 Node 204 / Go 52；需先补齐远端探测、插件模型和中转 Provider 全集 |
| `gateway.anthropic.count_tokens` | Go-owned | 已通过本地 parity gate，由 Node 转发到 Go |
| 其余 12 个推理数据面 entry | Go-owned | 已通过现有 ownership 闸门并由 Node 转发到 Go |

**剩余工作**：不是重做已经接管的能力，而是逐项完成 3 个 blocker 的语义核验和证据。
模型目录的账号/模型禁用策略已经由 Node→Go 对账同步；2026-10-25 的 live shadow 显示
Node 204 / Go 52，Node 独有 152（其中 `opencode/*` 85、`opencode-go/*` 38、
`cline-*` 16）；`gateway.models.list` 仍需要解决远端探测、全局合并目录与账号所有权；
health/readiness 保持 Node 宿主边界并由 ownership 测试守住。验证手段仍是既有的
`npm run gateway:shadow -- --node <url> --go <url>`（同请求双发对比）及对应 live tests。

> 注意：manifest 明确写着「Go 侧控制面管理接口（如 `PUT,GET /v1/management/upstream-error-rules`）不是数据面 capability route，
> production owner 仍为 Node」。所以 `/v1/management/*` 也不在「该迁」清单里。

---

## 2. 控制面 / 管理面（`/v0/management/*`）—— 完全没迁

Node 30 条，Go 0 条。这些是**内部管理接口**，按 `docs/functional-matrix.md` 的划分需确认哪些属于 Go 范围。

| 分组 | 条数 | 代表端点 |
|---|---|---|
| `usage/*`（用量统计） | 15 | `/v0/management/usage`、`/usage/dashboard`、`/usage/scan`、`/usage/stats` |
| `state-index/*`（状态索引） | 3 | `/state-index/upsert`、`/prune-missing`、`/operational-status` |
| `watch/*`（变更订阅） | 2 | `/watch`、`/watch/snapshot` |
| 单条 | 9 | `/status`、`/accounts`、`/models`、`/metrics`、`/cooldown/clear`、`/reload`、`/restart`、`/shutdown`、`/ui` |

**当前证据不支持直接迁移 usage dashboard。** Go 的 `accountusage` 是账号当前额度快照，
`accountusagefeed` 是给 Node 汇总器消费的 `(boot_id, seq)` 增量 token event feed；两者都不
提供 Node `usage/*` 所需的日期范围、定价、模型/会话/请求明细和扫描任务合同。2026-10-25
live probe 结果：Node 的 `/v0/management/usage/stats|models|sessions|requests` 均返回 200
和对应完整 payload；Go `GET /v1/management/account-usage-events?after_seq=0` 返回
`boot_id/latest_seq/truncated/data`，本轮 `data` 为空。下一步应先为持久化 usage projection
定义独立 Go 查询合同并做 Node shadow，再决定哪些 `/v0/management/usage/*` 子接口可以迁移；
不能把 event feed 描述成 dashboard 等价物。`/reload`、`/restart`、`/shutdown` 属于进程
生命周期，仍可单独评估是否保持 Node。

---

## 3. PTY / 终端 / 持久会话 —— 最大的能力缺口

**Go 侧零实现、零依赖**（`go.mod` 里没有任何终端库）。

| Node 侧 | 文件数 | Go |
|---|---|---|
| `lib/cli/services/pty/` | 28 | 无 |
| `lib/server/native-*.js`（原生会话引擎） | 33 | 无 |
| `lib/server/codex-*`（Codex 专项，含 app-server） | 67 | 无 |
| `lib/server/chat-runtime/` | 104 | 无 |

具体能力（都在 Node 侧，Go 没有对应物）：
- **PTY 运行时**：`pty-runtime-spawn/run/launch`、`persistent-launch`、`persistent-provider-supervisor`
- **tmux / psmux / herdr** 多路复用抽象（`internal/` 无对应）
- **原生会话引擎**：`native-session-chat`、`native-run-adoption`、`native-approval-bridge`
- **Codex app-server / stdio 代理**（manifest 标 `out_of_scope`，但这是「会话」能力的核心）

**这是「Go 只留推理」与「Go 全量」的分水岭**：如果目标只是推理面，这块不用动；
如果要 Go 全量，这是工作量最大的一块（Node 侧相关文件 230+：pty 28 + native 33 + codex 67 + chat-runtime 104）。

---

## 4. 官方标记 `out_of_scope`（Node 专有，Go 不参与）

manifest 明确列出 5 条，**不该要求 Go 对齐**：

| entry | 理由（manifest 原文） |
|---|---|
| `node.webui_and_session_surface` | intentionally retained by Node Host in Go Refactor .1 |
| `node.webui_image_studio` | Image Studio remains a Node-owned WebUI product surface |
| `node.fabric_surface` | Fabric remains a Node-owned product surface in this baseline |
| `node.node_rpc_surface` | remote node/session orchestration is not part of Go Refactor .1 |
| `node.codex_app_server` | Codex app-server/stdio session proxy remains Node-owned |

对应路由：`/v0/webui/*`（203）、`/v0/node-rpc/*`（63）、`/v0/fabric/*`（9）、`/v0/codex/app-server`（1）。

---

## 5. 已对齐的部分（无需处理）

| 面 | 证据 |
|---|---|
| **Provider 定义** | 两侧各 16 个（codex gemini claude agy opencode grok qoder qodercn kimi kiro zcode codebuddy codebuddycn workbuddy workbuddycn cline） |
| **Provider 采集面** | `providers:audit`：16 个 provider 全有 API 通道，「只有 CLI 通道的采集面：0」 |
| **geo 查询** | 本次新增：Node `lib/runtime/geo/` + Go `application/geo/`，同一 DB-IP 文件两侧结论逐条一致 |
| **`/v1` 推理路由** | Go 33 条覆盖 Node 14 条数据面候选，「Go 缺失 0 条」 |

---

## 6. 另一条独立的收敛线：legacy 引擎 → canonical 引擎

`npm run chat:legacy-readiness` 的结论（**与 Go 迁移并行、但不同维度**）：

- **legacy 仍必需，不可删** —— web 表面未注册 13 个 provider（只有 codex 注册了）
- web 表面**不接受 API-key 账号**（legacy 接受）
- **审批传输未声明 10 个 provider**（agy、cline、codebuddy、codebuddycn、gemini、qoder、qodercn、workbuddy、workbuddycn、zcode → confirm/plan 模式不可用）
- `grok` 已声明但未接线（`native_session_terminal_approval_not_wired`）
- 合同与引擎不同源：合同声明 5 个（agy/claude/cline/codex/opencode），引擎实际多服务 8 个

清单见 `docs/plans/2026-10-15-chat-legacy-retirement-readiness.md`。

---

## 7. 建议的处理顺序

按「依赖关系 + 收益」排，而不是按规模：

1. **收尾剩余 3 个推理 blocker**：评估 models catalog；
   health/readiness 保持 Node 宿主所有权并补齐文档与回归守卫。
2. **先建立 usage 查询投影与合同**：把 `accountusage` 快照、推理 token event 和 Node
   持久化 usage records 的边界对齐，先 shadow 一个只读子接口，再迁移 `usage/*`；当前
   event feed 不足以直接接管 dashboard。
3. **审批传输补声明**（10 个 provider；不依赖 Go，能独立推进，且直接解锁 confirm/plan）。
4. **PTY / 会话能力迁 Go**（规模最大，需先定「Go 是否要全量」这个前提）。
5. **web 表面注册剩余 provider + 支持 API-key 账号**（legacy 退役的前提）。

> 第 4 步的前提必须由你拍板：**Go 的终局是「只做推理」还是「全量接管」**。
> 前者只需做 1–3；后者要连 PTY/会话/WebUI 一起搬（Node 侧 150+ 文件）。

---

## 附：复现命令

```bash
npm run gateway:routes          # 两侧路由清单与数据面差异
npm run gateway:shadow -- --node <url> --go <url>   # 同请求双发对比（切所有权前的验证）
npm run providers:audit         # provider 采集面覆盖
npm run chat:legacy-readiness   # legacy→canonical 收敛就绪度
node -e "const m=require('./contracts/route-ownership/manifest.json');console.table(m.entries.map(e=>({id:e.id,owner:e.production_owner,state:e.migration_state,go:e.go_implementation})))"
```
