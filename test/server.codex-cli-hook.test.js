const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  WRAPPER_MARKER,
  buildWrapperScript,
  buildWindowsPowerShellWrapperScript,
  buildWindowsCmdWrapperScript,
  createCodexCliHookService
} = require('../lib/server/codex-cli-hook');
const {
  findCodexSubcommand
} = require('../lib/server/codex-app-server-hook-wrapper');

function getStateFilePath(aiHomeDir) {
  return path.join(aiHomeDir, 'run', 'codex', 'cli-hook-state.json');
}

test('buildWrapperScript renders stable codex cli wrapper', () => {
  const script = buildWrapperScript({
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/helper.js',
    upstreamBinaryPath: '/tmp/codex.aih-original',
    stateFilePath: '/tmp/codex-hook-state.json'
  });
  assert.equal(script.includes(WRAPPER_MARKER), true);
  assert.equal(script.includes('/tmp/helper.js'), true);
  assert.equal(script.includes('app-server'), true);
  assert.equal(script.includes('AIH_CODEX_APP_SERVER_PASSTHROUGH'), true);
  assert.equal(script.includes('--run-cli-resume'), true);
  assert.equal(script.includes('--run-cli-default'), true);
  assert.equal(script.includes('--repair-resume-visibility'), false);
});

test('buildWindowsPowerShellWrapperScript renders stable codex cli wrapper', () => {
  const script = buildWindowsPowerShellWrapperScript({
    nodeExecPath: 'C:\\Program Files\\nodejs\\node.exe',
    helperScriptPath: 'C:\\Users\\me\\ai_home\\lib\\server\\codex-app-server-stdio-proxy.js',
    upstreamBinaryPath: 'C:\\Users\\me\\AppData\\Local\\pnpm\\codex.aih-original.ps1',
    stateFilePath: 'C:\\Users\\me\\.ai_home\\codex-cli-hook-state.json'
  });
  assert.equal(script.includes(WRAPPER_MARKER), true);
  assert.equal(script.includes('--run-cli-resume'), true);
  assert.equal(script.includes('--run-cli-default'), true);
  assert.equal(script.includes('$subcommand -eq "app-server"'), true);
  assert.equal(script.includes('$valueOptions -contains $arg'), true);
  assert.equal(script.includes('$env:AIH_CODEX_APP_SERVER_PASSTHROUGH'), true);
});

test('buildWindowsCmdWrapperScript renders stable codex cli wrapper', () => {
  const script = buildWindowsCmdWrapperScript({
    nodeExecPath: 'C:\\Program Files\\nodejs\\node.exe',
    helperScriptPath: 'C:\\Users\\me\\ai_home\\lib\\server\\codex-app-server-stdio-proxy.js',
    upstreamBinaryPath: 'C:\\Users\\me\\AppData\\Local\\pnpm\\codex.aih-original.CMD',
    stateFilePath: 'C:\\Users\\me\\.ai_home\\codex-cli-hook-state.json'
  });
  assert.equal(script.includes(WRAPPER_MARKER), true);
  assert.equal(script.includes('if /I "%AIH_SUBCOMMAND%"=="resume"'), true);
  assert.equal(script.includes('if /I "%AIH_SUBCOMMAND%"=="app-server"'), true);
  assert.equal(script.includes('--run-cli-default'), true);
  assert.equal(script.includes(':AIH_FIND_SUBCOMMAND'), true);
  assert.equal(script.includes('%AIH_CODEX_APP_SERVER_PASSTHROUGH%'), true);
});

test('all wrapper variants share option-aware Codex subcommand semantics', () => {
  assert.equal(findCodexSubcommand(['app-server']), 'app-server');
  assert.equal(findCodexSubcommand(['-c', 'features.foo=true', 'app-server']), 'app-server');
  assert.equal(findCodexSubcommand(['--profile', 'work', 'resume']), 'resume');
  assert.equal(findCodexSubcommand(['--config=value', '--verbose', 'exec']), 'exec');
  assert.equal(findCodexSubcommand(['--', 'app-server']), '');
  assert.equal(findCodexSubcommand(['--profile']), '');
});

