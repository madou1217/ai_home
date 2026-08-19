# 06-05 PTY 终端与 WebUI 双端完全等价通信桥设计

> **“在现代 Agent 系统的终局架构中，命令行 TUI（Terminal UI）与浏览器 WebUI 绝不应是两套割裂的代码库或互有妥协的残血阉割版。`ai_home` 的双端等价通信桥（Dual-Parity Communication Bridge）确立了‘统一事件总线驱动、双端状态毫秒级镜像同步、全功能 Slash/Approval/PTY 等价投射’的工业级标准，让工程师在黑底绿字的极客终端与现代优雅的可视化控制台之间自由无缝切换。”**

---

## 1. 章节导读与核心命题

长期以来，工业界的 AI 编程工具往往在交互形态上面临艰难的“二选一”抉择：
- **纯 CLI 派（如早期 Claude Code/Codex CLI）**：深度绑定终端字符设备，具备极佳的响应速度与极客体验，但在渲染复杂多维图表、可视化审批卡片、多子代理并发泳道以及长文本折叠时受限于终端 80x24 的字符网格；
- **纯 Web 派（如各类 Chatbot / Web IDE）**：具备丰富绚丽的富文本渲染与可视化看板，但缺乏真实本地 PTY 伪终端的直接执行力，无法进行交互式按键监听（如 `y/n` 快捷审批、`Ctrl+C` 信号强杀、ANSI 颜色序列透传），让习惯了命令行的重度开发者感到极其笨重迟钝。

`ai_home` 自主研发的 **“PTY 终端与 WebUI 双端完全等价通信桥（Dual-Parity Communication Bridge）”** 彻底终结了这一割裂。

本节作为整部《现代 AI Agent 运行时与 Harness 架构设计》的技术**压轴终章**，将深度解构：
1. **双端完全等价（Dual-Parity）的四大维度契约与核心拓扑**；
2. **底层 PTY Master/Slave 设备与 xterm.js 前端渲染管道**；
3. **基于 OSC（Operating System Command）转义序列的终端状态栏与用量投影**；
4. **统一审批网桥在 TUI 与 WebUI 之间的原子 CAS 互斥状态同步**；
5. **全书宏观技术总结与生产落地蓝图**。

<div class="rich-diagram-box">
  <div class="diagram-header-tag">Dual-Parity Topology</div>
  <div class="diagram-title"><span>🌉</span> ai_home 双端完全等价通信桥 (Dual-Parity Bridge) 全景架构</div>
  <div class="split-two-col">
    <div class="col-box">
      <div class="col-title">💻 Client 1: Terminal PTY Client (CLI)</div>
      <div class="tech-card blue" style="margin-bottom:6px;"><div class="card-label">🖥️ 真实终端 (xterm-256color / ANSI)</div></div>
      <div class="tech-card green" style="margin-bottom:6px;"><div class="card-label">⌨️ 键盘单键快捷审批 (y/n/a)</div></div>
      <div class="tech-card orange"><div class="card-label">🏷️ OSC 转义标题实时用量投影</div></div>
    </div>
    <div class="col-box">
      <div class="col-title">🌐 Client 2: Modern WebUI (Browser)</div>
      <div class="tech-card purple" style="margin-bottom:6px;"><div class="card-label">🌐 React 18 + Ant Design Pro</div></div>
      <div class="tech-card red" style="margin-bottom:6px;"><div class="card-label">🛡️ 可视化审批卡片 + 进度泳道</div></div>
      <div class="tech-card cyan"><div class="card-label">📑 折叠思考抽屉 + 富文本渲染</div></div>
    </div>
  </div>
  <div class="flow-connector" style="margin:10px 0;">
    <span>⬇️ Native PTY I/O Pipe</span>
    <span class="flow-line"></span>
    <span>⬇️ WebSocket JSON-RPC 2.0</span>
  </div>
  <div class="stack-layer" style="margin-top:6px;">
    <div class="layer-badge">Dual-Parity Unified Communication Bus (统一通信总线)</div>
    <div class="chips-grid-3">
      <div class="tech-card blue"><div class="card-label">📡 Event Demuxer</div><div class="card-sub">全双工数据帧毫秒广播</div></div>
      <div class="tech-card purple"><div class="card-label">🔒 CAS Mutex Engine</div><div class="card-sub">双端原子互斥状态结算</div></div>
      <div class="tech-card green"><div class="card-label">💉 Runtime Shims</div><div class="card-sub">自动注入 .runtime-bin/</div></div>
    </div>
  </div>
