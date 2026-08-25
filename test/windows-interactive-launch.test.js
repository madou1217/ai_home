'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('node:path');

const {
  buildInteractiveCommandScript,
  buildInteractiveBootstrapScript,
  launchWindowsInteractiveCommand
} = require('../lib/runtime/windows-interactive-launch');

function createFakeFs() {
  const files = new Map();
  return {
    files,
    writeFileSync(filePath, content) {
      files.set(String(filePath), String(content));
    },
    unlinkSync(filePath) {
      files.delete(String(filePath));
    }
  };
}

test('交互命令脚本只写入非敏感运行环境并在 Codex 退出后清理自身', () => {
  const script = buildInteractiveCommandScript('set "AIH_ACCOUNT_APP=1" && "C:\\node.exe" "C:\\repo\\bin\\ai-home.js" codex 3', {
    environment: {
      AIH_HOME: 'C:\\Users\\madou\\.ai_home',
      PATH: 'C:\\Program Files\\nodejs'
    }
  });
  assert.match(script, /set "AIH_HOME=C:\\Users\\madou\\\.ai_home"/);
  assert.match(script, /set "PATH=C:\\Program Files\\nodejs"/);
  assert.match(script, /AIH_ACCOUNT_APP=1/);
  assert.match(script, /del "%~f0"/);
  assert.doesNotMatch(script, /OPENAI_API_KEY|MANAGEMENT_KEY|CLIENT_KEY/);
});

test('交互引导脚本使用可见 cmd 窗口并清理自身', () => {
  const script = buildInteractiveBootstrapScript({
    title: 'aih codex 3',
    runPath: 'C:\\Users\\madou\\AppData\\Local\\Temp\\aih-run.cmd'
  });
  assert.match(script, /start "aih codex 3" cmd\.exe \/d \/s \/k call/);
  assert.match(script, /del "%~f0"/);
});

test('Windows 交互启动通过 schtasks /IT 交接到当前登录用户', () => {
  const fsImpl = createFakeFs();
  const calls = [];
  const result = launchWindowsInteractiveCommand('set "AIH_ACCOUNT_APP=1" && node app.js', {
    fs: fsImpl,
    path: nodePath.win32,
    tempDir: 'C:\\Users\\madou\\AppData\\Local\\Temp',
    env: {
      USERDOMAIN: 'MEADEO',
      USERNAME: 'madou',
      PATH: 'C:\\node'
    },
    processObj: { platform: 'win32', pid: 123 },
    aiHomeDir: 'C:\\Users\\madou\\.ai_home',
    title: 'aih codex 3',
    nonce: 'test',
    execFileSync(file, args) {
      calls.push({ file, args });
      return '';
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.taskName, 'AihWebCli_test');
  assert.equal(result.user, 'madou');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].args.slice(0, 8), [
    '/Create', '/TN', 'AihWebCli_test', '/SC', 'ONCE', '/ST', '00:00', '/RU'
  ]);
  assert.equal(calls[0].args[8], 'madou');
  assert.ok(calls[0].args.includes('/IT'));
  assert.ok(!calls[0].args.includes('/Z'));
  assert.deepEqual(calls[1].args, ['/Run', '/TN', 'AihWebCli_test']);
  assert.deepEqual(calls[2].args, ['/Delete', '/TN', 'AihWebCli_test', '/F']);
  assert.ok(fsImpl.files.get(result.runPath).includes('AIH_ACCOUNT_APP=1'));
  assert.ok(fsImpl.files.get(result.bootstrapPath).includes('start "aih codex 3" cmd.exe'));
});

test('交互启动失败时删除计划任务和临时脚本', () => {
  const fsImpl = createFakeFs();
  const calls = [];
  const result = launchWindowsInteractiveCommand('node app.js', {
    fs: fsImpl,
    path: nodePath.win32,
    tempDir: 'C:\\Temp',
    env: { USERNAME: 'madou' },
    processObj: { platform: 'win32', pid: 123 },
    nonce: 'failed',
    execFileSync(file, args) {
      calls.push({ file, args });
      if (args[0] === '/Run') throw new Error('run failed');
      return '';
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'interactive_launch_failed');
  assert.deepEqual(calls.at(-1).args, ['/Delete', '/TN', 'AihWebCli_failed', '/F']);
  assert.equal(fsImpl.files.size, 0);
});
