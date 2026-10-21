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

// qoder 的权限取值用下划线（bypass_permissions），与 claude 的驼峰（bypassPermissions）
// 不同；合同原先没声明权限，最大权限推导不出参数。
test('qoder and qodercn resolve max permission with their own underscore mode', (t) => {
  const home = withHome(t);
  for (const provider of ['qoder', 'qodercn']) {
    const result = launch(provider, [], { aiHomeDir: home });
    assert.deepEqual(result.args, ['--permission-mode', 'bypass_permissions'], provider);
  }
});

// 2026-10-21 实测（kimi 2.2.0 --help 原文）：`-y/--yolo` 是「Ask When Needed」，
// **有风险的操作、提问与计划仍会问**；`--auto` 才是「Never Ask」。合同原先只声明
// `--yolo`，于是「最大权限」被注入成低一档。
test('kimi max permission is --auto (Never Ask), not --yolo (Ask When Needed)', (t) => {
  const home = withHome(t);
  const result = launch('kimi', [], { aiHomeDir: home });
  assert.deepEqual(result.args, ['--auto']);
  // --yolo 低一档，不能拿来当最大权限。
  assert.ok(!result.args.includes('--yolo'));
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


// 2026-10-21 用户报障：`aih codex` 每次启动都补 `--sandbox danger-full-access
// --ask-for-approval never`，而 config.toml 里本来就写着 `sandbox_mode =
// "danger-full-access"`。命令行与配置重复表达同一件事，让 codex 界面的权限状态与
// 用户自己 /approvals 切出来的对不上，resume 路径又会把旗标整组摘掉，于是新会话与
// 恢复会话显示两种权限状态。用户的要求：配置里已经有的就不要再加。
test('a host config that already grants the permission is not restated on the command line', (t) => {
  const home = withHome(t);
  const codexDir = path.join(home, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'config.toml'), 'sandbox_mode = "danger-full-access"\n');

  const result = launch('codex', [], { aiHomeDir: home, hostHomeDir: home, env: { HOME: home } });
  // sandbox 已在配置里 → 不再注入；approval 配置没写 → 补上（不替用户加宽）。
  assert.deepEqual(result.args, ['--ask-for-approval', 'never']);
  assert.equal(result.reason, 'applied_remainder');
  assert.equal(result.hostState.known, true);
});

test('a host config that grants everything means no permission args at all', (t) => {
  const home = withHome(t);
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    permissions: { defaultMode: 'bypassPermissions' }
  }));

  const result = launch('claude', [], { aiHomeDir: home, hostHomeDir: home, env: { HOME: home } });
  assert.deepEqual(result.args, []);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'host_config_satisfied');
});

test('without a readable host config the full max-permission set is still injected', (t) => {
  const home = withHome(t);
  const result = launch('opencode', [], { aiHomeDir: home, hostHomeDir: home, env: { HOME: home } });
  assert.deepEqual(result.args, ['--auto']);
  assert.equal(result.reason, 'applied');
});

test('a host config that grants a weaker value does not suppress the injection', (t) => {
  const home = withHome(t);
  const codexDir = path.join(home, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'config.toml'), 'sandbox_mode = "workspace-write"\n');

  const result = launch('codex', [], { aiHomeDir: home, hostHomeDir: home, env: { HOME: home } });
  assert.deepEqual(result.args, ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never']);
  assert.equal(result.reason, 'applied');
});