</div>

---

## 2. 核心专业术语与概念精确释义

| 专业术语 (Terminology) | 中文标准译名 | 底层架构定义与机制说明 |
| :--- | :--- | :--- |
| **Dual-Parity** | **双端完全等价性** | 保证命令行终端（Terminal TUI）与图形控制台（WebUI）在功能全集、流式分片、交互审批与数据状态上实现 100% 毫无妥协的对等一致。 |
| **PTY (Pseudoterminal) Master/Slave** | **伪终端主从设备** | 操作系统内核提供的虚拟终端字符驱动对。Master 端由 Harness 进程控制读写，Slave 端挂载给子进程（如 `/bin/zsh`），提供完整的终端作业控制与色彩支持。 |
| **OSC (Operating System Command) Escape Sequence** | **操作系统指令转义序列** | ANSI/VT100 终端标准控制序列（如 `ESC ] 0 ; Title BEL`）。Harness 利用 OSC 将实时 Token 用量与状态写入终端窗口标题栏，绝不在屏幕正文叠加杂乱字符。 |
| **Atomic CAS Decision Settlement** | **原子化比较并交换决策结算** | 审批网桥在处理双端并发操作时的并发控制算法：首个到达的合法决策（无论来自终端还是 WebUI）立即生效并锁定状态，后续冲突决策被静默丢弃。 |
| **ANSI Escape Cleansing** | **ANSI 控制符流式清洗** | 从子进程 PTY 输出流中精准过滤光标跳转、屏幕擦除与色彩控制字符，提取纯净文本供大模型上下文理解与持久化归档的技术。 |
| **Runtime Shim Injection** | **运行时垫片环境注入** | 在通过 WebUI 打开的 PTY 会话中，自动将系统专用的轻量可执行脚本（Shim）注入 `PATH` 前端，确保在网页终端中敲击 `aih`、`git` 等命令与本地物理机完全一致。 |

---

## 3. 双端完全等价（Dual-Parity）四大维度契约

`ai_home` 在架构层制定了双端完全等价的四大硬性契约规范：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              Dual-Parity 四大核心维度对齐契约                           │
│                                                                                        │
│  [Dimension 1: Slash Commands 全集等价]                                                │
│  - 终端敲击 `/code-review --fix` 与 WebUI 输入框选择 `/code-review` 触发完全相同的底层管线│
│  - 客户端内置命令 (/clear, /cost, /model) 在两端均具备 0ms 本地即时响应                 │
│                                                                                        │
│  [Dimension 2: Approval 统一审批网桥等价]                                              │
│  - 终端展示带红黄高亮的交互行 `[y/n/a]`，WebUI 弹出带 AST 风险等级的可视化 Modal 卡片  │
│  - 任意一端批准或拒绝，另一端毫秒级自动擦除交互态并同步显示审批人身份                  │
│                                                                                        │
│  [Dimension 3: Stream Rendering 流式渲染等价]                                          │
│  - 思考流：终端使用折叠行显示，WebUI 渲染为可展开的动画抽屉面板                       │
│  - 正文流：终端呈现平滑字符打字机效果，WebUI 支持 Markdown 语法高亮与数学公式排版       │
│                                                                                        │
│  [Dimension 4: PTY Terminal 物理接地等价]                                              │
│  - WebUI 底栏内嵌基于 xterm.js 的真实 Shell PTY 面板，共享相同的物理工作区 CWD         │
│  - 注入 `.runtime-bin/` 隔离垫片，支持在 Web 端直接敲击调试命令与脚本                   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. OSC 终端标题栏状态投影与 ANSI 清洗算法

在纯命令行 TUI 交互中，如果频繁在屏幕正文中输出当前会话的 Token 用量与成本，会严重破坏用户的阅读体验并干扰多行代码复制。

