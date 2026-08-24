'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  convertWindowsPathToWsl,
  healCodexProjectsSection,
  healCodexConfigFile
} = require('../lib/cli/services/pty/codex-config-heal');

function fakeFs(existingPaths = []) {
  const set = new Set(existingPaths.map((value) => String(value).toLowerCase()));
  return { existsSync: (value) => set.has(String(value).toLowerCase()) };
}

function realFsWithExistingPaths(existingPaths = []) {
  const set = new Set(existingPaths.map((value) => String(value).toLowerCase()));
  return Object.assign(Object.create(fs), {
    existsSync: (value) => set.has(String(value).toLowerCase()) || fs.existsSync(value)
  });
}

// 用 String.raw 保证夹具里的 TOML 转义与真实 config.toml 完全一致：
// 双引号基本串中一个反斜杠需写成 \\。
const WIN_AI = String.raw`[projects."C:\\Users\\madou\\proj\\ai"]`;
const WSL_AI = "[projects.'/mnt/c/Users/madou/proj/ai']";
const WIN_AI_DIR = 'C:\\Users\\madou\\proj\\ai';

test('projects 跨端重复条目保留本平台形态、删除外来形态', () => {
  const config = [
    WIN_AI,
    'trust_level = "trusted"',
    '',
    WSL_AI,
    'trust_level = "trusted"'
  ].join('\n');
  const result = healCodexProjectsSection(config, {
    platform: 'win32',
    fs: fakeFs([WIN_AI_DIR])
  });
  assert.deepEqual(result.removed, [
    { path: '/mnt/c/Users/madou/proj/ai', reason: 'duplicate' }
  ]);
  assert.equal(result.converted.length, 0);
  assert.equal(result.config.includes('/mnt/c'), false);
  assert.ok(result.config.includes(WIN_AI));
});

test('projects 跨端条目无本平台形态时转换为目标存在的路径', () => {
  const config = [
    "[projects.'/mnt/c/Users/madou/proj/solo']",
    'trust_level = "trusted"'
  ].join('\n');
  const result = healCodexProjectsSection(config, {
    platform: 'win32',
    fs: fakeFs(['C:\\Users\\madou\\proj\\solo'])
  });
  assert.deepEqual(result.converted, [
    { from: '/mnt/c/Users/madou/proj/solo', to: 'C:\\Users\\madou\\proj\\solo' }
  ]);
  assert.ok(result.config.includes("[projects.'C:\\Users\\madou\\proj\\solo']"));
});

test('projects 两种形态目录都不存在的死条目被清理', () => {
  const config = [
    "[projects.'C:\\Users\\madou\\AppData\\Local\\Temp\\aih-remove-project-junk']",
    'trust_level = "trusted"',
    '',
    String.raw`[projects."C:\\Users\\madou\\proj\\alive"]`,
    'trust_level = "trusted"',
    '',
    "[projects.'/mnt/c/Users/madou/proj/gone']",
    'trust_level = "trusted"'
  ].join('\n');
  const result = healCodexProjectsSection(config, {
    platform: 'win32',
    fs: fakeFs(['C:\\Users\\madou\\proj\\alive'])
  });
  assert.equal(result.config.includes('aih-remove-project-junk'), false);
  assert.equal(result.config.includes('gone'), false);
  assert.ok(result.config.includes('alive'));
  assert.equal(result.removed.length, 2);
  assert.ok(result.removed.every((item) => item.reason === 'dead'));
});

test('projects 在 WSL/Linux 侧把 Windows 条目转换为挂载形态', () => {
  const config = [
    "[projects.'C:\\Users\\madou\\proj\\shared']",
    'trust_level = "trusted"'
  ].join('\n');
  const result = healCodexProjectsSection(config, {
    platform: 'linux',
    fs: fakeFs(['/mnt/c/Users/madou/proj/shared'])
  });
  assert.deepEqual(result.converted, [
    { from: 'C:\\Users\\madou\\proj\\shared', to: '/mnt/c/Users/madou/proj/shared' }
  ]);
  assert.ok(result.config.includes("[projects.'/mnt/c/Users/madou/proj/shared']"));
});

