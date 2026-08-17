'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { listProviderDefinitions } = require('../lib/provider-catalog');
const { getAppInstaller, INSTALLERS } = require('../lib/server/app-installers');

test('每个合同 CLI Provider 都由独立安装器模块提供统一入口', () => {
  const providers = listProviderDefinitions()
    .filter((definition) => definition.cli)
    .map((definition) => definition.id);
  assert.ok(providers.length > 0);
  providers.forEach((provider) => {
    const installer = getAppInstaller(provider);
    assert.ok(installer, `${provider} must have an independent installer module`);
    assert.equal(installer.provider, provider);
    assert.equal(typeof installer.installCli, 'function');
    assert.equal(typeof installer.resolveDesktopInstallPlans, 'function');
  });
  assert.deepEqual(Object.keys(INSTALLERS).sort(), providers.slice().sort());
});

test('桌面安装参数只来自对应 Provider 安装器', () => {
  const codex = getAppInstaller('codex');
  const claude = getAppInstaller('claude');
  const zcode = getAppInstaller('zcode');
  const gemini = getAppInstaller('gemini');
  const grok = getAppInstaller('grok');

  assert.deepEqual(codex.resolveDesktopInstallPlans({ platform: 'darwin' })[0].args, [
    'install', '--cask', 'chatgpt'
  ]);
  assert.deepEqual(claude.resolveDesktopInstallPlans({ platform: 'win32' })[0].args.slice(0, 4), [
    'install', '--id', 'Anthropic.Claude', '--exact'
  ]);
  assert.equal(zcode.resolveDesktopInstallPlans({ platform: 'darwin' })[0].id, 'zcode_desktop_macos_official_page');
  assert.deepEqual(gemini.resolveDesktopInstallPlans({ platform: 'darwin' }), []);
  assert.deepEqual(grok.resolveDesktopInstallPlans({ platform: 'darwin' }), []);
});

test('安装器公共平台接口使用 macos/windows/linux，兼容 Node 别名输入', () => {
  const codex = getAppInstaller('codex');
  const claude = getAppInstaller('claude');
  assert.equal(codex.resolveDesktopInstallPlans({ platform: 'macos' })[0].command, 'brew');
  assert.equal(claude.resolveDesktopInstallPlans({ platform: 'windows' })[0].command, 'winget.exe');
  assert.equal(codex.resolveDesktopInstallPlans({ platform: 'win32' })[0].command, 'winget.exe');
});
