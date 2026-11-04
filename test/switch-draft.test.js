'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSwitchDraft, scheduleDraftReplay } = require('../lib/cli/services/pty/switch-draft');

test('keeps text typed since the last Enter', () => {
  const draft = createSwitchDraft();
  draft.observe('hello world');
  assert.equal(draft.take(), 'hello world');
  assert.equal(draft.peek(), '');
});

test('Enter submits and clears the draft', () => {
  const draft = createSwitchDraft();
  draft.observe('hello');
  draft.observe('\r');
  draft.observe('next line');
  assert.equal(draft.take(), 'next line');
});

test('backspace and cursor keys are preserved byte-for-byte', () => {
  const draft = createSwitchDraft();
  draft.observe('helo\x7f\x1b[DX');
  assert.equal(draft.take(), 'helo\x7f\x1b[DX');
});

test('pasted newlines are content, not submit', () => {
  const draft = createSwitchDraft();
  draft.observe('\x1b[200~line one\nline two\x1b[201~');
  assert.equal(draft.take(), '\x1b[200~line one\nline two\x1b[201~');
});

test('Ctrl+C / Ctrl+D / a lone Esc cancel the draft instead of being replayed', () => {
  const draft = createSwitchDraft();
  draft.observe('secret');
  draft.observe('\x03');
  assert.equal(draft.take(), '');

  draft.observe('secret');
  draft.observe('\x04');
  assert.equal(draft.take(), '');

  draft.observe('secret');
  draft.observe('\x1b');
  assert.equal(draft.take(), '');
});

test('the draft is capped and keeps the most recent bytes', () => {
  const draft = createSwitchDraft({ maxBytes: 8 });
  draft.observe('1234567890');
  assert.equal(draft.take(), '34567890');
});

test('multi-byte UTF-8 input survives as the exact original bytes', () => {
  const draft = createSwitchDraft();
  const bytes = Buffer.from('中文草稿🙂', 'utf8');
  draft.observe(bytes);
  assert.deepEqual(Buffer.from(draft.take(), 'latin1'), bytes);
});

test('replay waits for readiness and is cancelled when the process is gone', async () => {
  let ready = false;
  let current = true;
  const writes = [];
  scheduleDraftReplay({
    draft: 'draft text',
    isCurrent: () => current,
    isReady: () => ready,
    write: (value) => writes.push(value),
    readyDelayMs: 0,
    timeoutMs: 1000
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(writes, []);
  ready = true;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(writes, ['draft text']);
  current = false;
  scheduleDraftReplay({
    draft: 'late',
    isCurrent: () => current,
    isReady: () => true,
    write: (value) => writes.push(value),
    readyDelayMs: 0,
    timeoutMs: 1000
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(writes, ['draft text']);
});
