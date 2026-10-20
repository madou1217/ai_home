'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildToolPermissionLaunchArgs
} = require('../lib/cli/services/toolkit/tool-permission-launch');
const {
  saveToolPermissionSettings
} = require('../lib/cli/services/toolkit/tool-app-settings');

function withHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-tool-permission-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function launch(provider, argv, extra = {}) {
  return buildToolPermissionLaunchArgs({
    provider,
    argv,
    fs,
    aiHomeDir: extra.aiHomeDir || '',
    ...extra
  });
}

test('tool permission launch derives max-permission args from the provider contract', (t) => {
  const home = withHome(t);

  assert.deepEqual(launch('claude', [], { aiHomeDir: home }).args, [
    '--permission-mode',
    'bypassPermissions'
  ]);
  assert.deepEqual(launch('codex', [], { aiHomeDir: home }).args, [
    '--sandbox',
    'danger-full-access',
    '--ask-for-approval',
    'never'
  ]);
  assert.deepEqual(launch('gemini', [], { aiHomeDir: home }).args, [
    '--approval-mode',
    'yolo'
  ]);
  assert.deepEqual(launch('opencode', [], { aiHomeDir: home }).args, ['--auto']);
  assert.equal(launch('cline', [], { aiHomeDir: home }).applied, false);
  assert.equal(launch('cline', [], { aiHomeDir: home }).reason, 'unsupported');
});

test('tool permission launch never overrides an explicit native permission flag', (t) => {
  const home = withHome(t);

  assert.equal(
    launch('claude', ['--permission-mode', 'acceptEdits'], { aiHomeDir: home }).reason,
    'explicit'
  );
  assert.equal(
    launch('claude', ['--permission-mode=plan'], { aiHomeDir: home }).reason,
    'explicit'
  );
  assert.equal(
    launch('codex', ['-s', 'workspace-write'], { aiHomeDir: home }).reason,
    'explicit'
  );
  assert.equal(
    launch('codex', ['--dangerously-bypass-approvals-and-sandbox'], { aiHomeDir: home }).reason,
    'explicit'
  );
  assert.equal(
    launch('claude', [], { aiHomeDir: home, isLogin: true }).reason,
    'login'
  );
});

test('tool permission launch leaves informational commands untouched', (t) => {
  const home = withHome(t);

  for (const argv of [['--version'], ['-V'], ['--help'], ['-h']]) {
    const result = launch('codex', argv, { aiHomeDir: home });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'informational');
    assert.deepEqual(result.args, []);
  }
});

test('tool permission launch respects the per-provider maxPermission switch', (t) => {
  const home = withHome(t);

  saveToolPermissionSettings('claude', { maxPermission: false, applyToHost: false }, fs, home);
  const disabled = launch('claude', [], { aiHomeDir: home });
  assert.equal(disabled.applied, false);
  assert.equal(disabled.reason, 'disabled');

  saveToolPermissionSettings('claude', { maxPermission: true, applyToHost: false }, fs, home);
  const enabled = launch('claude', [], { aiHomeDir: home });
  assert.equal(enabled.applied, true);
  assert.deepEqual(enabled.args, ['--permission-mode', 'bypassPermissions']);
});
