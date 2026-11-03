'use strict';

function mapCodexMcpProgress(params = {}) {
  const turnId = text(params.turnId);
  const itemId = text(params.itemId);
  if (!turnId || !itemId || typeof params.message !== 'string') {
    return invalidNotification('item/mcpToolCall/progress', params);
  }
  return {
    type: 'timeline.item.delta',
    turnId,
    itemId,
    payload: {
      itemId,
      chunk: params.message,
      detail: { channel: 'progress' }
    }
  };
}

function mapCodexTurnDiff(params = {}) {
  const turnId = text(params.turnId);
  if (!turnId || typeof params.diff !== 'string') {
    return invalidNotification('turn/diff/updated', params);
  }
  const itemId = `codex-diff:${turnId}`;
  return {
    type: 'timeline.item.updated',
    turnId,
    itemId,
    payload: {
      item: {
        id: itemId,
        turnId,
        kind: 'diff',
        createdAt: 0,
        updatedAt: 0,
        status: 'completed',
        detail: { patch: params.diff }
      }
    }
  };
}

function invalidNotification() {
  return {
    type: 'stream.error',
    payload: {
      error: 'invalid_codex_timeline_notification',
      message: 'Invalid Codex timeline notification',
      retryable: false
    }
  };
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

module.exports = {
  mapCodexMcpProgress,
  mapCodexTurnDiff
};
