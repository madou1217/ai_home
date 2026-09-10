'use strict';

// DSH compaction checkpoints carry provenance; Pi discards pre-compaction usage.
// Keep a small durable projection so pagination/reload cannot resurrect old usage.
function contextPatch(session, event) {
  if (session.policy.workspaceMode !== 'chat') return null;
  const previous = session.policy.contextState || {};
  if (event.type === 'turn.metrics.updated') {
    const metrics = event.payload.metrics;
    if (metrics.contextTokens === undefined) return null;
    return { ...previous, usedTokens: metrics.contextTokens,
      ...(metrics.contextWindow ? { contextWindow: metrics.contextWindow } : {}),
      measuredAt: event.at, model: session.policy.model || '', stale: false };
  }
  const item = event.payload?.item;
  if (item?.kind === 'notice' && ['contextCompaction', 'context_compacted'].includes(item.detail.code)) {
    return { ...previous, compaction: {
      itemId: item.id, turnId: event.turnId, status: item.status,
      requestedAt: previous.compaction?.itemId === item.id ? previous.compaction.requestedAt : event.at,
      ...(item.status === 'completed' ? { completedAt: event.at } : {})
    }, ...(item.status === 'completed' ? { stale: true } : {}) };
  }
  if (['turn.failed', 'turn.interrupted'].includes(event.type)
    && previous.compaction?.turnId === event.turnId && previous.compaction.status === 'running') {
    return { ...previous, compaction: { ...previous.compaction,
      status: event.type === 'turn.failed' ? 'failed' : 'cancelled', completedAt: event.at } };
  }
  return null;
}

function projectChatContextInTransaction(context, events, event) {
  const row = context.db.prepare('SELECT policy_json FROM chat_runtime_sessions WHERE session_id = ?').get(event.sessionId);
  if (!row) return;
  const policy = JSON.parse(row.policy_json);
  const patch = contextPatch({ policy }, event);
  if (!patch) return;
  const next = { ...policy, contextState: patch };
  context.db.prepare('UPDATE chat_runtime_sessions SET policy_json = ? WHERE session_id = ?')
    .run(JSON.stringify(next), event.sessionId);
  events.appendInTransaction(event.sessionId, {
    type: 'session.policy.changed', source: event.source, at: event.at, payload: { policy: next }
  });
}

module.exports = { contextPatch, projectChatContextInTransaction };
