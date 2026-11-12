'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isContiguousFrom } = require('../lib/server/chat-runtime-service-support');

test('replay is contiguous only when seqs run after+1 without holes', () => {
  assert.equal(isContiguousFrom(4, []), true);
  assert.equal(isContiguousFrom(4, [{ seq: 5 }, { seq: 6 }]), true);
  // 历史压缩删掉了 seq 6：重放必须改走快照重置，否则前端判 gap 并暂停操作。
  assert.equal(isContiguousFrom(4, [{ seq: 5 }, { seq: 7 }]), false);
  assert.equal(isContiguousFrom(4, [{ seq: 6 }]), false);
});

test('returning to a visible tab resumes the stream instead of forcing a snapshot resync', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../web/src/chat-runtime/session-runtime-controller.ts'),
    'utf8',
  );
  const body = source.slice(source.indexOf('private setVisible('));
  const start = body.indexOf('if (visible) {');
  const visibleBranch = body.slice(start, body.indexOf('\n    }\n', start));
  assert.doesNotMatch(visibleBranch, /requestSnapshotResync/);
  assert.match(visibleBranch, /openEventStreamSafely/);
});

test('work drafts list accounts of every runnable provider', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../web/src/features/chat-runtime/session-surface-policy.ts'),
    'utf8',
  );
  const fn = source.slice(source.indexOf('export function runtimeAccountsForSession'));
  assert.match(fn.slice(0, fn.indexOf('\n}\n')), /if \(session\.draft\)/);
  const page = fs.readFileSync(path.join(__dirname, '../web/src/pages/chat-page-state.tsx'), 'utf8');
  assert.match(page, /session\.draft && session\.provider !== account\.provider/);
});