test('POSIX wrapper requires the explicit marker after global Codex options', {
  skip: process.platform === 'win32'
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-wrapper-'));
  const wrapperPath = path.join(root, 'codex');
  const helperPath = path.join(root, 'helper.sh');
  const upstreamPath = path.join(root, 'codex-upstream');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(helperPath, '#!/bin/sh\nprintf "proxy:%s\\n" "$*"\n', { mode: 0o755 });
  fs.writeFileSync(upstreamPath, [
    '#!/bin/sh',
    'printf "upstream:%s:%s\\n" "${AIH_CODEX_APP_SERVER_PASSTHROUGH:-unset}" "$*"',
    ''
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(wrapperPath, buildWrapperScript({
    nodeExecPath: '/bin/sh',
    helperScriptPath: helperPath,
    upstreamBinaryPath: upstreamPath,
    stateFilePath: path.join(root, 'state.json')
  }), { mode: 0o755 });

  const args = ['-c', 'features.foo=true', 'app-server', '--listen', 'stdio://'];
  const proxied = spawnSync(wrapperPath, args, { encoding: 'utf8', env: { PATH: process.env.PATH } });
  const passedThrough = spawnSync(wrapperPath, args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, AIH_CODEX_APP_SERVER_PASSTHROUGH: '1' }
  });

  assert.equal(proxied.status, 0);
  assert.match(proxied.stdout, /^proxy:/);
  assert.equal(passedThrough.status, 0);
  assert.match(passedThrough.stdout, /^upstream:unset:/);

  const rawCli = spawnSync(wrapperPath, ['exec', 'hello'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH }
  });
  assert.equal(rawCli.status, 0);
  assert.match(rawCli.stdout, /^proxy:--run-cli-default /);
});

test('codex cli hook activates by installing wrapper and enabling state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const binDir = path.join(root, 'bin');
  const targetBinaryPath = path.join(binDir, 'codex');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho original\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);

  const service = createCodexCliHookService({
    fs,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    resolveCliPath: () => targetBinaryPath
  });

  const result = service.activate();
  const wrapper = fs.readFileSync(targetBinaryPath, 'utf8');
  const upstreamBinaryPath = `${targetBinaryPath}.aih-original`;
  const state = JSON.parse(fs.readFileSync(getStateFilePath(aiHomeDir), 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(fs.existsSync(upstreamBinaryPath), true);
  assert.equal(fs.readFileSync(upstreamBinaryPath, 'utf8'), '#!/bin/sh\necho original\n');
  assert.equal(wrapper.includes(WRAPPER_MARKER), true);
  assert.equal(wrapper.includes('/tmp/codex-proxy.js'), true);
  assert.equal(state.enabled, true);
});

