import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionCommandInput } from '@/chat-runtime';
import { SessionRuntimeActions } from './session-runtime-actions';

test('runtime actions translate composer intent into canonical commands', async () => {
  const commands: SessionCommandInput[] = [];
  const actions = new SessionRuntimeActions({
    dispatch: async (command) => { commands.push(command); },
  }, () => `command-${commands.length + 1}`);

  await actions.submit({
    content: '  hello  ', model: 'gpt-5.3-codex', reasoningEffort: 'high',
    attachmentIds: ['attachment-1'],
  });
  await actions.deliver('focus tests', 'steer_current');
  await actions.deliver('after the tool', 'after_tool_boundary');
  await actions.deliver('then document', 'after_turn');

  assert.deepEqual(commands, [
    {
      commandId: 'command-1', type: 'turn.submit',
      payload: {
        content: 'hello', model: 'gpt-5.3-codex', reasoningEffort: 'high',
        attachmentIds: ['attachment-1'],
      },
    },
    {
      commandId: 'command-2', type: 'turn.intervene',
      payload: { content: 'focus tests', mode: 'steer_current' },
    },
    {
      commandId: 'command-3', type: 'queue.add',
      payload: { content: 'after the tool', policy: 'after_tool_boundary' },
    },
    {
      commandId: 'command-4', type: 'queue.add',
      payload: { content: 'then document', policy: 'after_turn' },
    },
  ]);
});

test('slash execution strips the UI prefix', async () => {
  const commands: SessionCommandInput[] = [];
  const actions = new SessionRuntimeActions({
    dispatch: async (command) => { commands.push(command); },
  }, () => 'slash-1');
  await actions.executeSlash('/compact', 'now');
  assert.deepEqual(commands[0], {
    commandId: 'slash-1', type: 'slash.execute',
    payload: { name: 'compact', arguments: 'now' },
  });
});

test('runtime actions notify the observer without exposing command payloads', async () => {
  const notifications: Array<{ phase: string; commandId: string; type: string }> = [];
  const actions = new SessionRuntimeActions({
    dispatch: async (command) => {
      if (command.type === 'turn.submit') throw new Error('dispatch failed');
    },
  }, () => 'command-1', {
    onCommandDispatch(event) {
      notifications.push({ phase: 'dispatch', ...event });
    },
    onCommandDispatchFailed(event) {
      notifications.push({ phase: 'failed', ...event });
    },
  });

  await assert.rejects(actions.submit({ content: 'secret prompt' }), /dispatch failed/);

  assert.deepEqual(notifications, [
    { phase: 'dispatch', commandId: 'command-1', type: 'turn.submit' },
    { phase: 'failed', commandId: 'command-1', type: 'turn.submit' },
  ]);
  assert.equal(JSON.stringify(notifications).includes('secret prompt'), false);
});
