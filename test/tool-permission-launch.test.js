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

test('tool permission launch skips codex resume and fork because remote resume rejects overrides', (t) => {
  const home = withHome(t);

  for (const argv of [['resume', '--last'], ['resume', 'abc'], ['fork', '--last']]) {
    const result = launch('codex', argv, { aiHomeDir: home });
    assert.equal(result.applied, false, `${argv.join(' ')} 不应注入权限`);
    assert.equal(result.reason, 'remote_resume_permissions_unsupported');
    assert.deepEqual(result.args, []);
    assert.ok(result.notice.includes('权限'), '跳过注入必须有可见提示');
  }
  // 普通会话仍然注入；`codex exec` 不是续接，照常注入（-a 在根级合法）
  assert.equal(launch('codex', [], { aiHomeDir: home }).applied, true);
  assert.equal(launch('codex', ['exec', 'hi'], { aiHomeDir: home }).applied, true);
  // 带值根级参数的值不能被误认成 resume 子命令
  assert.equal(
    launch('codex', ['-c', 'model=resume', '--last'], { aiHomeDir: home }).applied,
    true
  );
});

test('tool permission launch applies WebUI-selected permission args verbatim', (t) => {
  const home = withHome(t);

  saveToolPermissionSettings('claude', {
    maxPermission: true,
    applyToHost: false,
    permissionArgs: ['--permission-mode', 'acceptEdits']
  }, fs, home);

  const result = launch('claude', [], { aiHomeDir: home });
  assert.equal(result.applied, true);
  assert.deepEqual(result.args, ['--permission-mode', 'acceptEdits']);
});

test('tool permission launch refuses mutually exclusive selected args', (t) => {
  const home = withHome(t);

  saveToolPermissionSettings('kimi', {
    maxPermission: true,
    applyToHost: false,
    permissionArgs: ['--yolo', '--auto']
  }, fs, home);

  const result = launch('kimi', [], { aiHomeDir: home });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'conflict');
  assert.deepEqual(result.args, [], '互斥组合绝不能发出去');
  assert.equal(result.conflicts.length, 1);
});

test('tool permission launch refuses selected args that conflict with the native argv', (t) => {
  const home = withHome(t);

  saveToolPermissionSettings('codex', {
    maxPermission: true,
    applyToHost: false,
    permissionArgs: ['--approve-for-me']
  }, fs, home);

  const result = launch('codex', ['-a', 'never'], { aiHomeDir: home });
  // 用户显式传了权限旗标 → 先按 explicit 处理（不注入、不覆盖），也不会拼出互斥组合
  assert.equal(result.applied, false);
  assert.deepEqual(result.args, []);
});

