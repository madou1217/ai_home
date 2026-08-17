'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');

const {
  createAccountAppLauncher,
  createAppEntryDetector,
  findOnPath,
  findRunningDesktopPids,
  listRunningDesktopInstances,
  normalizePlatform
} = require('../lib/server/account-app-launcher');
const { registerAccountIdentity } = require('../lib/account/account-registration');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const SANDBOX_DIR = nodePath.join('C:\\aih-home', 'run', 'auth-projections', 'zcode', ACCOUNT_REF);

// createFakeFs 提供纯内存 fs 假实现，existsSync 由调用方给定路径集合决定。
function createFakeFs(existingPaths = []) {
  const existing = new Set(existingPaths);
  const mkdirCalls = [];
  return {
    mkdirCalls,
    existsSync(candidate) {
      return existing.has(String(candidate));
    },
    mkdirSync(dir) {
      mkdirCalls.push(String(dir));
    },
    statSync() {
      return { isDirectory: () => false };
    },
    readFileSync() {
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
  };
}

// createFakeSpawn 记录 spawn 调用并返回可 unref 的假子进程。
function createFakeSpawn() {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    const child = { pid: 4321, unrefCalled: false, unref() { this.unrefCalled = true; } };
    calls.push({ file, args, options, child });
    return child;
  };
  return { calls, spawnImpl };
}

function createLauncher(overrides = {}) {
  const fakeSpawn = createFakeSpawn();
  const fsImpl = overrides.fs || createFakeFs();
  const launcher = createAccountAppLauncher({
    fs: fsImpl,
    path: overrides.path || nodePath,
    spawn: fakeSpawn.spawnImpl,
    processObj: overrides.processObj || { platform: 'win32', execPath: 'C:\\node\\node.exe', env: {} },
    env: overrides.env || {},
    aiHomeDir: 'C:\\aih-home',
    repoRoot: 'C:\\repo',
    execFileSync: overrides.execFileSync || function execFileSync() { throw new Error('exec disabled in tests'); },
    stopGraceMs: overrides.stopGraceMs,
    resolveAccount: overrides.resolveAccount || (() => ({
      accountRef: ACCOUNT_REF,
      provider: 'zcode',
      cliAccountId: '3'
    })),
    getProfileDir: overrides.getProfileDir || (() => SANDBOX_DIR),
    readAccountEnv: overrides.readAccountEnv || (() => ({})),
    resolveAccountEligibility: overrides.resolveAccountEligibility,
    enforceCliInstallation: overrides.enforceCliInstallation,
    resolveCliPath: overrides.resolveCliPath
  });
  return { launcher, fakeSpawn, fsImpl };
}

