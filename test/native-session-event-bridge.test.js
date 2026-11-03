'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createNativeSessionEventMapper } = require('../lib/server/chat-runtime/native-session-event-bridge');
const { resolveNativeSessionLaunchProfile } = require('../lib/server/native-session-launch-profile');

test('projects native slash terminal output into a canonical terminal item', () => {
  const mapper = createNativeSessionEventMapper({
    provider: 'claude',
    turnId: 'turn-1',
    assistantItemId: 'assistant-1',
    slash: true
  });

  const started = mapper.map({ type: 'terminal-output', text: 'command output' });
  assert.equal(started.events[0].type, 'timeline.item.started');
  assert.equal(started.events[0].payload.item.kind, 'terminal');
  assert.equal(started.events[1].type, 'timeline.item.delta');
  assert.equal(started.events[1].payload.detail.channel, 'output');

  const finished = mapper.finalize();
  assert.equal(finished.event.type, 'timeline.item.completed');
  assert.equal(finished.event.payload.item.content, 'command output');
});

test('slash launch profiles always use typed interactive input', () => {
  const profile = resolveNativeSessionLaunchProfile('opencode', { slash: true });
  assert.equal(profile.interactiveCli, true);
  assert.equal(profile.promptChannel, 'typed');
});
