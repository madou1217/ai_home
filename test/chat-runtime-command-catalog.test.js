'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createCapabilityCommandCatalog
} = require('../lib/server/chat-runtime/capability-command-catalog');

test('capability catalog advertises only commands implemented for the bound runtime', async () => {
  const catalog = createCapabilityCommandCatalog();
  const commands = await catalog.list({
    capabilitySnapshot: {
      capabilities: {
        'turn.interrupt': { support: 'native' },
        'turn.steer.current': { support: 'native' },
        'turn.queue': { support: 'emulated' },
        'terminal.stream': { support: 'unsupported' }
      },
      slashCommands: ['compact'],
      turnInterveneModes: ['steer_current']
    }
  });

  assert.deepEqual(commands, [
    { id: 'turn.submit', type: 'turn.submit' },
    { id: 'turn.interrupt', type: 'turn.interrupt' },
    {
      id: 'turn.intervene:steer_current',
      type: 'turn.intervene',
      mode: 'steer_current'
    },
    { id: 'queue.add', type: 'queue.add' },
    { id: 'queue.edit', type: 'queue.edit' },
    { id: 'queue.remove', type: 'queue.remove' },
    { id: 'queue.move', type: 'queue.move' },
    { id: 'queue.dispatch', type: 'queue.dispatch' },
    {
      id: 'slash:compact',
      type: 'slash.execute',
      name: 'compact',
      command: '/compact'
    }
  ]);
  assert.equal(commands.some((command) => command.type === 'terminal.stream'), false);
  assert.equal(commands.some((command) => command.type === 'artifact.read'), false);
});

test('capability catalog fails closed when optional capabilities are absent', async () => {
  const commands = await createCapabilityCommandCatalog().list({
    capabilitySnapshot: {}
  });

  assert.deepEqual(commands, [{ id: 'turn.submit', type: 'turn.submit' }]);
});

test('capability catalog trims and deduplicates provider command descriptors', async () => {
  const commands = await createCapabilityCommandCatalog().list({
    capabilitySnapshot: {
      slashCommands: [' compact ', 'compact', ''],
      turnInterveneModes: [' steer_current ', 'steer_current']
    }
  });

  assert.deepEqual(commands, [
    { id: 'turn.submit', type: 'turn.submit' },
    {
      id: 'turn.intervene:steer_current',
      type: 'turn.intervene',
      mode: 'steer_current'
    },
    {
      id: 'slash:compact',
      type: 'slash.execute',
      name: 'compact',
      command: '/compact'
    }
  ]);
});
