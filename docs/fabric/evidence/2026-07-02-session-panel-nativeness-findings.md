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