test('launchAccountApp 在账号未配置时拒绝打开', () => {
  const { launcher } = createLauncher({
    resolveAccountEligibility: () => ({ configured: false })
  });
  const result = launcher.launchAccountApp({ provider: 'zcode', accountRef: ACCOUNT_REF, kind: 'desktop' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'account_unconfigured');
});

test('launchAccountApp 在认证失效时拒绝打开', () => {
  const { launcher } = createLauncher({
    resolveAccount: () => ({ accountRef: ACCOUNT_REF, provider: 'codex', cliAccountId: '3' }),
    resolveAccountEligibility: () => ({ configured: true, runtimeStatus: 'auth_invalid' })
  });
  const result = launcher.launchAccountApp({ provider: 'codex', accountRef: ACCOUNT_REF, kind: 'cli' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'account_auth_invalid');
});

test('launchAccountApp 在生产资格检查开启且 CLI 缺失时返回 cli_not_installed', () => {
  const { launcher } = createLauncher({
    resolveAccount: () => ({ accountRef: ACCOUNT_REF, provider: 'codex', cliAccountId: '3' }),
    enforceCliInstallation: true,
    resolveCliPath: () => ''
  });
  const result = launcher.launchAccountApp({ provider: 'codex', accountRef: ACCOUNT_REF, kind: 'cli' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'cli_not_installed');
});

test('launchAccountApp 校验 kind，未知 kind 返回 unsupported_kind', () => {
  const { launcher } = createLauncher();
  assert.equal(launcher.launchAccountApp({ provider: 'zcode', accountRef: ACCOUNT_REF, kind: 'gui' }).error, 'unsupported_kind');
  assert.equal(launcher.launchAccountApp({ provider: 'zcode', accountRef: ACCOUNT_REF, kind: '' }).error, 'unsupported_kind');
});

test('launchAccountApp 对未知 Provider 返回 unsupported_provider', () => {
  const { launcher } = createLauncher();
  const result = launcher.launchAccountApp({ provider: 'unknown-ai', accountRef: ACCOUNT_REF, kind: 'desktop' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unsupported_provider');
});

test('launchAccountApp 对 clients.desktop=false 的 Provider 返回 desktop_not_supported', () => {
  const { launcher } = createLauncher();
  const result = launcher.launchAccountApp({ provider: 'gemini', accountRef: ACCOUNT_REF, kind: 'desktop' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'desktop_not_supported');
});

test('launchAccountApp 对不存在的账号返回 account_not_found', () => {
  const { launcher } = createLauncher({ resolveAccount: () => null });
  const result = launcher.launchAccountApp({ provider: 'zcode', accountRef: ACCOUNT_REF, kind: 'desktop' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'account_not_found');
});

test('launchAccountApp 拒绝 Provider 与账号不匹配的请求', () => {
  const { launcher } = createLauncher({
    resolveAccount: () => ({ accountRef: ACCOUNT_REF, provider: 'claude', cliAccountId: '3' })
  });
  const result = launcher.launchAccountApp({ provider: 'codex', accountRef: ACCOUNT_REF, kind: 'cli' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'account_not_found');
});

test('zcode desktop 在 Windows 按 LOCALAPPDATA -> ProgramFiles 顺序解析可执行文件', () => {
  const localAppDataExe = 'C:\\Users\\x\\AppData\\Local\\Programs\\ZCode\\ZCode.exe';
  const programFilesExe = 'C:\\Program Files\\ZCode\\ZCode.exe';

  // ProgramFiles 命中时优先于 PATH 回退，LOCALAPPDATA 缺失。
  const { launcher, fakeSpawn } = createLauncher({
    fs: createFakeFs([programFilesExe]),
    env: {
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      PATH: '',
      USERPROFILE: 'C:\\Users\\x'
    }
  });
  const result = launcher.launchAccountApp({ provider: 'zcode', accountRef: ACCOUNT_REF, kind: 'desktop' });
  assert.equal(result.ok, true);
  assert.equal(result.executable, programFilesExe);
  assert.equal(fakeSpawn.calls.length, 1);
  assert.equal(fakeSpawn.calls[0].file, programFilesExe);

  // LOCALAPPDATA 存在时优先命中。
  const localFirst = createLauncher({
    fs: createFakeFs([localAppDataExe, programFilesExe]),
    env: {
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      PATH: '',
      USERPROFILE: 'C:\\Users\\x'
    }
  });
  const localResult = localFirst.launcher.launchAccountApp({ provider: 'zcode', accountRef: ACCOUNT_REF, kind: 'desktop' });
  assert.equal(localResult.ok, true);
  assert.equal(localResult.executable, localAppDataExe);
});

test('zcode desktop 在 Windows 可执行文件缺失时回退到 PATH 查找', () => {
  const pathExe = 'C:\\tools\\ZCode.exe';
  const { launcher } = createLauncher({
    fs: createFakeFs([pathExe]),
    env: {
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      PATH: 'C:\\tools',
      USERPROFILE: 'C:\\Users\\x'
    }
  });
  const result = launcher.launchAccountApp({ provider: 'zcode', accountRef: ACCOUNT_REF, kind: 'desktop' });
  assert.equal(result.ok, true);
  assert.equal(result.executable, pathExe);
});

test('zcode desktop 在 Windows 环境变量全大写存储时仍能解析安装目录', () => {
  // 回归：Windows 上 Object.keys(process.env) 保留存储大小写（PROGRAMFILES），
  // 直接 env.ProgramFiles 会漏读导致 desktop_not_installed。
  const programFilesExe = 'C:\\Program Files\\ZCode\\ZCode.exe';
  const { launcher } = createLauncher({
    fs: createFakeFs([programFilesExe]),
    env: {
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
      PROGRAMFILES: 'C:\\Program Files',
      PATH: '',
      USERPROFILE: 'C:\\Users\\x'
    }
  });
  const result = launcher.launchAccountApp({ provider: 'zcode', accountRef: ACCOUNT_REF, kind: 'desktop' });
  assert.equal(result.ok, true);
  assert.equal(result.executable, programFilesExe);
});

test('zcode desktop 找不到可执行文件时返回 desktop_not_installed', () => {
  const { launcher, fakeSpawn } = createLauncher({
    fs: createFakeFs([]),
    env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', PATH: '', USERPROFILE: 'C:\\Users\\x' }
  });
  const result = launcher.launchAccountApp({ provider: 'zcode', accountRef: ACCOUNT_REF, kind: 'desktop' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'desktop_not_installed');
  assert.equal(fakeSpawn.calls.length, 0);
});

test('zcode desktop 启动带沙箱 env 与独立 --user-data-dir，进程 detached + unref', () => {
  const exe = 'C:\\Users\\x\\AppData\\Local\\Programs\\ZCode\\ZCode.exe';
  const fsImpl = createFakeFs([exe]);
  const { launcher, fakeSpawn } = createLauncher({
    fs: fsImpl,
    env: {
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
      PATH: '',
      USERPROFILE: 'C:\\Users\\x'
    },
    readAccountEnv: () => ({ ZCODE_API_KEY: 'test-key' })
  });
  const result = launcher.launchAccountApp({ provider: 'zcode', accountRef: ACCOUNT_REF, kind: 'desktop' });
  assert.equal(result.ok, true);
  assert.equal(result.pid, 4321);

  const call = fakeSpawn.calls[0];
  assert.equal(call.file, exe);
  const expectedUserDataDir = nodePath.join(SANDBOX_DIR, 'electron-user-data');
  assert.deepEqual(call.args, [`--user-data-dir=${expectedUserDataDir}`]);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.stdio, 'ignore');
  assert.equal(call.child.unrefCalled, true);

  // 沙箱 env 隔离：Desktop 宿主的 ZCODE_DATA_BASE_DIR 语义是 .zcode 的父目录
  // （宿主自行再拼 .zcode），因此回指到 profileDir；ZCODE_HOME 指向 .zcode 根。
  // ZCODE_API_KEY 不进入进程 env，由 prepareProviderRuntime 投影到沙箱配置中携带。
  assert.equal(call.options.env.ZCODE_DATA_BASE_DIR, SANDBOX_DIR);
  assert.equal(call.options.env.ZCODE_HOME, nodePath.join(SANDBOX_DIR, '.zcode'));
  assert.equal(call.options.env.ZCODE_API_KEY, undefined);

  // electron-user-data 目录在启动前创建。
  assert.ok(fsImpl.mkdirCalls.includes(expectedUserDataDir));
});

test('zcode desktop 注入按 accountRef 派生的 ZCODE_DESKTOP_APPLICATION_NAME（恒定且跨账号互异）', () => {
  const exe = 'C:\\Users\\x\\AppData\\Local\\Programs\\ZCode\\ZCode.exe';
  const mkLauncher = (accountRef) => createLauncher({
    fs: createFakeFs([exe]),
    env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', PATH: '', USERPROFILE: 'C:\\Users\\x' },
    resolveAccount: () => ({ accountRef, provider: 'zcode', cliAccountId: '3' })
  });

  const first = mkLauncher(ACCOUNT_REF);
  const firstResult = first.launcher.launchAccountApp({ provider: 'zcode', accountRef: ACCOUNT_REF, kind: 'desktop' });
  assert.equal(firstResult.ok, true);
  const nameA = first.fakeSpawn.calls[0].options.env.ZCODE_DESKTOP_APPLICATION_NAME;
  assert.match(nameA, /^ZCode-[0-9a-f]{8}$/);

  // 同 accountRef 重复启动，应用名恒定。
  const second = mkLauncher(ACCOUNT_REF);
  second.launcher.launchAccountApp({ provider: 'zcode', accountRef: ACCOUNT_REF, kind: 'desktop' });
  assert.equal(second.fakeSpawn.calls[0].options.env.ZCODE_DESKTOP_APPLICATION_NAME, nameA);

  // 不同 accountRef 派生出不同应用名，单实例锁不再互相吞掉。
  const otherRef = 'acct_ffffffffffffffffffff';
  const third = mkLauncher(otherRef);
  third.launcher.launchAccountApp({ provider: 'zcode', accountRef: otherRef, kind: 'desktop' });
  const nameB = third.fakeSpawn.calls[0].options.env.ZCODE_DESKTOP_APPLICATION_NAME;
  assert.match(nameB, /^ZCode-[0-9a-f]{8}$/);
  assert.notEqual(nameB, nameA);
});

test('非 zcode Provider 的 desktop 启动不注入 ZCODE_DESKTOP_APPLICATION_NAME', () => {
  const codexExe = 'C:\\tools\\ChatGPT.exe';
  const { launcher, fakeSpawn } = createLauncher({
    fs: createFakeFs([codexExe]),
    env: { PATH: 'C:\\tools', USERPROFILE: 'C:\\Users\\x' },
    resolveAccount: () => ({ accountRef: ACCOUNT_REF, provider: 'codex', cliAccountId: '3' })
  });
  const result = launcher.launchAccountApp({ provider: 'codex', accountRef: ACCOUNT_REF, kind: 'desktop' });
  assert.equal(result.ok, true);
  assert.equal(fakeSpawn.calls[0].options.env.ZCODE_DESKTOP_APPLICATION_NAME, undefined);
});

test('codex desktop 为每个账号注入独立 CODEX_ELECTRON_USER_DATA_PATH', () => {
  const bundlePath = '/Applications/ChatGPT.app';
  const executablePath = `${bundlePath}/Contents/MacOS/ChatGPT`;
  const profileDir = `/aih-home/run/auth-projections/codex/${ACCOUNT_REF}`;
  const expectedUserDataDir = `${profileDir}/electron-user-data`;
  const { launcher, fakeSpawn } = createLauncher({
    path: nodePath.posix,
    processObj: { platform: 'darwin', execPath: '/usr/local/bin/node', env: {} },
    fs: createFakeFs([bundlePath, executablePath]),
    env: { HOME: '/Users/x', PATH: '' },
    resolveAccount: () => ({ accountRef: ACCOUNT_REF, provider: 'codex', cliAccountId: '7' }),
    getProfileDir: () => profileDir,
    readAccountEnv: () => ({ OPENAI_API_KEY: 'account-key' })
  });

  const result = launcher.launchAccountApp({ provider: 'codex', accountRef: ACCOUNT_REF, kind: 'desktop' });

  assert.equal(result.ok, true);
  assert.equal(fakeSpawn.calls.length, 1);
  assert.equal(fakeSpawn.calls[0].options.env.CODEX_ELECTRON_USER_DATA_PATH, expectedUserDataDir);
  assert.equal(fakeSpawn.calls[0].options.env.OPENAI_API_KEY, 'account-key');
  assert.deepEqual(fakeSpawn.calls[0].args, [`--user-data-dir=${expectedUserDataDir}`]);
});

test('zcode desktop 在 macOS 使用 manifest installPaths 解析 .app 内可执行文件', () => {
  const bundlePath = '/Applications/ZCode.app';
  const expectedExe = '/Applications/ZCode.app/Contents/MacOS/ZCode';
  const { launcher, fakeSpawn } = createLauncher({
    path: nodePath.posix,
    processObj: { platform: 'darwin', execPath: '/usr/local/bin/node', env: {} },
    fs: createFakeFs([bundlePath, expectedExe]),
    env: { HOME: '/Users/x', PATH: '' },
    getProfileDir: () => '/aih-home/run/auth-projections/zcode/' + ACCOUNT_REF
  });
  const result = launcher.launchAccountApp({ provider: 'zcode', accountRef: ACCOUNT_REF, kind: 'desktop' });
  assert.equal(result.ok, true);
  assert.equal(result.executable, expectedExe);
  assert.equal(fakeSpawn.calls[0].file, expectedExe);
  assert.deepEqual(fakeSpawn.calls[0].args, [
    `--user-data-dir=/aih-home/run/auth-projections/zcode/${ACCOUNT_REF}/electron-user-data`
  ]);
  assert.equal(fakeSpawn.calls[0].options.env.ZCODE_DATA_BASE_DIR,
    `/aih-home/run/auth-projections/zcode/${ACCOUNT_REF}`);
  assert.equal(fakeSpawn.calls[0].options.env.ZCODE_HOME,
    `/aih-home/run/auth-projections/zcode/${ACCOUNT_REF}/.zcode`);
});

test('zcode desktop 在 Linux 通过 PATH 上的 execNames 解析', () => {
  const { launcher } = createLauncher({
    path: nodePath.posix,
    processObj: { platform: 'linux', execPath: '/usr/bin/node', env: {} },
    fs: createFakeFs(['/usr/bin/zcode']),
    env: { HOME: '/home/x', PATH: '/usr/bin' },
    getProfileDir: () => '/aih-home/run/auth-projections/zcode/' + ACCOUNT_REF
  });
  const result = launcher.launchAccountApp({ provider: 'zcode', accountRef: ACCOUNT_REF, kind: 'desktop' });
  assert.equal(result.ok, true);
  assert.equal(result.executable, '/usr/bin/zcode');
});

test('cli kind 在 Windows 通过 cmd start 打开新终端运行 aih 启动链路', () => {
  const { launcher, fakeSpawn } = createLauncher({
    resolveAccount: () => ({ accountRef: ACCOUNT_REF, provider: 'codex', cliAccountId: '3' })
  });
  const result = launcher.launchAccountApp({ provider: 'codex', accountRef: ACCOUNT_REF, kind: 'cli' });
  assert.equal(result.ok, true);
  assert.equal(result.pid, 4321);
  const call = fakeSpawn.calls[0];
  assert.equal(call.file, 'cmd.exe');
  assert.equal(call.args[0], '/c');
  assert.ok(call.args[1].includes('start "aih codex 3"'));
  assert.ok(call.args[1].includes('cmd /k'));
  assert.ok(call.args[1].includes(nodePath.win32.join('C:\\repo', 'bin', 'ai-home.js')));
  assert.ok(call.args[1].includes('"C:\\node\\node.exe"'));
  assert.equal(call.options.detached, true);
  assert.equal(call.child.unrefCalled, true);
});

test('cli kind 在 macOS 通过 osascript 让 Terminal.app 打开新窗口', () => {
  const { launcher, fakeSpawn } = createLauncher({
    path: nodePath.posix,
    processObj: { platform: 'darwin', execPath: '/usr/local/bin/node', env: {} },
    env: { HOME: '/Users/x', PATH: '' },
    resolveAccount: () => ({ accountRef: ACCOUNT_REF, provider: 'codex', cliAccountId: '3' })
  });
  const result = launcher.launchAccountApp({ provider: 'codex', accountRef: ACCOUNT_REF, kind: 'cli' });
  assert.equal(result.ok, true);
  const call = fakeSpawn.calls[0];
  assert.equal(call.file, 'osascript');
  const script = call.args.join(' ');
  assert.ok(script.includes('tell application "Terminal"'));
  assert.ok(script.includes('do script'));
  assert.ok(script.includes('bin/ai-home.js'));
  assert.ok(script.includes('codex 3'));
});

test('cli kind 在 Linux 按 x-terminal-emulator -> gnome-terminal -> konsole 顺序选择终端', () => {
  // 只有 gnome-terminal 可用时选中 gnome-terminal。
  const { launcher, fakeSpawn } = createLauncher({
    path: nodePath.posix,
    processObj: { platform: 'linux', execPath: '/usr/bin/node', env: {} },
    fs: createFakeFs(['/usr/bin/gnome-terminal']),
    env: { HOME: '/home/x', PATH: '/usr/bin' },
    resolveAccount: () => ({ accountRef: ACCOUNT_REF, provider: 'codex', cliAccountId: '3' })
  });
  const result = launcher.launchAccountApp({ provider: 'codex', accountRef: ACCOUNT_REF, kind: 'cli' });
  assert.equal(result.ok, true);
  const call = fakeSpawn.calls[0];
  assert.equal(call.file, '/usr/bin/gnome-terminal');
  assert.deepEqual(call.args.slice(0, 3), ['--', 'bash', '-lc']);
  assert.ok(call.args[3].includes('codex 3'));
});

test('cli kind 在 Linux 没有任何终端时返回 terminal_not_found', () => {
  const { launcher, fakeSpawn } = createLauncher({
    path: nodePath.posix,
    processObj: { platform: 'linux', execPath: '/usr/bin/node', env: {} },
    fs: createFakeFs([]),
    env: { HOME: '/home/x', PATH: '' },
    resolveAccount: () => ({ accountRef: ACCOUNT_REF, provider: 'codex', cliAccountId: '3' })
  });
  const result = launcher.launchAccountApp({ provider: 'codex', accountRef: ACCOUNT_REF, kind: 'cli' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'terminal_not_found');
  assert.equal(fakeSpawn.calls.length, 0);
});

test('ZCode 没有 CLI/TUI 入口', () => {
  const { launcher } = createLauncher({
    resolveAccount: () => ({ accountRef: ACCOUNT_REF, provider: 'zcode', cliAccountId: '3' })
  });
  const result = launcher.launchAccountApp({ provider: 'zcode', accountRef: ACCOUNT_REF, kind: 'cli' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'cli_not_supported');
});

test('默认 accountRef 解析会联结 CLI 别名，CLI 点击不再误报 account_not_found', () => {
  const aiHomeDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'aih-launcher-cli-'));
  try {
    const accountRef = registerAccountIdentity(nodeFs, aiHomeDir, {
      provider: 'codex',
      cliAccountId: '12',
      identitySeed: 'oauth:codex:launcher@example.test'
    }).accountRef;
    const fakeSpawn = createFakeSpawn();
    const launcher = createAccountAppLauncher({
      fs: nodeFs,
      path: nodePath,
      spawn: fakeSpawn.spawnImpl,
      processObj: { platform: 'win32', execPath: 'C:\\node\\node.exe', env: {} },
      env: {},
      aiHomeDir,
      repoRoot: 'C:\\repo',
      execFileSync: () => '',
      readAccountEnv: () => ({})
    });
    const result = launcher.launchAccountApp({ provider: 'codex', accountRef, kind: 'cli' });
    assert.equal(result.ok, true);
    assert.equal(result.terminalId, 'system-default');
    assert.equal(fakeSpawn.calls.length, 1);
    assert.match(fakeSpawn.calls[0].args[1], /aih codex 12/);
  } finally {
    nodeFs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('findOnPath 在 Windows 为无扩展名的名字补 .exe', () => {
  const fsImpl = createFakeFs(['C:\\tools\\zcode.exe']);
  const found = findOnPath(['zcode'], { PATH: 'C:\\tools' }, fsImpl, nodePath.win32, 'windows');
  assert.equal(found, 'C:\\tools\\zcode.exe');
});

test('normalizePlatform 归一化 Node 平台标识', () => {
  assert.equal(normalizePlatform('win32'), 'windows');
  assert.equal(normalizePlatform('darwin'), 'macos');
  assert.equal(normalizePlatform('linux'), 'linux');
});

// --- 单实例与 close 动作 ---

// createFakeExecRunning 模拟宿主机上本账号 Desktop 主进程正在运行。
function createFakeExecRunning(userDataDir) {
  const calls = [];
  const execFileSync = (file, args) => {
    calls.push({ file, args });
    if (file === 'powershell.exe') {
      return JSON.stringify([
        // 主进程：命令行带本账号的 --user-data-dir
        { ProcessId: 9001, Name: 'ZCode.exe', CommandLine: `"C:\\Program Files\\ZCode\\ZCode.exe" --user-data-dir=${userDataDir}` },
        // renderer 子进程：带 --type=，必须排除
        { ProcessId: 9002, Name: 'ZCode.exe', CommandLine: `"C:\\Program Files\\ZCode\\ZCode.exe" --type=renderer --user-data-dir=${userDataDir}` },
        // 其它账号实例：user-data-dir 不同，不能匹配
        { ProcessId: 9003, Name: 'ZCode.exe', CommandLine: '"C:\\Program Files\\ZCode\\ZCode.exe" --user-data-dir=C:\\other\\electron-user-data' }
      ]);
    }
    if (file === 'taskkill') return '';
    if (file === 'ps') {
      return `  9001 ZCode --user-data-dir=${userDataDir}\n` +
        `  9002 ZCode --type=renderer --user-data-dir=${userDataDir}\n`;
    }
    throw new Error(`unexpected exec: ${file}`);
  };
  return { calls, execFileSync };
}

test('desktop open 在实例已运行时返回 already_running 且不再 spawn', () => {
  const exe = 'C:\\Program Files\\ZCode\\ZCode.exe';
  const userDataDir = nodePath.join(SANDBOX_DIR, 'electron-user-data');
  const fakeExec = createFakeExecRunning(userDataDir);
  const { launcher, fakeSpawn } = createLauncher({
    fs: createFakeFs([exe]),
    env: { ProgramFiles: 'C:\\Program Files', PATH: '', USERPROFILE: 'C:\\Users\\x' },
    execFileSync: fakeExec.execFileSync
  });
  const result = launcher.launchAccountApp({ provider: 'zcode', accountRef: ACCOUNT_REF, kind: 'desktop' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'already_running');
  assert.deepEqual(result.pids, [9001]);
  assert.equal(fakeSpawn.calls.length, 0);
});

test('desktop close 结束本账号实例主进程并返回 closed', () => {
  const userDataDir = nodePath.join(SANDBOX_DIR, 'electron-user-data');
  const fakeExec = createFakeExecRunning(userDataDir);
  const { launcher, fakeSpawn } = createLauncher({
    execFileSync: fakeExec.execFileSync
  });
  const result = launcher.launchAccountApp({
    provider: 'zcode',
    accountRef: ACCOUNT_REF,
    kind: 'desktop',
    action: 'close'
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'closed');
  assert.deepEqual(result.pids, [9001]);
  const taskkillCalls = fakeExec.calls.filter((call) => call.file === 'taskkill');
  assert.equal(taskkillCalls.length, 1);
  assert.deepEqual(taskkillCalls[0].args, ['/PID', '9001', '/T', '/F']);
  assert.equal(fakeSpawn.calls.length, 0);
});

test('desktop close 在没有运行实例时返回 not_running', () => {
  const { launcher } = createLauncher();
  const result = launcher.launchAccountApp({
    provider: 'zcode',
    accountRef: ACCOUNT_REF,
    kind: 'desktop',
    action: 'close'
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'not_running');
});

test('posix close 先 SIGTERM，宽限后仍存活再 SIGKILL', () => {
  const userDataDir = '/aih-home/run/auth-projections/zcode/' + ACCOUNT_REF + '/electron-user-data';
  const signals = [];
  const fakeExec = {
    execFileSync(file) {
      if (file === 'ps') {
        return `  9001 zcode --user-data-dir=${userDataDir}\n  9002 zcode --type=utility --user-data-dir=${userDataDir}\n`;
      }
      throw new Error(`unexpected exec: ${file}`);
    }
  };
  const { launcher } = createLauncher({
    path: nodePath.posix,
    processObj: {
      platform: 'linux',
      execPath: '/usr/bin/node',
      env: {},
      kill(pid, signal) {
        signals.push([pid, signal]);
        if (signal === 0) return true; // 宽限后仍存活
        return true;
      }
    },
    env: { HOME: '/home/x', PATH: '' },
    getProfileDir: () => '/aih-home/run/auth-projections/zcode/' + ACCOUNT_REF,
    execFileSync: fakeExec.execFileSync,
    stopGraceMs: 0
  });
  const result = launcher.launchAccountApp({
    provider: 'zcode',
    accountRef: ACCOUNT_REF,
    kind: 'desktop',
    action: 'close'
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'closed');
  assert.deepEqual(result.pids, [9001]);
  assert.deepEqual(signals, [[9001, 'SIGTERM'], [9001, 0], [9001, 'SIGKILL']]);
});

test('action 校验：未知 action 与 cli+close 都返回 unsupported_action', () => {
  const { launcher } = createLauncher();
  assert.equal(
    launcher.launchAccountApp({ provider: 'zcode', accountRef: ACCOUNT_REF, kind: 'desktop', action: 'restart' }).error,
    'unsupported_action'
  );
  assert.equal(
    launcher.launchAccountApp({ provider: 'zcode', accountRef: ACCOUNT_REF, kind: 'cli', action: 'close' }).error,
    'unsupported_action'
  );
});

test('findRunningDesktopPids 排除 --type= 子进程并只匹配本账号 user-data-dir', () => {
  const userDataDir = 'C:\\aih-home\\run\\auth-projections\\zcode\\x\\electron-user-data';
  const fakeExec = createFakeExecRunning(userDataDir);
  const platformConfig = { processNames: ['ZCode.exe'], execNames: ['ZCode.exe'] };
  const pids = findRunningDesktopPids(userDataDir, platformConfig, 'windows', {
    execFileSync: fakeExec.execFileSync
  });
  assert.deepEqual(pids, [9001]);
  assert.deepEqual(findRunningDesktopPids('', platformConfig, 'windows', {
    execFileSync: fakeExec.execFileSync
  }), []);
});

// --- app-entries 宿主机检测 ---

test('app-entries 检测：zcode 桌面已安装但无 CLI 二进制 → desktop:true cli:false', () => {
  const exe = 'C:\\Users\\x\\AppData\\Local\\Programs\\ZCode\\ZCode.exe';
  const detector = createAppEntryDetector({
    fs: createFakeFs([exe]),
    path: nodePath,
    processObj: { platform: 'win32', env: {} },
    env: {
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
      PATH: 'C:\\empty',
      USERPROFILE: 'C:\\Users\\x'
    },
    now: () => 1000
  });
  const entries = detector.detect();
  assert.deepEqual(entries.zcode, { desktop: true, cli: false });
  // 未声明 desktopClient 的 Provider 恒为 desktop:false
  assert.equal(entries.kiro.desktop, false);
  assert.equal(entries.kiro.cli, false);
});

test('app-entries 检测结果在 30s 内命中缓存', () => {
  const exe = 'C:\\Program Files\\ZCode\\ZCode.exe';
  const fsImpl = createFakeFs([exe]);
  let nowValue = 1000;
  const detector = createAppEntryDetector({
    fs: fsImpl,
    path: nodePath,
    processObj: { platform: 'win32', env: {} },
    env: { ProgramFiles: 'C:\\Program Files', PATH: '', USERPROFILE: 'C:\\Users\\x' },
    now: () => nowValue
  });
  assert.equal(detector.detect().zcode.desktop, true);
  // 缓存窗口内即使文件消失也返回旧结果
  const emptyFs = createFakeFs([]);
  fsImpl.existsSync = emptyFs.existsSync;
  nowValue = 2000;
  assert.equal(detector.detect().zcode.desktop, true);
  // 超过缓存窗口重新检测
  nowValue = 1000 + 31 * 1000;
  assert.equal(detector.detect().zcode.desktop, false);
});

// --- 批量桌面实例扫描 ---

test('listRunningDesktopInstances 一次扫描解析多个主进程的 user-data-dir', () => {
  const execFileSync = (file) => {
    assert.equal(file, 'powershell.exe');
    return JSON.stringify([
      { ProcessId: 9101, Name: 'ZCode.exe', CommandLine: '"C:\\ZCode\\ZCode.exe" --user-data-dir=C:\\aih\\a\\electron-user-data' },
      // 引号包裹的路径也要能解析
      { ProcessId: 9102, Name: 'ZCode.exe', CommandLine: '"C:\\ZCode\\ZCode.exe" "--user-data-dir=C:\\aih dir\\b\\electron-user-data"' },
      // renderer 子进程排除
      { ProcessId: 9103, Name: 'ZCode.exe', CommandLine: '"C:\\ZCode\\ZCode.exe" --type=renderer --user-data-dir=C:\\aih\\a\\electron-user-data' },
      // 无 user-data-dir 的进程排除
      { ProcessId: 9104, Name: 'other.exe', CommandLine: 'C:\\other\\other.exe --flag' }
    ]);
  };
  const instances = listRunningDesktopInstances('windows', { execFileSync });
  assert.deepEqual(instances, [
    { pid: 9101, userDataDir: 'C:\\aih\\a\\electron-user-data' },
    { pid: 9102, userDataDir: 'C:\\aih dir\\b\\electron-user-data' }
  ]);
});

test('listRunningDesktopInstances 在 posix 解析 ps 输出并排除 --type= 子进程', () => {
  const execFileSync = (file, args) => {
    assert.equal(file, 'ps');
    assert.deepEqual(args, ['-ax', '-o', 'pid=,command=']);
    return [
      '  9201 /opt/ZCode/zcode --user-data-dir=/home/x/.aih/a/electron-user-data',
      '  9202 /opt/ZCode/zcode --type=utility --user-data-dir=/home/x/.aih/a/electron-user-data',
      '  9203 /usr/bin/vim session.txt'
    ].join('\n');
  };
  const instances = listRunningDesktopInstances('linux', { execFileSync });
  assert.deepEqual(instances, [
    { pid: 9201, userDataDir: '/home/x/.aih/a/electron-user-data' }
  ]);
});

test('listRunningDesktopInstances 在扫描失败时返回空数组', () => {
  const execFileSync = () => {
    throw new Error('powershell unavailable');
  };
  assert.deepEqual(listRunningDesktopInstances('windows', { execFileSync }), []);
  assert.deepEqual(listRunningDesktopInstances('linux', {}), []);
});
