# WebUI 账号页投影迁 Go：切分方案

日期：2026-11-06
状态：方案（未实施）

## 1. 现状

/v0/webui/accounts 的响应由 Node 的 lib/server/webui-account-live.js（2185 行）拼装：
账号事实来自 state.accounts（Node 运行池），运行态来自 accountStateIndex，
额度来自 Go 的快照，模型数来自 Go 的 account_models，探针状态来自 Node 内存。
页面还有 SSE /v0/webui/accounts/watch 做增量更新。

Go 侧已有的对应事实：
- 账号与凭据：aih.db 的 accounts / account_credentials（/v1/management/accounts）
- 运行态：account_runtime_state / account_runtime_blocks
- 额度快照：account_usage_snapshots（/v1/management/accounts/:ref/quota-stats）
- 模型数：account_models

## 2. 为什么不能整体搬

webui-account-live.js 里有三类 Node 独有事实：

1. 探针状态（getLastUsageProbeState/Error）：Node 进程内存里的最近一次额度探测结果；
2. 凭据形态判定：家族 nativeAuth、zcode 桌面会话过期等，依赖 Node 的凭据读取器；
3. watch 增量：SSE 由 Node 的事件源驱动。

这三类要么先在 Go 侧重建（探针结果落库、凭据事实进投影），要么保留 Node 覆盖层。

## 3. 三个切片

### A. Go 出「账号静态视图」（只读、可对账）
- 新接口 GET /v1/management/accounts/:ref/view：账号标识、Provider、启用、计划、
  运行态、额度剩余、模型数——全部来自 aih.db。
- Node 加影子对账（同 alias 的做法）：/v0/webui/accounts 返回后异步拉 Go 视图，
  逐字段比较并记 state.accountShadow。
- 验收：跑一天，state.accountShadow.equal 恒为 true。

### B. Node 把三处独有事实推给 Go
- 探针结果：Node 每次探测完写 PATCH /v1/management/accounts/:ref/probe（Go 落库）；
- 凭据形态：Node 在账号同步时一并推 auth_kind / native_auth_kind 投影；
- watch：Node 保留 SSE，事件里的账号行改为 Go 视图 + Node 覆盖层。

### C. 前门翻转
- /v0/webui/accounts 改为转发 Go 视图并叠加 Node 覆盖层，Node 只保留 state 供 CLI 使用；
- watch 事件载荷同步换形状；
- 验收：账号页 6 个 Tab 逐个真机对比，字段零差异；停 Go 时 503（不回落旧投影）。

## 4. 风险

| 风险 | 对策 |
| --- | --- |
| Go 缺 Node-only Provider（gemini）的账号 | A 阶段对账会直接暴露；先在 Go 补账号导入 |
| 探针状态在内存里，重启即丢 | B 阶段落库；过渡期接受「重启后探针未知」 |
| SSE 增量与全量形状不一致 | 先冻结行结构，再改两端 |
| 账号数 35 vs 43 的口径差异 | 以「可调度账号」为准，写进契约文档 |
