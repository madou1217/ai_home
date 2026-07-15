const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPtyLaunch,
  resolveWindowsBatchLaunch,
  resolveWindowsNodeShimLaunch
} = require('../lib/runtime/pty-launch');

test('buildPtyLaunch keeps direct launch on linux', () => {
  const launch = buildPtyLaunch('/usr/local/bin/codex', ['--help'], { platform: 'linux' });
  assert.equal(launch.command, '/usr/local/bin/codex');
  assert.deepEqual(launch.args, ['--help']);
});

test('buildPtyLaunch wraps POSIX shell shims for node-pty', () => {
  const fsImpl = {
    existsSync: (filePath) => filePath === '/Users/me/bin/codex' || filePath === '/bin/sh',
    readFileSync: () => '#!/bin/sh\nexec /real/codex "$@"\n'
  };
  const launch = buildPtyLaunch('/Users/me/bin/codex', ['--version'], {
    platform: 'darwin',
    fsImpl
  });
  assert.equal(launch.command, '/bin/sh');
  assert.deepEqual(launch.args, ['/Users/me/bin/codex', '--version']);
});

test('buildPtyLaunch keeps non-shell POSIX executables direct', () => {
  const fsImpl = {
    existsSync: () => true,
    readFileSync: () => '#!/usr/bin/env node\nconsole.log("ok")\n'
  };
  const launch = buildPtyLaunch('/Users/me/bin/tool', ['--version'], {
    platform: 'darwin',
    fsImpl
  });
  assert.equal(launch.command, '/Users/me/bin/tool');
  assert.deepEqual(launch.args, ['--version']);
});

test('buildPtyLaunch wraps .cmd with cmd.exe on windows', () => {
  const launch = buildPtyLaunch(
    'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd',
    ['--sandbox', 'danger-full-access'],
    { platform: 'win32' }
  );
  assert.equal(launch.command, 'cmd.exe');
  assert.equal(launch.args[0], '/d');
  assert.equal(launch.args[1], '/s');
  assert.equal(launch.args[2], '/c');
  assert.match(launch.args[3], /codex\.cmd/);
  assert.match(launch.args[3], /--sandbox/);
});

