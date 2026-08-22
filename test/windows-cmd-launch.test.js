'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildWindowsCmdLaunch,
  windowsSpawnOptions
} = require('../lib/runtime/windows-cmd-launch');

test('inline 规格以 /d /s /c 包裹命令并声明 verbatim 传递', () => {
  const launch = buildWindowsCmdLaunch('netstat -ano | findstr :9527');
  assert.equal(launch.file, 'cmd.exe');
  assert.deepEqual(launch.args, ['/d', '/s', '/c', '"netstat -ano | findstr :9527"']);
  assert.equal(launch.windowsVerbatimArguments, true);
});

test('newConsole 规格把整条命令链包进新窗口的内层 cmd /k', () => {
  const command = 'set "AIH_ACCOUNT_APP=1" && set "AIH_PROVIDER_ACCOUNT_REF=ref-1" && '
    + '"C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\bin\\ai-home.js" codex 12';
  const launch = buildWindowsCmdLaunch(command, { newConsole: true, title: 'aih codex 12' });
  assert.deepEqual(launch.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(
    launch.args[3],
    `start "aih codex 12" cmd.exe /d /s /k "${command}"`
  );
  assert.equal(launch.windowsVerbatimArguments, true);
});

test('命令行不出现反斜杠转义引号（cmd.exe 不认识 \" 会挂起 start）', () => {
  const launch = buildWindowsCmdLaunch(
    'set "A=1" && "C:\\Program Files\\x\\cli.cmd" run',
    { newConsole: true, title: 'aih x 1' }
  );
  assert.ok(!launch.args[3].includes('\\"'));
});

test('newConsole 标题中的双引号被转义避免截断 start 命令', () => {
  const launch = buildWindowsCmdLaunch('echo hi', { newConsole: true, title: 'aih "quoted" 1' });
  assert.ok(launch.args[3].startsWith('start "aih \'quoted\' 1" cmd.exe'));
});

test('windowsSpawnOptions 从规格提取 verbatim 选项且缺省关闭', () => {
  assert.deepEqual(windowsSpawnOptions({ windowsVerbatimArguments: true }), { windowsVerbatimArguments: true });
  assert.deepEqual(windowsSpawnOptions({}), { windowsVerbatimArguments: false });
  assert.deepEqual(windowsSpawnOptions(null), { windowsVerbatimArguments: false });
});
