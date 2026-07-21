const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  isClaudeNativeBinaryMissingOutput,
  repairNativeBinaryIfNeeded,
  resolveClaudePackageRoot
} = require('../lib/cli/services/ai-cli/native-binary-repair');

test('detects Claude native binary missing error', () => {
  assert.equal(isClaudeNativeBinaryMissingOutput('Error: claude native binary not installed.'), true);
  assert.equal(isClaudeNativeBinaryMissingOutput('some other claude error'), false);
});

test('resolves Claude package root from pnpm shell wrapper', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const binDir = path.join(root, 'bin');
  const pkgRoot = path.join(root, 'bin', 'global', '5', '.pnpm', '@anthropic-ai+claude-code@2.1.140', 'node_modules', '@anthropic-ai', 'claude-code');
  const cliPath = path.join(binDir, 'claude');
  fs.mkdirSync(path.join(pkgRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), '{"name":"@anthropic-ai/claude-code"}\n');
  fs.writeFileSync(cliPath, [
    '#!/bin/sh',
    'basedir=$(dirname "$0")',
    '"$basedir/global/5/.pnpm/@anthropic-ai+claude-code@2.1.140/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$@"'
  ].join('\n'), 'utf8');

  assert.equal(resolveClaudePackageRoot(cliPath), pkgRoot);
});

test('repairs Claude native binary by running package postinstall then verifying CLI', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const binDir = path.join(root, 'bin');
  const pkgRoot = path.join(root, 'bin', 'global', '5', '.pnpm', '@anthropic-ai+claude-code@2.1.140', 'node_modules', '@anthropic-ai', 'claude-code');
  const cliPath = path.join(binDir, 'claude');
  const installScriptPath = path.join(pkgRoot, 'install.cjs');
  fs.mkdirSync(path.join(pkgRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), '{"name":"@anthropic-ai/claude-code"}\n');
  fs.writeFileSync(installScriptPath, 'console.log("install")\n', 'utf8');
  fs.writeFileSync(cliPath, [
    '#!/bin/sh',
    'basedir=$(dirname "$0")',
    '"$basedir/global/5/.pnpm/@anthropic-ai+claude-code@2.1.140/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$@"'
  ].join('\n'), 'utf8');

  const calls = [];
  const repairStarts = [];
  let probeCount = 0;
  const result = repairNativeBinaryIfNeeded('claude', cliPath, {
    fs,
    path,
    nodeExecPath: '/usr/local/bin/node',
    processObj: { platform: 'linux', env: {}, execPath: '/usr/local/bin/node' },
    onRepairStart: (context) => repairStarts.push(context),
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      if (command === cliPath) {
        probeCount += 1;
        return probeCount === 1
          ? { status: 1, stdout: '', stderr: 'Error: claude native binary not installed.' }
          : { status: 0, stdout: '2.1.140\n', stderr: '' };
      }
      if (command === '/usr/local/bin/node' && args[0] === installScriptPath) {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected command' };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.repaired, true);
  assert.equal(result.installScriptPath, installScriptPath);
  assert.deepEqual(repairStarts, [{ packageRoot: pkgRoot, installScriptPath }]);
  assert.deepEqual(calls.map((call) => [call.command, call.args[0]]), [
    [cliPath, '--version'],
    ['/usr/local/bin/node', installScriptPath],
    [cliPath, '--version']
  ]);
});

test('repairs missing Claude native binary with official installer on Windows', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-windows-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wrapperPath = path.join(root, 'nodejs', 'claude.cmd');
  const installedPath = path.join(root, '.local', 'bin', 'claude.exe');
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
  fs.writeFileSync(wrapperPath, '@echo off\r\n', 'utf8');

  const calls = [];
  const repairStarts = [];
  const result = repairNativeBinaryIfNeeded('claude', wrapperPath, {
    fs,
    path,
    hostHomeDir: root,
    processObj: {
      platform: 'win32',
      env: { USERPROFILE: root, SystemRoot: 'C:\\Windows' },
      execPath: 'C:\\nodejs\\node.exe'
    },
    onRepairStart: (context) => repairStarts.push(context),
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      if (command.endsWith('cmd.exe') && args.at(-1).includes(wrapperPath)) {
        return { status: 1, stdout: '', stderr: 'Error: claude native binary not installed.' };
      }
      if (command.endsWith('powershell.exe')) {
        fs.mkdirSync(path.dirname(installedPath), { recursive: true });
        fs.writeFileSync(installedPath, '', 'utf8');
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === installedPath) {
        return { status: 0, stdout: '2.1.140\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected command' };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.repaired, true);
  assert.equal(result.cliPath, installedPath);
  assert.equal(result.strategy, 'claude_windows_native');
  assert.equal(repairStarts[0].strategy, 'claude_windows_native');
  assert.equal(calls.some((call) => call.command.endsWith('powershell.exe')), true);
  assert.equal(calls.find((call) => call.command.endsWith('powershell.exe')).options.windowsHide, true);
  assert.equal(calls.at(-1).command, installedPath);
});

test('does not run Claude repair for other providers', () => {
  const result = repairNativeBinaryIfNeeded('codex', '/usr/bin/codex', {
    spawnSync() {
      throw new Error('spawnSync should not be called');
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.needed, false);
});
