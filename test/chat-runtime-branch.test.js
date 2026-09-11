'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createChatRuntimeService } = require('../lib/server/chat-runtime-service');
const { contextPatch } = require('../lib/server/chat-runtime/chat-context-state');
const { chatThreadParams } = require('../lib/server/chat-runtime/chat-harness-policy');
const { videoFramesDir } = require('../lib/server/chat-video-attachments');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-history-prefix-'));
  const runs = [];
  const make = () => createChatRuntimeService({ storeOptions: { fs, aiHomeDir: root },
    runtimeResolver: { resolve: (provider) => ({ provider, fingerprint: 'local-v1', generation: 1 }) },
    driverRegistry: { resolve: () => ({ driver: { startTurn: async (context) => { runs.push(context); return {}; } } }) } });
  let service = make();
  t.after(() => { service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, runs, get service() { return service; }, restart() { service.close(); service = make(); } };
}

async function source(f, count = 3) {
  const session = await f.service.openChatSession({ provider: 'kimi', executionAccountRef: 'account-a' });
  for (let n = 0; n < count; n += 1) {
    await f.service.dispatchCommand(session.sessionId, { commandId: `input-${n}`, type: 'turn.submit',
      payload: { content: `question ${n}`, model: 'k3' } });
    await f.service.waitForActorIdle(session.sessionId);
    const turn = f.runs.at(-1);
    for (const role of ['user', 'assistant']) f.service.store.importTimeline(session.sessionId, [{
      eventId: `${role}-${n}-event`, type: 'timeline.item.completed', at: Date.now(),
      source: { provider: 'kimi', runtimeId: 'probe' }, payload: { item: {
        id: `${role}-${n}`, turnId: turn.turnId, kind: 'message', status: 'completed', createdAt: Date.now(),
        detail: { role }, content: `${role === 'user' ? 'question' : 'answer'} ${n}`
      } }
    }]);
  }
  return session;
}

test('message fork uses the complete journal, preserves exact prefix and survives reopening', async (t) => {
  const f = fixture(t);
  const parent = await source(f, 20);
  const before = f.service.getSnapshot(parent.sessionId);
  const command = { commandId: 'fork-early', type: 'session.fork', payload: { sourceItemId: 'assistant-2' } };
  const result = await f.service.dispatchCommand(parent.sessionId, command);
  const child = result.result.session;
  assert.equal(child.provider, 'kimi');
  assert.equal(child.executionAccountRef, 'account-a');
  assert.equal(child.policy.model, 'k3');
  assert.equal(child.policy.lineage.parentSessionId, parent.sessionId);
  assert.deepEqual(f.service.getSnapshot(child.sessionId).timeline.map((item) => item.content),
    ['question 0', 'answer 0', 'question 1', 'answer 1', 'question 2', 'answer 2']);
  assert.deepEqual(f.service.getSnapshot(parent.sessionId), before);
  assert.doesNotMatch(JSON.stringify(f.service.store.readHistorySeed(child.sessionId)), /question 3/);
  f.restart();
  const repeated = await f.service.dispatchCommand(parent.sessionId, command);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.result.session.sessionId, child.sessionId);
  assert.equal(f.service.getSnapshot(child.sessionId).timeline.length, 6);
});

test('regeneration excludes the selected answer and later messages, resubmits the original prompt once', async (t) => {
  const f = fixture(t);
  const parent = await source(f);
  const command = { commandId: 'regenerate', type: 'turn.regenerate', payload: { sourceItemId: 'assistant-1' } };
  const result = await f.service.dispatchCommand(parent.sessionId, command);
  const childId = result.result.session.sessionId;
  await f.service.waitForActorIdle(childId);
  assert.equal(f.runs.at(-1).command.payload.content, 'question 1');
  assert.equal(f.runs.at(-1).command.payload.model, 'k3');
  const seed = f.service.store.readHistorySeed(childId);
  assert.equal(seed.responseItems.length, 2);
  assert.doesNotMatch(JSON.stringify(seed.responseItems), /question 1|answer 1|question 2/);
  const count = f.runs.length;
  await f.service.dispatchCommand(parent.sessionId, command);
  assert.equal(f.runs.length, count);
});

test('forking at a user message excludes the answer in the same turn', async (t) => {
  const f = fixture(t);
  const parent = await source(f);
  const child = (await f.service.dispatchCommand(parent.sessionId, { commandId: 'user-anchor',
    type: 'session.fork', payload: { sourceItemId: 'user-1' } })).result.session;
  assert.deepEqual(f.service.getSnapshot(child.sessionId).timeline.map((item) => item.content),
    ['question 0', 'answer 0', 'question 1']);
  assert.doesNotMatch(JSON.stringify(f.service.store.readHistorySeed(child.sessionId)), /answer 1|question 2/);
});

