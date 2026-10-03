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

// 版本读空多半是偶发（机器忙、CLI 正被使用）：再试一次，别把已知版本覆盖成空。
test('upgrade deps retry an empty version probe once', async () => {
  const { EventEmitter } = require('node:events');
  let calls = 0;
  const deps = createProviderUpgradeDeps({
    processObj: { platform: 'linux', env: {}, execPath: '/usr/bin/node' },
    aiHomeDir: '/tmp/aih-upgrade-deps-test',
    fs: { readFileSync: () => '#!/bin/sh\n', realpathSync: (p) => p, existsSync: () => true },
    resolveCliPath: () => '/usr/local/bin/codex',
    spawn() {
      calls += 1;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      const ok = calls > 1;
      setImmediate(() => {
        if (ok) child.stdout.emit('data', 'codex-cli 0.160.0\n');
        child.emit('close', ok ? 0 : 1, null);
      });
      return child;
    }
  });

  assert.equal(await deps.probeInstalledVersion('codex'), '0.160.0');
  assert.equal(calls, 2);
});
