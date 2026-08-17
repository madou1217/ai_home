'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLIENT_ARCHITECTURES,
  CLIENT_PLATFORMS,
  CLIENT_PLATFORM_ADAPTERS,
  getClientPlatformAdapter,
  isClientArchitectureSupported,
  normalizeClientArchitecture,
  normalizeClientPlatform,
  resolveClientArchitecture,
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

test('平台接口统一归一化 CPU 架构并识别跨平台 ARM', () => {
  assert.deepEqual(Object.values(CLIENT_ARCHITECTURES).sort(), ['arm64', 'unknown', 'x64', 'x86']);
  assert.equal(normalizeClientArchitecture('AMD64'), CLIENT_ARCHITECTURES.X64);
  assert.equal(normalizeClientArchitecture('aarch64'), CLIENT_ARCHITECTURES.ARM64);
  assert.equal(resolveClientArchitecture({ processObj: { platform: 'linux', arch: 'arm64', env: {} } }), CLIENT_ARCHITECTURES.ARM64);
  assert.equal(resolveClientArchitecture({ platform: 'linux', processObj: { platform: 'darwin', arch: 'arm64', env: {} } }), CLIENT_ARCHITECTURES.UNKNOWN);
  assert.equal(isClientArchitectureSupported({ processObj: { platform: 'linux', arch: 'arm64', env: {} } }, [CLIENT_ARCHITECTURES.X64]), false);
  assert.equal(isClientArchitectureSupported({ platform: 'linux', processObj: { platform: 'darwin', arch: 'arm64', env: {} } }, [CLIENT_ARCHITECTURES.X64]), true);
});