test('an accepted source command resumes its committed child after a crash without forking again', async (t) => {
  const f = fixture(t);
  const parent = await source(f);
  const command = { sessionId: parent.sessionId, commandId: 'crash-fork', type: 'session.fork',
    payload: { sourceItemId: 'assistant-0' } };
  f.service.store.acceptCommand(command);
  const child = f.service.store.branchSession(command);
  f.restart();
  const result = await f.service.dispatchCommand(parent.sessionId, command);
  assert.equal(result.result.session.sessionId, child.sessionId);
  assert.equal(f.service.listSessions().length, 2);
});

test('fork rejects busy, foreign anchors and client-supplied context without creating children', async (t) => {
  const f = fixture(t);
  const parent = await source(f);
  for (const [id, payload] of [['foreign', { sourceItemId: 'other-account-message' }],
    ['forged', { sourceItemId: 'assistant-1', content: 'injected', executionAccountRef: 'account-b' }]]) {
    await assert.rejects(f.service.dispatchCommand(parent.sessionId, { commandId: id, type: 'session.fork', payload }));
  }
  f.service.store.context.db.prepare('UPDATE chat_runtime_sessions SET state = ? WHERE session_id = ?')
    .run('running', parent.sessionId);
  await assert.rejects(f.service.dispatchCommand(parent.sessionId, { commandId: 'busy', type: 'session.fork',
    payload: { sourceItemId: 'assistant-1' } }), { code: 'chat_branch_source_busy' });
  assert.equal(f.service.listSessions().length, 1);
});

test('fork refuses another account attachment and rolls back the child atomically', async (t) => {
  const f = fixture(t);
  const parent = await source(f, 1);
  const foreign = await f.service.openChatSession({ provider: 'kimi', executionAccountRef: 'account-b' });
  const file = path.join(f.root, 'private.txt');
  fs.writeFileSync(file, 'account-b-only');
  const [attachment] = f.service.store.createAttachments(foreign.sessionId,
    [{ filePath: file, name: 'private.txt', mimeType: 'text/plain' }]);
  f.service.store.context.db.prepare('UPDATE chat_runtime_commands SET payload_json = ? WHERE command_id = ?')
    .run(JSON.stringify({ content: 'question 0', attachmentIds: [attachment.attachmentId] }), 'input-0');
  await assert.rejects(f.service.dispatchCommand(parent.sessionId, { commandId: 'foreign-attachment',
    type: 'session.fork', payload: { sourceItemId: 'assistant-0' } }), { code: 'chat_attachment_not_found' });
  assert.equal(f.service.listSessions().length, 2);
  assert.equal(f.service.store.context.db.prepare('SELECT count(*) AS count FROM chat_runtime_history_seeds').get().count, 0);
});

test('attachment inputs are copied with child ownership and branch-of-branch retains documents', async (t) => {
  const f = fixture(t);
  const parent = await source(f, 1);
  const file = path.join(f.root, 'note.txt');
  fs.writeFileSync(file, 'document-marker');
  const [attachment] = f.service.store.createAttachments(parent.sessionId, [{ filePath: file, name: 'note.txt', mimeType: 'text/plain' }]);
  const db = f.service.store.context.db;
  db.prepare('UPDATE chat_runtime_commands SET payload_json = ? WHERE command_id = ?')
    .run(JSON.stringify({ content: 'question 0', attachmentIds: [attachment.attachmentId] }), 'input-0');
  const first = (await f.service.dispatchCommand(parent.sessionId, { commandId: 'doc-fork', type: 'session.fork',
    payload: { sourceItemId: 'assistant-0' } })).result.session;
  const seed = f.service.store.readHistorySeed(first.sessionId);
  assert.match(JSON.stringify(seed.responseItems), /document-marker/);
  const owned = Object.values(seed.messageSubmissions)[0].attachmentIds;
  assert.notEqual(owned[0], attachment.attachmentId);
  assert.deepEqual(f.service.store.resolveAttachmentPaths(first.sessionId, owned), [file]);
  assert.throws(() => f.service.store.resolveAttachmentPaths(parent.sessionId, owned));
  const second = (await f.service.dispatchCommand(first.sessionId, { commandId: 'doc-fork-again', type: 'session.fork',
    payload: { sourceItemId: f.service.getSnapshot(first.sessionId).timeline.at(-1).id } })).result.session;
  assert.match(JSON.stringify(f.service.store.readHistorySeed(second.sessionId).responseItems), /document-marker/);
});

