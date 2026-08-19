/**
 * 现代 AI Agent 运行时与 Harness 架构设计 - 交互式可视化仿真引擎全集 (13 个核心交互模拟器)
 */

window.HarnessInteractiveWidgets = {
  // 1. ReAct 7 态状态机模拟器 (01-01 & 06-02)
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
              <div class="inspector-terminal">${getFsmLogOutput(currentStep)}</div>
            </div>
            <div class="inspector-box">
              <div class="inspector-title">实时 Wire Protocol 协议帧快照</div>
              <pre class="inspector-payload"><code>${getFsmPayload(currentStep)}</code></pre>
            </div>
          </div>
        </div>
      `;

      document.getElementById('fsm-prev-btn').onclick = () => { if (currentStep > 0) { currentStep--; render(); } };
      document.getElementById('fsm-next-btn').onclick = () => { if (currentStep === states.length - 1) { currentStep = 0; } else { currentStep++; } render(); };
      document.getElementById('fsm-auto-btn').onclick = () => {
        isAutoPlaying = !isAutoPlaying;
        if (isAutoPlaying) {
          autoPlayTimer = setInterval(() => { currentStep = (currentStep + 1) % states.length; render(); }, 2500);
        } else {
          clearInterval(autoPlayTimer);
        }
        render();
      };
    };

    function getFsmLogOutput(step) {
      return [
        '[FSM:IDLE] Session listener armed on wss://127.0.0.1:9527. Ready for instructions.',
        '[FSM:PERCEIVE] Snapshot taken: CWD=/workspace, Git HEAD=2fcc2b81. Hydrated MEMORY.md (500 tokens).',
        '[FSM:INFER] Upstream HTTP/2 SSE active. Demuxed thinking stream: "Analyzing bug in auth.ts...". Parsed tool_use: Edit("auth.ts").',
        '[FSM:GATING] AST Safety Scan: Write operation detected on src/auth.ts. Mode: accept-reads -> Prompting Human Approval Bridge.',
        '[FSM:EXECUTE] Granted via WebUI CAS. Spawned node-pty in isolated worktree .aih/worktrees/wt-991. Output clamped at 1.2KB.',
        '[FSM:COMPACT] Context Token Budget at 170k/200k (85%). Triggered Micro-Pruner: folded 3 historical observations.',
        '[FSM:COMPLETED] Turn 2 settled. Persisted WAL events to ~/.aih/sessions/ses_001.jsonl. Total usage: 14,200 tokens ($0.038).'
      ][step];
    }

    function getFsmPayload(step) {
      return [
        '{\n  "sessionId": "ses_aih_001",\n  "status": "IDLE",\n  "activeTurn": 0\n}',
        '{\n  "event": "context_hydrated",\n  "gitHead": "2fcc2b81",\n  "cachedPrefixTokens": 8200\n}',
        '{\n  "event": "content_block_delta",\n  "type": "thinking_delta",\n  "thinking": "Validating JWT expiry logic..."\n}',
        '{\n  "event": "approval_required",\n  "approvalId": "appr_9921",\n  "riskLevel": "HIGH"\n}',
        '{\n  "event": "tool_executed",\n  "callId": "call_edit_01",\n  "status": "SUCCESS"\n}',
        '{\n  "event": "compaction_triggered",\n  "tokensBefore": 172000,\n  "tokensAfter": 28500\n}',
        '{\n  "event": "turn_settled",\n  "turnIndex": 2,\n  "costUsd": 0.0382\n}'
      ][step];
    }

    render();
  },

  // 2. Git Worktree 沙箱模拟器 (01-02 & 06-03)
  createWorktreeSandboxSimulator(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    let worktrees = [
      { id: 'wt-01', branch: 'agent/task-auth', status: 'ACTIVE', changes: 3 },
      { id: 'wt-02', branch: 'agent/task-linter', status: 'COMPLETED', changes: 1 }
    ];

    const render = () => {
      container.innerHTML = `
        <div class="interactive-card">
          <div class="card-header">
            <div class="card-title"><span>🌳</span> 交互式模拟：Git Worktree 物理并发沙箱与 PTY 进程树安全隔离池</div>
            <div class="card-controls">
              <button class="sim-btn" id="spawn-wt-btn">➕ 派生新 Worktree 沙箱</button>
              <button class="sim-btn sim-btn-primary" id="merge-wt-btn">🔀 Squash & Merge 任务</button>
              <button class="sim-btn" id="kill-pty-btn">⚡ 模拟超时 PTY 树杀 (SIGKILL -pgid)</button>
            </div>
          </div>
          <div class="worktree-sandbox-grid">
            <div class="workspace-card host-ws">
              <div class="ws-header"><span class="ws-icon">🏠</span><div><div class="ws-name">Host Main Workspace</div><div class="ws-branch">Branch: main (Clean & Protected)</div></div></div>
              <div class="ws-status-box"><div class="status-indicator online"></div><span>零代码脏写污染 · 生产安全锁定</span></div>
            </div>
            <div class="worktrees-container">
              <div class="wt-list-title">Active Isolated Git Worktrees (.aih/worktrees/)</div>
              <div class="wt-cards-flex">
                ${worktrees.map((wt, idx) => `
                  <div class="sandbox-item-card ${wt.status === 'COMPLETED' ? 'merged' : ''}">
                    <div class="sb-header"><span class="sb-badge">${wt.id}</span><span class="sb-branch">${wt.branch}</span></div>
                    <div class="sb-meta"><span>修改: <strong>${wt.changes} files</strong></span><span class="sb-state ${wt.status.toLowerCase()}">${wt.status}</span></div>
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
            🚨 [ProcessTreeWatcher]: PTY 子进程 PID: 8820 超时 (120s)。执行 <code>process.kill(-8820, 'SIGKILL')</code> 递归彻底杀灭进程树。
          </div>
        </div>
      `;

      document.getElementById('spawn-wt-btn').onclick = () => {
        worktrees.push({ id: 'wt-0' + (worktrees.length + 1), branch: 'agent/task-fix-' + (worktrees.length + 1), status: 'ACTIVE', changes: 2 });
        render();
      };
      document.getElementById('merge-wt-btn').onclick = () => {
        worktrees.forEach(wt => wt.status = 'COMPLETED');
        render();
      };
      document.getElementById('kill-pty-btn').onclick = () => {
        const el = document.getElementById('pty-kill-alert');
        el.style.display = 'block';
        setTimeout(() => el.style.display = 'none', 3000);
      };
    };

    window.__discardWt = (idx) => { worktrees.splice(idx, 1); render(); };
    window.__mergeWt = (idx) => { if (worktrees[idx]) { worktrees[idx].status = 'COMPLETED'; render(); } };
    render();
  },

  // 3. Prompt Cache Radix Tree 水位模拟器 (01-03, 04-03, 06-04)
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
            <div class="card-title"><span>📊</span> 交互式模拟：上下文 Token 预算水位线与 Radix Tree KV Cache 亲和布局</div>
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
              <div class="watermark-marker" style="left:80%;">80% Trigger</div>
            </div>
          </div>
          <div class="radix-tree-visual">
            <div class="tree-node"><div class="node-chip static">Node 0: 静态基础系统前缀 (8k)</div><div class="cache-badge">100% Cache Hit</div></div>
            <div class="tree-line"></div>
            <div class="tree-node"><div class="node-chip mid">Node 1: 压缩状态树 & 负向约束 (${(Math.min(totalTokens, 30000)/1000).toFixed(1)}k)</div><div class="cache-badge">95% Cache Hit</div></div>
            <div class="tree-line"></div>
            <div class="tree-node"><div class="node-chip active">Node 2: 当前活跃滑动窗口 (${((totalTokens - Math.min(totalTokens, 38000))/1000).toFixed(1)}k)</div><div class="cache-badge dynamic">增量 Prefill (仅 ~1.2k)</div></div>
          </div>
          <div class="cache-stats-row">
            <div class="stat-pill"><span class="stat-num">${cacheHitRatio}%</span><span class="stat-label">GPU KV Cache 命中率</span></div>
            <div class="stat-pill"><span class="stat-num">&lt; 180ms</span><span class="stat-label">首字生成延迟 (TTFT)</span></div>
            <div class="stat-pill"><span class="stat-num">-82.4%</span><span class="stat-label">Token 成本节约率</span></div>
          </div>
        </div>
      `;

      document.getElementById('add-turn-btn').onclick = () => { totalTokens = Math.min(maxTokens, totalTokens + 25000); render(); };
      document.getElementById('compact-btn').onclick = () => { totalTokens = 32000; render(); };
      document.getElementById('reset-cache-btn').onclick = () => { totalTokens = 50000; render(); };
    };

    render();
  },

  // 4. Subagent 对抗性裁决面板 (01-04)
  createAdversarialJudgeSimulator(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    let claimStatus = 'IDLE';
    let votes = [
      { judge: 'Judge 1: Correctness (正确性)', lens: '寻找边界逻辑反例', vote: null, reason: '' },
      { judge: 'Judge 2: Security (安全性)', lens: '排查越权与注入风险', vote: null, reason: '' },
      { judge: 'Judge 3: Regression (回归性)', lens: '检查历史用例破坏', vote: null, reason: '' }
    ];

    const render = () => {
      container.innerHTML = `
        <div class="interactive-card">
          <div class="card-header">
            <div class="card-title"><span>⚖️</span> 交互式模拟：Subagent 对抗性怀疑者面板 (Adversarial Judge Panel - 2/3 多数票)</div>
            <div class="card-controls">
              <button class="sim-btn sim-btn-primary" id="start-vote-btn" ${claimStatus === 'VOTING' ? 'disabled' : ''}>▶️ 提交补丁并唤起 3 审盲评</button>
              <button class="sim-btn" id="reset-vote-btn">🔄 重置</button>
            </div>
          </div>
          <div class="judge-panel-grid">
            <div class="patch-candidate-box">
              <div class="cand-title">待审代码补丁 (Candidate Patch)</div>
              <div class="cand-code"><code>diff --git a/src/auth.ts\n+ if (!user.isAdmin && token.scope === "sudo") { ... }</code></div>
              <div class="cand-verdict ${claimStatus.toLowerCase()}">
                裁决结论: <strong>${claimStatus === 'IDLE' ? '等待提交' : (claimStatus === 'VOTING' ? '正在盲审投票...' : (claimStatus === 'VERIFIED' ? '✅ 多数票通过 (MERGED)' : '❌ 对抗证伪击穿 (REJECTED)'))}</strong>
              </div>
            </div>
            <div class="judges-list">
              ${votes.map(v => `
                <div class="judge-card ${v.vote ? (v.vote === 'PASS' ? 'passed' : 'refuted') : ''}">
                  <div class="judge-header"><span class="j-name">${v.judge}</span><span class="j-badge ${v.vote ? (v.vote === 'PASS' ? 'pass' : 'fail') : ''}">${v.vote || '等待中'}</span></div>
                  <div class="j-lens">${v.lens}</div>
                  ${v.reason ? `<div class="j-reason">${v.reason}</div>` : ''}
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      `;

      document.getElementById('start-vote-btn').onclick = () => {
        claimStatus = 'VOTING';
        votes.forEach(v => { v.vote = null; v.reason = ''; });
        render();
        setTimeout(() => {
          votes[0].vote = 'PASS'; votes[0].reason = '边界分支已闭合。'; render();
          setTimeout(() => {
            votes[1].vote = 'PASS'; votes[1].reason = '未引入注入点。'; render();
            setTimeout(() => {
              votes[2].vote = 'PASS'; votes[2].reason = '测试全部通过。';
              claimStatus = 'VERIFIED';
              render();
            }, 600);
          }, 600);
        }, 600);
      };
      document.getElementById('reset-vote-btn').onclick = () => { claimStatus = 'IDLE'; votes.forEach(v => { v.vote = null; v.reason = ''; }); render(); };
    };
    render();
  },

  // 5. 双端等价审批网桥 (01-06 & 06-05)
  createApprovalBridgeSimulator(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    let bridgeStatus = 'PENDING';
    let settledBy = null;

    const render = () => {
      container.innerHTML = `
        <div class="interactive-card">
          <div class="card-header">
            <div class="card-title"><span>🛡️</span> 交互式模拟：双端等价审批网桥 (Dual-Parity) 原子 CAS 互斥结算</div>
            <button class="sim-btn" id="reset-bridge-btn">🔄 发起新审批任务</button>
          </div>
          <div class="dual-bridge-grid">
            <div class="client-pane terminal-pane">
              <div class="pane-header">💻 终端 Client (PTY TUI - ANSI Raw Mode)</div>
              <div class="terminal-body">
                <p class="term-warn">⚠️ [PERMISSION REQUIRED] Tool: Bash</p>
                <p class="term-cmd">Command: git push --force origin main</p>
                <p class="term-reason">Reason: 检测到对远端主干的强推操作 (AST: R003_FORCE_PUSH)</p>
                ${bridgeStatus === 'PENDING' ? '<p class="term-prompt">Approve? [<span class="key-hint" id="term-y-btn">y</span>/<span class="key-hint" id="term-n-btn">n</span>/a]: <span class="term-cursor">_</span></p>' : `<p class="term-result ${bridgeStatus === 'APPROVED' ? 'term-success' : 'term-danger'}">${bridgeStatus === 'APPROVED' ? '✅ Action APPROVED' : '❌ Action DENIED'} (Settled via ${settledBy})</p>`}
              </div>
            </div>
            <div class="bridge-center">
              <div class="mutex-badge ${bridgeStatus !== 'PENDING' ? 'locked' : ''}">${bridgeStatus === 'PENDING' ? '🔓 CAS: OPEN' : '🔒 CAS: SETTLED'}</div>
            </div>
            <div class="client-pane webui-pane">
              <div class="pane-header">🌐 浏览器 Client (WebUI WebSocket Modal)</div>
              <div class="webui-modal-card">
                <div class="modal-risk-tag">RISK: CRITICAL</div>
                <div class="modal-title">高危操作审批拦截</div>
                <div class="modal-body">检测到 Agent 正在尝试执行 Git Force Push。请确认是否授权。</div>
                <div class="modal-actions">
                  ${bridgeStatus === 'PENDING' ? '<button class="btn btn-danger" id="web-deny-btn">拒绝</button><button class="btn btn-primary" id="web-approve-btn">批准执行</button>' : `<div class="settled-status-box">已由 <strong>${settledBy}</strong> 结算为 <strong>${bridgeStatus}</strong></div>`}
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      if (bridgeStatus === 'PENDING') {
        const settle = (decision, actor) => { bridgeStatus = decision; settledBy = actor; render(); };
        const termY = document.getElementById('term-y-btn');
        const termN = document.getElementById('term-n-btn');
        const webApprove = document.getElementById('web-approve-btn');
        const webDeny = document.getElementById('web-deny-btn');
        if (termY) termY.onclick = () => settle('APPROVED', 'TERMINAL (Key: y)');
        if (termN) termN.onclick = () => settle('DENIED', 'TERMINAL (Key: n)');
        if (webApprove) webApprove.onclick = () => settle('APPROVED', 'WEBUI (Click)');
        if (webDeny) webDeny.onclick = () => settle('DENIED', 'WEBUI (Click)');
      }
      document.getElementById('reset-bridge-btn').onclick = () => { bridgeStatus = 'PENDING'; settledBy = null; render(); };
    };
    render();
  },

  // 6. Responses API SSE 协议模拟器 (02-01 & 02-02)
  createResponsesSseSimulator(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    let sseEvents = [
      { type: 'response.created', payload: '{"id":"resp_01","status":"in_progress"}' },
      { type: 'response.output_item.added', payload: '{"item":{"id":"item_reasoning","type":"reasoning"}}' },
      { type: 'response.reasoning.delta', payload: '{"delta":"分析 JWT 签名算法混淆漏洞..."}' },
      { type: 'response.output_item.added', payload: '{"item":{"id":"item_func","type":"function_call","name":"bash"}}' },
      { type: 'response.function_call_arguments.delta', payload: '{"call_id":"call_01","delta":"{\"command\":\"git diff\"}"}' },
      { type: 'response.output_item.done', payload: '{"item":{"id":"item_func","status":"completed"}}' },
      { type: 'response.completed', payload: '{"id":"resp_01","status":"completed","usage":{"total_tokens":1420}}' }
    ];
    let currentEventIdx = 0;

    const render = () => {
      container.innerHTML = `
        <div class="interactive-card">
          <div class="card-header">
            <div class="card-title"><span>⚡</span> 交互式模拟：OpenAI Responses API (`POST /v1/responses`) 强类型 SSE 协议流</div>
            <div class="card-controls">
              <button class="sim-btn" id="sse-next-btn" ${currentEventIdx >= sseEvents.length - 1 ? 'disabled' : ''}>⏭️ 下一帧 SSE</button>
              <button class="sim-btn sim-btn-primary" id="sse-reset-btn">🔄 重置</button>
            </div>
          </div>
          <div class="sse-wire-grid">
            <div class="sse-timeline">
              <div class="timeline-title">SSE Event Stream Timeline</div>
              <div class="timeline-events">
                ${sseEvents.map((evt, idx) => `
                  <div class="timeline-event-item ${idx === currentEventIdx ? 'active' : ''} ${idx < currentEventIdx ? 'past' : ''}">
                    <span class="evt-index">#${idx+1}</span>
                    <span class="evt-name">${evt.type}</span>
                  </div>
                `).join('')}
              </div>
            </div>
            <div class="sse-inspector">
              <div class="inspector-title">当前 SSE 帧 JSON 载荷</div>
              <pre class="inspector-payload"><code>event: ${sseEvents[currentEventIdx].type}\ndata: ${sseEvents[currentEventIdx].payload}</code></pre>
            </div>
          </div>
        </div>
      `;

      document.getElementById('sse-next-btn').onclick = () => { if (currentEventIdx < sseEvents.length - 1) { currentEventIdx++; render(); } };
      document.getElementById('sse-reset-btn').onclick = () => { currentEventIdx = 0; render(); };
    };
    render();
  },

  // 7. OpenCode 洋葱 Hook 模拟器 (03-01)
  createOnionPipelineSimulator(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    let currentLayer = 0;
    const layers = [
      { name: 'Layer 1: SecurityGuard (beforeToolDispatch)', desc: '前置拦截：扫描 AST，检查 rm -rf 等破坏性命令' },
      { name: 'Layer 2: TimeoutWatchdog (wrapToolExecution)', desc: '洋葱包裹：启动 120s 进程树超时监控与 Worktree 分配' },
      { name: 'Core Layer: Physical Execution (node-pty/fs)', desc: '核心执行：在物理子进程中执行 Bash 并捕获输出' },
      { name: 'Layer 2: TimeoutWatchdog (afterToolExecuted)', desc: '后置清理：释放超时定时器，记录真实执行耗时' },
      { name: 'Layer 1: AutoLinterPlugin (afterToolExecuted)', desc: '后置收割：检测文件变动并伴随运行 eslint --fix 修复' }
    ];

    const render = () => {
      container.innerHTML = `
        <div class="interactive-card">
          <div class="card-header">
            <div class="card-title"><span>🧅</span> 交互式模拟：OpenCode 插件微内核洋葱模型（Onion Hook Pipeline）</div>
            <button class="sim-btn sim-btn-primary" id="onion-step-btn">${currentLayer === layers.length - 1 ? '🔄 重置流水线' : '进入下一层 next() ⏭️'}</button>
          </div>
          <div class="onion-pipeline-visual">
            <div class="onion-rings-container">
              <div class="onion-ring outer ${currentLayer === 0 || currentLayer === 4 ? 'active' : ''}">
                <div class="ring-label">Plugin 1: Security & Linter</div>
                <div class="onion-ring middle ${currentLayer === 1 || currentLayer === 3 ? 'active' : ''}">
                  <div class="ring-label">Plugin 2: Timeout</div>
                  <div class="onion-ring center ${currentLayer === 2 ? 'active' : ''}"><div class="ring-label">Core Exec</div></div>
                </div>
              </div>
            </div>
            <div class="onion-inspector">
              <div class="onion-stage-title" style="color:var(--accent); font-weight:700;">${layers[currentLayer].name}</div>
              <div class="inspector-desc">${layers[currentLayer].desc}</div>
            </div>
          </div>
        </div>
      `;
      document.getElementById('onion-step-btn').onclick = () => { currentLayer = (currentLayer + 1) % layers.length; render(); };
    };
    render();
  },

  // 8. SQLite Token 财务归属计算器 (03-02)
  createTokenAttributionCalculator(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    let selectedModel = 'claude-opus-5';
    let inputTokens = 12000;
    let cachedTokens = 85000;
    let outputTokens = 1500;

    const render = () => {
      const pricing = {
        'claude-opus-5': { input: 15.0, cacheRead: 1.5, output: 75.0 },
        'gpt-5.5': { input: 5.0, cacheRead: 1.25, output: 15.0 },
        'deepseek-r1': { input: 0.55, cacheRead: 0.14, output: 2.19 }
      }[selectedModel];

      const rawCost = (inputTokens / 1e6) * pricing.input;
      const cacheCost = (cachedTokens / 1e6) * pricing.cacheRead;
      const outCost = (outputTokens / 1e6) * pricing.output;
      const totalCost = rawCost + cacheCost + outCost;
      const savedCost = ((cachedTokens / 1e6) * (pricing.input - pricing.cacheRead));
      const hitRate = ((cachedTokens / (inputTokens + cachedTokens)) * 100).toFixed(1);

      container.innerHTML = `
        <div class="interactive-card">
          <div class="card-header">
            <div class="card-title"><span>💰</span> 交互式模拟：opencode.db 细粒度 Token 财务归属与 Prompt Cache 成本计算器</div>
            <div class="card-controls">
              <select class="sim-select" id="model-select">
                <option value="claude-opus-5" ${selectedModel === 'claude-opus-5' ? 'selected' : ''}>Claude Opus 5</option>
                <option value="gpt-5.5" ${selectedModel === 'gpt-5.5' ? 'selected' : ''}>OpenAI GPT-5.5</option>
                <option value="deepseek-r1" ${selectedModel === 'deepseek-r1' ? 'selected' : ''}>DeepSeek-R1</option>
              </select>
            </div>
          </div>
          <div class="calc-grid">
            <div class="calc-inputs">
              <div class="calc-row"><label>未命中 Input Tokens:</label><input type="range" min="1000" max="50000" step="1000" value="${inputTokens}" id="input-range"><span>${(inputTokens/1000).toFixed(0)}k</span></div>
              <div class="calc-row"><label>命中 Cache Tokens:</label><input type="range" min="10000" max="180000" step="5000" value="${cachedTokens}" id="cache-range"><span>${(cachedTokens/1000).toFixed(0)}k</span></div>
              <div class="calc-row"><label>Output Tokens:</label><input type="range" min="500" max="8000" step="500" value="${outputTokens}" id="out-range"><span>${(outputTokens/1000).toFixed(1)}k</span></div>
            </div>
            <div class="calc-results-box">
              <div class="res-item"><span class="res-label">Cache 命中率:</span><span class="res-val highlight">${hitRate}%</span></div>
              <div class="res-item"><span class="res-label">单轮总成本:</span><span class="res-val">$${totalCost.toFixed(4)}</span></div>
              <div class="res-item"><span class="res-label">Cache 节约:</span><span class="res-val green">+$${savedCost.toFixed(4)} (-90%)</span></div>
            </div>
          </div>
        </div>
      `;

      document.getElementById('model-select').onchange = (e) => { selectedModel = e.target.value; render(); };
      document.getElementById('input-range').oninput = (e) => { inputTokens = parseInt(e.target.value, 10); render(); };
      document.getElementById('cache-range').oninput = (e) => { cachedTokens = parseInt(e.target.value, 10); render(); };
      document.getElementById('out-range').oninput = (e) => { outputTokens = parseInt(e.target.value, 10); render(); };
    };
    render();
  },

  // 9. Zen 智能路由与 Go 数据面 (03-03)
  createZenRouterSimulator(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    let targetStrategy = 'cost-first';

    const render = () => {
      const routeResult = {
        'cost-first': { target: 'DeepSeek-R1 (acc_relay_01)', cost: '$0.002', ttfb: '450ms', reason: '单价最优策略，选择 DeepSeek 高性价比推理节点' },
        'speed-first': { target: 'Claude 3.7 Flash (acc_claude_03)', cost: '$0.015', ttfb: '120ms', reason: '延迟优先策略，选择首字响应最快的 Flash 节点' },
        'quality-first': { target: 'Claude Opus 5 (acc_team_prod)', cost: '$0.045', ttfb: '320ms', reason: '综合质量最优策略，选择顶级 Opus 5 架构师模型' }
      }[targetStrategy];

      container.innerHTML = `
        <div class="interactive-card">
          <div class="card-header">
            <div class="card-title"><span>🧭</span> 交互式模拟：Zen 策略决策大脑与 Go 零拷贝数据平面协同路由</div>
            <div class="card-controls">
              <button class="sim-btn ${targetStrategy === 'cost-first' ? 'sim-btn-primary' : ''}" id="strat-cost">💰 成本优先</button>
              <button class="sim-btn ${targetStrategy === 'speed-first' ? 'sim-btn-primary' : ''}" id="strat-speed">⚡ 延迟优先</button>
              <button class="sim-btn ${targetStrategy === 'quality-first' ? 'sim-btn-primary' : ''}" id="strat-qual">👑 质量优先</button>
            </div>
          </div>
          <div class="zen-flow-grid">
            <div class="zen-step">
              <div class="z-title">1. Zen Policy Engine (TS)</div>
              <div class="z-box">
                <p><strong>策略:</strong> ${targetStrategy.toUpperCase()}</p>
                <p><strong>命中目标:</strong> <span style="color:var(--accent); font-weight:700;">${routeResult.target}</span></p>
                <p style="font-size:11px; color:var(--text-muted); margin-top:4px;">${routeResult.reason}</p>
              </div>
            </div>
            <div class="zen-arrow">➔</div>
            <div class="zen-step">
              <div class="z-title">2. Go Data Plane (Proxy)</div>
              <div class="z-box">
                <p><strong>转发性能:</strong> TTFB ${routeResult.ttfb}</p>
                <p><strong>预估单轮:</strong> ${routeResult.cost}</p>
                <p style="font-size:11px; color:var(--success); margin-top:4px;">✓ HTTP/2 Keep-Alive 零拷贝分帧</p>
              </div>
            </div>
          </div>
        </div>
      `;

      document.getElementById('strat-cost').onclick = () => { targetStrategy = 'cost-first'; render(); };
      document.getElementById('strat-speed').onclick = () => { targetStrategy = 'speed-first'; render(); };
      document.getElementById('strat-qual').onclick = () => { targetStrategy = 'quality-first'; render(); };
    };
    render();
  },

  // 10. Thinking 解耦管道模拟器 (04-01)
  createDemuxerSimulator(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    let streamState = 'IDLE';

    const render = () => {
      container.innerHTML = `
        <div class="interactive-card">
          <div class="card-header">
            <div class="card-title"><span>🧠</span> 交互式模拟：ThinkingStreamDemuxer 思考流/正文流实时解耦管道</div>
            <button class="sim-btn sim-btn-primary" id="play-stream-btn" ${streamState.startsWith('STREAMING') ? 'disabled' : ''}>▶️ 播放多路流式解包过程</button>
          </div>
          <div class="demuxer-pipeline-flow">
            <div class="pipe-source">
              <div class="pipe-label">Inbound SSE Raw Stream</div>
              <div class="raw-stream-box">${getRawStreamText(streamState)}</div>
            </div>
            <div class="pipe-splitter"><div class="splitter-core">Demuxer FSM</div><div class="splitter-arrow">➔</div></div>
            <div class="pipe-outputs">
              <div class="output-lane thinking-lane"><div class="lane-header"><span class="lane-dot orange"></span>通道 1: Thinking 思考流</div><div class="lane-content">${streamState === 'IDLE' ? '等待流式分片...' : '分析用户意图：重构 auth 鉴权模块... 考虑边界时钟漂移...'}</div></div>
              <div class="output-lane text-lane"><div class="lane-header"><span class="lane-dot cyan"></span>通道 2: Text 正文流</div><div class="lane-content">${streamState === 'STREAMING_TEXT' || streamState === 'FINISHED' ? '我已经为您定位了鉴权模块的漏洞，准备应用修复补丁。' : '等待思考结束...'}</div></div>
            </div>
          </div>
        </div>
      `;

      document.getElementById('play-stream-btn').onclick = () => {
        streamState = 'STREAMING_THINK'; render();
        setTimeout(() => { streamState = 'STREAMING_TEXT'; render(); setTimeout(() => { streamState = 'FINISHED'; render(); }, 1500); }, 1500);
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

  // 11. Pi Agent 即时打断波形模拟器 (05-01)
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
            <div class="card-title"><span>🎙️</span> 交互式模拟：Pi Agent 全双工流式音频波形与 50ms 即时打断 (Barge-in)</div>
            <div class="card-controls">
              <button class="sim-btn sim-btn-primary" id="start-voice-btn" ${isPlaying ? 'disabled' : ''}>▶️ 开始播放语音</button>
              <button class="sim-btn sim-btn-danger" id="bargein-btn" ${!isPlaying ? 'disabled' : ''}>✋ 插话打断 (Barge-in)!</button>
              <button class="sim-btn" id="reset-voice-btn">🔄 重置</button>
            </div>
          </div>
          <div class="voice-bargein-visual">
            <div class="waveform-box">
              <div class="wave-bars-container ${isPlaying ? 'animating' : ''} ${isInterrupted ? 'interrupted' : ''}">
                ${Array.from({ length: 20 }).map((_, i) => `<div class="wave-bar" style="--delay: ${(i * 0.08).toFixed(2)}s; --h: ${Math.sin(i)*40 + 50}%;"></div>`).join('')}
              </div>
              <div class="wave-status-text">${isInterrupted ? '🚨 50ms VAD 捕获插话！已发送 input.interrupt 截断并回滚幽灵分片' : (isPlaying ? '🔊 正在流式播放语音 (Playhead Token #' + tokenCount + ')...' : '⏸️ 麦克风与扬声器就绪')}</div>
            </div>
            <div class="token-purge-tracker">
              <div class="tracker-item"><span class="tk-label">已生成 Token</span><span class="tk-val">${tokenCount}</span></div>
              <div class="tracker-item"><span class="tk-label">已播放 Token (Playhead)</span><span class="tk-val">${isInterrupted ? Math.max(0, tokenCount - 8) : tokenCount}</span></div>
              <div class="tracker-item"><span class="tk-label">已物理剪裁幽灵 Token</span><span class="tk-val highlight">${isInterrupted ? '8 Tokens' : '0'}</span></div>
            </div>
          </div>
        </div>
      `;

      document.getElementById('start-voice-btn').onclick = () => {
        isPlaying = true; isInterrupted = false; tokenCount = 0; render();
        timer = setInterval(() => { tokenCount++; if (tokenCount >= 25) { clearInterval(timer); isPlaying = false; } render(); }, 150);
      };
      document.getElementById('bargein-btn').onclick = () => { clearInterval(timer); isPlaying = false; isInterrupted = true; render(); };
      document.getElementById('reset-voice-btn').onclick = () => { clearInterval(timer); isPlaying = false; isInterrupted = false; tokenCount = 0; render(); };
    };
    render();
  },

  // 12. 层次化记忆图谱衰减模拟器 (05-03)
  createMemoryGraphVisualizer(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    let daysPassed = 0;
    let nodes = [
      { name: 'Core: Senior Rust Architect', category: 'PROFILE', w: 1.0, halfLife: 9999, immutable: true },
      { name: 'Tech: Prefers Async Tokio', category: 'TECH', w: 0.95, halfLife: 30 },
      { name: 'Project: ai_home Gateway', category: 'PROJECT', w: 0.88, halfLife: 14 },
      { name: 'Episodic: Debugged WebSocket bug', category: 'EPISODIC', w: 0.75, halfLife: 3 }
    ];

    const render = () => {
      container.innerHTML = `
        <div class="interactive-card">
          <div class="card-header">
            <div class="card-title"><span>🧬</span> 交互式模拟：Pi Agent 层次化动态记忆图谱（HMG）时间衰减与强化跃迁</div>
            <div class="card-controls">
              <button class="sim-btn" id="advance-time-btn">⏳ 时间流逝 (+5 天)</button>
              <button class="sim-btn sim-btn-primary" id="reinforce-btn">⚡ 再次提及并强化记忆</button>
              <button class="sim-btn" id="reset-mem-btn">🔄 重置</button>
            </div>
          </div>
          <div class="memory-graph-grid">
            <div class="time-gauge"><span>当前相对时间: <strong>第 ${daysPassed} 天</strong></span><span style="font-size:11px; color:var(--text-muted);">艾宾浩斯指数衰减公式: $W(t) = W_0 \cdot e^{-\lambda t}$</span></div>
            <div class="nodes-list-box">
              ${nodes.map(n => {
                const currentWeight = n.immutable ? 1.0 : (n.w * Math.exp(- (Math.LN2 / n.halfLife) * daysPassed));
                const isArchived = currentWeight < 0.2;
                return `
                  <div class="hmg-node-card ${isArchived ? 'archived' : ''}">
                    <div class="hmg-header"><span class="hmg-cat ${n.category.toLowerCase()}">${n.category}</span><span class="hmg-name">${n.name}</span><span class="hmg-weight ${currentWeight > 0.6 ? 'high' : 'low'}">权重: ${currentWeight.toFixed(2)}</span></div>
                    <div class="hmg-bar-bg"><div class="hmg-bar-fill" style="width:${Math.max(0, currentWeight * 100)}%; background:${isArchived ? 'var(--text-muted)' : (currentWeight > 0.5 ? 'var(--success)' : 'var(--warning)')};"></div></div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        </div>
      `;

      document.getElementById('advance-time-btn').onclick = () => { daysPassed += 5; render(); };
      document.getElementById('reinforce-btn').onclick = () => { daysPassed = Math.max(0, daysPassed - 3); nodes[1].w = 1.0; nodes[2].w = 1.0; render(); };
      document.getElementById('reset-mem-btn').onclick = () => { daysPassed = 0; nodes[1].w = 0.95; nodes[2].w = 0.88; render(); };
    };
    render();
  },

  // 13. ai_home 五层物理架构探索器 (06-01)
  createLayeredArchitectureExplorer(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    let selectedLayer = 1;
    const layersData = [
      { id: 1, name: 'Layer 1: Presentation & Ingress (交互接入层)', components: ['Terminal PTY (xterm.js)', 'WebUI (React/AntD Pro)', 'IDE Extension IPC'], desc: '负责用户输入捕获、流式渲染、双端等价审批与长连接维护。严禁包含业务逻辑。' },
      { id: 2, name: 'Layer 2: Core Orchestration (核心调度层)', components: ['UniversalAgentEventLoop', 'ContextOrchestrator', 'PermissionGatekeeper', 'SubagentPool'], desc: '核心 FSM 状态机中枢，管理 ReAct 循环、上下文压缩与权限拦截。' },
      { id: 3, name: 'Layer 3: Tools & Execution (工具与沙箱层)', components: ['Built-in Tools (Read/Edit/Bash)', 'MCP Bridge', 'Git Worktree Manager'], desc: '物理执行接地层，提供进程树超时强杀与临时文件系统并发隔离。' },
      { id: 4, name: 'Layer 4: Multi-Model Gateway (网关与路由层)', components: ['Zen Policy Engine', 'Circuit Breaker', 'Go Data Plane Proxy'], desc: '负责多账号凭据投影、四态熔断、Prompt Cache 亲和调度与零拷贝流式转发。' },
      { id: 5, name: 'Layer 5: Persistence & Memory (持久化与记忆层)', components: ['SQLite 3 (WAL)', 'JSONL Event Sourcing', 'Hierarchical Memory Graph'], desc: '双轨存储底座，记录不可变事件物理流、实体索引与长效记忆图谱。' }
    ];

    const render = () => {
      const cur = layersData[selectedLayer - 1];
      container.innerHTML = `
        <div class="interactive-card">
          <div class="card-header">
            <div class="card-title"><span>🏛️</span> 交互式探索：ai_home 下一代 Agent Harness 五层物理架构拓扑</div>
            <span style="font-size:12px; color:var(--text-muted);">点击各层查看职责边界</span>
          </div>
          <div class="arch-explorer-grid">
            <div class="layers-stack">
              ${layersData.map(l => `
                <div class="layer-item ${l.id === selectedLayer ? 'active' : ''}" onclick="window.__selectLayer(${l.id})">
                  <span class="l-num">L${l.id}</span>
                  <span class="l-name">${l.name}</span>
                </div>
              `).join('')}
            </div>
            <div class="layer-detail-box">
              <div class="ld-title" style="color:var(--accent); font-weight:700; margin-bottom:8px;">${cur.name}</div>
              <p style="font-size:12.5px; line-height:1.6; margin-bottom:12px;">${cur.desc}</p>
              <div class="comp-list-title" style="font-size:11px; font-weight:700; color:var(--text-muted); text-transform:uppercase; margin-bottom:6px;">包含核心模块组件:</div>
              <div class="comp-badges-flex">${cur.components.map(c => `<span class="comp-badge">${c}</span>`).join('')}</div>
            </div>
          </div>
        </div>
      `;
    };

    window.__selectLayer = (id) => { selectedLayer = id; render(); };
    render();
  },

  // 统一挂载入口
  mountWidgetsForChapter(chapterId) {
    if (chapterId.includes('01-01') || chapterId.includes('06-02')) this.createReActSimulator('widget-fsm-container');
    if (chapterId.includes('01-02') || chapterId.includes('06-03')) this.createWorktreeSandboxSimulator('widget-worktree-container');
    if (chapterId.includes('01-03') || chapterId.includes('04-03') || chapterId.includes('06-04')) this.createCacheWatermarkSimulator('widget-cache-container');
    if (chapterId.includes('01-04')) this.createAdversarialJudgeSimulator('widget-judge-container');
    if (chapterId.includes('01-06') || chapterId.includes('06-05')) this.createApprovalBridgeSimulator('widget-bridge-container');
    if (chapterId.includes('02-01') || chapterId.includes('02-02')) this.createResponsesSseSimulator('widget-responses-container');
    if (chapterId.includes('03-01')) this.createOnionPipelineSimulator('widget-onion-container');
    if (chapterId.includes('03-02')) this.createTokenAttributionCalculator('widget-attribution-container');
    if (chapterId.includes('03-03')) this.createZenRouterSimulator('widget-zen-container');
    if (chapterId.includes('04-01')) this.createDemuxerSimulator('widget-demuxer-container');
    if (chapterId.includes('05-01')) this.createBargeInWaveformSimulator('widget-bargein-container');
    if (chapterId.includes('05-03')) this.createMemoryGraphVisualizer('widget-memory-graph-container');
    if (chapterId.includes('06-01')) this.createLayeredArchitectureExplorer('widget-arch-container');
  }
};
