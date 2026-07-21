'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  mapCodexMcpProgress,
  mapCodexTurnDiff
} = require('../lib/server/chat-runtime/codex-timeline-notification-adapter');

test('maps the current MCP progress message field to a typed timeline delta', () => {
  const event = mapCodexMcpProgress({
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'mcp-1',
    message: 'Reading documentation'
  });

  assert.deepEqual(event, {
    type: 'timeline.item.delta',
    turnId: 'turn-1',
    itemId: 'mcp-1',
    payload: {
      itemId: 'mcp-1',
      chunk: 'Reading documentation',
      detail: { channel: 'progress' }
    }
  });
});

test('maps turn diff snapshots to one stable canonical diff item', () => {
  const first = mapCodexTurnDiff({
    threadId: 'thread-1',
    turnId: 'turn-1',
    diff: 'diff --git a/a.js b/a.js\n'
  });
  const updated = mapCodexTurnDiff({
    threadId: 'thread-1',
    turnId: 'turn-1',
    diff: 'diff --git a/a.js b/a.js\n+const value = 1;\n'
  });

  assert.equal(first.type, 'timeline.item.updated');
  assert.equal(first.itemId, 'codex-diff:turn-1');
  assert.equal(updated.itemId, first.itemId);
  assert.equal(updated.payload.item.id, first.payload.item.id);
  assert.equal(updated.payload.item.turnId, 'turn-1');
  assert.equal(updated.payload.item.kind, 'diff');
  assert.equal(updated.payload.item.status, 'completed');
  assert.equal(updated.payload.item.detail.patch, 'diff --git a/a.js b/a.js\n+const value = 1;\n');
});

test('rejects malformed timeline notifications without leaking provider values', () => {
  const event = mapCodexMcpProgress({
    turnId: 'turn-1',
    message: { private: 'must-not-leak' },
    providerPrivate: 'must-not-leak'
  });

  assert.deepEqual(event, {
    type: 'stream.error',
    payload: {
      error: 'invalid_codex_timeline_notification',
      message: 'Invalid Codex timeline notification',
      retryable: false
    }
  });
  assert.doesNotMatch(
    JSON.stringify(event),
    /must-not-leak|providerPrivate|paramKeys|item\/mcpToolCall\/progress/
  );
});