test('video key frames survive branch history rebuilding and remain session-owned', async (t) => {
  const f = fixture(t);
  const parent = await source(f, 1);
  const video = path.join(f.root, 'clip.mp4');
  const framesDir = videoFramesDir(video);
  const frame = path.join(framesDir, 'frame-01.jpg');
  fs.writeFileSync(video, 'video-marker');
  fs.mkdirSync(framesDir, { recursive: true });
  fs.writeFileSync(frame, 'frame-marker');
  fs.writeFileSync(path.join(framesDir, 'metadata.json'), JSON.stringify({
    durationSeconds: 4,
    ready: true,
    frames: ['frame-01.jpg']
  }));
  const [attachment] = f.service.store.createAttachments(parent.sessionId, [{
    filePath: video,
    name: 'clip.mp4',
    mimeType: 'video/mp4'
  }]);
  f.service.store.context.db.prepare('UPDATE chat_runtime_commands SET payload_json = ? WHERE command_id = ?')
    .run(JSON.stringify({ content: 'analyze video', attachmentIds: [attachment.attachmentId] }), 'input-0');

  const child = (await f.service.dispatchCommand(parent.sessionId, {
    commandId: 'video-fork',
    type: 'session.fork',
    payload: { sourceItemId: 'assistant-0' }
  })).result.session;
  const seed = f.service.store.readHistorySeed(child.sessionId);
  const userMessage = seed.responseItems.find((item) => item.role === 'user');
  assert.match(userMessage.content[0].text, /Attached video files:/);
  assert.match(userMessage.content[0].text, /clip\.mp4 \(4s\)/);
  assert.equal(userMessage.content[1].type, 'input_image');
  assert.equal(userMessage.content[1].image_url,
    `data:image/jpeg;base64,${Buffer.from('frame-marker').toString('base64')}`);
  const ownedIds = Object.values(seed.messageSubmissions)[0].attachmentIds;
  assert.notEqual(ownedIds[0], attachment.attachmentId);
  assert.deepEqual(f.service.store.resolveAttachmentPaths(child.sessionId, ownedIds), [video]);
});

test('system prompt is durable and inherited; invalid thresholds and mid-turn updates fail', async (t) => {
  const f = fixture(t);
  const parent = await source(f);
  await f.service.dispatchCommand(parent.sessionId, { commandId: 'role', type: 'session.policy.set',
    payload: { key: 'systemPrompt', value: 'Answer as a language teacher.' } });
  await f.service.dispatchCommand(parent.sessionId, { commandId: 'threshold', type: 'session.policy.set',
    payload: { key: 'autoCompactPercent', value: 75 } });
  const child = (await f.service.dispatchCommand(parent.sessionId, { commandId: 'role-fork', type: 'session.fork',
    payload: { sourceItemId: 'assistant-1' } })).result.session;
  const params = chatThreadParams({}, child, { threadConfig: { model_context_window: 10000 } });
  assert.equal(params.developerInstructions, 'Answer as a language teacher.');
  assert.equal(params.config.model_auto_compact_token_limit, 7500);
  assert.equal(params.config['features.shell_tool'], false);
  await assert.rejects(f.service.dispatchCommand(parent.sessionId, { commandId: 'invalid-limit', type: 'session.policy.set',
    payload: { key: 'autoCompactPercent', value: 0 } }), { code: 'chat_compaction_threshold_invalid' });
  f.service.store.context.db.prepare('UPDATE chat_runtime_sessions SET state = ? WHERE session_id = ?')
    .run('running', parent.sessionId);
  await assert.rejects(f.service.dispatchCommand(parent.sessionId, { commandId: 'mid-turn-role', type: 'session.policy.set',
    payload: { key: 'systemPrompt', value: 'Changed while running' } }), { code: 'chat_policy_turn_active' });
  f.restart();
  assert.equal(f.service.getSnapshot(child.sessionId).policy.systemPrompt, params.developerInstructions);
});

test('context state invalidates pre-compaction usage and records compaction failure', () => {
  const policy = { workspaceMode: 'chat', contextState: { usedTokens: 1000, contextWindow: 2000 } };
  const event = { type: 'timeline.item.started', turnId: 't1', at: 10,
    payload: { item: { kind: 'notice', id: 'c1', status: 'running', detail: { code: 'contextCompaction' } } } };
  const running = contextPatch({ policy }, event);
  const failed = contextPatch({ policy: { ...policy, contextState: running } }, { type: 'turn.failed', turnId: 't1', at: 20 });
  assert.equal(failed.compaction.status, 'failed');
  const done = contextPatch({ policy: { ...policy, contextState: running } }, { ...event,
    payload: { item: { ...event.payload.item, status: 'completed' } }, at: 25 });
  assert.equal(done.stale, true);
  const fresh = contextPatch({ policy: { ...policy, contextState: done } }, { type: 'turn.metrics.updated', at: 30,
    payload: { metrics: { contextTokens: 250, contextWindow: 2000 } } });
  assert.equal(fresh.usedTokens, 250);
  assert.equal(fresh.stale, false);
});
