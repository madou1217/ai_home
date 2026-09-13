'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { codexForkSource, findCodexForkReceipt, readCodexInjectionReceipt } = require('../lib/server/chat-runtime/codex-fork-receipt');

const sourceThreadId = '00000000-0000-7000-8000-000000000001';
const childId = '00000000-0000-7000-8000-000000000002';
const secondId = '00000000-0000-7000-8000-000000000003';
const threadSource = codexForkSource({ sessionId: 'source', commandId: 'branch' });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fork-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function account(name) {
    const codexHome = path.join(root, name);
    fs.mkdirSync(codexHome);
    const real = fs.realpathSync(codexHome);
    return { codexHome, runtimeHomeHash: crypto.createHash('sha256')
      .update(process.platform === 'win32' ? real.toLowerCase() : real).digest('hex'), sourceThreadId, threadSource };
  }
  return { a: account('a'), b: account('b') };
}

function write(home, { id = childId, source = sourceThreadId, marker = threadSource,
  directory = 'sessions/2026/09/13', contents } = {}) {
  const target = path.join(home.codexHome, directory);
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, `rollout-2026-09-13T12-00-00-${id}.jsonl`);
  fs.writeFileSync(file, contents ?? `${JSON.stringify({ type: 'session_meta', payload: {
    id, forked_from_id: source, thread_source: marker, base_instructions: { text: 'PRIVATE_INSTRUCTIONS' }
  } })}\nnot parsed: PRIVATE_HISTORY\n`);
  return file;
}

test('fork receipt reads only the verified account and returns addressing metadata', async (t) => {
  const { a, b } = fixture(t);
  write(b);
  assert.equal(await findCodexForkReceipt(a), null);
  await assert.rejects(findCodexForkReceipt({ ...b, runtimeHomeHash: a.runtimeHomeHash }), /runtime_home_mismatch/);
  const file = write(a);
  const bytes = fs.readFileSync(file);
  assert.deepEqual(await findCodexForkReceipt(a), { threadId: childId, sourceThreadId, threadSource });
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.doesNotMatch(JSON.stringify(await findCodexForkReceipt(a)), /PRIVATE_|codexHome/);
});

test('marker is scoped to both command and session, without exposing either', () => {
  assert.equal(codexForkSource({ sessionId: 'source', commandId: 'branch' }), threadSource);
  assert.notEqual(codexForkSource({ sessionId: 'other', commandId: 'branch' }), threadSource);
  assert.notEqual(codexForkSource({ sessionId: 'source', commandId: 'other' }), threadSource);
  assert.notEqual(codexForkSource({ sessionId: 'a:b', commandId: 'c' }),
    codexForkSource({ sessionId: 'a', commandId: 'b:c' }));
  assert.match(threadSource, /^aih-fork-[a-f0-9]{64}$/);
  assert.throws(() => codexForkSource({ sessionId: 'source' }), /identity_required/);
});

test('archive lookup survives native archive movement and rejects duplicate operations', async (t) => {
  const { a } = fixture(t);
  write(a, { directory: 'archived_sessions' });
  assert.equal((await findCodexForkReceipt(a)).threadId, childId);
  write(a, { id: secondId });
  await assert.rejects(findCodexForkReceipt(a), /receipt_ambiguous/);
});

test('duplicate paths for one native identity do not choose an arbitrary injection history', async (t) => {
  const { a } = fixture(t);
  write(a);
  write(a, { directory: 'archived_sessions' });
  await assert.rejects(findCodexForkReceipt(a), /receipt_ambiguous/);
});

test('receipt validates parent, self-fork and filename identity without guessing', async (t) => {
  const { a, b } = fixture(t);
  write(a, { source: secondId });
  await assert.rejects(findCodexForkReceipt(a), /receipt_identity_conflict/);
  const file = write(b);
  const meta = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
  meta.payload.id = secondId;
  fs.writeFileSync(file, `${JSON.stringify(meta)}\n`);
  await assert.rejects(findCodexForkReceipt(b), /receipt_identity_conflict/);
  meta.payload.id = sourceThreadId;
  write(b, { id: sourceThreadId, contents: `${JSON.stringify(meta)}\n` });
  await assert.rejects(findCodexForkReceipt(b), /receipt_identity_conflict/);
});

test('a torn or oversized header is unknown, not proof a fork was never accepted', async (t) => {
  const { a, b } = fixture(t);
  write(a, { contents: '{"type":"session_meta","private":"SECRET' });
  write(b, { contents: `${JSON.stringify({ type: 'session_meta', payload: {
    id: childId, forked_from_id: sourceThreadId, thread_source: threadSource,
    base_instructions: 'SECRET'.repeat(200000)
  } })}\n` });
  for (const home of [a, b]) await assert.rejects(findCodexForkReceipt(home), (error) => {
    assert.equal(error.code, 'codex_fork_receipt_unavailable');
    assert.doesNotMatch(String(error), /SECRET/);
    return true;
  });
});

test('receipt discovery refuses links outside the verified runtime directory', async (t) => {
  const { a, b } = fixture(t);
  write(b);
  fs.symlinkSync(path.join(b.codexHome, 'sessions'), path.join(a.codexHome, 'sessions'), 'junction');
  await assert.rejects(findCodexForkReceipt(a), /receipt_unavailable/);
});

test('a rollout file link cannot cross account boundaries', async (t) => {
  const { a, b } = fixture(t);
  const foreign = write(b);
  fs.mkdirSync(path.join(a.codexHome, 'sessions'));
  fs.symlinkSync(foreign, path.join(a.codexHome, 'sessions', path.basename(foreign)));
  await assert.rejects(findCodexForkReceipt(a), /receipt_unavailable/);
});

test('injection receipt proves exact ordered content once and distinguishes absent from partial', async (t) => {
  const { a } = fixture(t);
  const file = write(a);
  const header = fs.readFileSync(file, 'utf8').split('\n')[0];
  const items = [
    { type: 'function_call', id: 'call', call_id: 'c', name: 'exec', arguments: '{}' },
    { type: 'function_call_output', id: 'result', call_id: 'c', output: 'PRIVATE_RESULT' },
    { type: 'message', id: 'answer', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }
  ];
  const options = { ...a, threadId: childId, items };
  const set = (records) => fs.writeFileSync(file, [header, ...records.map((payload) =>
    JSON.stringify({ type: 'response_item', payload })), ''].join('\n'));
  set([]);
  assert.equal(await readCodexInjectionReceipt(options), 'absent');
  set(items.slice(0, 1));
  assert.equal(await readCodexInjectionReceipt(options), 'incomplete');
  set(items);
  assert.equal(await readCodexInjectionReceipt(options), 'complete');
  for (const invalid of [[...items, items[0]], [items[1], items[0], items[2]],
    [items[0], { ...items[1], output: 'changed' }, items[2]],
    [items[0], { id: 'interleaved', type: 'message' }, ...items.slice(1)],
    [...items, { id: 'later', type: 'message' }]]) {
    set(invalid);
    await assert.rejects(readCodexInjectionReceipt(options), /injection_receipt_conflict/);
  }
  set(items);
  fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }) + '\n');
  await assert.rejects(readCodexInjectionReceipt(options), /injection_receipt_conflict/);
  set(items);
  fs.appendFileSync(file, '{"type":"response_item"');
  await assert.rejects(readCodexInjectionReceipt(options), /receipt_unavailable/);
});
