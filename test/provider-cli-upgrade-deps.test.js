'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createProviderUpgradeDeps } = require('../lib/server/provider-cli-upgrade/upgrade-deps');

// qoder 的 CLI 叫 qodercli。拿 provider id 当命令名时，Windows 上 `qoder` 命中的是
// Qoder IDE 自带的 qoder.cmd（报 IDE 的版本号），升级闭环会拿它和 qodercli 的 npm 版本比。
test('upgrade deps resolve the provider by its declared binary name, not its id', async () => {
  const asked = [];
  const deps = createProviderUpgradeDeps({
    processObj: { platform: 'linux', env: {}, execPath: '/usr/bin/node' },
    aiHomeDir: '/tmp/aih-upgrade-deps-test',
    resolveCliPath(name) {
      asked.push(name);
      return '';
    }
  });

  await deps.probeInstalledVersion('qoder');
  await deps.probeInstalledVersion('codex');

  assert.deepEqual(asked, ['qodercli', 'codex']);
});
