'use strict';

const assert = require('node:assert/strict');
const nodePath = require('node:path');
const test = require('node:test');

const {
  PROVIDER_UPGRADE_PLUGINS,
  collectInstallRootCandidates,
  getProviderUpgradePlugin,
  strongVerifierFor
} = require('../lib/server/provider-cli-upgrade/provider-plugins');

const OPTIONAL_HOOKS = ['standaloneRoots', 'vendorSelfUpdateRoots', 'collectBusyEvidence', 'strongVerifier'];

test('CLI 升级插件：契约字段齐全，可选钩子要么缺省要么是函数', () => {
  assert.deepEqual(PROVIDER_UPGRADE_PLUGINS.map((plugin) => plugin.id), ['codex', 'claude', 'opencode']);
  for (const plugin of PROVIDER_UPGRADE_PLUGINS) {
    assert.equal(plugin.capability, 'provider-cli.upgrade');
    for (const hook of OPTIONAL_HOOKS) {
      if (plugin[hook] !== undefined) assert.equal(typeof plugin[hook], 'function', `${plugin.id}.${hook}`);
    }
  }
  assert.equal(getProviderUpgradePlugin(' Codex ').id, 'codex');
  assert.equal(getProviderUpgradePlugin('gemini'), null, '未注册的 provider 走通用路径');
});

test('CLI 升级插件：安装根候选按注册顺序汇总，强判据只有 codex 声明', () => {
  const context = { home: '/h', localAppData: '', path: nodePath.posix };
  assert.deepEqual(collectInstallRootCandidates('standaloneRoots', context).filter(Boolean), ['/h/.codex/packages/standalone']);
  assert.deepEqual(collectInstallRootCandidates('vendorSelfUpdateRoots', context), [
    '/h/.local/share/claude',
    '/h/.claude/local',
    '/h/.opencode'
  ]);
  assert.equal(strongVerifierFor('codex').name, 'verifyCodexAppServerBoot');
  assert.equal(strongVerifierFor('claude'), null);
  assert.equal(strongVerifierFor('gemini'), null);
});