test('codex cli hook activates only the resolved default binary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const firstBinDir = path.join(root, 'bin-a');
  const secondBinDir = path.join(root, 'bin-b');
  const firstCodexPath = path.join(firstBinDir, 'codex');
  const secondCodexPath = path.join(secondBinDir, 'codex');
  fs.mkdirSync(firstBinDir, { recursive: true });
  fs.mkdirSync(secondBinDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(firstCodexPath, '#!/bin/sh\necho first\n', 'utf8');
  fs.writeFileSync(secondCodexPath, '#!/bin/sh\necho second\n', 'utf8');
  fs.chmodSync(firstCodexPath, 0o755);
  fs.chmodSync(secondCodexPath, 0o755);

  const service = createCodexCliHookService({
    fs,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    resolveCliPath: () => firstCodexPath
  });

  const result = service.activate();
  const state = JSON.parse(fs.readFileSync(getStateFilePath(aiHomeDir), 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(fs.readFileSync(firstCodexPath, 'utf8').includes(WRAPPER_MARKER), true);
  assert.equal(fs.readFileSync(secondCodexPath, 'utf8'), '#!/bin/sh\necho second\n');
  assert.equal(fs.readFileSync(`${firstCodexPath}.aih-original`, 'utf8'), '#!/bin/sh\necho first\n');
  assert.equal(fs.existsSync(`${secondCodexPath}.aih-original`), false);
  assert.equal(state.enabled, true);
  assert.equal(state.targetBinaryPath, firstCodexPath);
  assert.equal(Object.hasOwn(state, 'targets'), false);
});

test('codex cli hook uses only the resolved default Windows shim', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-hook-win-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const binDir = path.join(root, 'bin');
  const ps1Path = path.join(binDir, 'codex.ps1');
  const cmdPath = path.join(binDir, 'codex.CMD');
  const ps1UpstreamPath = path.join(binDir, 'codex.aih-original.ps1');
  const cmdUpstreamPath = path.join(binDir, 'codex.aih-original.CMD');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(ps1Path, '#!/usr/bin/env pwsh\nWrite-Host original\n', 'utf8');
  fs.writeFileSync(cmdPath, '@echo off\r\necho original\r\n', 'utf8');

  const service = createCodexCliHookService({
    fs,
    path,
    processObj: { platform: 'win32' },
    aiHomeDir,
    nodeExecPath: 'C:\\Program Files\\nodejs\\node.exe',
    helperScriptPath: 'C:\\repo\\lib\\server\\codex-app-server-stdio-proxy.js',
    resolveCliPath: () => ps1Path
  });

  const result = service.activate();
  const state = JSON.parse(fs.readFileSync(getStateFilePath(aiHomeDir), 'utf8'));
  const ps1Wrapper = fs.readFileSync(ps1Path, 'utf8');

  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(fs.readFileSync(ps1UpstreamPath, 'utf8'), '#!/usr/bin/env pwsh\nWrite-Host original\n');
  assert.equal(fs.existsSync(cmdUpstreamPath), false);
  assert.equal(ps1Wrapper.includes(WRAPPER_MARKER), true);
  assert.equal(ps1Wrapper.includes('$subcommand -eq "resume"'), true);
  assert.equal(ps1Wrapper.includes(ps1UpstreamPath), true);
  assert.equal(fs.readFileSync(cmdPath, 'utf8'), '@echo off\r\necho original\r\n');
  assert.equal(state.enabled, true);
  assert.equal(state.targetBinaryPath, ps1Path);
});

test('codex cli hook never recovers the default binary from another installation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const firstBinDir = path.join(root, 'bin-a');
  const secondBinDir = path.join(root, 'bin-b');
  const firstCodexPath = path.join(firstBinDir, 'codex');
  const secondCodexPath = path.join(secondBinDir, 'codex');
  const firstUpstreamPath = `${firstCodexPath}.aih-original`;
  const secondUpstreamPath = `${secondCodexPath}.aih-original`;
  const stateFilePath = getStateFilePath(aiHomeDir);
  const cleanOriginal = '#!/bin/sh\necho clean-original\n';
  fs.mkdirSync(firstBinDir, { recursive: true });
  fs.mkdirSync(secondBinDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(firstCodexPath, buildWrapperScript({
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    upstreamBinaryPath: firstUpstreamPath,
    stateFilePath
  }), 'utf8');
  fs.writeFileSync(firstUpstreamPath, buildWrapperScript({
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    upstreamBinaryPath: firstUpstreamPath,
    stateFilePath
  }), 'utf8');
  fs.writeFileSync(secondCodexPath, buildWrapperScript({
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    upstreamBinaryPath: secondUpstreamPath,
    stateFilePath
  }), 'utf8');
  fs.writeFileSync(secondUpstreamPath, cleanOriginal, 'utf8');
  fs.chmodSync(firstCodexPath, 0o755);
  fs.chmodSync(firstUpstreamPath, 0o755);
  fs.chmodSync(secondCodexPath, 0o755);
  fs.chmodSync(secondUpstreamPath, 0o755);

  const service = createCodexCliHookService({
    fs,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    resolveCliPath: () => firstCodexPath
  });

  const result = service.ensureInstalled();
  const state = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'upstream_backup_invalid');
  assert.equal(fs.readFileSync(firstUpstreamPath, 'utf8').includes(WRAPPER_MARKER), true);
  assert.equal(fs.readFileSync(secondUpstreamPath, 'utf8'), cleanOriginal);
  assert.equal(state.enabled, false);
  assert.equal(state.reason, 'upstream_backup_invalid');
});

