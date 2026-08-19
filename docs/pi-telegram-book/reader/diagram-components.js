/**
 * 现代 AI Agent 运行时与 Harness 架构设计 - 原生精美 SVG/HTML 双语流程图组件库
 * (High-Fidelity Bilingual SVG & Visual Flowchart Component Engine)
 */

window.HarnessDiagramComponents = {
  // 1. ReAct 状态机时序流 (Bilingual ReAct State Machine Sequence)
  renderReActSequenceDiagram(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = `
      <div class="rich-diagram-box high-tech-card">
        <div class="diagram-header-tag">Sequence Flow · 时序交互流</div>
        <div class="diagram-title"><span>🔄</span> ReAct 核心事件循环与全双工流式时序 (ReAct Event Loop &amp; Stream Sequence)</div>
        <div class="svg-diagram-wrapper">
          <svg viewBox="0 0 880 460" width="100%" height="100%" class="flow-svg">
            <defs>
              <linearGradient id="grad-blue" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.8"/>
                <stop offset="100%" stop-color="#1d4ed8" stop-opacity="0.9"/>
              </linearGradient>
              <linearGradient id="grad-purple" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#8b5cf6" stop-opacity="0.8"/>
                <stop offset="100%" stop-color="#6d28d9" stop-opacity="0.9"/>
              </linearGradient>
              <linearGradient id="grad-green" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#10b981" stop-opacity="0.8"/>
                <stop offset="100%" stop-color="#047857" stop-opacity="0.9"/>
              </linearGradient>
              <linearGradient id="grad-orange" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.8"/>
                <stop offset="100%" stop-color="#b45309" stop-opacity="0.9"/>
              </linearGradient>
              <linearGradient id="grad-red" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#ef4444" stop-opacity="0.8"/>
                <stop offset="100%" stop-color="#b91c1c" stop-opacity="0.9"/>
              </linearGradient>
              <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            </defs>

            <!-- Participant Lifelines -->
            <!-- User -->
            <g class="lifeline" transform="translate(60, 20)">
              <rect width="100" height="36" rx="6" fill="#1e293b" stroke="#3b82f6" stroke-width="1.5"/>
              <text x="50" y="22" fill="#f8fafc" font-size="12" font-weight="600" text-anchor="middle">👤 User (用户)</text>
              <line x1="50" y1="36" x2="50" y2="420" stroke="#334155" stroke-dasharray="4 4" stroke-width="1.5"/>
            </g>

            <!-- Harness Core -->
            <g class="lifeline" transform="translate(240, 20)">
              <rect width="140" height="36" rx="6" fill="#1e293b" stroke="#8b5cf6" stroke-width="1.5"/>
              <text x="70" y="22" fill="#f8fafc" font-size="12" font-weight="600" text-anchor="middle">⚙️ Harness FSM (状态机)</text>
              <line x1="70" y1="36" x2="70" y2="420" stroke="#334155" stroke-dasharray="4 4" stroke-width="1.5"/>
            </g>

            <!-- LLM Engine -->
            <g class="lifeline" transform="translate(460, 20)">
              <rect width="130" height="36" rx="6" fill="#1e293b" stroke="#f59e0b" stroke-width="1.5"/>
              <text x="65" y="22" fill="#f8fafc" font-size="12" font-weight="600" text-anchor="middle">🧠 LLM Core (模型端)</text>
              <line x1="65" y1="36" x2="65" y2="420" stroke="#334155" stroke-dasharray="4 4" stroke-width="1.5"/>
            </g>

            <!-- Physical Tool Runner -->
            <g class="lifeline" transform="translate(670, 20)">
              <rect width="140" height="36" rx="6" fill="#1e293b" stroke="#10b981" stroke-width="1.5"/>
              <text x="70" y="22" fill="#f8fafc" font-size="12" font-weight="600" text-anchor="middle">💻 Tool Runner (执行层)</text>
              <line x1="70" y1="36" x2="70" y2="420" stroke="#334155" stroke-dasharray="4 4" stroke-width="1.5"/>
            </g>

            <!-- Message 1: User Prompt -->
            <g transform="translate(0, 75)">
              <line x1="110" y1="0" x2="310" y2="0" stroke="#3b82f6" stroke-width="2" marker-end="url(#arrow-blue)"/>
              <text x="210" y="-8" fill="#93c5fd" font-size="11" font-family="var(--font-mono)" text-anchor="middle">1. User Prompt (任务输入)</text>
            </g>

            <!-- Message 2: Hydrate & Forward -->
            <g transform="translate(0, 120)">
              <line x1="310" y1="0" x2="525" y2="0" stroke="#8b5cf6" stroke-width="2"/>
              <text x="417" y="-8" fill="#c4b5fd" font-size="11" font-family="var(--font-mono)" text-anchor="middle">2. POST /v1/messages (带 CWD/Memory)</text>
            </g>

            <!-- Message 3: Stream SSE Thinking & ToolUse -->
            <g transform="translate(0, 175)">
              <line x1="525" y1="0" x2="310" y2="0" stroke="#f59e0b" stroke-width="2" stroke-dasharray="3 3"/>
              <text x="417" y="-8" fill="#fcd34d" font-size="11" font-family="var(--font-mono)" text-anchor="middle">3. SSE Stream: &lt;think&gt; + tool_use(Edit)</text>
            </g>

            <!-- Message 4: Approval Bridge Hook -->
            <g transform="translate(0, 235)">
              <line x1="310" y1="0" x2="110" y2="0" stroke="#ef4444" stroke-width="2"/>
              <text x="210" y="-8" fill="#fca5a5" font-size="11" font-family="var(--font-mono)" text-anchor="middle">4. approval_required (HITL 审批挂起)</text>
            </g>

            <!-- Message 5: User Granted -->
            <g transform="translate(0, 280)">
              <line x1="110" y1="0" x2="310" y2="0" stroke="#10b981" stroke-width="2"/>
              <text x="210" y="-8" fill="#6ee7b7" font-size="11" font-family="var(--font-mono)" text-anchor="middle">5. Decision: GRANTED (批准执行)</text>
            </g>

            <!-- Message 6: Physical Execution in Sandbox -->
            <g transform="translate(0, 330)">
              <line x1="310" y1="0" x2="740" y2="0" stroke="#10b981" stroke-width="2"/>
              <text x="525" y="-8" fill="#6ee7b7" font-size="11" font-family="var(--font-mono)" text-anchor="middle">6. Execute in Git Worktree Sandbox (原子替换)</text>
            </g>

            <!-- Message 7: Tool Observation Result -->
            <g transform="translate(0, 375)">
              <line x1="740" y1="0" x2="310" y2="0" stroke="#3b82f6" stroke-width="2" stroke-dasharray="3 3"/>
              <text x="525" y="-8" fill="#93c5fd" font-size="11" font-family="var(--font-mono)" text-anchor="middle">7. tool_result (捕获 Stdout / 递增 Turn)</text>
            </g>
          </svg>
        </div>
      </div>
    `;
  },

  // 2. 挂载所有章节的富媒体流程图组件
  mountAllDiagrams() {
    this.renderReActSequenceDiagram('diagram-react-sequence');
  }
};
