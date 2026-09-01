const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getAppInstaller } = require('../lib/server/app-installers');
const createPtyRuntimeLaunchDomain = require('../lib/cli/services/pty/pty-runtime-launch');
const createPtyRuntimeRunDomain = require('../lib/cli/services/pty/pty-runtime-run');

function makeTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kimi-path-'));
}

// 模拟 which：在给定 env.PATH 里按名字找第一个存在的文件。
function createWhichLikeResolveCliPath(fallbackEnv) {
  return (name, options = {}) => {
    const env = options.env || fallbackEnv || {};
    const entries = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
    for (const entry of entries) {
      const candidate = path.join(entry, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    return '';
  };
}

function createLaunchDomain(homeDir, resolveCliPath) {
  const processObj = {
    env: { PATH: '/usr/bin' },
    platform: 'darwin',
    execPath: '/usr/local/bin/node'
  };
  return createPtyRuntimeLaunchDomain({
    path,
    fs,
    processObj,
    resolveCliPath,
    hostHomeDir: homeDir,
    aiHomeDir: path.join(homeDir, '.ai_home')
  }, {
    codexLaunchSupport: {
      resolveLatestCodexThreadIdForCwd: () => '',
      buildCodexAutoResumeArgs: () => []
    }
  });
}

test('kimi collectCliPathEntries 覆盖官方安装器/npm/bun 的常见落点', () => {
  const home = makeTmpHome();
  const installer = getAppInstaller('kimi');
  const entries = installer.collectCliPathEntries({
    hostHomeDir: home,
    platform: 'darwin',
    processObj: { platform: 'darwin', execPath: '/usr/local/bin/node' }
  });
  assert.ok(entries.includes(path.join(home, '.local', 'bin')), 'install.sh / uv 默认落点');
  assert.ok(entries.includes(path.join(home, '.kimi-code', 'bin')), 'kimi-code 自带 bin 目录');
  assert.ok(entries.includes(path.join(home, '.bun', 'bin')), 'bun 全局安装落点');
  assert.ok(entries.includes('/usr/local/bin'), 'npm 全局 bin（跟随 node）');
  assert.ok(entries.includes('/opt/homebrew/bin'), 'Homebrew 前缀');
});

test('resolveCliPathWithRuntimeTools 能在 ~/.kimi-code/bin 找到 PATH 外的 kimi', () => {
  const home = makeTmpHome();
  const binDir = path.join(home, '.kimi-code', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const planted = path.join(binDir, 'kimi');
  fs.writeFileSync(planted, '#!/bin/sh\n', { mode: 0o755 });

  const launch = createLaunchDomain(home, createWhichLikeResolveCliPath({ PATH: '/usr/bin' }));
  assert.equal(launch.resolveCliPathWithRuntimeTools('kimi'), planted);
});

test('findCliBinaryInSearchEntries 能在候选目录里直接定位二进制文件', () => {
  const home = makeTmpHome();
  const binDir = path.join(home, '.bun', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const planted = path.join(binDir, 'kimi');
  fs.writeFileSync(planted, '#!/bin/sh\n');

  const launch = createLaunchDomain(home, () => '');
  const entries = launch.collectCliPathSearchEntries('kimi');
  assert.equal(launch.findCliBinaryInSearchEntries('kimi', entries), planted);
  assert.equal(launch.findCliBinaryInSearchEntries('kimi', [path.join(home, 'empty')]), '');
});

function createRunDomain(homeDir, { askYesNo, spawnSync }) {
  const exitCodes = [];
  const processObj = {
    env: { PATH: '/usr/bin' },
    platform: 'darwin',
    execPath: '/usr/local/bin/node',
    exit: (code) => { exitCodes.push(code); }
  };
  const launch = createPtyRuntimeLaunchDomain({
    path,
    fs,
    processObj,
    resolveCliPath: () => '',
    hostHomeDir: homeDir,
    aiHomeDir: path.join(homeDir, '.ai_home')
  }, {
    codexLaunchSupport: {
      resolveLatestCodexThreadIdForCwd: () => '',
      buildCodexAutoResumeArgs: () => []
    }
  });
  const run = createPtyRuntimeRunDomain({
    path,
    fs,
    processObj,
    spawnSync,
    cliConfigs: {},
    hostHomeDir: homeDir,
    aiHomeDir: path.join(homeDir, '.ai_home'),
    askYesNo
  }, launch, {}, {
    shared: {},
    codexLaunchSupport: {
      resolveLatestCodexThreadIdForCwd: () => '',
      buildCodexAutoResumeArgs: () => []
    },
    persistentWrapper: {
      reconcileRegistryAfterExit: () => ({})
    }
  });
  return { run, exitCodes };
}

function captureConsole(fn) {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message) => { lines.push(String(message)); };
  console.error = (message) => { lines.push(String(message)); };
  try {
    fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return lines.join('\n');
}

test('安装成功但重解析失败时打印查找路径与 PATH 建议，不再沉默退出', () => {
  const home = makeTmpHome();
  const binDir = path.join(home, '.kimi-code', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const planted = path.join(binDir, 'kimi');
  fs.writeFileSync(planted, '#!/bin/sh\n');

  const { run, exitCodes } = createRunDomain(home, {
    askYesNo: () => true,
    spawnSync: () => ({ status: 0 })
  });
  const output = captureConsole(() => {
    run.runCliPty('kimi', 'acct_' + 'a'.repeat(20), [], false);
  });
  assert.deepEqual(exitCodes, [1]);
  assert.match(output, /Successfully installed kimi/);
  assert.match(output, /still not resolvable/);
  assert.match(output, /Searched directories:/);
  assert.ok(output.includes(binDir), '诊断应列出实际查找过的 kimi-code bin 目录');
  assert.ok(output.includes(planted), '诊断应指出已发现的二进制位置');
  assert.match(output, /Add .+ to PATH, then retry/);
});

test('用户拒绝安装时明确提示并退出，不进入无提示循环', () => {
  const home = makeTmpHome();
  const { run, exitCodes } = createRunDomain(home, {
    askYesNo: () => false,
    spawnSync: () => { throw new Error('spawnSync must not be called when install is declined'); }
  });
  const output = captureConsole(() => {
    run.runCliPty('kimi', 'acct_' + 'a'.repeat(20), [], false);
  });
  assert.deepEqual(exitCodes, [1]);
  assert.match(output, /install skipped/);
});
