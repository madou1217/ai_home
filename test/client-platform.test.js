'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLIENT_PLATFORMS,
  CLIENT_PLATFORM_ADAPTERS,
  getClientPlatformAdapter,
  normalizeClientPlatform,
  resolveClientPlatform,
  toNodePlatform
} = require('../lib/runtime/client-platform');
const { resolvePlatformPath } = require('../lib/runtime/platform-path');

test('跨平台公共接口只暴露统一平台标识', () => {
  assert.deepEqual(Object.values(CLIENT_PLATFORMS).sort(), ['linux', 'macos', 'windows']);
  assert.equal(normalizeClientPlatform('darwin'), CLIENT_PLATFORMS.MACOS);
  assert.equal(normalizeClientPlatform('win32'), CLIENT_PLATFORMS.WINDOWS);
  assert.equal(normalizeClientPlatform('Windows'), CLIENT_PLATFORMS.WINDOWS);
  assert.equal(normalizeClientPlatform('linux2'), CLIENT_PLATFORMS.LINUX);
  assert.equal(resolveClientPlatform({ processObj: { platform: 'darwin' } }), CLIENT_PLATFORMS.MACOS);
});

test('平台适配器接口封装 Node 路径和命令差异', () => {
  Object.values(CLIENT_PLATFORM_ADAPTERS).forEach((adapter) => {
    assert.equal(adapter.id, normalizeClientPlatform(adapter.id));
    assert.equal(typeof adapter.nodePlatform, 'string');
    assert.equal(typeof adapter.path.join, 'function');
    assert.equal(typeof adapter.commands.npm, 'string');
  });
  assert.equal(getClientPlatformAdapter('windows').commands.npm, 'npm.cmd');
  assert.equal(toNodePlatform('windows'), 'win32');
  assert.equal(resolvePlatformPath('windows').sep, '\\');
  assert.equal(resolvePlatformPath('macos').sep, '/');
});