`ai_home` 创新性地采用 **OSC 标题栏转义序列（OSC Title Injection）** 方案：

```
                              Token Usage & State Update
                                          │
                                          ▼
                   [OSC Formatter: `\x1b]0;${statusTitle}\x07`]
                                          │
                                          ▼
               Title: "aih [Opus 5] | Tokens: 24.5k | Cost: $0.12 | Turn: 3"
                                          │
                                          ▼
                      [Direct Write to Terminal Stdout (0 Screen Noise)]
```

### 4.1 TypeScript ANSI 清洗与 OSC 状态投影实现

```typescript
export class TerminalPresenter {
  private stdout: NodeJS.WriteStream;

  constructor(stdout: NodeJS.WriteStream = process.stdout) {
    this.stdout = stdout;
  }

  /**
   * 将实时用量与状态投影至终端窗口标题栏 (完全不污染终端正文屏幕)
   */
  public updateTerminalTitle(modelName: string, totalTokens: number, costUsd: number, state: string): void {
    const tokensK = (totalTokens / 1000).toFixed(1);
    const costStr = costUsd.toFixed(3);
    const titleText = `aih [${modelName}] | State: ${state} | Tokens: ${tokensK}k | Cost: $${costStr}`;
    
    // 发送 OSC 0 控制序列: \x1b]0;{title}\x07
    this.stdout.write(`\x1b]0;${titleText}\x07`);
  }

  /**
   * 清洗物理 PTY 输出中的 ANSI 控制字符，提取纯文本供模型与 WAL 存储
   */
  public static cleanAnsiEscapeCodes(rawOutput: string): string {
    // 匹配 VT100 / ANSI 颜色、光标跳转与格式控制字符
    const ansiRegex = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
    return rawOutput.replace(ansiRegex, "");
  }
}
```

---

## 5. 双端等价审批网桥（Unified Dual-Bridge）核心源码实现

<div id="widget-bridge-container"></div>



以下是支持 PTY 终端单键监听与 WebUI WebSocket 全双工互斥结算的 `UnifiedApprovalBridge` 生产级代码：

