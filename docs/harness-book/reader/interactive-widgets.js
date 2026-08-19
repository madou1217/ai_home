/**
 * 现代 AI Agent 运行时与 Harness 架构设计 - 交互式可视化仿真引擎
 * (Interactive Visual Simulation Widgets for Harness Book)
 */

window.HarnessInteractiveWidgets = {
  /**
   * 5. Git Worktree 物理并发沙箱与 PTY 进程组隔离动画视效 (for 01-02 & 06-03)
   */
  createWorktreeSandboxSimulator(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    let worktrees = [
      { id: 'wt-01', branch: 'agent/task-auth', status: 'ACTIVE', changes: 3, isolation: 'ISOLATED' },
      { id: 'wt-02', branch: 'agent/task-linter', status: 'COMPLETED', changes: 1, isolation: 'ISOLATED' }
    ];

    const render = () => {
      container.innerHTML = `
        <div class="interactive-card">
          <div class="card-header">
            <div class="card-title">
              <span>🌳</span> 交互式模拟：Git Worktree 物理并发沙箱与 PTY 进程树安全隔离池
            </div>
            <div class="card-controls">
              <button class="sim-btn" id="spawn-wt-btn">➕ 派生新 Worktree 沙箱</button>
              <button class="sim-btn sim-btn-primary" id="merge-wt-btn">🔀 Squash & Merge 任务</button>
              <button class="sim-btn" id="kill-pty-btn">⚡ 模拟超时 PTY 树杀 (SIGKILL -pgid)</button>
            </div>
          </div>

          <div class="worktree-sandbox-grid">
            <!-- Host Main Workspace -->
            <div class="workspace-card host-ws">
              <div class="ws-header">
                <span class="ws-icon">🏠</span>
                <div>
                  <div class="ws-name">Host Main Workspace</div>
                  <div class="ws-branch">Branch: main (Clean & Protected)</div>
                </div>
              </div>
              <div class="ws-status-box">
                <div class="status-indicator online"></div>
                <span>零代码脏写污染 · 生产安全锁定</span>
              </div>
            </div>

            <!-- Isolated Subagent Worktrees -->
            <div class="worktrees-container">
              <div class="wt-list-title">Active Isolated Git Worktrees (沙箱隔离区: .aih/worktrees/)</div>
              <div class="wt-cards-flex">
                ${worktrees.map((wt, idx) => `
                  <div class="sandbox-item-card ${wt.status === 'COMPLETED' ? 'merged' : ''}">
                    <div class="sb-header">
                      <span class="sb-badge">${wt.id}</span>
                      <span class="sb-branch">${wt.branch}</span>
                    </div>
                    <div class="sb-meta">
                      <span>修改文件: <strong>${wt.changes} files</strong></span>
                      <span class="sb-state ${wt.status.toLowerCase()}">${wt.status}</span>
                    </div>
                    <div class="sb-actions">
                      <button class="mini-btn" onclick="window.__discardWt(${idx})">🗑️ 丢弃</button>
                      <button class="mini-btn primary" onclick="window.__mergeWt(${idx})">✅ 合并</button>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          </div>

          <div id="pty-kill-alert" class="pty-kill-log" style="display:none;">
            🚨 [ProcessTreeWatcher]: PTY 子进程 PID: 8820 超时 (120s)。执行 <code>process.kill(-8820, 'SIGKILL')</code> 递归彻底杀灭进程树（包含 node, vite, esbuild 全部子孙进程）。
          </div>
        </div>
      `;

      document.getElementById('spawn-wt-btn').onclick = () => {
        const nextNum = worktrees.length + 1;
        worktrees.push({
          id: `wt-0${nextNum}`,
          branch: `agent/task-fix-${nextNum}`,
          status: 'ACTIVE',
          changes: Math.floor(Math.random() * 4) + 1,
          isolation: 'ISOLATED'
        });
        render();
      };

      document.getElementById('merge-wt-btn').onclick = () => {
        worktrees.forEach(wt => wt.status = 'COMPLETED');
        render();
      };

      document.getElementById('kill-pty-btn').onclick = () => {
        const el = document.getElementById('pty-kill-alert');
        el.style.display = 'block';
        setTimeout(() => el.style.display = 'none', 4000);
      };
    };

    window.__discardWt = (idx) => {
      worktrees.splice(idx, 1);
      render();
    };

    window.__mergeWt = (idx) => {
      if (worktrees[idx]) {
        worktrees[idx].status = 'MERGED';
        render();
      }
    };

    render();
  },

  /**
   * 6. Pi Agent 毫秒级流式波形与即时打断 (Barge-in) 动态模拟器 (for 05-01)
   */
  createBargeInWaveformSimulator(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    let isPlaying = false;
    let isInterrupted = false;
    let tokenCount = 0;
    let timer = null;

    const render = () => {
      container.innerHTML = `
        <div class="interactive-card">
          <div class="card-header">
            <div class="card-title">
              <span>🎙️</span> 交互式模拟：Pi Agent 全双工流式音频波形与 50ms 即时打断 (Barge-in)
            </div>
            <div class="card-controls">
              <button class="sim-btn sim-btn-primary" id="start-voice-btn" ${isPlaying ? 'disabled' : ''}>
                ▶️ 开始播放流式语音
              </button>
              <button class="sim-btn sim-btn-danger" id="bargein-btn" ${!isPlaying ? 'disabled' : ''}>
                ✋ 用户插话打断 (Barge-in)!
              </button>
              <button class="sim-btn" id="reset-voice-btn">🔄 重置</button>
            </div>
          </div>

          <div class="voice-bargein-visual">
            <div class="waveform-box">
              <div class="wave-bars-container ${isPlaying ? 'animating' : ''} ${isInterrupted ? 'interrupted' : ''}">
                ${Array.from({ length: 24 }).map((_, i) => `
                  <div class="wave-bar" style="--delay: ${(i * 0.08).toFixed(2)}s; --h: ${Math.sin(i)*40 + 50}%;"></div>
                `).join('')}
              </div>
              <div class="wave-status-text">
                ${isInterrupted ? '🚨 50ms VAD 捕获插话！已发送 input.interrupt 截断并回滚幽灵分片' : (isPlaying ? '🔊 正在流式播放语音 (Playhead Token #' + tokenCount + ')...' : '⏸️ 麦克风与扬声器就绪')}
              </div>
            </div>

            <div class="token-purge-tracker">
              <div class="tracker-item">
                <span class="tk-label">已生成 Token 数</span>
                <span class="tk-val">${tokenCount}</span>
              </div>
              <div class="tracker-item">
                <span class="tk-label">已播放 Token (Playhead)</span>
                <span class="tk-val">${isInterrupted ? Math.max(0, tokenCount - 8) : tokenCount}</span>
              </div>
              <div class="tracker-item">
                <span class="tk-label">已物理剪裁幽灵 Token</span>
                <span class="tk-val highlight">${isInterrupted ? '8 Tokens' : '0'}</span>
              </div>
            </div>
          </div>
        </div>
      `;

      document.getElementById('start-voice-btn').onclick = () => {
        isPlaying = true;
        isInterrupted = false;
        tokenCount = 0;
        render();

        timer = setInterval(() => {
          tokenCount++;
          if (tokenCount >= 30) {
            clearInterval(timer);
            isPlaying = false;
          }
          render();
        }, 150);
      };

      document.getElementById('bargein-btn').onclick = () => {
        clearInterval(timer);
        isPlaying = false;
        isInterrupted = true;
        render();
      };

      document.getElementById('reset-voice-btn').onclick = () => {
        clearInterval(timer);
        isPlaying = false;
        isInterrupted = false;
        tokenCount = 0;
        render();
      };
    };

    render();
  }

  /**
   * 1. ReAct 7-State FSM 交互式状态机模拟器 (for 01-01 & 06-02)
   */
  createReActSimulator(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const states = [
      { id: 'IDLE', label: '1. IDLE', desc: '会话就绪，等待用户输入', color: '#8b949e', icon: '⚪' },
      { id: 'PERCEIVING', label: '2. PERCEIVING', desc: '环境感知水合: Git HEAD, CWD, MEMORY.md 索引', color: '#58a6ff', icon: '🔍' },
      { id: 'INFERRING', label: '3. INFERRING', desc: '模型流式推理: 实时解包 Thinking / Text / ToolUse', color: '#d29922', icon: '🧠' },
      { id: 'GATING', label: '4. GATING', desc: '4态权限状态机拦截: AST 扫描与双端 HITL 审批', color: '#f85149', icon: '🛡️' },
      { id: 'EXECUTING', label: '5. EXECUTING', desc: '物理工具驱动: PTY 进程隔离 / Git Worktree 沙箱', color: '#bc8cff', icon: '⚡' },
      { id: 'COMPACTING', label: '6. COMPACTING', desc: '上下文水位治理: 80% 水位微观折叠与宏观状态提炼', color: '#39c5bb', icon: '📦' },
      { id: 'COMPLETED', label: '7. COMPLETED', desc: '轮次幂等结算: WAL 追加落盘与 Token 财务归属', color: '#3fb950', icon: '✅' }
    ];

    let currentStep = 0;
    let isAutoPlaying = false;
    let autoPlayTimer = null;

    const render = () => {
      const cur = states[currentStep];
      container.innerHTML = `
        <div class="interactive-card">
          <div class="card-header">
            <div class="card-title">
              <span class="pulse-dot" style="background:${cur.color};"></span>
              🎮 交互式仿真：ReAct 7 态有限状态机生命周期引擎
            </div>
            <div class="card-controls">
              <button class="sim-btn" id="fsm-prev-btn" ${currentStep === 0 ? 'disabled' : ''}>⏮️ 上一步</button>
              <button class="sim-btn sim-btn-primary" id="fsm-next-btn">${currentStep === states.length - 1 ? '🔄 重置循环' : '下一步 ⏭️'}</button>
              <button class="sim-btn" id="fsm-auto-btn">${isAutoPlaying ? '⏸️ 暂停' : '▶️ 自动推演'}</button>
            </div>
          </div>
          
          <div class="fsm-nodes-track">
            ${states.map((s, idx) => `
              <div class="fsm-node ${idx === currentStep ? 'active' : ''} ${idx < currentStep ? 'passed' : ''}" style="--node-color:${s.color};">
                <div class="node-icon">${s.icon}</div>
                <div class="node-label">${s.label}</div>
                ${idx < states.length - 1 ? '<div class="node-arrow">➔</div>' : ''}
              </div>
            `).join('')}
          </div>

          <div class="fsm-inspector-grid">
            <div class="inspector-box">
              <div class="inspector-title">当前状态机内部动作</div>
              <div class="inspector-desc" style="color:${cur.color}; font-weight:600;">${cur.label}: ${cur.desc}</div>
              <div class="inspector-terminal">
                ${getFsmLogOutput(currentStep)}
              </div>
            </div>
            <div class="inspector-box">
              <div class="inspector-title">实时 Wire Protocol 协议帧快照</div>
              <pre class="inspector-payload"><code>${getFsmPayload(currentStep)}</code></pre>
            </div>
          </div>
        </div>
      `;

      document.getElementById('fsm-prev-btn').onclick = () => {
        if (currentStep > 0) { currentStep--; render(); }
      };
      document.getElementById('fsm-next-btn').onclick = () => {
        if (currentStep === states.length - 1) { currentStep = 0; } else { currentStep++; }
        render();
      };
      document.getElementById('fsm-auto-btn').onclick = () => {
        isAutoPlaying = !isAutoPlaying;
        if (isAutoPlaying) {
          autoPlayTimer = setInterval(() => {
            currentStep = (currentStep + 1) % states.length;
            render();
          }, 2500);
        } else {
          clearInterval(autoPlayTimer);
        }
        render();
      };
    };

    function getFsmLogOutput(step) {
      const logs = [
        '[FSM:IDLE] Session listener armed on wss://127.0.0.1:9527. Ready for instructions.',
        '[FSM:PERCEIVE] Snapshot taken: CWD=/workspace, Git HEAD=2fcc2b81. Hydrated MEMORY.md (500 tokens).',
        '[FSM:INFER] Upstream HTTP/2 SSE active. Demuxed thinking stream: "Analyzing bug in auth.ts...". Parsed tool_use: Edit("auth.ts").',
        '[FSM:GATING] AST Safety Scan: Write operation detected on src/auth.ts. Mode: accept-reads -> Prompting Human Approval Bridge.',
        '[FSM:EXECUTE] Granted via WebUI CAS. Spawned node-pty in isolated worktree .aih/worktrees/wt-991. Output clamped at 1.2KB.',
        '[FSM:COMPACT] Context Token Budget at 170k/200k (85%). Triggered Micro-Pruner: folded 3 historical observations.',
        '[FSM:COMPLETED] Turn 2 settled. Persisted WAL events to ~/.aih/sessions/ses_001.jsonl. Total usage: 14,200 tokens ($0.038).'
      ];
      return logs[step];
    }

    function getFsmPayload(step) {
      const payloads = [
        `{\n  "sessionId": "ses_aih_001",\n  "status": "IDLE",\n  "activeTurn": 0\n}`,
        `{\n  "event": "context_hydrated",\n  "gitHead": "2fcc2b81",\n  "cachedPrefixTokens": 8200,\n  "ephemeralBreakpoint": true\n}`,
        `{\n  "event": "content_block_delta",\n  "type": "thinking_delta",\n  "thinking": "Validating JWT expiry logic...",\n  "toolCall": { "name": "Edit", "args": { "file": "auth.ts" } }\n}`,
        `{\n  "event": "approval_required",\n  "approvalId": "appr_9921",\n  "riskLevel": "HIGH",\n  "command": "Edit(src/auth.ts)"\n}`,
        `{\n  "event": "tool_executed",\n  "callId": "call_edit_01",\n  "status": "SUCCESS",\n  "bytesWritten": 1240\n}`,
        `{\n  "event": "compaction_triggered",\n  "tokensBefore": 172000,\n  "tokensAfter": 28500,\n  "reclaimedRatio": "83.4%"\n}`,
        `{\n  "event": "turn_settled",\n  "turnIndex": 2,\n  "stopReason": "end_turn",\n  "costUsd": 0.0382\n}`
      ];
      return payloads[step];
    }

    render();
  },

  /**
   * 2. Prompt Cache Radix Tree & 80% 水位动态压缩模拟器 (for 01-03, 04-03 & 06-04)
   */
  createCacheWatermarkSimulator(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    let totalTokens = 75000;
    const maxTokens = 200000;

    const render = () => {
      const pct = Math.min(100, (totalTokens / maxTokens) * 100);
      const isWarn = pct >= 75 && pct < 80;
      const isCompacting = pct >= 80;
      const cacheHitRatio = totalTokens > 160000 ? 94.5 : (totalTokens > 80000 ? 91.2 : 88.0);

      container.innerHTML = `
        <div class="interactive-card">
          <div class="card-header">
            <div class="card-title">
              <span>📊</span> 交互式模拟：上下文 Token 预算水位线与 Radix Tree KV Cache 亲和布局
            </div>
            <div class="card-controls">
              <button class="sim-btn" id="add-turn-btn">➕ 增加一轮交互 (+25k)</button>
              <button class="sim-btn sim-btn-primary" id="compact-btn" ${!isCompacting ? 'disabled' : ''}>⚡ 立即执行自动滚扎压缩</button>
              <button class="sim-btn" id="reset-cache-btn">🔄 重置</button>
            </div>
          </div>

          <div class="watermark-meter-wrapper">
            <div class="meter-labels">
              <span>当前上下文体积: <strong>${(totalTokens/1000).toFixed(1)}k / ${(maxTokens/1000)}k Tokens</strong> (${pct.toFixed(1)}%)</span>
              <span style="color:${isCompacting ? 'var(--danger)' : (isWarn ? 'var(--warning)' : 'var(--success)')}; font-weight:700;">
                ${isCompacting ? '🚨 超过 80% 警戒线 (触发 Auto-Compaction)' : (isWarn ? '⚠️ 75% 软预警' : '🟢 水位健康安全')}
              </span>
            </div>
            <div class="meter-bar-bg">
              <div class="meter-bar-fill" style="width:${pct}%; background:${isCompacting ? 'linear-gradient(90deg, #d29922, #f85149)' : (isWarn ? 'linear-gradient(90deg, #58a6ff, #d29922)' : 'linear-gradient(90deg, #3fb950, #58a6ff)')};"></div>
              <div class="watermark-marker" style="left:80%;" title="80% 自动压缩触发点">80% Trigger</div>
            </div>
          </div>

          <div class="radix-tree-visual">
            <div class="tree-node root">
              <div class="node-chip static">Node 0: 静态基础系统前缀 (8k)</div>
              <div class="cache-badge">100% Cache Hit</div>
            </div>
            <div class="tree-line"></div>
            <div class="tree-node middle">
              <div class="node-chip mid">Node 1: 压缩状态树 & 负向约束 (${(Math.min(totalTokens, 30000)/1000).toFixed(1)}k)</div>
              <div class="cache-badge">95% Cache Hit</div>
            </div>
            <div class="tree-line"></div>
            <div class="tree-node branch">
              <div class="node-chip active">Node 2: 当前活跃滑动窗口 (${((totalTokens - Math.min(totalTokens, 38000))/1000).toFixed(1)}k)</div>
              <div class="cache-badge dynamic">增量 Prefill (仅 ~1.2k)</div>
            </div>
          </div>

          <div class="cache-stats-row">
            <div class="stat-pill">
              <span class="stat-num">${cacheHitRatio}%</span>
              <span class="stat-label">GPU KV Cache 命中率</span>
            </div>
            <div class="stat-pill">
              <span class="stat-num">&lt; 180ms</span>
              <span class="stat-label">首字生成延迟 (TTFT)</span>
            </div>
            <div class="stat-pill">
              <span class="stat-num">-82.4%</span>
              <span class="stat-label">Token 成本节约率</span>
            </div>
          </div>
        </div>
      `;

      document.getElementById('add-turn-btn').onclick = () => {
        totalTokens = Math.min(maxTokens, totalTokens + 25000);
        render();
      };
      document.getElementById('compact-btn').onclick = () => {
        // 压缩至 32k
        totalTokens = 32000;
        render();
      };
      document.getElementById('reset-cache-btn').onclick = () => {
        totalTokens = 50000;
        render();
      };
    };

    render();
  },

  /**
   * 3. 双端等价审批网桥 (Dual-Parity Approval Bridge) CAS 互斥模拟器 (for 01-06 & 06-05)
   */
  createApprovalBridgeSimulator(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    let bridgeStatus = 'PENDING'; // PENDING | APPROVED | DENIED
    let settledBy = null;

    const render = () => {
      container.innerHTML = `
        <div class="interactive-card">
          <div class="card-header">
            <div class="card-title">
              <span>🛡️</span> 交互式模拟：双端等价审批网桥 (Dual-Parity) 原子 CAS 互斥结算
            </div>
            <button class="sim-btn" id="reset-bridge-btn">🔄 发起新审批任务</button>
          </div>

          <div class="dual-bridge-grid">
            <!-- Left: Terminal TUI -->
            <div class="client-pane terminal-pane">
              <div class="pane-header">💻 终端 Client (PTY TUI - ANSI Raw Mode)</div>
              <div class="terminal-body">
                <p class="term-warn">⚠️ [PERMISSION REQUIRED] Tool: Bash</p>
                <p class="term-cmd">Command: git push --force origin main</p>
                <p class="term-reason">Reason: 检测到对远端生产主干的强推操作 (AST: R003_FORCE_PUSH)</p>
                ${bridgeStatus === 'PENDING' ? `
                  <p class="term-prompt">Approve this action? [<span class="key-hint" id="term-y-btn">y</span>/<span class="key-hint" id="term-n-btn">n</span>/a]: <span class="term-cursor">_</span></p>
                ` : `
                  <p class="term-result ${bridgeStatus === 'APPROVED' ? 'term-success' : 'term-danger'}">
                    ${bridgeStatus === 'APPROVED' ? '✅ Action APPROVED' : '❌ Action DENIED'} (Settled via ${settledBy})
                  </p>
                `}
              </div>
            </div>

            <!-- Center Mutex Bridge -->
            <div class="bridge-center">
              <div class="mutex-badge ${bridgeStatus !== 'PENDING' ? 'locked' : ''}">
                ${bridgeStatus === 'PENDING' ? '🔓 CAS Lock: OPEN' : '🔒 CAS Lock: SETTLED'}
              </div>
              <div class="bridge-arrow-left">◀</div>
              <div class="bridge-arrow-right">▶</div>
            </div>

            <!-- Right: WebUI Client -->
            <div class="client-pane webui-pane">
              <div class="pane-header">🌐 浏览器 Client (WebUI WebSocket Modal)</div>
              <div class="webui-modal-card">
                <div class="modal-risk-tag">RISK: CRITICAL</div>
                <div class="modal-title">高危操作审批拦截</div>
                <div class="modal-body">检测到 Agent 正在尝试执行 Git Force Push。请确认是否授权本次动作。</div>
                <div class="modal-actions">
                  ${bridgeStatus === 'PENDING' ? `
                    <button class="btn btn-danger" id="web-deny-btn">拒绝 (Deny)</button>
                    <button class="btn btn-primary" id="web-approve-btn">批准执行 (Approve)</button>
                  ` : `
                    <div class="settled-status-box">
                      已由 <strong>${settledBy}</strong> 结算为 <strong>${bridgeStatus}</strong>
                    </div>
                  `}
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      if (bridgeStatus === 'PENDING') {
        const settle = (decision, actor) => {
          bridgeStatus = decision;
          settledBy = actor;
          render();
        };

        const termY = document.getElementById('term-y-btn');
        const termN = document.getElementById('term-n-btn');
        const webApprove = document.getElementById('web-approve-btn');
        const webDeny = document.getElementById('web-deny-btn');

        if (termY) termY.onclick = () => settle('APPROVED', 'TERMINAL (Key: y)');
        if (termN) termN.onclick = () => settle('DENIED', 'TERMINAL (Key: n)');
        if (webApprove) webApprove.onclick = () => settle('APPROVED', 'WEBUI (Button Click)');
        if (webDeny) webDeny.onclick = () => settle('DENIED', 'WEBUI (Button Click)');
      }

      document.getElementById('reset-bridge-btn').onclick = () => {
        bridgeStatus = 'PENDING';
        settledBy = null;
        render();
      };
    };

    render();
  },

  /**
   * 4. Thinking Stream Demuxer 流式多路解耦管道模拟器 (for 04-01)
   */
  createDemuxerSimulator(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    let streamState = 'IDLE'; // IDLE | STREAMING_THINK | STREAMING_TEXT | FINISHED

    const render = () => {
      container.innerHTML = `
        <div class="interactive-card">
          <div class="card-header">
            <div class="card-title">
              <span>🧠</span> 交互式模拟：ThinkingStreamDemuxer 思考流/正文流实时解耦管道
            </div>
            <button class="sim-btn sim-btn-primary" id="play-stream-btn" ${streamState.startsWith('STREAMING') ? 'disabled' : ''}>
              ▶️ 播放多路流式解包过程
            </button>
          </div>

          <div class="demuxer-pipeline-flow">
            <div class="pipe-source">
              <div class="pipe-label">Inbound SSE Raw Stream</div>
              <div class="raw-stream-box" id="raw-stream-display">
                ${getRawStreamText(streamState)}
              </div>
            </div>

            <div class="pipe-splitter">
              <div class="splitter-core">Demuxer FSM</div>
              <div class="splitter-arrow top">➔</div>
              <div class="splitter-arrow bottom">➔</div>
            </div>

            <div class="pipe-outputs">
              <div class="output-lane thinking-lane">
                <div class="lane-header">
                  <span class="lane-dot orange"></span>
                  通道 1: Thinking 思考流 (推送到折叠抽屉 / 历史去思考化)
                </div>
                <div class="lane-content" id="thinking-lane-content">
                  ${streamState === 'IDLE' ? '等待流式分片...' : '分析用户意图：重构 auth 鉴权模块。首先需要检索 jwt.ts... 考虑边界时钟漂移...'}
                </div>
              </div>

              <div class="output-lane text-lane">
                <div class="lane-header">
                  <span class="lane-dot cyan"></span>
                  通道 2: Text 正文流 (实时推送至打字机屏幕)
                </div>
                <div class="lane-content" id="text-lane-content">
                  ${streamState === 'STREAMING_TEXT' || streamState === 'FINISHED' ? '我已经为您定位了鉴权模块的漏洞，准备应用修复补丁。' : '等待思考结束...'}
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      document.getElementById('play-stream-btn').onclick = () => {
        streamState = 'STREAMING_THINK';
        render();
        setTimeout(() => {
          streamState = 'STREAMING_TEXT';
          render();
          setTimeout(() => {
            streamState = 'FINISHED';
            render();
          }, 2000);
        }, 2000);
      };
    };

    function getRawStreamText(state) {
      if (state === 'IDLE') return '等待上游网络包...';
      if (state === 'STREAMING_THINK') return '<span class="tok-tag">&lt;think&gt;</span>\n分析用户意图：重构 auth 模块...\n考虑边界时钟漂移...';
      if (state === 'STREAMING_TEXT') return '<span class="tok-tag">&lt;/think&gt;</span>\n我已经为您定位了鉴权模块的漏洞...';
      return '<span class="tok-tag">&lt;think&gt;...&lt;/think&gt;</span>\n[DONE]';
    }

    render();
  },

  /**
   * 自动根据当前章节挂载对应的仿真 Widget
   */
  mountWidgetsForChapter(chapterId) {
    // 挂载 ReAct 状态机模拟器 (01-01 & 06-02)
    if (chapterId.includes('01-01') || chapterId.includes('06-02')) {
      const target = document.getElementById('widget-fsm-container');
      if (target) this.createReActSimulator('widget-fsm-container');
    }
    // 挂载 Git Worktree 沙箱模拟器 (01-02 & 06-03)
    if (chapterId.includes('01-02') || chapterId.includes('06-03')) {
      const target = document.getElementById('widget-worktree-container');
      if (target) this.createWorktreeSandboxSimulator('widget-worktree-container');
    }
    // 挂载 Cache & Compaction 水位模拟器 (01-03, 04-03, 06-04)
    if (chapterId.includes('01-03') || chapterId.includes('04-03') || chapterId.includes('06-04')) {
      const target = document.getElementById('widget-cache-container');
      if (target) this.createCacheWatermarkSimulator('widget-cache-container');
    }
    // 挂载 统一审批网桥模拟器 (01-06 & 06-05)
    if (chapterId.includes('01-06') || chapterId.includes('06-05')) {
      const target = document.getElementById('widget-bridge-container');
      if (target) this.createApprovalBridgeSimulator('widget-bridge-container');
    }
    // 挂载 Thinking 解耦管道模拟器 (04-01)
    if (chapterId.includes('04-01')) {
      const target = document.getElementById('widget-demuxer-container');
      if (target) this.createDemuxerSimulator('widget-demuxer-container');
    }
    // 挂载 Pi Agent 即时打断波形模拟器 (05-01)
    if (chapterId.includes('05-01')) {
      const target = document.getElementById('widget-bargein-container');
      if (target) this.createBargeInWaveformSimulator('widget-bargein-container');
    }
  }
};
