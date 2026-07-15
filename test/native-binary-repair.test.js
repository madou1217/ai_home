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
    processObj: { env: {}, execPath: '/usr/local/bin/node' },
    onRepairStart: (context) => repairStarts.push(context),
    spawnSync(command, args) {
      calls.push({ command, args });
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

test('does not run Claude repair for other providers', () => {
  const result = repairNativeBinaryIfNeeded('codex', '/usr/bin/codex', {
    spawnSync() {
      throw new Error('spawnSync should not be called');
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.needed, false);
});