test('codex cli hook keeps the resolved pnpm shim independent of later PATH entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const firstBinDir = path.join(root, 'pnpm-root');
  const secondBinDir = path.join(root, 'pnpm-root', 'bin');
  const validTargetPath = path.join(root, 'pnpm-root', 'global', 'v11', 'pkg', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const firstCodexPath = path.join(firstBinDir, 'codex');
  const secondCodexPath = path.join(secondBinDir, 'codex');
  const firstUpstreamPath = `${firstCodexPath}.aih-original`;
  const secondUpstreamPath = `${secondCodexPath}.aih-original`;
  const stateFilePath = getStateFilePath(aiHomeDir);
  const pnpmShimFromBinDir = [
    '#!/bin/sh',
    'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
    'exec node "$basedir/../global/v11/pkg/node_modules/@openai/codex/bin/codex.js" "$@"',
    `# cmd-shim-target=${validTargetPath}`,
    ''
  ].join('\n');
  fs.mkdirSync(firstBinDir, { recursive: true });
  fs.mkdirSync(secondBinDir, { recursive: true });
  fs.mkdirSync(path.dirname(validTargetPath), { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(validTargetPath, '#!/usr/bin/env node\nconsole.log("codex-cli 9.999.0")\n', 'utf8');
  fs.writeFileSync(firstCodexPath, buildWrapperScript({
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    upstreamBinaryPath: firstUpstreamPath,
    stateFilePath
  }), 'utf8');
  fs.writeFileSync(firstUpstreamPath, pnpmShimFromBinDir, 'utf8');
  fs.writeFileSync(secondCodexPath, buildWrapperScript({
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    upstreamBinaryPath: secondUpstreamPath,
    stateFilePath
  }), 'utf8');
  fs.writeFileSync(secondUpstreamPath, pnpmShimFromBinDir, 'utf8');
  for (const p of [firstCodexPath, firstUpstreamPath, secondCodexPath, secondUpstreamPath, validTargetPath]) {
    fs.chmodSync(p, 0o755);
  }

  const service = createCodexCliHookService({
    fs,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    resolveCliPath: () => secondCodexPath
  });

  const result = service.ensureInstalled();
  const selectedUpstream = fs.readFileSync(secondUpstreamPath, 'utf8');

  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(selectedUpstream, pnpmShimFromBinDir);
  assert.equal(fs.readFileSync(firstUpstreamPath, 'utf8'), pnpmShimFromBinDir);
});

test('codex cli hook rejects polluted upstream backup when no clean recovery exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const binDir = path.join(root, 'bin');
  const targetBinaryPath = path.join(binDir, 'codex');
  const upstreamBinaryPath = `${targetBinaryPath}.aih-original`;
  const stateFilePath = getStateFilePath(aiHomeDir);
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pollutedWrapper = buildWrapperScript({
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    upstreamBinaryPath,
    stateFilePath
  });
  fs.writeFileSync(targetBinaryPath, pollutedWrapper, 'utf8');
  fs.writeFileSync(upstreamBinaryPath, pollutedWrapper, 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);
  fs.chmodSync(upstreamBinaryPath, 0o755);

  const service = createCodexCliHookService({
    fs,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    resolveCliPath: () => targetBinaryPath
  });

  const result = service.ensureInstalled();
  const state = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));

  assert.equal(result.ok, false);
  assert.equal(result.enabled, false);
  assert.equal(result.reason, 'upstream_backup_invalid');
  assert.equal(state.enabled, false);
  assert.equal(state.reason, 'upstream_backup_invalid');
});

