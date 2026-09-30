'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDesktopRuntimeLayout } = require('../lib/runtime/desktop-runtime-layout');
const { CODEX_DESKTOP_LAYOUTS, isCodexDesktopBinary } = require('../lib/runtime/codex-desktop-layouts');

test('desktop layouts prefer the current installed runtime without inventing a version boundary', () => {
  const root = '/Applications/ChatGPT.app';
  const current = `${root}/${CODEX_DESKTOP_LAYOUTS[0].relativePath}`;
  const legacy = `${root}/${CODEX_DESKTOP_LAYOUTS[1].relativePath}`;
  const present = new Set([current, legacy]);
  const fs = { existsSync: filename => present.has(filename) };
  const input = { fs, root, platform: 'darwin', layouts: CODEX_DESKTOP_LAYOUTS };
  assert.equal(resolveDesktopRuntimeLayout(input).executablePath, current);
  present.delete(current);
  assert.equal(resolveDesktopRuntimeLayout(input).executablePath, legacy);
  present.delete(legacy);
  assert.equal(resolveDesktopRuntimeLayout(input), null);
  assert.equal(isCodexDesktopBinary(current), true);
  assert.equal(isCodexDesktopBinary(legacy), true);
  assert.equal(isCodexDesktopBinary('/opt/homebrew/bin/codex'), false);
});

for (const [platform, root, expected] of [
  ['darwin', '/Applications/Test.app', '/Applications/Test.app/runtime/codex'],
  ['linux', '/opt/test', '/opt/test/runtime/codex'],
  ['win32', 'C:\\Apps\\Test', 'C:\\Apps\\Test\\runtime\\codex.exe']
]) {
  test(`${platform} composes layout path and numeric version range`, () => {
    const layouts = [
      { id: 'new', platform, minVersion: '26.10', relativePath: `runtime/codex${platform === 'win32' ? '.exe' : ''}` },
      { id: 'old', platform, maxVersionExclusive: '26.10', relativePath: 'old/codex' }
    ];
    const input = { fs: { existsSync: () => true }, root, platform, layouts };
    assert.equal(resolveDesktopRuntimeLayout({ ...input, version: '26.10.1' }).executablePath, expected);
    assert.equal(resolveDesktopRuntimeLayout({ ...input, version: '26.9' }).layoutId, 'old');
    assert.equal(resolveDesktopRuntimeLayout({ ...input, version: 'unknown' }), null);
  });
}

test('layout rules cannot escape the installation root or select a directory', () => {
  const fs = { existsSync: () => true, statSync: () => ({ isFile: () => false }) };
  for (const relativePath of ['../outside', '/absolute', 'C:\\outside', 'runtime/codex']) {
    assert.equal(resolveDesktopRuntimeLayout({
      fs, root: '/install', platform: 'linux', layouts: [{ platform: 'linux', relativePath }]
    }), null);
  }
});

test('Windows Store layout resolves the observed packaged CLI rather than the GUI', () => {
  const root = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.924.1866.0_x64__2p2nqsd0c76g0';
  const executable = `${root}\\app\\resources\\codex.exe`;
  assert.equal(resolveDesktopRuntimeLayout({
    fs: { existsSync: filename => filename === executable }, root, platform: 'win32',
    version: '26.924.1866.0', layouts: CODEX_DESKTOP_LAYOUTS
  }).executablePath, executable);
});