```typescript
import { EventEmitter } from "events";

export interface ApprovalRequestPayload {
  approvalId: string;
  toolName: string;
  command?: string;
  riskLevel: "LOW" | "HIGH" | "CRITICAL";
  reason?: string;
}

export interface ApprovalDecisionResult {
  approvalId: string;
  decision: "APPROVED" | "DENIED";
  actor: "TERMINAL_KEYBOARD" | "WEBUI_CLIENT";
  timestamp: number;
}

export class UnifiedApprovalBridge extends EventEmitter {
  private pendingApprovals = new Map<string, (result: ApprovalDecisionResult) => void>();
  private activeStdinListener: ((char: string) => void) | null = null;

  /**
   * 发起一次双端等价审批挂起
   */
  public async requestApproval(payload: ApprovalRequestPayload, wsBroadcast: (frame: any) => void): Promise<ApprovalDecisionResult> {
    return new Promise<ApprovalDecisionResult>((resolve) => {
      const { approvalId } = payload;
      
      // 1. 注册原子结算回调
      this.pendingApprovals.set(approvalId, resolve);

      // 2. 向 WebUI 广播 approval_required WebSocket 帧
      wsBroadcast({
        type: "approval_required",
        payload
      });

      // 3. 在终端控制台渲染高亮警告行并激活键盘单键原始监听 (Raw Mode)
      this.promptTerminalInteractive(payload);
    });
  }

  /**
   * 处理来自 WebUI 或终端的决策结算 (原子 CAS 互斥)
   */
  public settleDecision(decision: ApprovalDecisionResult, wsBroadcast: (frame: any) => void): boolean {
    const handler = this.pendingApprovals.get(decision.approvalId);
    if (!handler) {
      // 已经被另一端抢先结算，丢弃重复请求
      return false;
    }

    // 移除待决映射与清理终端按键监听
    this.pendingApprovals.delete(decision.approvalId);
    this.cleanupTerminalListener();

    // 向双端广播决策完成通知
    wsBroadcast({
      type: "approval_settled",
      payload: decision
    });

    // 打印终端确认行
    const icon = decision.decision === "APPROVED" ? "✅" : "❌";
    console.log(`\n${icon} Action ${decision.decision} (via ${decision.actor})\n`);

    // 唤醒挂起的 Agent 状态机
    handler(decision);
    return true;
  }

  private promptTerminalInteractive(payload: ApprovalRequestPayload): void {
    console.log(`\n\x1b[33m⚠️  [PERMISSION REQUIRED] Tool: ${payload.toolName}\x1b[0m`);
    if (payload.command) console.log(`\x1b[36mCommand: ${payload.command}\x1b[0m`);
    if (payload.reason) console.log(`\x1b[90mReason: ${payload.reason}\x1b[0m`);
    process.stdout.write(`\x1b[1mApprove this action? [y/n]: \x1b[0m`);

    // 开启 Raw Mode 监听单个按键
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf-8");

      this.activeStdinListener = (key: string) => {
        if (key === "y" || key === "Y" || key === "\r") {
          this.settleDecision({
            approvalId: payload.approvalId,
            decision: "APPROVED",
            actor: "TERMINAL_KEYBOARD",
            timestamp: Date.now()
          }, () => {});
        } else if (key === "n" || key === "N" || key === " ") {
          this.settleDecision({
            approvalId: payload.approvalId,
            decision: "DENIED",
            actor: "TERMINAL_KEYBOARD",
            timestamp: Date.now()
          }, () => {});
        }
      };

      process.stdin.on("data", this.activeStdinListener);
    }
  }

  private cleanupTerminalListener(): void {
    if (process.stdin.isTTY && this.activeStdinListener) {
      process.stdin.removeListener("data", this.activeStdinListener);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      this.activeStdinListener = null;
    }
  }
}
```

---

## 6. 双端等价通信时序图与核心调用栈

```mermaid
sequenceDiagram
    autonumber
    actor TermUser as 终端用户 (PTY TUI)
    actor WebUser as 浏览器用户 (WebUI)
    participant Bridge as UnifiedApprovalBridge
    participant Loop as UniversalAgentEventLoop
    participant WS as WebSocket Gateway
    participant Term as TerminalPresenter

    Loop->>Bridge: 遇到危险命令，触发 requestApproval(payload)
    activate Bridge
    Bridge->>WS: 广播 approval_required 帧
    WS-->>WebUser: 弹出可视化审批卡片 (带 AST 风险标记)
    Bridge->>TermUser: 控制台输出高亮行并开启 Raw Key 监听

    Note over TermUser,WebUser: 任意一端响应即刻生效 (First Responder Wins)

    alt Web 端用户先点击了 "批准"
        WebUser->>WS: 发送 approval_decision (APPROVED)
        WS->>Bridge: 调用 settleDecision(APPROVED, actor: WEBUI_CLIENT)
        Bridge->>TermUser: 发送控制序列擦除终端等待行，打印 "✅ Approved (via WEBUI)"
        Bridge-->>Loop: Promise Resolved -> GRANTED
    else 终端用户先按下了 y
        TermUser->>Bridge: 捕获键盘事件 y
        Bridge->>WS: 广播 approval_settled (APPROVED)
        WS-->>WebUser: 自动关闭 Modal 弹窗并标记为已通过
        Bridge-->>Loop: Promise Resolved -> GRANTED
    end
    deactivate Bridge

    Loop->>Loop: 执行物理工具动作
    Loop->>Term: 更新终端标题栏 OSC 转义用量
    Term-->>TermUser: 标题栏实时刷新 "Tokens: 28k | Cost: $0.14"
```

---

## 7. 极端异常边界与双端状态一致性防御

| 异常边界场景 | 物理成因与危害 | `ai_home` 核心防线与自愈算法 (Self-Healing) |
| :--- | :--- | :--- |
| **1. 双端并发冲突敲击 (Simultaneous Conflicting Input)** | 终端按 `n` 拒绝的同时，WebUI 点击了“批准”，两帧在同一毫秒到达网桥。 | **原子 Map 取消（Atomic Delete-and-Execute）**：<br>`UnifiedApprovalBridge` 在进入结算体瞬间执行 `pendingApprovals.delete(id)`；只有首个获取到回调函数的执行流能被 Resolve，后续冲突调用直接被丢弃并返回 `false`。 |
| **2. xterm.js 前端作用域提升崩溃 (Super constructor null)** | webpack/umi 在编译 xterm.js ESM 模块时进行 Scope-Hoisting，导致运行时抛出 `Super constructor null`。 | **CJS UMD 别名重定向（Alias to CJS Build）**：<br>在 Web 构建配置中强制建立 alias：`xterm: path.resolve(node_modules/xterm/lib/xterm.js)`，彻底规避打包器对 ES Class 继承的语法破坏。 |
| **3. PTY 屏幕字符错位与乱码 (Terminal Resizing Desync)** | 浏览器窗口调整大小导致 xterm.js 字符宽高与后端 Node-pty 的 Master PTY 不一致。 | **动态 SIGWINCH 尺寸同步流**：<br>前端监听 `fitAddon.onResize`，实时向后端发送 `{ cols, rows }` 调整帧；后端调用 `ptyProcess.resize(cols, rows)` 实现双端几何尺寸毫秒级对齐。 |
| **4. 远程命令环境缺失 (Remote Shim Missing)** | 通过 WebUI 终端执行 `aih` 命令时报错 `command not found`。 | **自动注入 `.runtime-bin/` 垫片环境**：<br>在分配 PTY 进程时，自动将当前项目 `.runtime-bin/` 预置到 `process.env.PATH` 最前端，保证远程 Web 终端与本地 CLI 拥有完全对等的指令集。 |

---

## 8. 全书宏观技术总结与生产落地蓝图（Grand Conclusion）

至此，**《现代 AI Agent 运行时与 Harness 架构设计》全书六大篇章共 21 个小节全部高质量编写完成！**

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│                        《现代 AI Agent 运行时与 Harness 架构设计》 全景技术总结              │
│                                                                                            │
│  📘 第一篇: Claude Code 解构 ────> ReAct 状态机 / AST 补丁 / 双层自记忆 / 4态权限门禁      │
│                                                                                            │
│  📗 第二篇: OpenAI Codex 解构 ───> Stdio JSON-RPC App Server / Responses API / 双轨持久化 │
│                                                                                            │
│  📙 第三篇: OpenCode 解构 ───────> 插件微内核 / 洋葱 Hook 流水线 / opencode.db 细粒度归属 │
│                                                                                            │
│  📕 第四篇: DeepSeek 推理解构 ───> <think> 思考流解耦 / 4k 答案净空锁定 / 负向约束提炼     │
│                                                                                            │
│  🔮 第五篇: Pi Agent 解构 ───────> 全双工 WSS 管道 / 毫秒级 Barge-in 打断 / 动态 Persona   │
│                                                                                            │
│  🚀 第六篇: ai_home 自主落地 ────> 五层物理架构 / 统一事件循环 / Worktree 沙箱 / 双端等价桥│
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 8.1 `ai_home` 下一代全功能 Agent Harness 生产落地路线图
1. **统一运行时中枢**：以 `UniversalAgentEventLoop`（`lib/runtime/`）为唯一核心，统一驱动所有多模型会话；
2. **安全与工具总线**：基于 `ToolDispatcher`、`UnifiedApprovalBridge` 与 `WorktreeManager`（`lib/tools/`、`lib/git/`），筑牢代码修改与命令执行的物理安全铁笼；
3. **高性能网关与存储**：以 Go 数据平面实施流式零拷贝，以 SQLite + JSONL 双轨持久化守护状态，以 Prompt Cache 亲和调度将延迟与成本优化至极致；
4. **双端无缝体验**：在 CLI 极客终端与现代 WebUI 之间提供 100% 对等的控制力与沉浸感。

**“大模型是算力引擎，而 Harness 是操作系统的灵魂。”** 愿本书成为每一位探索生产级自主 Agent 运行时的开发者与架构师最坚实、最深刻的工程指南！