test('codex cli hook rejects an upstream delegate whose pnpm target disappeared', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const binDir = path.join(root, 'bin');
  const targetBinaryPath = path.join(binDir, 'codex');
  const upstreamBinaryPath = `${targetBinaryPath}.aih-original`;
  const delegatedShimPath = path.join(binDir, 'codex-stale-shim');
  const stateFilePath = getStateFilePath(aiHomeDir);
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetBinaryPath, buildWrapperScript({
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    upstreamBinaryPath,
    stateFilePath
  }), 'utf8');
  fs.writeFileSync(upstreamBinaryPath, [
    '#!/bin/sh',
    '# aih-codex-upstream-delegate',
    `exec '${delegatedShimPath}' "$@"`,
    ''
  ].join('\n'), 'utf8');
  fs.writeFileSync(delegatedShimPath, [
    '#!/bin/sh',
    'basedir=$(dirname "$0")',
    'exec node "$basedir/missing/node_modules/@openai/codex/bin/codex.js" "$@"',
    ''
  ].join('\n'), 'utf8');
  for (const filePath of [targetBinaryPath, upstreamBinaryPath, delegatedShimPath]) {
    fs.chmodSync(filePath, 0o755);
  }

  const service = createCodexCliHookService({
    fs,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    resolveCliPath: () => targetBinaryPath
  });

  const result = service.ensureInstalled();

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'upstream_backup_invalid');
});

test('codex cli hook refreshes upstream snapshot when global shim was overwritten by upgrade', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const binDir = path.join(root, 'bin');
  const targetBinaryPath = path.join(binDir, 'codex');
  const upstreamBinaryPath = `${targetBinaryPath}.aih-original`;
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho upgraded\n', 'utf8');
  fs.writeFileSync(upstreamBinaryPath, '#!/bin/sh\necho stale\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);
  fs.chmodSync(upstreamBinaryPath, 0o755);

  const service = createCodexCliHookService({
    fs,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    resolveCliPath: () => targetBinaryPath
  });

  const result = service.activate();

  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(upstreamBinaryPath, 'utf8'), '#!/bin/sh\necho upgraded\n');
  assert.equal(fs.readFileSync(targetBinaryPath, 'utf8').includes(WRAPPER_MARKER), true);
});

test('codex cli hook preserves .js suffix for node-entry symlink backups', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const binDir = path.join(root, 'bin');
  const libDir = path.join(root, 'lib');
  const targetBinaryPath = path.join(binDir, 'codex');
  const targetEntryPath = path.join(libDir, 'codex.js');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetEntryPath, '#!/usr/bin/env node\nconsole.log("original")\n', 'utf8');
  fs.chmodSync(targetEntryPath, 0o755);
  fs.symlinkSync(targetEntryPath, targetBinaryPath);

  const service = createCodexCliHookService({
    fs,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    resolveCliPath: () => targetBinaryPath
  });

  const result = service.activate();
  const expectedUpstreamBinaryPath = path.join(fs.realpathSync(libDir), 'codex.aih-original.js');

  assert.equal(result.ok, true);
  assert.equal(result.upstreamBinaryPath, expectedUpstreamBinaryPath);
  assert.equal(fs.existsSync(expectedUpstreamBinaryPath), true);
  assert.equal(fs.readFileSync(expectedUpstreamBinaryPath, 'utf8'), '#!/usr/bin/env node\nconsole.log("original")\n');
});

test('codex cli hook migrates legacy node-entry backup from target shim path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const binDir = path.join(root, 'bin');
  const libDir = path.join(root, 'lib');
  const targetBinaryPath = path.join(binDir, 'codex');
  const targetEntryPath = path.join(libDir, 'codex.js');
  const legacyUpstreamBinaryPath = `${targetBinaryPath}.aih-original.js`;
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetEntryPath, '#!/bin/sh\n# aih-codex-cli-hook\nexec echo wrapped\n', 'utf8');
  const expectedUpstreamBinaryPath = path.join(path.dirname(fs.realpathSync(targetEntryPath)), 'codex.aih-original.js');
  fs.symlinkSync(targetEntryPath, targetBinaryPath);
  fs.writeFileSync(legacyUpstreamBinaryPath, '#!/usr/bin/env node\nconsole.log("legacy")\n', 'utf8');
  fs.chmodSync(targetEntryPath, 0o755);
  fs.chmodSync(legacyUpstreamBinaryPath, 0o755);

  const service = createCodexCliHookService({
    fs,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    resolveCliPath: () => targetBinaryPath
  });

  const result = service.ensureInstalled();

  assert.equal(result.ok, true);
  assert.equal(result.repaired, true);
  assert.equal(fs.existsSync(expectedUpstreamBinaryPath), true);
  assert.equal(fs.readFileSync(expectedUpstreamBinaryPath, 'utf8'), '#!/usr/bin/env node\nconsole.log("legacy")\n');
  assert.equal(fs.existsSync(legacyUpstreamBinaryPath), false);
  assert.equal(fs.readFileSync(targetBinaryPath, 'utf8').includes(expectedUpstreamBinaryPath), true);
});

