'use strict';

// harness → adapter 的**显式**登记表（只做 TUI，不含 desktop）。
//
// 与 aih peer 的 HARNESS_CHANNELS 同一套纪律：一个 provider 一行，没有「其它 provider
// 走默认」的暗门。新增 harness 必须补一行，否则 test/agent-session-matrix.test.js 会红
// ——它拿 contracts/providers/manifest.json 当名单真值源做双向比对。
//
// candidates 是**有序**的降级链：先试协议级 adapter（能拿到结构化交互），再退到 PTY
// （只能读屏）。facade 按顺序找第一个已实现的模块，全部缺失就报
// agent_session_adapter_unavailable 并列出试过哪些，绝不静默降级成「没有交互」。

const { support } = require('./contracts');

const ADAPTER_CAPABILITIES = Object.freeze([
  Object.freeze({
    adapter: 'acp-stdio',
    label: 'ACP (stdio)',
    transport: 'acp-stdio',
    interactions: Object.freeze({
      approval: support('native', null, {
        evidence: 'ACP session/request_permission（lib/server/acp-session-runner.js requestPermissionFromSurface）'
      }),
      question: support('unsupported', 'ACP 没有提问方法，只能靠 permission 选项承载'),
      plan_confirmation: support('unsupported', 'ACP 没有计划确认方法')
    }),
    note: 'NDJSON over stdio；entry 参数由 lib/runtime/acp-layouts.js 决定'
  }),
  Object.freeze({
    adapter: 'acp-http-sse',
    label: 'ACP (HTTP/SSE)',
    transport: 'acp-http-sse',
    interactions: Object.freeze({
      approval: support('native', null, {
        evidence: 'codebuddy --serve 的 HTTP/SSE 通道承载同一 session/request_permission'
      }),
      question: support('unsupported', 'ACP 没有提问方法'),
      plan_confirmation: support('unsupported', 'ACP 没有计划确认方法')
    }),
    note: '同一个 ACP 合同，传输换成 HTTP + SSE'
  }),
  Object.freeze({
    adapter: 'codex-app-server',
    label: 'Codex app-server',
    transport: 'codex-app-server',
    interactions: Object.freeze({
      approval: support('native', null, {
        evidence: 'item/commandExecution|fileChange|permissions/requestApproval（lib/server/codex-app-server-protocol.js）'
      }),
      question: support('native', null, {
        evidence: 'item/tool/requestUserInput（lib/server/chat-runtime/codex-interaction-request-adapter.js）'
      }),
      plan_confirmation: support('native', null, {
        evidence: 'turn/plan/updated + plan 模式审批策略（APPROVAL_MODE_POLICIES.plan）'
      })
    }),
    note: 'WS JSON-RPC；比 PTY 探测可靠，且带 turn id'
  }),
  Object.freeze({
    adapter: 'claude-stream-mcp',
    label: 'Claude stream-json + MCP',
    transport: 'claude-stream-mcp',
    interactions: Object.freeze({
      approval: support('native', null, {
        evidence: '--permission-prompt-tool mcp__aih__approve（lib/server/claude-permission-mcp-tool.js）'
      }),
      question: support('emulated', 'AskUserQuestion 工具调用被 permission tool 截获后转成 question', {
        evidence: 'claude-permission-mcp-tool 的 tool_name 分流'
      }),
      plan_confirmation: support('emulated', 'ExitPlanMode 走同一 permission tool，映射成 plan_confirmation', {
        evidence: 'claudeApprovalArgs --permission-mode plan（lib/server/native-approval-modes.js）'
      })
    }),
    note: '结构化输出 + 回调式审批；不需要读屏'
  }),
  Object.freeze({
    adapter: 'opencode-serve',
    label: 'OpenCode serve',
    transport: 'opencode-serve',
    interactions: Object.freeze({
      approval: support('native', null, {
        evidence: 'SSE permission.asked + POST /permission/:id/reply（lib/server/chat-runtime/native-approval-transports.js）'
      }),
      question: support('unsupported', 'opencode serve 没有提问端点'),
      plan_confirmation: support('unsupported', 'opencode serve 没有计划确认端点')
    }),
    note: '本地 server + SSE；比 ACP 兼容层稳'
  }),
  Object.freeze({
    adapter: 'pty',
    label: 'PTY 屏幕探测',
    transport: 'pty',
    interactions: Object.freeze({
      approval: support('emulated', '从终端屏幕文本识别确认提示，按序号/按键回写', {
        evidence: 'lib/protocol/native-interactive-prompts.js parseConfirmPrompt/parseNumberedChoicePrompt'
      }),
      question: support('emulated', '识别编号选项提示后回写选项', {
        evidence: 'lib/protocol/native-interactive-prompts.js parseNumberedChoicePrompt'
      }),
      plan_confirmation: support('emulated', '识别 plan 选择提示后回写选项', {
        evidence: 'lib/protocol/native-interactive-prompts.js parseCodexPlanChoiceOptions'
      })
    }),
    note: '最后兜底：没有协议端点、或端点未装时才用；误判风险最高'
  })
]);

const ADAPTER_BY_ID = new Map(ADAPTER_CAPABILITIES.map((row) => [row.adapter, row]));

