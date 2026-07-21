# 证据：会话面板"接近原生(A)"各子项的真实边界（2026-07-02）

在决定把会话面板做"好用/接近原生"前，主控 Opus 用真实设备 token 路对 AWS aws-current-node / opencode 逐项实测，避免建错方向。全程无 mock。

## 逐项结论

1. **多轮上下文续话 —— 已通，无需额外开发。**
   - turn1 `prompt=记住数字73` → sessionId `ses_0e09b6f2dffeSlt9BxWsDSyjKx`。
   - turn2 带同 sessionId `prompt=刚让你记的数字是多少?` → 回复 `73`。
   - 现有面板在续话时已传 `sessionId`，故多轮上下文本就工作。

2. **slash（/status 等）= 交互式 TUI，是大刀不是小 polish。**
   - `POST device-node-session-command {type:'slash', command:'/status'}` → `accepted=true, type=slash, resumed=true`，返回**新 runId**。
   - 该 run 事件 = `{ready:1, terminal-output:18}`：输出是原始终端帧（含 ANSI 控制码），非 delta/result 文本。
   - 结论：网页里做 slash 需嵌终端模拟器（xterm.js）渲染 TUI 帧 + 输入转发。这是"原生 TUI 体验"的独立里程碑，硬塞进当前文本面板只会吐 ANSI 乱码，违背"看得懂/不伪造"。

3. **真流式(SSE) 对 opencode 无可见收益。**
   - opencode 回复一次性来一个整块 `delta`（非逐字 token 流），当前轮询即可完整呈现；SSE 逐字流对该 provider 不产生可见差异。其他 provider（未授权，暂不可测）可能不同。

4. **stop/中断** 走 `device-node-session-command {type:'stop', scope:'run'}`（未在本轮深测；opencode 单条回复约 10s 完成，中断价值有限）。

## 对 A 的重新规划建议

- 多轮已通、流式无益 → 不做。
- 真正的"原生体验"价值集中在 **TUI 终端渲染（slash + 交互式画面 + 输入转发）**，这是一整块独立里程碑（xterm.js 级别），需单独立项与验收；账号4 额度恢复后可委派 aih claude 4，或由主控专门做一刀。
- 当前文本会话面板对"发消息看回复 + 多轮"已可用；在 TUI 之前不再往文本面板堆半成品交互。

## TUI 交互路预验证（2026-07-02，动手前，无 mock）

按 advisor 要求，先证"输入回传"与传输方式：

- **slash → 交互 run**：`POST device-node-session-command {type:'slash', command:'/status', sessionId:<runId>}`（注意 sessionId 字段实为 **runId**，传 ses_ 引用会 `native_chat_run_not_found` 404）→ 返回新交互 runId。
- **输入回传（关键）**：`POST device-node-session-run-input {nodeId, runId:<交互run>, input, appendNewline}` → `accepted:true`；输入后该 run 的 `terminal-output` 帧 **6→18（3.3KB→30KB）**，TUI 真实响应。→ 交互输入回路成立。
- **帧数据**：`terminal-output` 事件的原始 ANSI 在 `.text` 字段；字符被光标控制码打散，**文本 grep 不可靠，验收须用截图**（xterm 正确重组渲染）。
- **传输选择**：device SSE (`device-node-session-stream`) 为**会话级**（要 `sessionRef=ses_`），且浏览器 **EventSource 不能带 Authorization 头**（跨域 Bearer 需 token-in-URL，属额外改造）。故 TUI 首刀用 **run-events 游标快轮询（~600ms 只取新帧）**：响应快、仅增量、对 2-3M 小水管友好；SSE token-in-URL 留作后续优化。
- **复用**：前端已有 `@xterm/xterm` + `web/src/components/chat/TerminalDock.tsx`（本地 Chat 已用其渲染交互 TUI）；本刀复用该组件与 writer/cursor 模式。

## TUI 终端首刀结果：未交付（诚实记录）

主控 Opus 尝试实现"节点内嵌 TUI 终端"（复用 xterm/TerminalDock），**本轮未能交付验证通过的功能**，已回退到文本会话面板（commit 3d0f9bf）。前端 WIP 存为 patch：`scratchpad/tui-frontend-wip-v2.patch`（354 行，含 start/command/run-input 服务方法 + FabricNodeSession 终端模式）。

**已确证可用（后端，真实无 mock）**：slash→交互 run、run-input 输入回传（accepted + 帧 6→18 响应）、terminal-output 帧结构、命令端点 sessionId 字段实为 runId。

**未攻克的障碍（叠加）**：
1. **xterm + Umi 构建 bug**：`TerminalDock` 复用到第二个页面后，xterm 被拆入 async/vendor chunk，实例化时 `Super constructor null`。试过 esbuildMinifyIIFE、jsMinifier=terser、codeSplitting depPerChunk/bigVendors、targets 提到 chrome91，**均未确证修复**。⚠️ 教训：几次"console 干净"是**假信号**——因 xterm 未挂载（会话被 503 挡在 /status 之前）才没报错，非真的修好。验证 xterm 必须确保它真的 mount。
2. **无健康节点可端到端验证**：AWS 因前期过度测试残留 10 个 `opencode --session` 孤儿进程（吃 6.8G/7.7G 内存）→ 新会话 503；重启 9527 server 未清掉这些独立子进程。本机 loopback 节点(local-mac-remote-node)会话起会话返回 400。
3. self-test（dummy terminalRun 强挂 TerminalDock）未见崩溃**也**未见 xterm 挂载，无法据此定论。

**下一步建议**：TUI 终端作为独立里程碑单独立项：先在一个干净环境用最小复现确认 xterm+Umi 的正确加载方式（可能需 externalize xterm 为 UMD、或 MessageArea 现有 Chat 终端到底是否真渲染的对照实验），再接 slash/输入。可待账号4 恢复后委派 aih claude 4（前端构建专长）。当前 main 保持文本会话面板（已验证可用）。
