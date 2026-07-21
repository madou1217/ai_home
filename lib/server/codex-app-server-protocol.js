'use strict';

// codex app-server(JSON-RPC over ws)协议编解码：纯函数,无 IO(P3b)。
//
// 协议真相来自 S3 spike 实证(scratchpad/appserver/spike-*.jsonl + schema/)：
//   thread/start {cwd,approvalPolicy,sandbox} → resp.thread.id == sessionId == rollout UUID
//   turn/start {threadId,input:[{type:'text',...}]} → resp.turn.id == turnId
//   流式 notification:item/agentMessage/delta(正文增量)、item/reasoning/*Delta(思考)、
//   item/started|completed(工具卡)、turn/completed(收尾)、thread/status/changed。
//   审批 = server→client 的 JSON-RPC request(带 id)：item/commandExecution/requestApproval /
//   item/fileChange/requestApproval;回 {"id":<同id>,"result":{"decision":"accept"|"decline"}}。
//
// 事件形状与 native-session-chat parseNativeStreamEvent 的 codex 分支对齐：
//   {type:'delta'|'thinking'|'assistant_tool_call'|'assistant_tool_result'|'result'|'error',...}

const { renderNativeToolCallTag, renderNativeToolResultTag } = require('./native-tool-tags');
const { createRetryStatus } = require('./native-retry-status');

const APPROVAL_REQUEST_METHODS = Object.freeze([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval'
]);

const REASONING_DELTA_METHODS = new Set([
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta'
]);

const APPROVAL_MODE_POLICIES = Object.freeze({
  bypass: Object.freeze({
    approvalPolicy: 'never',
    threadSandbox: 'danger-full-access',
    turnSandboxPolicy: Object.freeze({ type: 'dangerFullAccess' })
  }),
  confirm: Object.freeze({
    approvalPolicy: 'untrusted',
    threadSandbox: 'workspace-write',
    turnSandboxPolicy: Object.freeze({ type: 'workspaceWrite' })
  }),
  plan: Object.freeze({
    approvalPolicy: 'untrusted',
    threadSandbox: 'workspace-write',
    turnSandboxPolicy: Object.freeze({ type: 'workspaceWrite' })
  })
});

// 不渲染为工具卡的 item 类型（正文/思考/用户消息各有专门通道）。
const NON_TOOL_ITEM_TYPES = new Set(['agentMessage', 'userMessage', 'reasoning', 'error']);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveApprovalModePolicy(approvalMode) {
  const mode = normalizeString(approvalMode).toLowerCase();
  const policy = APPROVAL_MODE_POLICIES[mode];
  if (policy) return policy;
  const error = new Error(`unsupported Codex approval mode: ${mode || '(empty)'}`);
  error.code = 'codex_approval_mode_unsupported';
  throw error;
}

function buildApprovalPolicyParams(approvalMode) {
  const policy = resolveApprovalModePolicy(approvalMode);
  return {
    approvalPolicy: policy.approvalPolicy,
    sandbox: policy.threadSandbox
  };
}

function buildTurnApprovalPolicyParams(approvalMode) {
  const policy = resolveApprovalModePolicy(approvalMode);
  return {
    approvalPolicy: policy.approvalPolicy,
    sandboxPolicy: { ...policy.turnSandboxPolicy }
  };
}

function buildThreadStartParams(options = {}) {
  const params = buildApprovalPolicyParams(options.approvalMode);
  const cwd = normalizeString(options.cwd);
  if (cwd) params.cwd = cwd;
  return params;
}

function buildThreadResumeParams(options = {}) {
  const params = {
    threadId: normalizeString(options.threadId),
    ...buildApprovalPolicyParams(options.approvalMode)
  };
  if (options.excludeTurns === true) params.excludeTurns = true;
  return params;
}

function buildTurnStartParams(options = {}) {
  const input = [{ type: 'text', text: String(options.prompt || '') }];
  for (const imagePath of (Array.isArray(options.imagePaths) ? options.imagePaths : [])) {
    const normalized = normalizeString(imagePath);
    if (normalized) input.push({ type: 'localImage', path: normalized });
  }
  const params = {
    ...buildTurnApprovalPolicyParams(options.approvalMode),
    threadId: normalizeString(options.threadId),
    input
  };
  const clientUserMessageId = normalizeString(options.clientUserMessageId);
  if (clientUserMessageId) params.clientUserMessageId = clientUserMessageId;
  const model = normalizeString(options.model);
  if (model) params.model = model;
  const reasoningEffort = normalizeString(options.reasoningEffort).toLowerCase();
  if (reasoningEffort) params.effort = reasoningEffort;
  if (model && reasoningEffort) {
    params.collaborationMode = {
      mode: normalizeString(options.approvalMode).toLowerCase() === 'plan'
        ? 'plan'
        : 'default',
      settings: {
        model,
        reasoning_effort: reasoningEffort,
        developer_instructions: null
      }
    };
  }
  return params;
}

