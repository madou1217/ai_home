'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TERMINAL_IDS = [
  'system-default',
  'wezterm',
  'warp',
  'iterm2',
  'windows-terminal',
  'cmd'
];
const ENVIRONMENT_TOOL_IDS = [
  'nvm',
  'fnm',
  'volta',
  'pnpm',
  'yarn',
  'bun',
  'pyenv',
  'conda',
  'uv',
  'poetry'
];

let terminalRegistry = {};
try {
  terminalRegistry = require('../lib/runtime/client-terminals');
} catch (_error) {}

let environmentRegistry = {};
try {
  environmentRegistry = require('../lib/cli/services/toolkit/environment/tools');
} catch (_error) {}

test('每个终端资源由独立模块实现统一启动与生命周期接口', () => {
  assert.equal(typeof terminalRegistry.listClientTerminalAdapters, 'function');
  assert.equal(typeof terminalRegistry.getClientTerminalAdapter, 'function');
  const adapters = terminalRegistry.listClientTerminalAdapters();
  assert.deepEqual(adapters.map((adapter) => adapter.id), TERMINAL_IDS);
  for (const adapter of adapters) {
    assert.equal(typeof adapter.supports, 'function', `${adapter.id} supports`);
    assert.equal(typeof adapter.detect, 'function', `${adapter.id} detect`);
    assert.equal(typeof adapter.buildLaunch, 'function', `${adapter.id} buildLaunch`);
    assert.equal(typeof adapter.install, 'function', `${adapter.id} install`);
    assert.equal(typeof adapter.update, 'function', `${adapter.id} update`);
    assert.equal(typeof adapter.uninstall, 'function', `${adapter.id} uninstall`);
    assert.equal(
      fs.existsSync(path.join(__dirname, '..', 'lib', 'runtime', 'client-terminals', `${adapter.id}.js`)),
      true,
      `${adapter.id} independent module`
    );
  }
});

test('每个运行环境资源由独立模块实现统一探测与生命周期接口', () => {
  assert.equal(typeof environmentRegistry.listEnvironmentToolAdapters, 'function');
  assert.equal(typeof environmentRegistry.getEnvironmentToolAdapter, 'function');
  const adapters = environmentRegistry.listEnvironmentToolAdapters();
  assert.deepEqual(adapters.map((adapter) => adapter.id), ENVIRONMENT_TOOL_IDS);
  for (const adapter of adapters) {
    assert.equal(typeof adapter.supports, 'function', `${adapter.id} supports`);
    assert.equal(typeof adapter.detect, 'function', `${adapter.id} detect`);
    assert.equal(typeof adapter.install, 'function', `${adapter.id} install`);
    assert.equal(typeof adapter.update, 'function', `${adapter.id} update`);
    assert.equal(typeof adapter.uninstall, 'function', `${adapter.id} uninstall`);
    assert.equal(
      fs.existsSync(path.join(__dirname, '..', 'lib', 'cli', 'services', 'toolkit', 'environment', 'tools', `${adapter.id}.js`)),
      true,
      `${adapter.id} independent module`
    );
  }
});

test('应用安装器继续遵循相同的 install update uninstall 契约', () => {
  const { INSTALLERS } = require('../lib/server/app-installers');
  const installers = Object.values(INSTALLERS);
  assert.ok(installers.length > 0);
  for (const installer of installers) {
    assert.equal(typeof installer.install, 'function', `${installer.provider} install`);
    assert.equal(typeof installer.update, 'function', `${installer.provider} update`);
    assert.equal(typeof installer.uninstall, 'function', `${installer.provider} uninstall`);
  }
});

test('聚合层不再内嵌终端或运行环境资源定义与资源 ID 分支', () => {
  const terminalSource = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'runtime', 'client-terminal.js'),
    'utf8'
  );
  const catalogSource = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'cli', 'services', 'toolkit', 'environment', 'catalog.js'),
    'utf8'
  );
  assert.doesNotMatch(terminalSource, /defineClientTerminalAdapter\(\{/);
  assert.doesNotMatch(catalogSource, /\bid:\s*['"](?:nvm|fnm|volta|pnpm|yarn|bun|pyenv|conda|uv|poetry)['"]/);
});
