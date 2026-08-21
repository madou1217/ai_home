const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('node:path');

const {
  resolveHostSearchPath,
  resolveHostSearchPathEntries,
  withHostSearchPath
} = require('../lib/runtime/host-search-path');

function fakeLoginShell(pathValue, calls = []) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    return pathValue;
  };
}

test('resolveHostSearchPathEntries 补齐登录 shell 的 PATH 且保持宿主顺序优先', () => {
  const calls = [];
  const entries = resolveHostSearchPathEntries({
    env: { PATH: '/usr/bin:/bin' },
    platform: 'darwin',
    execFileSync: fakeLoginShell('/home/alice/.local/bin:/usr/bin:/opt/extra', calls)
  });
  assert.deepEqual(entries, ['/usr/bin', '/bin', '/home/alice/.local/bin', '/opt/extra']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/bin/sh');
  assert.deepEqual(calls[0].args, ['-lc', 'printf %s "$PATH"']);
});

test('resolveHostSearchPathEntries 追加安装器约定的 ~/.local/bin', () => {
  const entries = resolveHostSearchPathEntries({
    env: { PATH: '/usr/bin' },
    platform: 'linux',
    hostHomeDir: '/home/alice',
    execFileSync: () => ''
  });
  assert.deepEqual(entries, ['/usr/bin', '/home/alice/.local/bin']);
});

test('resolveHostSearchPathEntries 在 Windows 上不拉起登录 shell', () => {
  const calls = [];
  const entries = resolveHostSearchPathEntries({
    env: { Path: 'C:\\Windows' },
    platform: 'win32',
    hostHomeDir: 'C:\\Users\\alice',
    path: nodePath.win32,
    execFileSync: fakeLoginShell('ignored', calls)
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(entries, ['C:\\Windows', 'C:\\Users\\alice\\.local\\bin']);
});

test('登录 shell 失败时降级为宿主 PATH，不抛错', () => {
  const entries = resolveHostSearchPathEntries({
    env: { PATH: '/usr/bin' },
    platform: 'darwin',
    execFileSync: () => { throw new Error('sh missing'); }
  });
  assert.deepEqual(entries, ['/usr/bin']);
});

test('resolveHostSearchPath 按平台分隔符拼接', () => {
  assert.equal(resolveHostSearchPath({
    env: { PATH: '/usr/bin' },
    platform: 'darwin',
    hostHomeDir: '/home/alice',
    execFileSync: () => ''
  }), '/usr/bin:/home/alice/.local/bin');
  assert.equal(resolveHostSearchPath({
    env: { Path: 'C:\\Windows' },
    platform: 'windows',
    hostHomeDir: 'C:\\Users\\alice',
    path: nodePath.win32,
    execFileSync: () => ''
  }), 'C:\\Windows;C:\\Users\\alice\\.local\\bin');
});

test('withHostSearchPath 保留其余 env 并只改写 PATH 键', () => {
  const out = withHostSearchPath({
    env: { PATH: '/usr/bin', HOME: '/home/alice', LANG: 'C' },
    platform: 'darwin',
    hostHomeDir: '/home/alice',
    execFileSync: () => ''
  });
  assert.equal(out.PATH, '/usr/bin:/home/alice/.local/bin');
  assert.equal(out.HOME, '/home/alice');
  assert.equal(out.LANG, 'C');

  const windows = withHostSearchPath({
    env: { Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\alice' },
    platform: 'win32',
    hostHomeDir: 'C:\\Users\\alice',
    path: nodePath.win32,
    execFileSync: () => ''
  });
  assert.equal(windows.Path, 'C:\\Windows;C:\\Users\\alice\\.local\\bin');
  assert.equal(windows.PATH, undefined);

  // 混合大小写的 env 只保留一个 PATH 键，避免不同解析器读到两份不同的值。
  const mixed = withHostSearchPath({
    env: { PATH: '/usr/bin', Path: '/stale', path: '/stale-lower' },
    platform: 'darwin',
    hostHomeDir: '/home/alice',
    execFileSync: () => ''
  });
  assert.equal(mixed.PATH, '/usr/bin:/home/alice/.local/bin');
  assert.equal(mixed.Path, undefined);
  assert.equal(mixed.path, undefined);
});
