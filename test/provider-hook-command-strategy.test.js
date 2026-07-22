'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildProviderHookCommand,
  commandReferencesProvider,
  resolveProviderHookCommandStrategy
} = require('../lib/server/provider-hook-command-strategy');

const BASE_OPTIONS = Object.freeze({
  senderScriptPath: 'C:\\repo path\\scripts\\hook.js',
  managedMarker: '--aih-provider-session-hook',
  provider: 'codex',
  eventName: 'UserPromptSubmit',
  receiverUrl: 'http://127.0.0.1:9527/hook?provider=codex&event=UserPromptSubmit'
});

test('Windows strategy invokes node.exe directly with cross-shell paths', () => {
  const command = buildProviderHookCommand({
    ...BASE_OPTIONS,
    platform: 'win32',
    nodeCommand: 'C:\\Program Files\\nodejs\\node.exe'
  });

  assert.match(command, /^"C:\/Program Files\/nodejs\/node\.exe" /);
  assert.match(command, /"C:\/repo path\/scripts\/hook\.js"/);
  assert.match(command, /--provider "codex"/);
  assert.equal(command.includes('powershell'), false);
  assert.equal(commandReferencesProvider(command, 'codex'), true);
});

test('Windows strategy defaults to the current Node executable', () => {
  const command = buildProviderHookCommand({ ...BASE_OPTIONS, platform: 'win32' });

  const normalizedNodePath = process.execPath.replace(/\\/g, '/');
  assert.equal(command.startsWith(`"${normalizedNodePath}" `), true);
});

test('Windows strategy command executes through cmd.exe with spaced paths', {
  skip: process.platform !== 'win32'
}, (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih hook strategy '));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const scriptPath = path.join(tempDir, 'capture args.js');
  const outputPath = path.join(tempDir, 'args.json');
  fs.writeFileSync(
    scriptPath,
    `require('node:fs').writeFileSync(process.env.AIH_HOOK_TEST_OUTPUT, JSON.stringify(process.argv.slice(2)));`,
    'utf8'
  );
  const command = buildProviderHookCommand({
    ...BASE_OPTIONS,
    platform: 'win32',
    nodeCommand: process.execPath,
    senderScriptPath: scriptPath
  });

  childProcess.execSync(command, {
    shell: 'cmd.exe',
    env: { ...process.env, AIH_HOOK_TEST_OUTPUT: outputPath },
    stdio: 'pipe'
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), [
    '--aih-provider-session-hook',
    '--provider',
    'codex',
    '--event',
    'UserPromptSubmit',
    '--url',
    BASE_OPTIONS.receiverUrl
  ]);
});

test('Windows strategy command executes through Git Bash when available', {
  skip: process.platform !== 'win32'
}, (t) => {
  const bashPath = [
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe'
  ].find((candidate) => fs.existsSync(candidate));
  if (!bashPath) {
    t.skip('Git Bash is not installed');
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih hook bash '));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const scriptPath = path.join(tempDir, 'capture args.js');
  const outputPath = path.join(tempDir, 'args.json');
  fs.writeFileSync(
    scriptPath,
    `require('node:fs').writeFileSync(process.env.AIH_HOOK_TEST_OUTPUT, JSON.stringify(process.argv.slice(2)));`,
    'utf8'
  );
  const command = buildProviderHookCommand({
    ...BASE_OPTIONS,
    platform: 'win32',
    nodeCommand: process.execPath,
    senderScriptPath: scriptPath
  });

  childProcess.execFileSync(bashPath, ['-lc', command], {
    env: { ...process.env, AIH_HOOK_TEST_OUTPUT: outputPath },
    stdio: 'pipe'
  });

  assert.equal(fs.existsSync(outputPath), true);
});

for (const platform of ['linux', 'darwin']) {
  test(`${platform} strategy preserves POSIX shell commands`, () => {
    const command = buildProviderHookCommand({
      ...BASE_OPTIONS,
      platform,
      senderScriptPath: '/tmp/repo path/scripts/hook.js'
    });

    assert.match(command, /^\/usr\/bin\/env node /);
    assert.match(command, /'\/tmp\/repo path\/scripts\/hook\.js'/);
    assert.match(command, /--provider 'codex'/);
    assert.equal(commandReferencesProvider(command, 'codex'), true);
  });
}

test('strategy resolver uses Windows only for win32', () => {
  assert.notEqual(
    resolveProviderHookCommandStrategy('win32'),
    resolveProviderHookCommandStrategy('linux')
  );
  assert.equal(
    resolveProviderHookCommandStrategy('linux'),
    resolveProviderHookCommandStrategy('darwin')
  );
});
