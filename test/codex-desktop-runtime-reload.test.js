'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reloadCodexDesktopRuntime } = require('../lib/server/codex-desktop-runtime-reload');

test('an undetected desktop runtime cannot be reported as successfully reloaded', () => {
  const result = reloadCodexDesktopRuntime({
    ensureInstalled: () => ({ ok: true, supported: true, enabled: false, reason: 'codex_app_not_found' }),
    restartRunningAppServers: () => assert.fail('disabled hook must not restart a process')
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'codex_app_not_found');
});

test('an installed hook with no running desktop can be ready for the next launch', () => {
  const result = reloadCodexDesktopRuntime({
    ensureInstalled: () => ({ ok: true, enabled: true }),
    restartRunningAppServers: () => ({ ok: true, count: 0, pids: [] })
  });
  assert.equal(result.ok, true);
  assert.equal(result.restarted, false);
});
