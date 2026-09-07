# Codex App 返回结果但仍显示 Connection refused

日期：2026-09-07。目标会话：`01a07a6a-19ee-7701-9113-2d91f5b9e8b0`。

## 根因与前次验收纠正

用户截图中的 `test` 最终返回，但同一轮经历了 4 次重试。之前只核对 `turn-complete` 和没有 yeslaoban 401，漏掉了中间断连，因此“有回复”不能作为无错误验收。

这次错误来自 **Codex App 到本机 AIH 网关**。AIH 默认每秒检测源码指纹，发现编辑就后台重启，导致监听端口暂时消失。源码修复期间的编辑触发了该行为。CLI 的服务就绪检查也有一条独立入口，会在发现源码 stale 时重启已就绪的服务。

| 北京时间 | 真实事件 |
| --- | --- |
| 17:41:37 | App 启动用户的 `test` 请求，turn ID `01a07b3e-a2ab-7bd2-921a-843544c28124` |
| 17:41:38 | 旧 WebSocket 正常关闭，Codex 开始第 1 次重试；新的网关进程 6384 同秒启动 |
| 17:41:39—41 | 连接 `ws://127.0.0.1:9527/v1/responses` 被拒绝，记录第 2、3、4 次重试 |
| 17:41:42 | 新服务写入启动指纹，HTTP 管理接口开始响应 |
| 17:41:45 | WebSocket 连接成功 |
| 17:42:00 | 请求完成，App 显示 `test`，但保留了该轮重连历史 |

原始证据来自 `.codex/logs_2.sqlite` 的目标线程记录、App 日志、本机服务启动指纹和进程启动时间。`background-supervisor.log` 明确存在 `server source changed ... restarting`、`received SIGTERM`、关闭超时及再次启动的连续记录。不是上游拒绝 WSS，也不是上一次的 key 错配。

## 已实施修复

- `lib/server/source-auto-restart.js`：默认不启用源码自动重启；仅 `AIH_SERVER_SOURCE_AUTO_RESTART=1` 显式开启开发自动重载。原 `AIH_SERVER_DISABLE_SOURCE_AUTO_RESTART=1` 保持最高优先级。
- 关闭自动重启时，`checkOnce()` 仍返回 `stale: true`，不覆盖启动指纹、不启动重启子进程。`aih server status` 继续显示新源码尚未加载。
- `lib/cli/services/pty/pty-runtime-launch.js`：复用同一策略判断，CLI 默认使用 ready 的服务，不因源码 stale 打断其他客户端。服务未运行时的正常自动启动保持原行为。
- README 和功能矩阵更新相应语义。需要应用新的业务代码时，在会话空闲后显式执行 `aih server restart`；本修复没有引入零停机部署机制，显式重启仍可能中断连接。

旧服务在补丁写入时最后触发了一次自动重启，新进程 17498 已加载默认关闭策略。之后再次修改受监测文件中的注释，服务状态变为 `stale: true (source_changed)`，进程仍保持 17498。该注释不改变运行行为，无需再为它重启服务。

## 验证

本机证据目录：`/Users/model/.ai_home/backups/codex-connection-refused-20260907-175059`。

| 检查 | 结果与边界 |
| --- | --- |
| 原错误还原 | `original-turn-retries.json` 保存准确的 4 次重试和本机 URL；只保留诊断元数据 |
| 官方 App 随附 app-server + 真实宿主配置 | 同一临时会话连续 3 轮真实 WebSocket 推理，正确回复随机标记；RPC 错误 0、重试 0、连接拒绝 0；45 次健康检查全部正常，网关 PID 始终 17498；见 `app-runtime-stability.json` |
| 独立第二组 App runtime 验收 | 2 轮真实 WebSocket 推理成功，逐条检查 RPC error 通知；重试 0、连接拒绝 0、端口失败 0、PID 不变；见 `app-multiturn.json`。此组显式禁用了用户配置中的 MCP，仅验证模型传输 |
| 源码再次变化后的真实 `aih codex 1 exec` | 两次 exit 0、正确回复、`turn.completed`，网关保持 PID 17498；第一组监测 141 次端口全部连通；两条线程查询 Codex 日志均为 0 传输重试/拒绝连接。见 `stale-cli.json`、`aih-stale-cli.json` |
| 原 App | App 及其 app-server 保持运行，没有为测试结束原会话 writer；新建的临时验收会话不冒充原窗口点击验收 |
| 相关自动化测试 | `server.source-auto-restart`、`server.source-fingerprint`、`pty-runtime`、`server.command-fast-start` 共 208/208 通过；覆盖默认不重启、显式启用、disable 优先、stale 持续可见以及 CLI 复用就绪服务 |

该修复阶段测试日志：`/tmp/aih-connection-refused-final-tests.log`。当时沿用前轮全量失败记录，未修改 WebUI 源码或 `llm_api`，也尚未提交或推送。后续用户要求提交全部工作区变更，整体验证见下节。

