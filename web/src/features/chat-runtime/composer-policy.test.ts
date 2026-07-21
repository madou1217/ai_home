import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canSubmitComposerInput,
  canSwitchComposerAccount,
  resolveComposerPolicy,
} from './composer-policy';

const capabilities = {
  slashCommands: ['compact'],
  capabilities: {
    'turn.interrupt': { support: 'native' as const },
    'turn.steer.current': { support: 'native' as const },
    'turn.steer.tool_boundary': { support: 'emulated' as const },
    'turn.queue': { support: 'emulated' as const },
  },
};

test('idle sessions expose turns and slash commands', () => {
  assert.deepEqual(resolveComposerPolicy('idle', capabilities), {
    turnActive: false, deliveries: ['turn'], slashCommands: ['compact'],
    canInterrupt: false,
  });
});

test('active sessions expose only advertised canonical controls', () => {
  assert.deepEqual(resolveComposerPolicy('running', capabilities), {
    turnActive: true,
    deliveries: ['steer_current', 'after_tool_boundary', 'after_turn'],
    slashCommands: [],
    canInterrupt: true,
  });
});

test('native turns can use the provider default model when no override is selected', () => {
  assert.equal(canSubmitComposerInput('hello', 'turn', false), true);
  assert.equal(canSubmitComposerInput(' ', 'turn', false), false);
  assert.equal(canSubmitComposerInput(' ', 'turn', false, 1), true);
  assert.equal(canSubmitComposerInput(' ', 'steer_current', false, 1), false);
  assert.equal(canSubmitComposerInput('hello', undefined, false), false);
});

test('account switching is locked for the complete active turn lifecycle', () => {
  assert.equal(canSwitchComposerAccount(resolveComposerPolicy('idle', capabilities)), true);
  assert.equal(canSwitchComposerAccount(resolveComposerPolicy('starting', capabilities)), false);
  assert.equal(canSwitchComposerAccount(resolveComposerPolicy('waiting_input', capabilities)), false);
  assert.equal(canSwitchComposerAccount(resolveComposerPolicy('recovering', capabilities)), false);
});
