'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CHANNELS } = require('../lib/server/provider-cli-upgrade/upgrade-channel');
const {
  normalizeVersionSpec,
  buildPinnedPlans
} = require('../lib/server/provider-cli-upgrade/upgrade-plan-builder');

// codex 官方 install.sh 只认环境变量选版本（第 5 行 RELEASE="${CODEX_RELEASE:-latest}"），
// 所以钉版本必须落在 plan.env 上，而不是拼进命令串。
test('standalone 渠道经 CODEX_RELEASE 环境变量钉版本', () => {
  const result = buildPinnedPlans({
    channel: CHANNELS.STANDALONE_RELEASE,
    version: '0.153.4',
    platform: 'darwin'
  });

  assert.equal(result.ok, true);
  assert.equal(result.plans.length, 1);
  const [plan] = result.plans;
  assert.equal(plan.env.CODEX_RELEASE, '0.153.4');
  assert.match(plan.id, /pin_0\.153\.4$/);
  // 版本号不得出现在命令行里，避免任何拼接/转义面。
  assert.ok(!JSON.stringify(plan.args || []).includes('0.153.4'));
});

test('npm 渠道经 pkg@version 钉版本', () => {
  const result = buildPinnedPlans({
    channel: CHANNELS.NPM_GLOBAL,
    packageName: '@google/gemini-cli',
    version: '1.2.3',
    platform: 'darwin'
  });

  assert.equal(result.ok, true);
  assert.ok(result.plans[0].args.includes('@google/gemini-cli@1.2.3'));
});

test('npm 渠道缺包名时拒绝产出 plan', () => {
  const result = buildPinnedPlans({ channel: CHANNELS.NPM_GLOBAL, version: '1.2.3' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_package_name');
});

// 不可钉版本 = 不可回滚 = 不许自动升级，必须在 plan 这一层就断掉。
test('不可钉版本的渠道一律不产出 plan', () => {
  for (const channel of [CHANNELS.VENDOR_SELFUPDATE, CHANNELS.HOMEBREW, CHANNELS.UNKNOWN]) {
    const result = buildPinnedPlans({ channel, version: '1.2.3', packageName: 'x' });
    assert.equal(result.ok, false, channel);
    assert.equal(result.reason, 'channel_not_pinnable', channel);
  }
});

test('版本号做字符集白名单，拒绝可疑输入', () => {
  assert.equal(normalizeVersionSpec('0.154.0'), '0.154.0');
  assert.equal(normalizeVersionSpec('0.154.0-alpha.3'), '0.154.0-alpha.3');
  for (const bad of ['', '  ', '1.0.0; rm -rf /', '$(whoami)', '1.0.0 && x', '`id`', '-rf']) {
    assert.equal(normalizeVersionSpec(bad), '', bad);
  }
  assert.equal(buildPinnedPlans({
    channel: CHANNELS.STANDALONE_RELEASE,
    version: '1.0.0; rm -rf /'
  }).reason, 'invalid_version');
});

// plan.env 之前会被 runInstallPlanAsync 丢弃，钉版本会静默退化成装 latest。
test('runInstallPlanAsync 把 plan.env 合并进子进程环境', async () => {
  const { runInstallPlanAsync } = require('../lib/cli/services/ai-cli/ensure-native-cli');
  let captured = null;
  const fakeSpawn = (command, args, opts) => {
    captured = opts.env;
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit('close', 0));
    return child;
  };

  await runInstallPlanAsync(
    { command: 'true', args: [], env: { CODEX_RELEASE: '0.153.4' } },
    { spawn: fakeSpawn, processObj: { env: { PATH: '/usr/bin' }, platform: 'darwin' } }
  );

  assert.equal(captured.CODEX_RELEASE, '0.153.4');
  assert.equal(captured.CI, '1');
  assert.equal(captured.NONINTERACTIVE, '1');
  assert.equal(captured.PATH, '/usr/bin');
});

// 实测：install.sh 的 add_to_path 在 BIN_DIR 不在 PATH 上时会改写用户的 ~/.zprofile。
// 后台自动升级绝不能悄悄动 shell 配置，所以必须把 BIN_DIR 预置进子进程 PATH。
test('standalone plan 把安装目录预置进 PATH，避免安装脚本改写 shell profile', () => {
  const [plan] = buildPinnedPlans({
    channel: CHANNELS.STANDALONE_RELEASE,
    version: '0.153.4',
    platform: 'darwin',
    installDir: '/home/u/.local/bin',
    env: { PATH: '/usr/bin:/bin' }
  }).plans;

  assert.equal(plan.env.CODEX_INSTALL_DIR, '/home/u/.local/bin');
  assert.ok(plan.env.PATH.startsWith('/home/u/.local/bin:'));
});

test('安装目录已在 PATH 上时不重复注入 PATH', () => {
  const [plan] = buildPinnedPlans({
    channel: CHANNELS.STANDALONE_RELEASE,
    version: '0.153.4',
    platform: 'darwin',
    installDir: '/home/u/.local/bin',
    env: { PATH: '/usr/bin:/home/u/.local/bin' }
  }).plans;

  assert.equal(plan.env.CODEX_INSTALL_DIR, '/home/u/.local/bin');
  assert.equal(plan.env.PATH, undefined);
});

// 实测：update_visible_command 会用符号链接覆盖 <BIN_DIR>/codex，
// 而那正是 aih 的 CLI hook 垫片所在位置。
test('standalone plan 标记了升级后必须重装 aih 的 codex hook', () => {
  const [plan] = buildPinnedPlans({
    channel: CHANNELS.STANDALONE_RELEASE,
    version: '0.153.4',
    platform: 'darwin'
  }).plans;

  assert.deepEqual(plan.postInstall, ['reinstall_codex_cli_hook']);
});