真实 CLI 仍记录模型目录刷新子进程超时和技能描述压缩提示，不能把这两轮描述为所有诊断均无错误。第一组脚本的 `streamErrorCount=1` 实际是 `item.completed` 内的技能描述压缩提示，并非传输错误；对应两条线程的 `codex_core::responses_retry` 和 `Connection refused` 日志查询均为 0。本轮修复针对重启造成的断流，不掩盖这些独立诊断。

最终四个相关 JavaScript 文件 `node --check`、`git diff --check` 与范围受控的 Gitleaks 检查通过。官方 App binary 的 SHA256 仍为 `a30ec314bbd0e3721632234d07db7c99855db3b9f1e32dbe8c791947f07e7629`，见 `final-checks.json`。

computer use 已尝试选择 App，并重置工具连接后再次获取状态，两次均返回 `Sky Computer Use native pipe startup failed`。没有使用其他 UI 自动化绕过，也没有把 app-server 协议测试写成 UI 点击测试。已请用户在原会话发送 `APP_STABLE_OK` 作为界面复验；新一轮结果应单独判定，旧一轮的历史错误不会因服务恢复而被删除。

## 提交全部工作区变更前的整体验证

用户随后明确要求 `提交并 push all`，交付范围扩大到当前 `ai_home` 全部源码、测试和文档变更，包括既存的两个测试文件删除及三个 WebUI 会话目录文件；不包含被忽略的凭据、数据库、运行时和构建产物。未操作 `llm_api`。

- 使用项目要求的 Node 22.23.2 执行 `npm test`：6,380 项，6,373 通过、7 跳过、0 失败；日志 `/tmp/aih-push-all-node22-tests.log`。
- 修正两个测试前提：CLI 路径用例显式指定临时宿主目录；node-rpc 用例除账号身份和凭据外，还写入 `up` 持久状态，符合删除/停用账号不再被选中的规则。
- 审查用量扫描预算时发现超长 JSONL 单行可能反复回退到原偏移。读取改为在完整记录边界停止，单条超长记录允许超过软预算；显式 fork 重建保持整文件原子替换。回归覆盖 UTF-8 超长行、恰好达到预算的 EOF、跨轮无重复及小预算下的完整重建。
- Web 全量 `npm run build`：Node 22.23.2 下通过，Webpack 编译 21.68 秒；默认 Node 26 的首次构建因旧依赖调用已删除的 `http_parser` 失败，没有通过修改依赖绕开。
- Web 三个变更文件 ESLint 通过；`bun test web/src/features/chat-runtime`：100 通过、0 失败（27 个文件）。
- Go `go test -race ./internal/adapters/codex/responseswebsocket ./internal/host/aihserver ./internal/transport/http/codexresponsesws` 三包通过。
- 语法检查通过。全范围密钥扫描首轮将测试中的固定 sessionKey 误报为密钥；已改为明确的 `test-session`，账号生命周期测试单独复跑通过。
- 验证后官方 App binary SHA256 与上文一致，本机网关 PID 仍为 17498，`/readyz` 为 ready。提交不重启网关，不把旧进程描述为已经加载所有新业务代码。

验证日志分别位于 `/tmp/aih-push-all-web-build-node22.log`、`/tmp/aih-push-all-web-eslint.log`、`/tmp/aih-push-all-web-tests.log` 和 `/tmp/aih-push-all-go-tests.log`。这些文件是本机证据，不纳入 Git。

## 设计模式与原则

| 文件/模块 | 模式 | 用途 | 验证证据 |
| --- | --- | --- | --- |
| `source-auto-restart.js`、`pty-runtime-launch.js` | 共享策略函数 | 两个自动重启入口使用相同的显式启用规则 | 默认、opt-in、disable 优先级及 CLI 用例 |
| `source-auto-restart.js` | 既有依赖注入 | 测试观察重启子进程而不操作真实服务 | 源码变化测试中的 spawn 次数为 0，stale 保持可见 |
| `codex-gateway-connection.js` | 值对象工厂 | URL、key 和账号 pin 一起生成，供 App/CLI 入口复用 | 连接配置及认证隔离测试 |
| `codex-chat-stream-converter.js`、`codex-response-stream.js` | 适配器 | 分离协议转换与流生命周期，流式和聚合路径复用转换逻辑 | 首字节、取消、超时及错误后不重放测试 |
| `canonical-session-directory.ts` | 有界工作队列 | 最多六个目录请求同时执行，结果保持输入顺序 | Web 相关 100 项测试、ESLint、全量构建 |

SOLID：策略集中，服务就绪编排复用。KISS：调整现有开关，不新增重载服务。DRY：两入口共用判断。YAGNI：不增加无限重试、错误隐藏、会话搬迁或未经需要的零停机框架。