const HARNESS_ADAPTERS = Object.freeze([
  Object.freeze({ provider: 'codex', label: 'Codex', candidates: Object.freeze(['codex-app-server', 'pty']), phase: 2, note: 'app-server 包装器；PTY 兜底' }),
  Object.freeze({ provider: 'claude', label: 'Claude Code', candidates: Object.freeze(['claude-stream-mcp', 'pty']), phase: 3, note: 'permission-prompt-tool 承载 approval/question/plan' }),
  Object.freeze({ provider: 'gemini', label: 'Gemini CLI', candidates: Object.freeze(['acp-stdio']), phase: 1, note: '--acp 已验证' }),
  Object.freeze({ provider: 'cline', label: 'Cline', candidates: Object.freeze(['acp-stdio']), phase: 1, note: '--acp 已验证，resume 也走 ACP' }),
  Object.freeze({ provider: 'codebuddy', label: 'CodeBuddy', candidates: Object.freeze(['acp-stdio']), phase: 1, note: '--acp / --serve 已验证' }),
  Object.freeze({ provider: 'codebuddycn', label: 'CodeBuddy CN', candidates: Object.freeze(['acp-stdio']), phase: 1, note: '布局为推断，phase 1 需实测确认' }),
  Object.freeze({ provider: 'qoder', label: 'Qoder', candidates: Object.freeze(['acp-stdio']), phase: 1, note: '--acp 已验证；缺 acp_session 能力登记，见计划 §7' }),
  Object.freeze({ provider: 'qodercn', label: 'Qoder CN', candidates: Object.freeze(['acp-stdio']), phase: 1, note: '布局为推断，phase 1 需实测确认' }),
  Object.freeze({ provider: 'kimi', label: 'Kimi CLI', candidates: Object.freeze(['acp-stdio']), phase: 5, note: '有 ACP 布局与能力，但不在 native session 名单里，需先接线' }),
  Object.freeze({ provider: 'opencode', label: 'OpenCode', candidates: Object.freeze(['opencode-serve', 'acp-stdio']), phase: 4, note: 'serve 优先，ACP 兼容层兜底' }),
  Object.freeze({ provider: 'grok', label: 'Grok CLI', candidates: Object.freeze(['pty', 'acp-stdio']), phase: 5, note: '当前只有 PTY；ACP 入口待账号通道' }),
  Object.freeze({ provider: 'agy', label: 'Antigravity CLI', candidates: Object.freeze(['pty']), phase: 6, note: '无 ACP、无审批通道' }),
  Object.freeze({ provider: 'kiro', label: 'Kiro', candidates: Object.freeze(['pty']), phase: 6, note: '无 ACP' }),
  Object.freeze({ provider: 'pi', label: 'pi', candidates: Object.freeze(['pty']), phase: 7, note: '外部 harness，无 ACP' }),
  Object.freeze({ provider: 'dsh-tui', label: 'dsh (TUI)', candidates: Object.freeze(['pty']), phase: 7, note: '外部 harness；dsh 的 web profile 不在范围内' })
]);

// 明确不登记 = 明确不做。desktop 会话不是「还没写」，是「不属于这一层」。
const EXCLUDED_HARNESSES = Object.freeze([
  Object.freeze({ provider: 'zcode', reason: 'desktop 会话（ZCode Desktop），不是 TUI harness' }),
  Object.freeze({ provider: 'workbuddy', reason: 'desktop 会话，审批在桌面进程内' }),
  Object.freeze({ provider: 'workbuddycn', reason: 'desktop 会话，审批在桌面进程内' }),
  Object.freeze({ provider: 'dsh', reason: '外部 harness 的 web profile，不是 TUI 会话' })
]);

const HARNESS_BY_PROVIDER = new Map(HARNESS_ADAPTERS.map((row) => [row.provider, row]));
const EXCLUDED_BY_PROVIDER = new Map(EXCLUDED_HARNESSES.map((row) => [row.provider, row]));

function normalizeProvider(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function getHarnessAdapter(provider) {
  return HARNESS_BY_PROVIDER.get(normalizeProvider(provider)) || null;
}

function listHarnessAdapterRows() {
  return HARNESS_ADAPTERS.slice();
}

function listAdapterCapabilityRows() {
  return ADAPTER_CAPABILITIES.slice();
}

function getAdapterCapabilities(adapterId) {
  return ADAPTER_BY_ID.get(normalizeProvider(adapterId)) || null;
}

function listExcludedHarnesses() {
  return EXCLUDED_HARNESSES.slice();
}

function isExcludedHarness(provider) {
  return EXCLUDED_BY_PROVIDER.has(normalizeProvider(provider));
}

// 返回**有序**候选（带各自能力），供 facade 逐条试装。
function resolveAdapterCandidates(provider) {
  const row = getHarnessAdapter(provider);
  if (!row) return [];
  return row.candidates.map((adapterId) => {
    const capabilities = getAdapterCapabilities(adapterId);
    if (!capabilities) {
      throw new Error(`agent_session_adapter_capability_missing:${adapterId}`);
    }
    return { adapterId, capabilities };
  });
}

function interactionSupport(adapterId, kind) {
  const row = getAdapterCapabilities(adapterId);
  if (!row) return null;
  return row.interactions[kind] || null;
}

module.exports = {
  ADAPTER_CAPABILITIES,
  EXCLUDED_HARNESSES,
  HARNESS_ADAPTERS,
  getAdapterCapabilities,
  getHarnessAdapter,
  interactionSupport,
  isExcludedHarness,
  listAdapterCapabilityRows,
  listExcludedHarnesses,
  listHarnessAdapterRows,
  normalizeProvider,
  resolveAdapterCandidates
};