test('buildPtyLaunch wraps extensionless command with cmd.exe on windows', () => {
  const launch = buildPtyLaunch('codex', ['login'], { platform: 'win32' });
  assert.equal(launch.command, 'cmd.exe');
  assert.deepEqual(launch.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(launch.args[3], 'chcp 65001>nul & codex login');
});

test('buildPtyLaunch keeps native exe direct on windows', () => {
  const launch = buildPtyLaunch(
    'C:\\Program Files\\OpenAI\\codex.exe',
    ['--version'],
    { platform: 'win32' }
  );
  assert.equal(launch.command, 'C:\\Program Files\\OpenAI\\codex.exe');
  assert.deepEqual(launch.args, ['--version']);
});

test('resolveWindowsBatchLaunch injects cmd directory into PATH and uses basename', () => {
  const resolved = resolveWindowsBatchLaunch(
    'codex',
    'D:\\nvm4w\\nodejs\\codex.cmd',
    { Path: 'C:\\Windows\\System32' },
    'win32'
  );
  assert.equal(resolved.launchBin, 'codex');
  assert.match(resolved.envPatch.Path, /D:\\nvm4w\\nodejs/i);
  assert.equal(resolved.envPatch.Path, resolved.envPatch.PATH);
});

test('resolveWindowsNodeShimLaunch unwraps pnpm cmd shim to direct node launch', () => {
  const shimPath = 'C:\\Users\\me\\AppData\\Local\\pnpm\\codex.cmd';
  const fsImpl = {
    existsSync: (filePath) => filePath === shimPath,
    readFileSync: () => [
      '@SETLOCAL',
      '@IF NOT DEFINED NODE_PATH (',
      '  @SET "NODE_PATH=C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\@openai+codex@1\\node_modules"',
      ') ELSE (',
      '  @SET "NODE_PATH=C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\@openai+codex@1\\node_modules;%NODE_PATH%"',
      ')',
      '@IF EXIST "%~dp0\\node.exe" (',
      '  "%~dp0\\node.exe"  "%~dp0\\global\\5\\.pnpm\\@openai+codex@1\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
      ') ELSE (',
      '  node  "%~dp0\\global\\5\\.pnpm\\@openai+codex@1\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
      ')'
    ].join('\r\n')
  };

  const launch = resolveWindowsNodeShimLaunch(shimPath, ['--model', 'gpt-5'], {
    platform: 'win32',
    fsImpl,
    env: { NODE_PATH: 'C:\\existing' },
    nodeExecPath: 'C:\\Program Files\\nodejs\\node.exe'
  });

  assert.equal(launch.command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(launch.args, [
    'C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\@openai+codex@1\\node_modules\\@openai\\codex\\bin\\codex.js',
    '--model',
    'gpt-5'
  ]);
  assert.equal(
    launch.envPatch.NODE_PATH,
    'C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\@openai+codex@1\\node_modules;C:\\existing'
  );
});

test('resolveWindowsNodeShimLaunch prefers adjacent node.exe for npm cmd shim', () => {
  const shimPath = 'D:\\nvm\\v24.13.0\\codex.cmd';
  const localNode = 'D:\\nvm\\v24.13.0\\node.exe';
  const fsImpl = {
    existsSync: (filePath) => filePath === shimPath || filePath === localNode,
    readFileSync: () => [
      '@ECHO off',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*'
    ].join('\r\n')
  };

  const launch = resolveWindowsNodeShimLaunch(shimPath, [], {
    platform: 'win32',
    fsImpl,
    nodeExecPath: 'C:\\Program Files\\nodejs\\node.exe'
  });

  assert.equal(launch.command, localNode);
  assert.deepEqual(launch.args, ['D:\\nvm\\v24.13.0\\node_modules\\@openai\\codex\\bin\\codex.js']);
});

test('resolveWindowsNodeShimLaunch follows delegated ai-home codex hook cmd', () => {
  const hookPath = 'D:\\nvm4w\\nodejs\\codex.cmd';
  const upstreamPath = 'C:\\Users\\me\\AppData\\Local\\nvm\\v24.13.0\\codex.aih-original.cmd';
  const upstreamNode = 'C:\\Users\\me\\AppData\\Local\\nvm\\v24.13.0\\node.exe';
  const files = new Map([
    [hookPath.toLowerCase(), [
      '@echo off',
      'REM aih-codex-cli-hook',
      'setlocal',
      `set "UPSTREAM=${upstreamPath}"`,
      'set "NODE_BIN=D:\\nvm4w\\nodejs\\node.exe"',
      'set "HELPER=C:\\work\\ai_home\\lib\\server\\codex-app-server-stdio-proxy.js"',
      'if /I "%~1"=="resume" (',
      '  "%NODE_BIN%" "%HELPER%" --run-cli-resume --upstream "%UPSTREAM%" -- %*',
      '  exit /b %ERRORLEVEL%',
      ')',
      'call "%UPSTREAM%" %*',
      'exit /b %ERRORLEVEL%'
    ].join('\r\n')],
    [upstreamPath.toLowerCase(), [
      '@ECHO off',
      'SETLOCAL',
      'SET dp0=%~dp0',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*'
    ].join('\r\n')]
  ]);
  const fsImpl = {
    existsSync: (filePath) => filePath === upstreamNode || files.has(String(filePath || '').toLowerCase()),
    readFileSync: (filePath) => files.get(String(filePath || '').toLowerCase())
  };

  const launch = resolveWindowsNodeShimLaunch(hookPath, ['--model', 'gpt-5'], {
    platform: 'win32',
    fsImpl,
    nodeExecPath: 'D:\\nvm4w\\nodejs\\node.exe'
  });

  assert.equal(launch.command, upstreamNode);
  assert.deepEqual(launch.args, [
    'C:\\Users\\me\\AppData\\Local\\nvm\\v24.13.0\\node_modules\\@openai\\codex\\bin\\codex.js',
    '--model',
    'gpt-5'
  ]);
  assert.equal(launch.shimPath, upstreamPath);
});

test('resolveWindowsNodeShimLaunch does not bypass explicit ai-home hook branches', () => {
  const hookPath = 'D:\\nvm4w\\nodejs\\codex.cmd';
  const upstreamPath = 'C:\\Users\\me\\AppData\\Local\\nvm\\v24.13.0\\codex.aih-original.cmd';
  const fsImpl = {
    existsSync: (filePath) => filePath === hookPath || filePath === upstreamPath,
    readFileSync: () => [
      '@echo off',
      'REM aih-codex-cli-hook',
      `set "UPSTREAM=${upstreamPath}"`,
      'set "NODE_BIN=D:\\nvm4w\\nodejs\\node.exe"',
      'set "HELPER=C:\\work\\ai_home\\lib\\server\\codex-app-server-stdio-proxy.js"',
      'if /I "%~1"=="resume" (',
      '  "%NODE_BIN%" "%HELPER%" --run-cli-resume --upstream "%UPSTREAM%" -- %*',
      '  exit /b %ERRORLEVEL%',
      ')',
      'call "%UPSTREAM%" %*'
    ].join('\r\n')
  };

  assert.equal(
    resolveWindowsNodeShimLaunch(hookPath, ['resume', 'thread-id'], { platform: 'win32', fsImpl }),
    null
  );
});

test('resolveWindowsNodeShimLaunch ignores non-node cmd files', () => {
  const shimPath = 'C:\\tools\\tool.cmd';
  const fsImpl = {
    existsSync: (filePath) => filePath === shimPath,
    readFileSync: () => '@echo off\r\necho hello %*\r\n'
  };

  assert.equal(resolveWindowsNodeShimLaunch(shimPath, [], { platform: 'win32', fsImpl }), null);
});