function buildTurnSteerParams(options = {}) {
  return {
    threadId: normalizeString(options.threadId),
    expectedTurnId: normalizeString(options.turnId),
    input: [{ type: 'text', text: String(options.text || '') }]
  };
}

function buildTurnInterruptParams(options = {}) {
  return {
    threadId: normalizeString(options.threadId),
    turnId: normalizeString(options.turnId)
  };
}

// 每个 turn 一份观察状态：正文累计、item 缓存(审批详情/工具结果引用)、去重集。
function createTurnObserverState(threadId) {
  return {
    threadId: normalizeString(threadId),
    turnId: '',
    content: '',
    deltaTextByItem: new Map(), // itemId -> 已流出的正文(completed 帧据此补差额)
    itemsById: new Map(), // itemId -> item(item/started 缓存,审批/结果详情引用)
    toolCallEmitted: new Set(), // itemId 去重(工具卡只发一次)
    failureMessage: ''
  };
}

// app-server item → 工具三元组(name/args/result)。非工具项返回 null。
// 命名与 exec 路径 codexItemToTool 对齐(commandExecution→Shell),前端渲染一致。
function codexAppServerItemToTool(item) {
  if (!item || typeof item !== 'object') return null;
  const type = String(item.type || '');
  if (!type || NON_TOOL_ITEM_TYPES.has(type)) return null;
  if (type === 'commandExecution') {
    const exitCode = Number.isFinite(Number(item.exitCode)) && item.exitCode !== null
      ? Number(item.exitCode)
      : null;
    const output = normalizeString(item.aggregatedOutput);
    return {
      name: 'Shell',
      args: item.command || '',
      result: output || (exitCode !== null ? `(exit ${exitCode})` : '')
    };
  }
  if (type === 'fileChange') {
    const changes = (Array.isArray(item.changes) ? item.changes : []).map((change) => ({
      path: normalizeString(change && change.path),
      kind: normalizeString(change && change.kind && change.kind.type),
      diff: typeof (change && change.diff) === 'string' ? change.diff : ''
    }));
    return {
      name: 'FileChange',
      args: changes,
      result: normalizeString(item.status) === 'completed'
        ? changes.map((change) => `${change.kind || 'edit'} ${change.path}`).join('\n')
        : ''
    };
  }
  return {
    name: type,
    args: item.command || item.input || item.arguments || item.changes || item.path || item,
    result: item.aggregatedOutput || item.output || item.result || ''
  };
}

function belongsToThread(state, params) {
  const threadId = normalizeString(params && params.threadId);
  // 无 threadId 的全局通知(account/* 等)不属于任何 turn。
  if (!threadId || !state || !state.threadId) return false;
  return threadId === state.threadId;
}

