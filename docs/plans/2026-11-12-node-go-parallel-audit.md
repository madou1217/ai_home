# Node→Go 六项并行审计（2026-11-12）

## 1. /sessions/:provider/:sessionId/messages
- Node：lib/server/webui-session-routes.js 的 handleGetSessionMessagesRequest
- Go：没有消息读取包，仅有 webuisessionpreviewsapi 的预览抽取
- 判定：**阻塞**。下一步先在 internal/sessionscan 上抽 Reader 端口，再建 webuisessionmessagesapi；不能把文件解析直接塞进 HTTP 层。

## 2. /sessions/:provider/:sessionId/events
- Node：handleGetSessionEventsRequest
- Go：无增量事件读取端口
- 判定：**阻塞**，与 messages 共用 Reader。

## 3. /projects/sessions
- Node：handleGetProjectSessionsRequest，按 projectPath 返回完整会话
- Go：webuisessionslistapi 是账号维度，webuiprojectsapi 单项目最多 40 条
- 判定：**阻塞**，需要 Go 增加 projectPath 全量读取能力。

## 4. /projects/watch + snapshot
- Node：SSE watch / snapshot
- Go：没有项目运行态事件源
- 判定：**阻塞**。不能把 Node 轮询搬到 Go 冒充事件；先定义 Go 事件源。

## 5. /app-entries 形状核对
- Node 已经消费 Go 的 entries，只补外部 harness（pi/dsh/dsh-tui）与 runningAccounts。
- 实测：Node 19 个 entry，Go 16 个；差异仅 pi/dsh/dsh-tui；两边 unfilledFields 一致。
- 判定：**无需切代理**，当前是 Go 数据 + Node 宿主运行态/外部 harness 的刻意合并。若要纯 Go，需把外部 harness 合同和进程扫描迁 Go。

## 6. /accounts/provider-auth-sources
- 实测 claude：
  - Node installable=true, reason=client_not_installed
  - Go installable=false, reason=client_unavailable
  - Go unfilledFields 含 installable / installableSourceId / alreadyImported / pluginSources
- 判定：**阻塞**。直接切会让安装入口消失；必须先补 Go installability 与 plugin source 投影。

## 本轮已闭环
- /git/diff 切 Go（14043382），实测返回真实 diff。
- /git/summary、/sessions/previews、/slash-commands、/projects、/toolkit/environments 已切。

## 下一批可执行顺序
1. 抽会话 Reader 端口（messages/events）
2. projects/sessions 全量读
3. 项目 watch 事件源
4. provider-auth-sources installable/pluginSources
5. app-entries 外部 harness 合同（若要求纯 Go）

## 2026-11-12 复核（本轮）
- Node entries=19，Go entries=16；差异仍只有 `pi / dsh / dsh-tui`。
- 两边 unfilledFields 相同：runningAccounts 四个键、externalHarnessEntries、capabilities.crossProviderHarness。
- 结论不变：Node 是 Go 数据 + 宿主运行态/外部 harness 合并，不是纯 Go 端点。
- 同日新增：`/sessions/events` 已由 Go 覆盖 codex 并带 15 条 Node 对拍；`/projects/sessions` Go 全量读因只覆盖 claude/codex，已回退 Node 避免丢 provider。
