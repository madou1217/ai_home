# 20 · Native Session 行为对齐清单（webUI /chat）

目标：webUI 聊天里的 native 会话做到 ~99% TUI 行为。gemini 已忽略（OAuth 停服）。

## Per-provider /chat 会话现状（2026-07-02 实测）

| Provider | /chat 执行路径 | 状态 | 说明 |
|---|---|---|---|
| **claude** | native headless (`claude --print --output-format stream-json`) | ✅ 通 | 修复了「用错旧版 CLI (~/Downloads/package 2.1.88) 报未登录」。实测真实回复。 |
| **codex** | native headless (`codex exec --json`) | ✅ 通 | 修复了「交互式 TUI + PTY 卡死」，改 exec --json；新建+resume 均通。 |
| **agy** | native (antigravity CLI, 冷启动~100s + warm-LS 池) | ✅ 通 | 修复了「classifier 看到冷启动横幅 'not signed in' 就 premature kill + 熔断」；改为只在 'select login method' 才判未登录。账号本就有效,冷启动后返回真实回复。（响应尾部有 checkpoint 噪声,待清理） |
| **opencode** | native headless (`opencode run --format json`) | ✅ 通 | 修复了「被排除在 webui native 外 → 甩 api-proxy 401」；已纳入 native + headless。实测真实回复。 |
| gemini | — | 忽略 | OAuth 停服，弃用。 |

## TUI ↔ webUI 行为对齐清单（逐项补齐）

以 claude/codex（已通）为基线，按项对齐；每项列 TUI 有 / webUI 现状 / 差距。

- [x] 流式增量输出（delta） — claude/codex headless 已 emit delta。
- [x] 最终结果 / 完成信号（result/done） — 已对齐（codex 补了 turn.completed→result）。
- [x] 会话续接（resume，多轮上下文） — claude --resume / codex exec resume 已通。
- [x] **工具调用可视化**（tool_use / tool_result）：claude native **实时流式**已做——后端从 stream-json 抽 tool_use/tool_result 渲染成 `:::tool`/`:::tool-result` 标签，发 assistant_tool_call/assistant_tool_result 事件，前端追加到 pending 气泡,复用历史同一套 parseMessageBlocks/MessageBubble 卡片。**codex(exec item 事件)/opencode 待复制同样逻辑。**
- [x] **审批 / 权限交互**：会话级三态(2026-07-04)——bypass(默认,保持 --dangerously-* 流畅)/ confirm / plan。三家已落地并真机 e2e:claude=MCP 权限工具、codex=app-server JSON-RPC、opencode=serve API,统一收敛到 native-approval-bridge + 审批卡 + `/runs/:id/approvals/:id` 决策端点。详见 docs/fabric/21-provider-hooks.md §7。此前的"不做审批"决策已被用户"完全对齐 TUI"要求取代;bypass 保证流畅仍是默认。
- [x] **推理/思考流**（thinking/reasoning）：claude stream-json 的 thinking 块已透传(type:'thinking'，前端 :::thinking 渲染)；gemini/agy 原有通道。
- [x] **stop/中断**：实测——abort 请求后 native CLI 进程正确清理(0 残留)。
- [x] **图片输入**：实测——1x1 粉 PNG 经 claude native 端到端，回复"粉色"。
- [x] **slash 命令**：五家全集实测清单(2026-07-04)——claude 81 / codex 45 / opencode 20 / agy 30 / gemini 10,拆到 native-slash-command-catalog.js(TUI 抓补全+官方文档交集,含别名);未匹配放行交给 CLI。见 21 号 §9。
- [x] **queue / steer**（2026-07-04）：运行中默认入队(有提示)+ detached 入队/flush + sessionStorage 持久化;claude 真 steer(stream-json 注入=同会话下一轮),QueueDock"插话"按钮。
- [x] **provider hook 全景 + 文档**（2026-07-04,硬性交付）：claude/codex/gemini/agy 生命周期 hook 在用;opencode 从零补插件桥(default run 路径 turn-started/completed,真机 e2e);统一文档 docs/fabric/21-provider-hooks.md(管线/逐家协议/审批契约/事件字典/slash 附录)。
- [ ] **错误分类**：native_session_failed 需把真实 CLI 报错透给前端（已有 classify*，codex error/turn.failed 已接）。

## 下一步
1. 工具调用/结果渲染（最大差距）：扩 headless JSONL 解析 + 前端卡片。claude stream-json 有 tool_use/tool_result；codex exec 有 item(type=command_execution/file_change 等)。
2. agy not-signed-in 专项（antigravity 冷启动/登录态同步）。
3. opencode 是否纳入 native TUI 的决策。
4. 另一线：底部 xterm 终端面板（VSCode 式）。