// server notification → onEvent 事件数组(可能为空)。state 就地更新。
function mapServerNotification(message, state) {
  if (!message || typeof message !== 'object' || !message.method) return [];
  const method = String(message.method);
  const params = (message.params && typeof message.params === 'object') ? message.params : {};
  if (!belongsToThread(state, params)) return [];

  if (method === 'turn/started') {
    const turnId = normalizeString(params.turn && params.turn.id);
    if (turnId) state.turnId = turnId;
    return [];
  }

  if (method === 'item/agentMessage/delta') {
    const delta = typeof params.delta === 'string' ? params.delta : '';
    if (!delta) return [];
    const itemId = normalizeString(params.itemId);
    state.deltaTextByItem.set(itemId, (state.deltaTextByItem.get(itemId) || '') + delta);
    state.content += delta;
    return [{ type: 'delta', delta }];
  }

  if (REASONING_DELTA_METHODS.has(method)) {
    const delta = typeof params.delta === 'string' ? params.delta : '';
    return delta ? [{ type: 'thinking', thinking: delta }] : [];
  }

  if (method === 'item/started' || method === 'item/completed') {
    const item = params.item && typeof params.item === 'object' ? params.item : null;
    if (!item) return [];
    const itemId = normalizeString(item.id);
    if (itemId) state.itemsById.set(itemId, item);

    // agentMessage 完成帧带全文：流式 delta 可能缺尾(或整段没发 delta),按 item 补差额。
    if (method === 'item/completed' && item.type === 'agentMessage') {
      const text = String(item.text || '');
      const streamed = state.deltaTextByItem.get(itemId) || '';
      if (!text || text === streamed) return [];
      const delta = text.startsWith(streamed) ? text.slice(streamed.length) : text;
      state.deltaTextByItem.set(itemId, text);
      state.content += delta;
      return delta ? [{ type: 'delta', delta }] : [];
    }

    // 疑似致命错误记录(与 exec 路径同判定),留待 turn 结束裁决。
    if (method === 'item/completed' && item.type === 'error') {
      const msg = normalizeString(item.message);
      if (msg && /(not supported|invalid_request|unauthorized|401|forbidden|quota|rate.?limit)/i.test(msg)) {
        state.failureMessage = msg;
      }
      return [];
    }

    const tool = codexAppServerItemToTool(item);
    if (!tool) return [];
    const events = [];
    const dedupeKey = itemId || `${tool.name}:${state.toolCallEmitted.size}`;
    if (!state.toolCallEmitted.has(dedupeKey)) {
      state.toolCallEmitted.add(dedupeKey);
      const tag = renderNativeToolCallTag(tool.name, tool.args);
      if (tag) events.push({ type: 'assistant_tool_call', content: tag });
    }
    if (method === 'item/completed') {
      const resultTag = renderNativeToolResultTag(tool.result);
      if (resultTag) events.push({ type: 'assistant_tool_result', content: resultTag });
    }
    return events;
  }

  if (method === 'turn/completed') {
    const turn = params.turn && typeof params.turn === 'object' ? params.turn : {};
    const status = normalizeString(turn.status);
    const errorMessage = normalizeString(
      (turn.error && (turn.error.message || turn.error.code))
      || state.failureMessage
    );
    if (status === 'failed') {
      return [{ type: 'error', message: errorMessage || 'codex_app_server_turn_failed' }];
    }
    // interrupted(用户 stop)也按 result 收尾:携带已产出内容,由上层决定丢弃与否。
    if (!state.content && state.failureMessage) {
      return [{ type: 'error', message: state.failureMessage }];
    }
    return [{ type: 'result', content: state.content, turnStatus: status || 'completed' }];
  }

  if (method === 'error') {
    const nativeError = params.error && typeof params.error === 'object' ? params.error : {};
    const messageText = normalizeString(nativeError.message || params.message)
      || 'codex_app_server_error';
    if (params.willRetry === true) {
      return [createRetryStatus({
        phase: 'scheduled',
        source: 'upstream-api',
        provider: 'codex'
      })];
    }
    state.failureMessage = messageText;
    return [{ type: 'error', message: messageText }];
  }

  return [];
}

function isApprovalServerRequest(message) {
  return Boolean(
    message
    && typeof message === 'object'
    && message.id !== undefined
    && APPROVAL_REQUEST_METHODS.includes(String(message.method || ''))
  );
}

// 审批 server request → 审批桥 registerApprovalRequest 的输入形状。
// fileChange 请求本身不带 diff,从 state 缓存的 item/started 项取变更详情。
function mapApprovalServerRequest(message, state) {
  if (!isApprovalServerRequest(message)) return null;
  const method = String(message.method);
  const params = (message.params && typeof message.params === 'object') ? message.params : {};
  const itemId = normalizeString(params.itemId);
  if (method === 'item/commandExecution/requestApproval') {
    return {
      toolName: 'Shell',
      toolUseId: itemId,
      input: {
        command: String(params.command || ''),
        cwd: normalizeString(params.cwd)
      }
    };
  }
  const cachedItem = state && state.itemsById ? state.itemsById.get(itemId) : null;
  const changes = (cachedItem && Array.isArray(cachedItem.changes) ? cachedItem.changes : [])
    .map((change) => ({
      path: normalizeString(change && change.path),
      kind: normalizeString(change && change.kind && change.kind.type)
    }));
  const input = { changes };
  const reason = normalizeString(params.reason);
  if (reason) input.reason = reason;
  return {
    toolName: 'FileChange',
    toolUseId: itemId,
    input
  };
}

// 审批桥决策({behavior:'allow'|'deny'}) → JSON-RPC result。availableDecisions 里
// accept/decline 恒可用(S3 实证),细粒度 amendment 选项不透出、保持二选一。
function approvalDecisionToResult(behavior) {
  return { decision: behavior === 'allow' ? 'accept' : 'decline' };
}

module.exports = {
  APPROVAL_REQUEST_METHODS,
  buildApprovalPolicyParams,
  buildThreadStartParams,
  buildThreadResumeParams,
  buildTurnStartParams,
  buildTurnSteerParams,
  buildTurnInterruptParams,
  createTurnObserverState,
  codexAppServerItemToTool,
  mapServerNotification,
  isApprovalServerRequest,
  mapApprovalServerRequest,
  approvalDecisionToResult
};
