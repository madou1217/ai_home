'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fsExtra = require('fs-extra');

const { createSessionEventBus } = require('../lib/server/session-event-bus');
const {
  appendCodexSessionNotification,
  readCodexSessionNotificationsSince,
  resolveCodexSessionNotificationQueuePath,
  resolveCodexSessionNotificationQueuePathFromStateFile,
  sanitizeNotificationEvent,
  startCodexSessionNotificationBridge
} = require('../lib/server/codex-session-notification-queue');

test('codex session notification queue stores only safe codex session metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-notify-'));
  const queueFile = path.join(dir, 'queue.jsonl');
  try {
    assert.equal(appendCodexSessionNotification(fs, queueFile, {
      provider: 'codex',
      sessionId: 'thread-1',
      type: 'session:turn-completed',
      source: 'native-session-chat',
      reason: 'native_session_done',
      prompt: 'do not store this'
    }), true);

    const result = readCodexSessionNotificationsSince(fs, queueFile, 0);
    assert.equal(result.events.length, 1);
    assert.deepEqual(result.events[0], {
      provider: 'codex',
      sessionId: 'thread-1',
      type: 'session:turn-completed',
      source: 'native-session-chat',
      reason: 'native_session_done',
      eventName: '',
      phase: '',
      at: result.events[0].at
    });
    assert.equal(Object.prototype.hasOwnProperty.call(result.events[0], 'prompt'), false);
    assert.equal(readCodexSessionNotificationsSince(fs, queueFile, result.offset).events.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codex session notification helpers resolve queue paths', () => {
  assert.equal(
    resolveCodexSessionNotificationQueuePath('/tmp/aih'),
    path.join('/tmp/aih', 'codex-session-notifications.jsonl')
  );
  assert.equal(
    resolveCodexSessionNotificationQueuePathFromStateFile('/tmp/aih/codex-desktop-hook-state.json'),
    path.join('/tmp/aih', 'codex-session-notifications.jsonl')
  );
});

test('codex session notification bridge writes only codex events from session bus', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-bridge-'));
  const bus = createSessionEventBus({
    fs: fsExtra,
    resolveSessionFilePath() { return ''; }
  });
  try {
    const queueFile = path.join(dir, 'queue.jsonl');
    const bridge = startCodexSessionNotificationBridge({ fs, queueFile, bus });
    bus.publish({
      provider: 'gemini',
      sessionId: 'gemini-1'
    }, {
      type: 'session:turn-completed',
      source: 'test'
    });
    bus.publish({
      provider: 'codex',
      sessionId: 'thread-1'
    }, {
      type: 'session:turn-started',
      source: 'test'
    });
    bridge.stop();

    const result = readCodexSessionNotificationsSince(fs, queueFile, 0);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].provider, 'codex');
    assert.equal(result.events[0].sessionId, 'thread-1');
    assert.equal(result.events[0].type, 'session:turn-started');
  } finally {
    bus.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sanitizeNotificationEvent rejects non-codex or missing session events', () => {
  assert.equal(sanitizeNotificationEvent({ provider: 'gemini', sessionId: 's1' }), null);
  assert.equal(sanitizeNotificationEvent({ provider: 'codex' }), null);
});
