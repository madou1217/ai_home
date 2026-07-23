const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readGrokTurnState } = require('../lib/sessions/grok-session-store');

function writeUpdates(dir, updates) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'updates.jsonl'), updates.map((update) => JSON.stringify({
    params: { update }
  })).join('\n'));
}

test('readGrokTurnState keeps pending tools from completing a turn', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-grok-turn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeUpdates(dir, [
    { sessionUpdate: 'user_message_chunk' },
    { sessionUpdate: 'agent_message_chunk' },
    { sessionUpdate: 'tool_call', toolCallId: 'tool-1' }
  ]);
  assert.deepEqual(readGrokTurnState(dir), {
    pendingCount: 1,
    failedCount: 0,
    failureMessage: '',
    hasAssistantAfterTerminalTool: true
  });
});

test('readGrokTurnState requires a final assistant message after tool failure', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-grok-turn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeUpdates(dir, [
    { sessionUpdate: 'user_message_chunk' },
    { sessionUpdate: 'agent_message_chunk' },
    { sessionUpdate: 'tool_call', toolCallId: 'tool-1' },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'failed',
      content: [{ content: { text: 'credit limit' } }]
    }
  ]);
  assert.equal(readGrokTurnState(dir).failureMessage, 'credit limit');
  assert.equal(readGrokTurnState(dir).hasAssistantAfterTerminalTool, false);
});
