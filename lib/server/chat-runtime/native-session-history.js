'use strict';

// 原生会话历史导入（非 codex provider）：打开一个已有原生会话时，把 CLI 自己落盘的对话
// （session-reader 读出的 user/assistant 消息）导入 canonical 时间线。
//
// 为什么存在：legacy 表面打开历史会话时直接读原生 transcript（use-legacy-history-projection →
// /v0/webui/sessions/:provider/:id/messages）；canonical 只有 codex 驱动会导入原生历史
// （codex-session-history-sync，经 thread/read）。其余 provider 在 canonical 下打开历史会话
// 时间线是空的 —— 退役 legacy 前必须补上，否则「打开旧会话看不到历史」。
//
// 幂等：eventId = 内容哈希（provider + nativeSessionId + 序号 + role + 内容 + 时间），
// 重复导入由 timeline-import-repository 按 eventId 跳过；新一轮对话的消息由驱动实时写入，
// 不与导入的历史重叠（导入只在会话还没有任何时间线消息时执行）。

const crypto = require('node:crypto');
const { readSessionMessages, readProjectsFromHostByProviders } = require('../../sessions/session-reader');

// 首屏只导入尾部这么多条：长会话的完整历史仍可在原生客户端查看；导入量要可控，
// 否则一次打开就向时间线写入成千上万条事件。
const NATIVE_HISTORY_IMPORT_LIMIT = 400;

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function timestampMs(value, fallback) {
  const parsed = typeof value === 'number' ? value : Date.parse(String(value || ''));
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function messageContent(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

/**
 * 原生消息 → canonical 历史事件草稿（timeline.item.completed）。
 * @param {object[]} messages session-reader 输出（{role, content, timestamp, model}）
 */
function projectNativeSessionHistory(messages, input = {}) {
  const provider = text(input.provider);
  const nativeSessionId = text(input.nativeSessionId);
  const runtimeId = text(input.runtimeId) || `${provider}:history`;
  const list = Array.isArray(messages) ? messages : [];
  const tail = list.slice(-NATIVE_HISTORY_IMPORT_LIMIT);
  const offset = list.length - tail.length;
  const now = Date.now();
  let lastAt = 0;
  const events = [];
  tail.forEach((message, index) => {
    const role = text(message && message.role);
    if (role !== 'user' && role !== 'assistant') return;
    const content = messageContent(message);
    if (!content.trim()) return;
    // 时间单调：缺时间戳的消息排在前一条之后，保证时间线顺序与原生顺序一致。
    const at = Math.max(timestampMs(message.timestamp, lastAt || now), lastAt);
    lastAt = at;
    const ordinal = offset + index;
    const identity = JSON.stringify([provider, nativeSessionId, ordinal, role, content, at]);
    const hash = crypto.createHash('sha256').update(identity).digest('hex');
    const itemId = `native-history-${hash.slice(0, 32)}`;
    events.push({
      eventId: `history-${hash}`,
      type: 'timeline.item.completed',
      at,
      itemId,
      source: { provider, runtimeId },
      payload: {
        item: {
          id: itemId,
          kind: 'message',
          createdAt: at,
          updatedAt: at,
          status: 'completed',
          content,
          detail: {
            role,
            phase: 'native_history',
            ...(text(message.model) ? { model: text(message.model) } : {})
          }
        }
      }
    });
  });
  return { nativeSessionId, events, truncated: offset > 0 };
}

/**
 * 读原生 transcript 并导入（best effort：读不到/导入失败不阻塞会话，只返回原因）。
 * @param {{provider:string,nativeSessionId:string,projectDirName?:string,projectPath?:string,
 *          readerOptions?:object,runtimeId?:string,historySink:Function,hasTimeline?:Function,
 *          readMessages?:Function}} input
 */
function importNativeSessionHistory(input = {}) {
  const nativeSessionId = text(input.nativeSessionId);
  if (!nativeSessionId || typeof input.historySink !== 'function') return { imported: 0, skipped: 'no_session' };
  if (typeof input.hasTimeline === 'function' && input.hasTimeline()) return { imported: 0, skipped: 'timeline_present' };
  const read = typeof input.readMessages === 'function' ? input.readMessages : readSessionMessages;
  const readerOptions = input.readerOptions || {};
  // projectDirName 因 provider 而异（codebuddy 是路径编码目录名，其它多为原始路径）。会话策略里没存时，
  // 从项目目录（与 WebUI 项目列表同一来源）按会话 id 找到它真实的 projectDirName。
  const listed = text(input.projectDirName) ? '' : lookupProjectDirName(input, readerOptions);
  const candidates = [...new Set([text(input.projectDirName), listed, text(input.projectPath)].filter(Boolean))];
  if (candidates.length === 0) candidates.push('');
  let messages = [];
  for (const projectDirName of candidates) {
    try {
      messages = read(input.provider, { sessionId: nativeSessionId, projectDirName }, readerOptions) || [];
    } catch (_error) {
      messages = [];
    }
    if (messages.length > 0) break;
  }
  if (messages.length === 0) return { imported: 0, skipped: 'transcript_empty' };
  const history = projectNativeSessionHistory(messages, {
    provider: input.provider,
    nativeSessionId,
    runtimeId: input.runtimeId
  });
  if (history.events.length === 0) return { imported: 0, skipped: 'no_messages' };
  const result = input.historySink(history);
  return { imported: history.events.length, truncated: history.truncated, result };
}

function lookupProjectDirName(input, readerOptions) {
  const lookup = typeof input.listProjects === 'function' ? input.listProjects : readProjectsFromHostByProviders;
  try {
    const projects = lookup([input.provider], readerOptions) || [];
    for (const project of projects) {
      const session = (project.sessions || []).find((entry) => entry && entry.id === text(input.nativeSessionId));
      if (session) return text(session.projectDirName);
    }
  } catch (_error) { /* 目录读不到：退回原始路径 */ }
  return '';
}

module.exports = {
  NATIVE_HISTORY_IMPORT_LIMIT,
  importNativeSessionHistory,
  projectNativeSessionHistory
};
