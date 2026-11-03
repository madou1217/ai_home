'use strict';

// Agent Session 契约（provider 中立）。
//
// 这一层回答一个问题：不管 harness 讲 ACP、Codex app-server、Claude stream-json+MCP、
// OpenCode serve 还是只能读 PTY 屏幕，向上都只暴露同一组「会话事件 + 交互请求」。
//
// 为什么不在这里再定义一套事件名：`aih.chat.event.v1` 已经是 WebUI 与 chat runtime
// 的事实契约，抄第二份必然漂移（WebUI 认 question、CLI 认 ask）。因此事件名、交互
// kind、会话状态都从 `lib/server/chat-runtime` 的叶子常量表取；那边只有常量与纯校验，
// 没有 I/O，下沉给 CLI 不会把服务端运行时拖进来。

const {
  CHAT_EVENT_SCHEMA,
  EVENT_TYPES,
  SESSION_STATES,
  TIMELINE_KINDS
} = require('../server/chat-runtime/contract-values');
const {
  normalizeCanonicalInteractionPayload
} = require('../server/chat-runtime/canonical-interaction-payload');

const AGENT_SESSION_EVENT_SCHEMA = CHAT_EVENT_SCHEMA;

const SUPPORT_LEVELS = Object.freeze(['native', 'emulated', 'unsupported']);
const INTERACTION_KINDS = Object.freeze(['approval', 'question', 'plan_confirmation']);
const INTERACTION_STATES = Object.freeze(['pending', 'resolved', 'expired']);
const DECISION_ACTIONS = Object.freeze(['submit', 'decline', 'cancel']);
const ADAPTER_TRANSPORTS = Object.freeze([
  'acp-stdio',
  'acp-http-sse',
  'codex-app-server',
  'claude-stream-mcp',
  'opencode-serve',
  'pty'
]);

class AgentSessionError extends Error {
  constructor(code, details) {
    super(code);
    this.name = 'AgentSessionError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

// 能力必须自证：声称 native/emulated 就得给证据（哪个协议方法/哪个文件），
// 声称 unsupported 就得给理由。没有第三种「大概是吧」。
function support(level, reason, extra) {
  if (!SUPPORT_LEVELS.includes(level)) {
    throw new AgentSessionError('agent_session_support_level_invalid', { level });
  }
  const normalized = {
    level,
    reason: nonEmptyString(reason) || null,
    evidence: nonEmptyString(extra && extra.evidence) || null
  };
  if (level !== 'unsupported' && !normalized.evidence) {
    throw new AgentSessionError('agent_session_support_evidence_required', { level });
  }
  if (level === 'unsupported' && !normalized.reason) {
    throw new AgentSessionError('agent_session_support_reason_required', { level });
  }
  if (extra && extra.verifiedAt) normalized.verifiedAt = String(extra.verifiedAt);
  return Object.freeze(normalized);
}

function normalizeInteractionRequest(input) {
  const request = isPlainObject(input) ? input : {};
  const interactionId = nonEmptyString(request.interactionId);
  if (!interactionId) throw new AgentSessionError('agent_session_interaction_id_required');
  const kind = nonEmptyString(request.kind);
  if (!INTERACTION_KINDS.includes(kind)) {
    throw new AgentSessionError('agent_session_interaction_kind_invalid', { kind });
  }
  let payload;
  try {
    payload = normalizeCanonicalInteractionPayload(kind, request.payload);
  } catch (error) {
    throw new AgentSessionError('agent_session_interaction_payload_invalid', {
      kind,
      cause: error && error.code ? error.code : String(error && error.message)
    });
  }
  const normalized = {
    interactionId,
    kind,
    payload,
    turnId: nonEmptyString(request.turnId) || null,
    itemId: nonEmptyString(request.itemId) || null
  };
  const timeoutMs = Number(request.timeoutMs);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) normalized.timeoutMs = Math.floor(timeoutMs);
  if (request.autoResolution) normalized.autoResolution = request.autoResolution;
  return Object.freeze(normalized);
}

function normalizeAnswers(payload, input) {
  if (input == null) return null;
  if (!isPlainObject(input)) {
    throw new AgentSessionError('agent_session_decision_answers_invalid');
  }
  const fieldIds = new Set((payload.fields || []).map((field) => field.id));
  const answers = {};
  for (const [key, value] of Object.entries(input)) {
    if (!fieldIds.has(key)) {
      throw new AgentSessionError('agent_session_decision_answer_unknown_field', { field: key });
    }
    if (Array.isArray(value)) {
      answers[key] = value.map((entry) => String(entry));
    } else if (typeof value === 'string') {
      answers[key] = value;
    } else {
      throw new AgentSessionError('agent_session_decision_answer_invalid', { field: key });
    }
  }
  return Object.freeze(answers);
}

// 决策形状按 kind 分流：approval 只能选一个 choiceId，question/plan_confirmation
// 只能 submit|decline|cancel。拒绝「多带字段」——多余字段通常意味着调用方
// 把两种交互搞混了，静默忽略会变成假成功。
function normalizeDecision(kind, payload, decision) {
  if (!INTERACTION_KINDS.includes(kind)) {
    throw new AgentSessionError('agent_session_interaction_kind_invalid', { kind });
  }
  const input = isPlainObject(decision) ? decision : {};
  if (kind === 'approval') {
    const choiceId = nonEmptyString(input.choiceId);
    if (!choiceId) throw new AgentSessionError('agent_session_decision_choice_required', { kind });
    const allowed = new Set((payload.choices || []).map((choice) => choice.id));
    if (!allowed.has(choiceId)) {
      throw new AgentSessionError('agent_session_decision_choice_unknown', { choiceId });
    }
    return Object.freeze({ choiceId });
  }
  const action = nonEmptyString(input.action) || 'submit';
  if (!DECISION_ACTIONS.includes(action)) {
    throw new AgentSessionError('agent_session_decision_action_invalid', { action });
  }
  // 只允许 payload 声明过的动作：question 只给 ['submit'] 时传 decline，
  // router 会先落 resolved、adapter 再失败关闭，harness 就永远收不到响应。
  const offered = Array.isArray(payload.actions) ? payload.actions : [];
  if (offered.length > 0 && !offered.includes(action)) {
    throw new AgentSessionError('agent_session_decision_action_not_offered', { action, offered });
  }
  const answers = normalizeAnswers(payload, input.answers);
  if (action === 'submit' && payload.answerShape !== 'none' && !answers) {
    throw new AgentSessionError('agent_session_decision_answers_required', { kind });
  }
  return Object.freeze(action === 'submit' ? { action, answers: answers || Object.freeze({}) } : { action });
}

function assertEventType(type) {
  const normalized = nonEmptyString(type);
  if (!EVENT_TYPES.has(normalized)) {
    throw new AgentSessionError('agent_session_event_type_unknown', { type: normalized });
  }
  return normalized;
}

function assertSessionState(state) {
  const normalized = nonEmptyString(state);
  if (!SESSION_STATES.has(normalized)) {
    throw new AgentSessionError('agent_session_state_invalid', { state: normalized });
  }
  return normalized;
}

module.exports = {
  ADAPTER_TRANSPORTS,
  AGENT_SESSION_EVENT_SCHEMA,
  AgentSessionError,
  DECISION_ACTIONS,
  INTERACTION_KINDS,
  INTERACTION_STATES,
  SUPPORT_LEVELS,
  TIMELINE_KINDS,
  assertEventType,
  assertSessionState,
  isPlainObject,
  nonEmptyString,
  normalizeDecision,
  normalizeInteractionRequest,
  support
};
