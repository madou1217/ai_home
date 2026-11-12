'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { beginSwitchScreen } = require('../lib/cli/services/pty/switch-screen');

function createStdout(isTTY) {
  const writes = [];
  return {
    isTTY,
    write(value) { writes.push(value); },
    writes
  };
}

test('non-TTY runs are a no-op', () => {
  const stdout = createStdout(false);
  const lease = beginSwitchScreen({ stdout });
  lease.end();
  assert.deepEqual(stdout.writes, []);
});

test('a TTY transition hides the cursor, enables synchronized output and restores once', () => {
  const stdout = createStdout(true);
  const lease = beginSwitchScreen({ stdout, timeoutMs: 10000 });
  assert.ok(stdout.writes.some((value) => value.includes('\x1b[?25l')));
  assert.ok(stdout.writes.some((value) => value.includes('\x1b[?2026h')));
  assert.ok(stdout.writes.some((value) => value.includes('\x1b[?2004l')));
  lease.end();
  lease.end();
  const joined = stdout.writes.join('');
  assert.equal((joined.match(/\x1b\[\?2026l/g) || []).length, 1);
  assert.equal((joined.match(/\x1b\[\?25h/g) || []).length, 1);
});
