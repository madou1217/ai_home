'use strict';

// 审批桥(P3):权限请求的挂起-决策往返中枢。
//
//   claude 权限工具(claude-permission-mcp-tool.js)POST /v0/webui/internal/approval-request
//     → 本模块登记 pending 并【长挂响应】;同时把审批请求发布到会话事件通道
//     → 前端(live SSE 或 watch)弹审批卡,用户点允许/拒绝
//     → POST /v0/webui/chat/runs/:runId/approvals/:approvalId → 决策回填,长挂响应返回
//     → MCP 工具把 {behavior} 交回 claude,工具继续/被拒。
//
// detached 恢复:GET /chat/runs 的 activePrompt 会合并 getPendingApprovalPromptForRun(),
// 刷新后的页面能看到仍在等待的审批。codex(app-server)/opencode(serve)接入时复用同一
// pending/决策/事件形状,只是请求来源与回填方式不同。

const crypto = require('node:crypto');

const PENDING_BY_ID = new Map(); // approvalId -> entry
const PENDING_BY_RUN = new Map(); // runId -> Set<approvalId>

function createApprovalId() {
  return typeof crypto.randomUUID === 'function'
    ? `apr-${crypto.randomUUID()}`
    : `apr-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function summarizeInput(input) {
  try {
    const text = JSON.stringify(input);
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  } catch (_error) {
    return '';
  }
}

// 审批请求 → 前端可直接渲染的 prompt 形状(复用 PlanChoiceDock 的 options 协议)。
function toApprovalPrompt(entry) {
  return {
    kind: 'approval',
    promptId: entry.approvalId,
    approvalId: entry.approvalId,
    runId: entry.runId,
    question: `允许执行 ${entry.toolName || '工具'} 吗?`,
    detail: summarizeInput(entry.input),
    toolName: entry.toolName,
    options: [
      { value: '1', title: '允许' },
      { value: '2', title: '拒绝' }
    ],
    submit: 'choice'
  };
}

function removeEntry(entry) {
  PENDING_BY_ID.delete(entry.approvalId);
  const set = PENDING_BY_RUN.get(entry.runId);
  if (set) {
    set.delete(entry.approvalId);
    if (set.size === 0) PENDING_BY_RUN.delete(entry.runId);
  }
}

// 登记一个待审批请求并挂起 respond 回调(HTTP 响应)。返回 entry(含 prompt)。
function registerApprovalRequest({ runId, toolName, input, toolUseId }, respond) {
  const entry = {
    approvalId: createApprovalId(),
    runId: String(runId || '').trim(),
    toolName: String(toolName || '').trim(),
    input: input && typeof input === 'object' ? input : {},
    toolUseId: String(toolUseId || '').trim(),
    createdAt: Date.now(),
    respond: typeof respond === 'function' ? respond : () => {}
  };
  PENDING_BY_ID.set(entry.approvalId, entry);
  if (entry.runId) {
    if (!PENDING_BY_RUN.has(entry.runId)) PENDING_BY_RUN.set(entry.runId, new Set());
    PENDING_BY_RUN.get(entry.runId).add(entry.approvalId);
  }
  return entry;
}

// 用户决策:allow/deny(+可选 message)。返回被决策的 entry(供发布 resolved 事件),没有则 null。
function decideApproval(approvalId, decision, message) {
  const entry = PENDING_BY_ID.get(String(approvalId || '').trim());
  if (!entry) return null;
  removeEntry(entry);
  const behavior = decision === 'allow' ? 'allow' : 'deny';
  try {
    entry.respond(behavior === 'allow'
      ? { behavior: 'allow', updatedInput: entry.input }
      : { behavior: 'deny', message: String(message || '用户在 webUI 拒绝了此操作') });
  } catch (_error) { /* 响应端已断开:决策仍算完成 */ }
  return entry;
}

// run 结束/中止时清空其挂起审批(全部按 deny 收尾,避免 MCP 工具悬挂到超时)。
function cancelApprovalsForRun(runId, reason = 'run_finished') {
  const set = PENDING_BY_RUN.get(String(runId || '').trim());
  if (!set) return 0;
  let cancelled = 0;
  for (const approvalId of [...set]) {
    const entry = PENDING_BY_ID.get(approvalId);
    if (!entry) continue;
    removeEntry(entry);
    try {
      entry.respond({ behavior: 'deny', message: `运行已结束(${reason}),自动拒绝` });
    } catch (_error) { /* ignore */ }
    cancelled += 1;
  }
  return cancelled;
}

// detached 恢复:该 run 最早一条待审批的 prompt 形状(一次只弹一张卡)。
function getPendingApprovalPromptForRun(runId) {
  const set = PENDING_BY_RUN.get(String(runId || '').trim());
  if (!set || set.size === 0) return null;
  const firstId = [...set][0];
  const entry = PENDING_BY_ID.get(firstId);
  return entry ? toApprovalPrompt(entry) : null;
}

function getPendingApproval(approvalId) {
  return PENDING_BY_ID.get(String(approvalId || '').trim()) || null;
}

module.exports = {
  registerApprovalRequest,
  decideApproval,
  cancelApprovalsForRun,
  getPendingApprovalPromptForRun,
  getPendingApproval,
  toApprovalPrompt
};
