'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('node:path');
const {
  buildWindowsDownloadStatements,
  buildWindowsExecutableLaunchStatements,
  powershellQuote
} = require('../lib/runtime/windows-install-script');
const { buildPowerShellScriptPlan } = require('../lib/cli/services/toolkit/environment/plan-builders');
const { resolveTerminalActionPlan } = require('../lib/runtime/client-terminal');

test('Windows 下载语句优先 curl.exe，并保留无 curl 时的回落', () => {
  const script = buildWindowsDownloadStatements({
    url: 'https://example.com/setup.exe',
    dest: '$dest'
  });
  assert.match(script, /Get-Command curl\.exe/);
  assert.match(script, /--speed-time 60/);
  assert.match(script, /-fL --retry 3/);
  assert.match(script, /Invoke-WebRequest -Uri 'https:\/\/example\.com\/setup\.exe' -OutFile \$dest/);
  // `}; else {` 在 PowerShell 里是语法错误（真机踩过）。
  assert.doesNotMatch(script, /\}\s*;\s*else/);
});

test('Windows 下载语句可以引用运行时 URL 变量，并安全引用标签', () => {
  const script = buildWindowsDownloadStatements({
    urlExpression: '$url',
    dest: '$archive',
    label: "Bob's installer"
  });
  assert.match(script, /-o \$archive \$url/);
  assert.match(script, /'Bob''s installer' \+ '下载失败/);
});

test('Windows 安装器启动只等安装器进程，并接受 3010', () => {
  const script = buildWindowsExecutableLaunchStatements({
    file: '$dest',
    silentArgs: ['/VERYSILENT', '/NORESTART']
  });
  assert.match(script, /Start-Process -FilePath \$dest -ArgumentList @\('\/VERYSILENT', '\/NORESTART'\) -PassThru/);
  assert.doesNotMatch(script, /-Wait\b/);
  assert.match(script, /WaitForExit\(1200000\)/);
  assert.match(script, /\$exitCode -ne 0 -and \$exitCode -ne 3010/);
  assert.match(script, /管理员权限/);
  assert.match(script, /UAC 授权被取消/);
});

test('Windows 安装器启动支持自定义超时与成功退出码', () => {
  const script = buildWindowsExecutableLaunchStatements({
    file: '$installer',
    timeoutMs: 600000,
    successExitCodes: [0]
  });
  assert.match(script, /WaitForExit\(600000\)/);
  assert.match(script, /if \(\$exitCode -ne 0\) \{ throw/);
  assert.doesNotMatch(script, /3010/);
});

test('Windows 路径引用只转义单引号', () => {
  assert.equal(powershellQuote("C:\\Users\\O'Brien\\app.exe"), "'C:\\Users\\O''Brien\\app.exe'");
});

test('工具链 PowerShell 安装脚本复用 curl 下载助手', () => {
  const plan = buildPowerShellScriptPlan('demo', 'install', {
    url: 'https://example.com/install.ps1',
    hosts: ['example.com'],
    label: '安装 demo',
    method: 'official script',
    options: { platform: 'windows' }
  });
  const script = plan.args.at(-1);
  assert.match(script, /Get-Command curl\.exe/);
  assert.match(script, /--speed-time 60/);
  assert.doesNotMatch(script, /\}\s*;\s*else/);
});

test('终端官方 Windows 安装脚本复用下载与等待助手', () => {
  const options = {
    platform: 'windows',
    path: nodePath.win32,
    env: { USERPROFILE: 'C:\\Users\\test', PATH: 'C:\\tools' },
    fs: { existsSync: () => false },
    hostHomeDir: 'C:\\Users\\test'
  };
  for (const terminalId of ['windows-terminal', 'wezterm', 'warp']) {
    const plan = resolveTerminalActionPlan({ terminalId, action: 'install' }, options);
    const script = plan.args.at(-1);
    assert.match(script, /Get-Command curl\.exe/, terminalId);
    assert.match(script, /--speed-time 60/, terminalId);
    assert.doesNotMatch(script, /\}\s*;\s*else/, terminalId);
  }
  const warp = resolveTerminalActionPlan({ terminalId: 'warp', action: 'install' }, options);
  assert.match(warp.args.at(-1), /WaitForExit\(1200000\)/);
  assert.doesNotMatch(warp.args.at(-1), /-Wait\b/);
});