test('verbatim 前缀与裸键 projects 条目不属跨端混杂，存在的原样保留', () => {
  const verbatimKey = '?\\C:\\Users\\madou\\proj\\v';
  const verbatimHeader = `[projects.'\\\\${verbatimKey}']`;
  const config = [
    verbatimHeader,
    'trust_level = "trusted"',
    '',
    '[projects.tiny]',
    'trust_level = "trusted"'
  ].join('\n');
  const result = healCodexProjectsSection(config, {
    platform: 'win32',
    fs: fakeFs([`\\\\${verbatimKey}`])
  });
  assert.equal(result.removed.length, 0);
  assert.equal(result.converted.length, 0);
  assert.ok(result.config.includes('projects.tiny'));
});

test('healCodexConfigFile 组合自愈一次备份一次写回', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-config-heal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.toml');
  const wslUvx = '/mnt/c/Users/madou/.local/bin/uvx.exe';
  const winUvx = 'C:\\Users\\madou\\.local\\bin\\uvx.exe';
  const winProjectDir = 'C:\\Users\\madou\\proj\\shared';
  const wslProjectDir = convertWindowsPathToWsl(winProjectDir);
  const winHeader = String.raw`[projects."C:\\Users\\madou\\proj\\shared"]`;
  const wslHeader = `[projects.'${wslProjectDir}']`;
  fs.writeFileSync(configPath, [
    '[mcp_servers.blender]',
    `command = '${wslUvx}'`,
    '',
    winHeader,
    'trust_level = "trusted"',
    '',
    wslHeader,
    'trust_level = "trusted"'
  ].join('\n'), 'utf8');

  const logs = [];
  const result = healCodexConfigFile(configPath, {
    fs: realFsWithExistingPaths([winUvx, winProjectDir]),
    platform: 'win32',
    log: (message) => logs.push(message)
  });
  assert.equal(result.changed, true);
  assert.equal(result.mcp.converted.length, 1);
  assert.deepEqual(result.mcp.converted[0].to, winUvx);
  assert.equal(result.projects.removed.length, 1);
  assert.equal(result.projects.removed[0].reason, 'duplicate');
  assert.equal(fs.existsSync(result.backupPath), true);
  const text = fs.readFileSync(configPath, 'utf8');
  assert.equal(text.includes('/mnt/c'), false);
  assert.ok(logs.some((line) => line.includes('projects')));

  const again = healCodexConfigFile(configPath, {
    fs: realFsWithExistingPaths([winUvx, winProjectDir]),
    platform: 'win32',
    log: () => {}
  });
  assert.equal(again.changed, false, '组合自愈应幂等');
});

test('hooks.state 外来形态信任键被清理，本平台键保留', () => {
  const { healCodexHooksStateSection } = require('../lib/cli/services/pty/codex-config-heal');
  const config = [
    '[hooks.state]',
    '',
    "[hooks.state.\"/mnt/c/Users/madou/.codex/hooks.json:stop:0:0\"]",
    'trusted_hash = "sha256:aaaa"',
    '',
    "[hooks.state.'C:\\Users\\madou\\.codex\\hooks.json:session_start:0:0']",
    'trusted_hash = "sha256:bbbb"',
    '',
    "[hooks.state.'C:\\Users\\madou\\.codex\\hooks.json:stop:0:0']",
    'trusted_hash = "sha256:cccc"'
  ].join('\n');
  const result = healCodexHooksStateSection(config, { platform: 'win32' });
  assert.equal(result.removed.length, 1);
  assert.ok(result.removed[0].key.includes('/mnt/c'));
  assert.equal(result.config.includes('/mnt/c'), false);
  assert.equal(result.config.includes('sha256:bbbb'), true);
  assert.equal(result.config.includes('sha256:cccc'), true);
});

test('hooks.state 在 WSL 侧清理 Windows 形态键', () => {
  const { healCodexHooksStateSection } = require('../lib/cli/services/pty/codex-config-heal');
  const config = [
    '[hooks.state]',
    "[hooks.state.'C:\\Users\\madou\\.codex\\hooks.json:stop:0:0']",
    'trusted_hash = "sha256:dddd"',
    "[hooks.state.\"/mnt/c/Users/madou/.codex/hooks.json:stop:0:0\"]",
    'trusted_hash = "sha256:eeee"'
  ].join('\n');
  const result = healCodexHooksStateSection(config, { platform: 'linux' });
  assert.equal(result.removed.length, 1);
  assert.ok(result.removed[0].path.includes('C:'));
  assert.equal(result.config.includes('sha256:eeee'), true);
  assert.equal(result.config.includes('sha256:dddd'), false);
});
