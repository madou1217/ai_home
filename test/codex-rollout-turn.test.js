'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readCodexRolloutTurn } = require('../lib/server/chat-runtime/codex-rollout-turn');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-rollout-turn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'sessions'));
  const file = path.join(root, 'sessions', 'rollout-thread.jsonl');
  const real = fs.realpathSync(root);
  const options = { codexHome: root, rolloutPath: file, threadId: 'thread', turnId: 'turn',
    runtimeHomeHash: crypto.createHash('sha256').update(process.platform === 'win32' ? real.toLowerCase() : real).digest('hex') };
  const user = { type: 'message', id: 'raw-user', role: 'user', content: [{ type: 'input_image', image_url: 'PRIVATE_IMAGE' }],
    internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.image'] } };
  const answer = { type: 'message', id: 'answer', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] };
  const rows = [
    { type: 'session_meta', payload: { id: 'thread' } },
    { type: 'response_item', payload: { id: 'earlier', type: 'message', role: 'user', content: [] } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    { type: 'response_item', payload: user },
    { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn', item: { id: 'typed-user', type: 'UserMessage' } } },
    { type: 'response_item', payload: answer },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } }
  ];
  const write = (input = rows, ending = '\n') => fs.writeFileSync(file, input.map((row) => JSON.stringify(row)).join('\n') + ending);
  write();
  return { options, file, rows, user, answer, write };
}

test('rollout turn requires exact disk boundaries and preserves images and explicit user IDs', async (t) => {
  const f = fixture(t);
  const result = await readCodexRolloutTurn(f.options);
  assert.deepEqual(result.items, [f.user, f.answer]);
  assert.deepEqual([...result.links], [['typed-user', 'raw-user']]);
  await assert.rejects(readCodexRolloutTurn({ ...f.options, runtimeHomeHash: '0'.repeat(64) }), /evidence_unavailable/);
  await assert.rejects(readCodexRolloutTurn({ ...f.options, threadId: 'foreign' }), /evidence_unavailable/);
  await assert.rejects(readCodexRolloutTurn({ ...f.options, turnId: 'foreign' }), /evidence_unavailable/);
});

test('torn, duplicate, compacted and rolled-back records cannot certify raw capture', async (t) => {
  const f = fixture(t);
  const event = (type) => ({ type: 'event_msg', payload: { type, turn_id: 'turn' } });
  for (const rows of [f.rows.slice(0, -1), [...f.rows, event('thread_rolled_back')],
    [...f.rows.slice(0, -1), f.rows[3], f.rows.at(-1)],
    [...f.rows.slice(0, -1), { type: 'compacted', payload: {} }, f.rows.at(-1)],
    [...f.rows.slice(0, -1), event('task_started'), f.rows.at(-1)]]) {
    f.write(rows);
    await assert.rejects(readCodexRolloutTurn(f.options), /evidence_unavailable/);
  }
  f.write(f.rows, '');
  await assert.rejects(readCodexRolloutTurn(f.options), /evidence_unavailable/);
});

test('a different thread header and symlinked rollout are rejected', async (t) => {
  const f = fixture(t);
  f.write([{ type: 'session_meta', payload: { id: 'foreign' } }, ...f.rows.slice(1)]);
  await assert.rejects(readCodexRolloutTurn(f.options), /evidence_unavailable/);
  f.write();
  const link = path.join(f.options.codexHome, 'sessions', 'link-thread.jsonl');
  fs.symlinkSync(f.file, link);
  await assert.rejects(readCodexRolloutTurn({ ...f.options, rolloutPath: link }), /evidence_unavailable/);
});
