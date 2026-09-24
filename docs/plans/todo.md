# Go 迁移 TODO（2026-09-24 暂停点）

上下文：[`2026-09-24-go-migration-plan.md`](./2026-09-24-go-migration-plan.md)，PR madou1217/ai_home#6（已 Ready for review）。

## 已完成（已提交并推送）

- [x] P0：`npm run go:build`；Go Core 由长驻 Server 进程监督；manifest 驱动的 Node→Go 透明转发（默认不转发）
- [x] S1 账号统一：`lib/server/go-account-sync.js` 双向同步（Go→Node 凭据回写 CAS、Node→Go 推送、启停/默认账号、安全删除、Go 独有账号收养）
- [x] S2：PR #6 标记 Ready for review
- [x] S3 P1 迁移工具：`npm run go:migrate-accounts -- plan|apply|verify`（演练账本 `migration/go-account-ledger.json`）
- [x] S4 工作区对齐：Node 采用 Go 工作区语义（21 条共享向量）；Go schema v6 `workspace_id` 列；Go API `workspace_id` 与 Node `workspaceId` 一致
- [x] 监督门限改为 `/healthz`（不再要求 aih.db 先有账号）；首轮同步完成前不转发

## 待办（按顺序）

- [x] **在真实机器上执行 P1**：`npm run go:build && npm run go:migrate-accounts -- plan`，检查账本里 `unsupported_in_go` / `rejected_by_go`，再 `apply`、`verify`（本容器无真实账号，只在夹具上验证过）
  - 2026-09-25 真实机器 `plan` 已跑：33 个账号 → 29 可迁（same_ref 17 / rekeyed 11 / merged 1），留 Node 4 个
    （zcode 3：无静态凭据或 artifact 无效；opencode 1：artifact 无效）。演练中发现并修复原生 `api-key`
    auth_kind 违反列约束导致 OpenCode API Key 导入全部 `account_not_found`（4748d838）。
  - 2026-09-25 已 `apply` + `verify`（ok）：Go `aih.db` 28 个账号（29 条迁移，其中 1 条并入同一 Codex 身份），0 失败、0 Go 独有账号；apply 前备份在 `~/.ai_home/backups/aih.db.pre-p1-apply.20260925021035`。
- [x] S5 就绪态：Node `/readyz` 汇合 Go 状态（进程、首轮同步、Go `/readyz.ready`、已划转路由）；补真实 `startLocalServer` + 真 Go 的端到端测试
  - 2026-09-25 完成：`goCoreHost.readiness()` 按需探测 Go `/readyz`，Node `/readyz` 增加 `go_core` 字段；有 Go 路由而转发不可用或 Go 不 ready 时整体 `ready=false`。`test/server.go-core-e2e.test.js` 用真实 startLocalServer + 真实 Go 验证就绪汇合、转发与杀进程后的失败关闭。
- [x] S6 `/v1/models` 对齐（以 Node 为准）：
  - 影子工具加目录语义比对（id 集合差、共同 id 顺序、owned_by、aih_modalities）与 capability 探针。
  - Go 改动：`aih_modalities` 默认输出；Codex 目录按 Node 规则剔除 `visibility` 非 list/default/public 与 `supported_in_api=false` 的项（真实比对抓到 `gpt-reserve`）。
  - 2026-09-25 真实影子（Node 生产 9527 vs Go 读 aih.db 快照，委托刷新）：结构一致、无 Go 独有 id，38 个共同 id 的顺序/owned_by/modalities 全部一致。
  - 剩余差异是**模型全集**：Node 396 / Go 38，差集是 Node 独有的中转/原生 Provider 模型。结论：目录描述「本网关能路由的模型」，Go 目录只能在推理全部划给 Go 后跟随。`go-core-route-ownership` 强制该约束（单独划转 `gateway.models.list` 整体拒绝）。
- [ ] S7 切只读路由：按 S6 结论，`gateway.models.list` 随推理最后划转；本步只划与目录无关的 `gateway.props`、`gateway.models.detail`：`aih server config set --go-core --go-core-routes gateway.props,gateway.models.detail`
- [ ] S8 `/v1/messages`：前置——Go 支持 `x-account-ref` 钉选（现在转发层返回 501）、Fabric 远端网关语义；真实 Claude 上游 shadow + 流式/取消/attempt 审计证据
- [ ] S9 依次：chat completions → responses（HTTP+WS 成对）→ gemini → images/blobs；每步 shadow + 改 manifest 为 `go_owned`
- [ ] S10 打包：postinstall 构建/下载 Go 构件 + 版本/sha 校验；Go 崩溃自动重启；Go stderr 落日志；基准测试（Node 直出 vs Node→Go vs Go 直连：TTFB、p50/p99、吞吐、RSS/CPU）
- [ ] S11 收口报告：Node+Go 共存、能力对等、性能数据

## 已知差异 / 风险

- Go 不承接：Claude 以外 Provider 的 API Key 账号、Gemini Vertex、工作区冲突的 Codex 凭据 → 留在 Node（账本列出原因）
- Codex API Key 的 `OPENAI_WIRE_API` / `AIH_UPSTREAM_HEADERS` / `AIH_IMAGE_API` Go 无法表示（账本 `lossy_fields`）
- Node 与 Go 两个 token 刷新器仍可能对同一 refresh_token 竞争；同步只保证「Go 更新时回写 Node」，未做单一刷新者