test('codex cli hook deactivates by flipping shared state only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const binDir = path.join(root, 'bin');
  const targetBinaryPath = path.join(binDir, 'codex');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho original\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);

  const service = createCodexCliHookService({
    fs,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    resolveCliPath: () => targetBinaryPath
  });

  service.activate();
  const result = service.deactivate();
  const state = JSON.parse(fs.readFileSync(getStateFilePath(aiHomeDir), 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(state.enabled, false);
});

test('codex cli hook ensureInstalled repairs overwritten shim only when drift is detected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const binDir = path.join(root, 'bin');
  const targetBinaryPath = path.join(binDir, 'codex');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho original\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);

  const service = createCodexCliHookService({
    fs,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    resolveCliPath: () => targetBinaryPath
  });

  const first = service.ensureInstalled();
  assert.equal(first.repaired, true);
  const healthy = service.ensureInstalled();
  assert.equal(healthy.repaired, false);

  fs.writeFileSync(targetBinaryPath, '#!/bin/sh\necho overwritten\n', 'utf8');
  fs.chmodSync(targetBinaryPath, 0o755);
  const repaired = service.ensureInstalled();
  assert.equal(repaired.repaired, true);
  assert.equal(fs.readFileSync(targetBinaryPath, 'utf8').includes(WRAPPER_MARKER), true);
  assert.equal(fs.readFileSync(`${targetBinaryPath}.aih-original`, 'utf8'), '#!/bin/sh\necho overwritten\n');
});

test('codex cli hook ensureInstalled refreshes stale wrapper content when upstream path changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-cli-hook-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const binDir = path.join(root, 'bin');
  const libDir = path.join(root, 'lib');
  const targetBinaryPath = path.join(binDir, 'codex');
  const targetEntryPath = path.join(libDir, 'codex.js');
  const legacyUpstreamBinaryPath = `${targetBinaryPath}.aih-original.js`;
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(targetEntryPath, '#!/bin/sh\n# aih-codex-cli-hook\nUPSTREAM=\'/tmp/old-codex.aih-original.js\'\nexec echo wrapped\n', 'utf8');
  const expectedUpstreamBinaryPath = path.join(path.dirname(fs.realpathSync(targetEntryPath)), 'codex.aih-original.js');
  fs.symlinkSync(targetEntryPath, targetBinaryPath);
  fs.writeFileSync(legacyUpstreamBinaryPath, '#!/usr/bin/env node\nconsole.log("legacy")\n', 'utf8');
  fs.chmodSync(targetEntryPath, 0o755);
  fs.chmodSync(legacyUpstreamBinaryPath, 0o755);

  const service = createCodexCliHookService({
    fs,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir,
    nodeExecPath: '/usr/local/bin/node',
    helperScriptPath: '/tmp/codex-proxy.js',
    resolveCliPath: () => targetBinaryPath
  });

  const result = service.ensureInstalled();

  assert.equal(result.ok, true);
  assert.equal(result.repaired, true);
  assert.equal(fs.readFileSync(targetBinaryPath, 'utf8').includes(expectedUpstreamBinaryPath), true);
  assert.equal(fs.existsSync(expectedUpstreamBinaryPath), true);
  assert.equal(fs.existsSync(legacyUpstreamBinaryPath), false);
});
