'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const fs = require('fs-extra');

const sessionReader = require('../lib/sessions/session-reader');

function withCodexSession(t, sessionId, initialBytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-session-reader-atomic-'));
  const previousRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;
  const sessionDir = path.join(root, '.codex', 'sessions', '2026', '07', '14');
  const sessionFile = path.join(
    sessionDir,
    `rollout-2026-07-14T23-00-00-${sessionId}.jsonl`
  );
  fs.ensureDirSync(sessionDir);
  fs.writeFileSync(sessionFile, initialBytes);
  t.after(() => {
    if (previousRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = previousRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return sessionFile;
}

function assistantRecord(sessionText, timestamp) {
  return Buffer.from(JSON.stringify({
    timestamp,
    type: 'response_item',
    payload: {
      role: 'assistant',
      content: [{ type: 'output_text', text: sessionText }]
    }
  }) + '\n');
}

test('Codex snapshot cursor waits for a partial JSONL record to finish', (t) => {
  const sessionId = 'dddddddd-dddd-4ddd-8ddd-000000000001';
  const first = assistantRecord('first', '2026-07-14T23:00:00.000Z');
  const second = assistantRecord('second', '2026-07-14T23:00:01.000Z');
  const split = Math.floor(second.length / 2);
  const sessionFile = withCodexSession(
    t,
    sessionId,
    Buffer.concat([first, second.subarray(0, split)])
  );

  const snapshot = sessionReader.readSessionMessagesSnapshot('codex', { sessionId });
  assert.equal(snapshot.cursor, first.length);
  assert.deepEqual(snapshot.messages.map((message) => message.content), ['first']);

  fs.appendFileSync(sessionFile, second.subarray(split));
  const delta = sessionReader.readSessionEvents('codex', { sessionId }, {
    cursor: snapshot.cursor
  });

  assert.equal(delta.cursor, first.length + second.length);
  assert.deepEqual(delta.events.map((event) => event.text), ['second']);
});

test('Codex strict snapshot propagates a transcript I/O failure', (t) => {
  const sessionId = 'dddddddd-dddd-4ddd-8ddd-000000000007';
  const sessionFile = withCodexSession(
    t,
    sessionId,
    assistantRecord('unreadable', '2026-07-14T23:06:00.000Z')
  );
  const originalOpenSync = fs.openSync;
  fs.openSync = function patchedOpenSync(targetPath, ...args) {
    if (targetPath === sessionFile) throw new Error('simulated_transcript_io_failure');
    return originalOpenSync.call(this, targetPath, ...args);
  };
  t.after(() => {
    fs.openSync = originalOpenSync;
  });

  assert.throws(
    () => sessionReader.readSessionMessagesSnapshot('codex', { sessionId }),
    /simulated_transcript_io_failure/
  );
});

test('Codex strict snapshot rejects and retries a short transcript read', (t) => {
  const sessionId = 'dddddddd-dddd-4ddd-8ddd-000000000008';
  const sessionFile = withCodexSession(
    t,
    sessionId,
    assistantRecord('retry-after-short-read', '2026-07-14T23:07:00.000Z')
  );
  const sessionInode = fs.statSync(sessionFile).ino;
  const originalReadSync = fs.readSync;
  let failNextRead = true;
  fs.readSync = function patchedReadSync(fd, ...args) {
    if (failNextRead && fs.fstatSync(fd).ino === sessionInode) {
      failNextRead = false;
      return 0;
    }
    return originalReadSync.call(this, fd, ...args);
  };
  t.after(() => {
    fs.readSync = originalReadSync;
  });

  assert.throws(
    () => sessionReader.readSessionMessagesSnapshot('codex', { sessionId }),
    (error) => error && error.code === 'SESSION_JSONL_SNAPSHOT_SHORT_READ'
  );

  const recovered = sessionReader.readSessionMessagesSnapshot('codex', { sessionId });
  assert.equal(recovered.messages.length, 1);
  assert.equal(recovered.messages[0].content, 'retry-after-short-read');
  assert.equal(recovered.cursor, fs.statSync(sessionFile).size);
});

test('Codex JSONL reader preserves UTF-8 split across its read chunk boundary', (t) => {
  const sessionId = 'dddddddd-dddd-4ddd-8ddd-000000000002';
  const marker = '__TEXT_MARKER__';
  const template = JSON.stringify({
    timestamp: '2026-07-14T23:01:00.000Z',
    type: 'response_item',
    payload: {
      role: 'assistant',
      content: [{ type: 'output_text', text: marker }]
    }
  });
  const markerIndex = template.indexOf(marker);
  const prefixBytes = Buffer.byteLength(template.slice(0, markerIndex), 'utf8');
  const chunkSize = 256 * 1024;
  const paddingLength = (chunkSize - 1 - (prefixBytes % chunkSize) + chunkSize) % chunkSize;
  const content = `${'x'.repeat(paddingLength)}中-END`;
  const record = Buffer.from(template.replace(marker, content) + '\n');
  withCodexSession(t, sessionId, record);

  const snapshot = sessionReader.readSessionMessagesSnapshot('codex', { sessionId });

  assert.equal((prefixBytes + paddingLength) % chunkSize, chunkSize - 1);
  assert.match(snapshot.messages[0].content, /中-END$/u);
  assert.doesNotMatch(snapshot.messages[0].content, /�/u);
  assert.equal(snapshot.cursor, record.length);
});

test('Codex event cursor follows the scanner snapshot when the file grows between stats', (t) => {
  const sessionId = 'dddddddd-dddd-4ddd-8ddd-000000000003';
  const first = assistantRecord('first', '2026-07-14T23:02:00.000Z');
  const second = assistantRecord('second', '2026-07-14T23:02:01.000Z');
  const sessionFile = withCodexSession(t, sessionId, first);
  const originalOpenSync = fs.openSync;
  let appended = false;

  fs.openSync = function patchedOpenSync(targetPath, ...args) {
    const fd = originalOpenSync.call(this, targetPath, ...args);
    if (!appended && targetPath === sessionFile) {
      appended = true;
      fs.appendFileSync(sessionFile, second);
    }
    return fd;
  };
  t.after(() => {
    fs.openSync = originalOpenSync;
  });

  const delta = sessionReader.readSessionEvents('codex', { sessionId }, { cursor: 0 });

  assert.equal(delta.cursor, first.length + second.length);
  assert.deepEqual(delta.events.map((event) => event.text), ['first', 'second']);
});

test('Codex events request a fresh snapshot after transcript truncation', (t) => {
  const sessionId = 'dddddddd-dddd-4ddd-8ddd-000000000005';
  const initial = Buffer.concat([
    assistantRecord('old-first', '2026-07-14T23:04:00.000Z'),
    assistantRecord('old-second', '2026-07-14T23:04:01.000Z')
  ]);
  const replacement = assistantRecord('new-generation', '2026-07-14T23:04:02.000Z');
  const sessionFile = withCodexSession(t, sessionId, initial);
  const oldSnapshot = sessionReader.readSessionMessagesSnapshot('codex', { sessionId });
  fs.writeFileSync(sessionFile, replacement);

  const delta = sessionReader.readSessionEvents('codex', { sessionId }, {
    cursor: oldSnapshot.cursor
  });
  const freshSnapshot = sessionReader.readSessionMessagesSnapshot('codex', { sessionId });

  assert.ok(delta.cursor < oldSnapshot.cursor);
  assert.equal(delta.requiresSnapshot, true);
  assert.deepEqual(delta.events, []);
  assert.equal(freshSnapshot.cursor, replacement.length);
  assert.deepEqual(
    freshSnapshot.messages.map((message) => message.content),
    ['new-generation']
  );
});
