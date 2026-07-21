'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ackSessionEvents,
  applyEventSeq,
  clearSessionEventAcks,
  getSessionEventAck,
  normalizeSessionAckPayload
} = require('../lib/server/control-plane-device-session-event-store');
const {
  buildControlPlaneDeviceSessionEvents,
  buildControlPlaneDeviceSessions
} = require('../lib/server/control-plane-device-sessions');
const {
  clearSessionArtifacts,
  readSessionArtifact
} = require('../lib/server/control-plane-device-session-artifact-store');
const {
  appendNativeChatRunEvent,
  readNativeChatRunEvents,
  registerNativeChatRun,
  unregisterNativeChatRun
} = require('../lib/server/native-chat-run-store');

test('session event seq is derived from cursor without duplicating resume windows', () => {
  const events = applyEventSeq([
    { type: 'assistant_text', text: 'one' },
    { cursor: '9', type: 'assistant_text', text: 'two' },
    { seq: '10', type: 'assistant_text', text: 'three' }
  ], 10);

  assert.deepEqual(events.map((event) => [event.seq, event.cursor, event.text]), [
    [8, 8, 'one'],
    [9, 9, 'two'],
    [10, 10, 'three']
  ]);
});

test('session ack payload accepts session refs and consumer ids', () => {
  assert.deepEqual(normalizeSessionAckPayload({
    sessionRef: 'sess_0123456789abcdefabcd',
    seq: 12,
    clientId: 'phone'
  }), {
    sessionId: 'sess_0123456789abcdefabcd',
    cursor: 12,
    consumerId: 'phone'
  });
});

test('session ack payload preserves explicit zero cursor', () => {
  assert.deepEqual(normalizeSessionAckPayload({
    sessionId: 'run-zero-cursor',
    cursor: 0,
    seq: 12,
    consumerId: 'phone'
  }), {
    sessionId: 'run-zero-cursor',
    cursor: 0,
    consumerId: 'phone'
  });
});

test('session event ack store keeps the highest cursor per consumer', () => {
  clearSessionEventAcks();

  const first = ackSessionEvents({
    sessionId: 'run-ack-1',
    cursor: 7,
    consumerId: 'phone'
  }, { nowMs: 1000 });
  const stale = ackSessionEvents({
    sessionId: 'run-ack-1',
    cursor: 3,
    consumerId: 'phone'
  }, { nowMs: 2000 });

  assert.deepEqual(first, {
    accepted: true,
    sessionId: 'run-ack-1',
    consumerId: 'phone',
    cursor: 7,
    ackedAt: 1000
  });
  assert.deepEqual(stale, {
    accepted: true,
    sessionId: 'run-ack-1',
    consumerId: 'phone',
    cursor: 7,
    ackedAt: 1000,
    stale: true
  });
  assert.deepEqual(getSessionEventAck('run-ack-1', 'phone'), first);
});

test('native chat run events expose seq and resume after cursor without duplication', () => {
  const runId = 'run-event-seq-1';
  registerNativeChatRun({
    runId,
    provider: 'codex',
    events: []
  });
  try {
    appendNativeChatRunEvent(runId, { type: 'assistant_text', text: 'one' });
    appendNativeChatRunEvent(runId, { type: 'assistant_text', text: 'two' });

    const first = readNativeChatRunEvents(runId, { cursor: 0, limit: 10 });
    assert.deepEqual(first.events.map((event) => [event.seq, event.cursor, event.text]), [
      [1, 1, 'one'],
      [2, 2, 'two']
    ]);

    const resumed = readNativeChatRunEvents(runId, { cursor: 1, limit: 10 });
    assert.deepEqual(resumed.events.map((event) => [event.seq, event.cursor, event.text]), [
      [2, 2, 'two']
    ]);
    assert.equal(resumed.cursor, 2);
  } finally {
    unregisterNativeChatRun(runId);
  }
});

test('native chat run stores large terminal output as artifact ref', () => {
  clearSessionArtifacts();
  const runId = 'run-artifact-lane-1';
  registerNativeChatRun({
    runId,
    provider: 'codex',
    events: []
  });
  try {
    const largeOutput = `AIH_ARTIFACT_START\n${'x'.repeat(5000)}\nAIH_ARTIFACT_END`;
    appendNativeChatRunEvent(runId, { type: 'terminal-output', text: largeOutput });

    const result = readNativeChatRunEvents(runId, { cursor: 0, limit: 10 });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].type, 'artifact_ref');
    assert.equal(result.events[0].cursor, 1);
    assert.ok(result.events[0].artifactId);
    assert.equal(result.events[0].artifact.kind, 'terminal-output');
    assert.equal(result.events[0].artifact.byteLength, Buffer.byteLength(largeOutput, 'utf8'));
    assert.doesNotMatch(JSON.stringify(result.events[0]), /AIH_ARTIFACT_END/);

    const artifact = readSessionArtifact({ artifactId: result.events[0].artifactId });
    assert.equal(artifact.content, largeOutput);
    assert.equal(artifact.artifact.artifactId, result.events[0].artifactId);
  } finally {
    unregisterNativeChatRun(runId);
    clearSessionArtifacts();
  }
});

test('device session events expose approval and artifact lanes as safe events', () => {
  const snapshot = {
    projects: [{
      id: 'project-1',
      name: 'AIH',
      path: '/work/ai_home',
      sessions: [{
        id: 'session-1',
        provider: 'codex',
        projectDirName: 'work-ai-home',
        title: 'Approval'
      }]
    }]
  };
  const sessionRef = buildControlPlaneDeviceSessions(snapshot).sessions[0].sessionRef;
  const result = buildControlPlaneDeviceSessionEvents(snapshot, {
    sessionRef,
    cursor: 0
  }, {
    readSessionEvents() {
      return {
        cursor: 3,
        events: [
          {
            type: 'interactive-prompt',
            prompt: {
              promptId: 'codex-plan-active',
              provider: 'codex',
              kind: 'plan-choice',
              question: 'Implement this plan?',
              options: [
                { value: '1', title: 'Yes' },
                { value: '2', title: 'No', description: 'Keep planning' }
              ]
            }
          },
          {
            type: 'artifact_ref',
            artifact: {
              artifactId: 'art_0123456789abcdef01234567',
              kind: 'terminal-output',
              title: 'Terminal output',
              mimeType: 'text/plain',
              byteLength: 8192,
              preview: 'AIH_ARTIFACT_START'
            }
          },
          {
            type: 'interactive-prompt-cleared',
            promptId: 'codex-plan-active',
            reason: 'input-submitted'
          }
        ]
      };
    }
  });

  assert.equal(result.cursor, 3);
  assert.deepEqual(result.events.map((event) => [event.seq, event.cursor, event.type]), [
    [1, 1, 'approval_request'],
    [2, 2, 'artifact_ref'],
    [3, 3, 'approval_cleared']
  ]);
  assert.equal(result.events[0].approvalId, 'codex-plan-active');
  assert.equal(result.events[0].options.length, 2);
  assert.equal(result.events[1].artifact.artifactId, 'art_0123456789abcdef01234567');
  assert.equal(result.events[1].artifact.byteLength, 8192);
  assert.equal(result.events[2].reason, 'input-submitted');
});
