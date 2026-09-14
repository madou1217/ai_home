'use strict';

// Node 18.20 / 20.12 起 spawn 一个 .cmd 且不带 shell 直接抛 EINVAL（CVE-2024-27980 的缓解）。
// 这条在**读路径**上尤其阴险：查询失败被上层当成「没有新版」静静吞掉，于是整套自动升级
// 在 Windows 上变成一块永远绿着的仪表盘 —— 从不出错，也从不升级任何东西。
//
// 2026-09-14 真机（Windows / nvm4w / node v22.23.1）实测：
//   spawnSync('npm.cmd', ['root','-g'])                 → EINVAL，stdout 空
//   spawnSync('npm.cmd', ['root','-g'], {shell: true})  → "d:\nvm4w\nodejs\node_modules"
//
// 这个不变量是跨模块的（三个不同的文件各自 spawn npm），所以断言集中在一处：
// 再出现第四个 spawn npm 的地方，应当加进这张表，而不是另开一个文件。

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { requiresCmdShell } = require('../lib/runtime/windows-cmd-launch');
const { probeNpmGlobalRoot } = require('../lib/server/provider-cli-upgrade/upgrade-install-roots');
const { fetchNpmPublishTime } = require('../lib/server/provider-cli-upgrade/upgrade-publish-time');
const { queryNpmLatestVersion } = require('../lib/cli/services/toolkit/app-update-checker');

const WINDOWS = { platform: 'win32', env: {}, execPath: 'C:\\node\\node.exe' };
const POSIX = { platform: 'darwin', env: {}, execPath: '/usr/local/bin/node' };

// 假 npm：记下 spawn 收到的选项，立刻用给定 stdout 正常退出。全程不起真进程、不联网。
function recordingSpawn(stdout) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', stdout);
      child.emit('close', 0);
    });
    return child;
  };
  return { spawn, calls };
}

function recordingSpawnSync(stdout) {
  const calls = [];
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout, stderr: '', status: 0 };
  };
  return { spawnSync, calls };
}

test('requiresCmdShell 只在 win32 且命令是 .cmd/.bat 时成立', () => {
  assert.equal(requiresCmdShell('npm.cmd', 'win32'), true);
  assert.equal(requiresCmdShell('NPM.CMD', 'win32'), true);
  assert.equal(requiresCmdShell('installer.bat', 'win32'), true);
  // winget.exe 与 brew 都不该被多包一层 cmd.exe：shell 每开一次就多一份注入面。
  assert.equal(requiresCmdShell('winget.exe', 'win32'), false);
  assert.equal(requiresCmdShell('npm', 'win32'), false);
  assert.equal(requiresCmdShell('npm.cmd', 'darwin'), false);
  assert.equal(requiresCmdShell('', 'win32'), false);
  assert.equal(requiresCmdShell('npm.cmd', ''), false);
});

test('npm root -g：Windows 开 shell、POSIX 不开', () => {
  const win = recordingSpawnSync('d:\\nvm4w\\nodejs\\node_modules\r\n');
  const root = probeNpmGlobalRoot({ spawnSync: win.spawnSync, processObj: WINDOWS });
  assert.equal(win.calls[0].command, 'npm.cmd');
  assert.equal(win.calls[0].options.shell, true);
  // shell 开对了，探测就拿到真实 prefix，而不是回落到按 execPath 推导的那个猜测值。
  assert.equal(root, 'd:\\nvm4w\\nodejs\\node_modules');

  const posix = recordingSpawnSync('/opt/homebrew/lib/node_modules\n');
  probeNpmGlobalRoot({ spawnSync: posix.spawnSync, processObj: POSIX });
  assert.equal(posix.calls[0].command, 'npm');
  assert.ok(!posix.calls[0].options.shell);
});

test('npm view <pkg> time：Windows 开 shell、POSIX 不开', async () => {
  const table = JSON.stringify({ '0.154.0': '2026-09-13T09:15:00.000Z' });

  const win = recordingSpawn(table);
  const result = await fetchNpmPublishTime('@openai/codex', '0.154.0', {
    spawn: win.spawn,
    processObj: WINDOWS
  });
  assert.equal(win.calls[0].command, 'npm.cmd');
  assert.equal(win.calls[0].options.shell, true);
  // soak 闸门唯一的输入；拿不到 publishedAt 时 policy 的两个分支都是 SKIP。
  assert.equal(result.ok, true);

  const posix = recordingSpawn(table);
  await fetchNpmPublishTime('@openai/codex', '0.154.0', { spawn: posix.spawn, processObj: POSIX });
  assert.equal(posix.calls[0].command, 'npm');
  assert.ok(!posix.calls[0].options.shell);
});

test('npm view <pkg> version：Windows 开 shell、POSIX 不开', async () => {
  const win = recordingSpawn('0.154.0\n');
  const result = await queryNpmLatestVersion('@openai/codex', {
    spawn: win.spawn,
    processObj: WINDOWS
  });
  assert.equal(win.calls[0].command, 'npm.cmd');
  assert.equal(win.calls[0].options.shell, true);
  assert.deepEqual(result, { ok: true, packageName: '@openai/codex', latestVersion: '0.154.0' });

  const posix = recordingSpawn('0.154.0\n');
  await queryNpmLatestVersion('@openai/codex', { spawn: posix.spawn, processObj: POSIX });
  assert.equal(posix.calls[0].command, 'npm');
  assert.ok(!posix.calls[0].options.shell);
});
