'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTerminalTitle } = require('../lib/cli/services/pty/terminal-title');

function createHarness(options = {}) {
  const writes = [];
  let now = 1000;
  const title = createTerminalTitle({
    processObj: { platform: 'darwin', env: {}, stdout: { columns: 80, rows: 24, write() {} } },
    now: () => now,
    noticeTtlMs: options.noticeTtlMs || 1000,
    rotateIntervalMs: 0,
    transport: {
      id: 'fake',
      writeTitle: (text) => writes.push(text),
      clearTitle: () => writes.push('')
    },
    collectContext: () => ({ provider: 'codebuddy', accountId: '2', model: 'DeepSeek' })
  });
  return {
    title,
    writes,
    advance: (ms) => { now += ms; },
    last: () => writes[writes.length - 1]
  };
}

test('a notice temporarily replaces the rotating frame', () => {
  const h = createHarness();
  h.title.start();
  assert.equal(h.last(), 'CodeBuddy:2:DeepSeek');
  h.title.setNotice('⇄ CodeBuddy 已自动换号 1→2');
  assert.equal(h.last(), '⇄ CodeBuddy 已自动换号 1→2');
  h.advance(1500);
  h.title.refresh();
  assert.equal(h.last(), 'CodeBuddy:2:DeepSeek');
  h.title.stop();
});

test('a notice outranks the transient error icon', () => {
  const h = createHarness();
  h.title.start();
  h.title.setError('[429]');
  assert.equal(h.last(), '[429] CodeBuddy:2:DeepSeek');
  h.title.setNotice('⇄ 已自动换号 1→2');
  assert.equal(h.last(), '⇄ 已自动换号 1→2');
  h.title.clearNotice();
  assert.equal(h.last(), '[429] CodeBuddy:2:DeepSeek');
  h.title.stop();
});

test('an active notice is rewritten after the CLI overwrites the title', () => {
  const h = createHarness({ noticeTtlMs: 5000 });
  h.title.start();
  h.title.setNotice('播报');
  const afterNotice = h.writes.length;
  h.title.refresh();
  assert.equal(h.writes.length, afterNotice, 'unchanged content stays deduped within 1s');
  h.advance(1200);
  h.title.refresh();
  assert.equal(h.writes.length, afterNotice + 1);
  assert.equal(h.last(), '播报');
  h.title.stop();
});

test('an empty notice clears the overlay instead of writing a blank title', () => {
  const h = createHarness();
  h.title.start();
  h.title.setNotice('播报');
  h.title.setNotice('');
  assert.equal(h.last(), 'CodeBuddy:2:DeepSeek');
  h.title.stop();
});
