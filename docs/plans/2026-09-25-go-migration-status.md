# Go 迁移收口报告（2026-09-25）

对应计划：[`2026-09-24-go-migration-plan.md`](./2026-09-24-go-migration-plan.md)，待办：[`todo.md`](./todo.md)。
本报告记录 Node + Go 共存的现状、能力对等证据与性能数据，以及切流前仍需决定的事项。

## 1. 共存拓扑（生产 9527 已生效）

- Node 公开宿主监督 Go Core（私有 loopback 端点，build stamp 校验，崩溃指数退避自动重启，输出落
  `logs/go-core.log`）。
- 账号：P1 已迁移（Go `aih.db` 28 个账号，`verify` 通过）；Node→Go 持续同步。
- **单一刷新者**：Go 以 `AIH_SERVER_CREDENTIAL_REFRESH=delegated` 运行，从不轮换 OAuth
  Refresh Token；Node 刷新后经同步推给 Go。消除了双刷新者互相作废 Token 的风险。
- 路由所有权：`gateway.props`、`gateway.models.detail` 由 Go 应答；其余数据面仍由 Node 应答。
- Node `/readyz` 汇合 `go_core`（进程、首轮同步、Go ready、转发可用）；Go 路由不可用时失败关闭。

## 2. 能力对等（真实上游影子比对）

比对方法：`scripts/gateway-shadow-compare.js`，Node = 生产 9527，Go = `aih.db` 快照上的隔离实例
（委托刷新，不触碰真实数据，结束即删除）。推理探针每协议 1 次、`max_tokens=16`。

| 协议 / 端点 | 状态 | 结构 | 结论 |
| --- | --- | --- | --- |
| `GET /v1/props` | 200/200 | 一致 | 已划给 Go |
| `GET /v1/models/{id}` | 200/200 | 一致 | 已划给 Go |
| `GET /v1/models` | 200/200 | 一致；共同 38 个 id 的顺序/owned_by/modalities 一致 | 全集不同（Node 396 / Go 38）：目录必须随推理最后划转，路由所有权已强制 |
| `POST /v1/messages` | 200/200 | 一致 | 可切流（见 §4） |
| `POST /v1/messages` SSE | 200/200 | 事件序列一致 | 可切流（见 §4） |
| `POST /v1/chat/completions` | 200/200 | Go 为超集（多 usage 明细） | 兼容 |
| `POST /v1/responses` | 200/200 | Go 为超集（完整 Responses 对象） | 兼容 |
| `POST /v1beta/models/{m}:generateContent` | 200/200 | 均为标准 Gemini 结构，可选字段略有差异 | 修复后兼容 |

比对过程中发现并修复的缺陷：

- Go：Codex 目录未剔除 `visibility` 隐藏项（`gpt-reserve`）；`aih_modalities` 需显式 opt-in。
- Go：原生 `api-key` 凭据违反 `auth_kind` 列约束，OpenCode API Key 账号导入全部失败。
- Go：AGY 思考模型（Gemini 3）一律 400——思考部分被当作非法、思考 token 未计入输出。
- Node：Gemini `generateContent` 缓冲路径泄漏 Code Assist `{response, traceId}` 信封。

账号钉选（`x-account-ref`）：Go 已支持独占路由；转发前由 Node 判定——可用钉选交给 Go，
不可用/未知/非法钉选仍由 Node 处理（回落常池 / 403 / 404 / 400），Fabric 远端网关在线时
未钉选推理留在 Node。

## 3. 性能

`node scripts/go-core-benchmark.js`（隔离 AIH_HOME，压测客户端独立进程，GET `/v1/models/{id}`，
3000 请求 / 并发 50）：

| 拓扑 | rps | p50 ms | p99 ms | Node CPU | Go CPU / RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| node-direct | 1454 | 33.4 | 66.6 | 2.21s | - |
| node-to-go | 16713 | 2.7 | 7.3 | 0.36s | 0.11s / 28MB |
| go-direct | 31519 | 1.3 | 7.0 | - | 0.09s / 30MB |

满足 P4 门槛（经 Go 的 p99 ≤ Node 直出；Node CPU 下降 84%）。推理端点的基准需真实 token，
随推理切流执行。

## 4. 切流前仍需决定 / 补齐的事项

推理切流（S8 `/v1/messages`、S9 其余协议）会把**生产实时流量**（包括正在使用的 Claude Code
会话）交给 Go，只能在负责人确认后进行，且计划要求每步 canary 跑满一个额度周期。已知缺口：

1. **模型别名**：已处理——命中启用 Node 别名的推理请求由转发前判定交还 Node（3d148724）。
   Go 原生别名（Node→Go 同步 + 路由规则装配）仍是后续工作，届时可去掉这条交还。
2. **钉选失效回落**：已由转发前判定交还 Node 保证语义；Go 自身仍是 503。
3. **`x-aih-server-account-ref`**：已处理——Go 推理响应按实际服务账号写入该头与 `x-aih-server-provider`。
4. **账号覆盖**：Go 不承接 zcode / 失效 opencode 等 4 个账号，这些 Provider 的推理只能留在 Node。
5. **生产切流**：由运维者执行 `scripts/go-core-canary.sh <entry-id>`（自动回滚看门狗）。

回退：`aih server config set --no-go-core --clear-go-core-routes && aih server restart`。
