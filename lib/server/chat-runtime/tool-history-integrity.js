'use strict';

const { ChatRuntimeError } = require('./contracts');

const TOOL_KINDS = new Set(['tool', 'shell', 'file_change']);

// DeepSeek Harness aa8262ec 的 tool-pairing 以 callId 守住 call/result
// 边界。Codex app-server 96883599 将一次调用和最终结果聚合到同一个
// ThreadItem；AIH 因此不伪造第二条 result，而是在统一持久化边界保证
// callId 与 canonical item 一一对应。这样乱序完成可以更新原项，损坏
// 历史却不能把一个结果配到另一项。
function createToolHistoryIntegrityGuard(context, sessionId) {
  let owners;
  return Object.freeze({
    assert(drafts) {
      const items = toolItems(drafts);
      if (items.length === 0) return;
      const current = owners || readPersistedOwners(context, sessionId);
      const next = cloneOwners(current);
      assertItems(next, items);
      owners = next;
    }
  });
}

function assertToolHistoryIntegrity(context, sessionId, drafts) {
  createToolHistoryIntegrityGuard(context, sessionId).assert(drafts);
}

function toolItems(drafts) {
  return drafts.map((draft) => draft && draft.payload && draft.payload.item)
    .filter((item) => item && TOOL_KINDS.has(item.kind));
}

function cloneOwners(owners) {
  return {
    itemsByCallId: new Map(owners.itemsByCallId),
    callIdsByItem: new Map(owners.callIdsByItem),
    legacyUnpairedItemIds: new Set(owners.legacyUnpairedItemIds)
  };
}

function assertItems(owners, items) {
  for (const item of items) {
    const callId = text(item.detail && item.detail.callId);
    if (!callId) {
      if (owners.legacyUnpairedItemIds.has(text(item.id))) continue;
      throw new ChatRuntimeError('chat_tool_history_call_id_required', 422, {
        itemId: text(item.id),
        kind: item.kind
      });
    }
    const itemId = text(item.id);
    claimOwnership(owners, callId, itemId);
  }
}

function claimOwnership(owners, callId, itemId) {
  const callOwner = owners.itemsByCallId.get(callId);
  if (callOwner && callOwner !== itemId) {
    throw new ChatRuntimeError('chat_tool_history_call_id_conflict', 409, {
      callId,
      itemId,
      ownerItemId: callOwner
    });
  }
  const itemCallId = owners.callIdsByItem.get(itemId);
  if (itemCallId && itemCallId !== callId) {
    throw new ChatRuntimeError('chat_tool_history_item_call_id_conflict', 409, {
      callId,
      itemId,
      ownerCallId: itemCallId
    });
  }
  owners.itemsByCallId.set(callId, itemId);
  owners.callIdsByItem.set(itemId, callId);
}

function readPersistedOwners(context, sessionId) {
  const owners = {
    itemsByCallId: new Map(),
    callIdsByItem: new Map(),
    legacyUnpairedItemIds: new Set()
  };
  const rows = context.db.prepare(`
    SELECT item_id, payload_json FROM chat_runtime_events
    WHERE session_id = ?
      AND type IN ('timeline.item.started', 'timeline.item.updated', 'timeline.item.completed')
    ORDER BY seq
  `).all(sessionId);
  for (const row of rows) {
    const item = JSON.parse(row.payload_json).item;
    if (!item || !TOOL_KINDS.has(item.kind)) continue;
    const callId = text(item.detail && item.detail.callId);
    const itemId = text(row.item_id || item.id);
    if (!callId) {
      if (!owners.callIdsByItem.has(itemId)) owners.legacyUnpairedItemIds.add(itemId);
      continue;
    }
    claimOwnership(owners, callId, itemId);
    owners.legacyUnpairedItemIds.delete(itemId);
  }
  return owners;
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

module.exports = {
  assertToolHistoryIntegrity,
  createToolHistoryIntegrityGuard
};
