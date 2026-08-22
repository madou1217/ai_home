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
  listRunningCliInstances,
  normalizePlatform
} = require('../lib/server/account-app-launcher');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { readDesktopSession, writeDesktopSession } = require('../lib/server/kimi-desktop-session');
const { ZCODE_CREDENTIAL_SECRET_ENV } = require('../lib/account/zcode-credential');
const {
  buildZcodeDesktopApplicationName
} = require('../lib/runtime/account-app-process-marker');

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
    readAccountNativeAuth: overrides.readAccountNativeAuth,
    readAgyKeychainCredentials: overrides.readAgyKeychainCredentials,
    writeAgyKeychainCredentials: overrides.writeAgyKeychainCredentials,
    resolveAccountEligibility: overrides.resolveAccountEligibility,
    enforceCliInstallation: overrides.enforceCliInstallation,
    resolveCliPath: overrides.resolveCliPath,
    readAccountCredentialRecord: overrides.readAccountCredentialRecord,
    seedKimiDesktopTokenStore: overrides.seedKimiDesktopTokenStore,
    adoptKimiDesktopTokensFromProfile: overrides.adoptKimiDesktopTokensFromProfile,
    hasKimiDesktopTokenStore: overrides.hasKimiDesktopTokenStore,
    resolveZcodeCredentialSecret: overrides.resolveZcodeCredentialSecret
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

  // ZCode settingService 写死按 HOME || USERPROFILE 定位 setting.json
  // （无视 ZCODE_DATA_BASE_DIR/ZCODE_HOME，HOME 优先），HOME 必须指向沙箱，
  // 否则多账号实例共享真实家目录的 setting.json 互踩套餐选择状态（假登陆）。
  assert.equal(call.options.env.HOME, SANDBOX_DIR);
  // USERPROFILE 保持真实家目录：实测把它指向沙箱会让 ZCode 主进程在
  // deep-link 注册前静默卡死。
  assert.equal(call.options.env.USERPROFILE, 'C:\\Users\\x');

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

test('agy macOS desktop 使用账号投影文件且不把 token 放进进程 env', () => {
  const bundlePath = '/Applications/Antigravity.app';
  const executablePath = `${bundlePath}/Contents/MacOS/Antigravity`;
  const profileDir = `/aih-home/run/auth-projections/agy/${ACCOUNT_REF}`;
  const { launcher, fakeSpawn } = createLauncher({
    path: nodePath.posix,
    processObj: { platform: 'darwin', execPath: '/usr/local/bin/node', env: {} },
    fs: createFakeFs([bundlePath, executablePath]),
    env: { HOME: '/Users/x', PATH: '' },
    execFileSync: (file) => {
      if (file === 'ps') return '';
      throw new Error(`unexpected exec: ${file}`);
    },
    resolveAccount: () => ({ accountRef: ACCOUNT_REF, provider: 'agy', cliAccountId: '7' }),
    getProfileDir: () => profileDir,
    readAccountNativeAuth: () => ({
      email: 'agy@example.test',
      oauthToken: {
        auth_method: 'consumer',
        token: {
          access_token: 'agy-access-test',
          refresh_token: 'agy-refresh-test',
          expiry: '2030-01-01T00:00:00Z'
        }
      }
    }),
    writeAgyKeychainCredentials: () => assert.fail('Desktop must not write the shared AGY Keychain')
  });

  const result = launcher.launchAccountApp({ provider: 'agy', accountRef: ACCOUNT_REF, kind: 'desktop' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'launched');
  assert.equal(result.executable, executablePath);
  assert.equal(fakeSpawn.calls.length, 1);
  assert.equal(fakeSpawn.calls[0].options.env.AGY_ACCESS_TOKEN, undefined);
  assert.equal(fakeSpawn.calls[0].options.env.SSH_CONNECTION, '127.0.0.1 12345 127.0.0.1 22');
  assert.equal(fakeSpawn.calls[0].options.env.SSH_CLIENT, '127.0.0.1 12345 22');
  assert.equal(fakeSpawn.calls[0].options.env.SSH_TTY, '/dev/tty');
  assert.equal(fakeSpawn.calls[0].options.env.container, 'docker');
  assert.equal(fakeSpawn.calls[0].options.env.WSL_DISTRO_NAME, 'Ubuntu');
  assert.equal(fakeSpawn.calls[0].file, '/usr/bin/open');
  assert.deepEqual(fakeSpawn.calls[0].args, [
    '-n',
    '-a',
    bundlePath,
    '--args',
    `--user-data-dir=${profileDir}/electron-user-data`
  ]);
});

test('agy macOS desktop 不依赖共享 Keychain，仍可创建账号独立数据目录', () => {
  const bundlePath = '/Applications/Antigravity.app';
  const executablePath = `${bundlePath}/Contents/MacOS/Antigravity`;
  const fsImpl = createFakeFs([bundlePath, executablePath]);
  const { launcher, fakeSpawn } = createLauncher({
    path: nodePath.posix,
    processObj: { platform: 'darwin', execPath: '/usr/local/bin/node', env: {} },
    fs: fsImpl,
    env: { HOME: '/Users/x', PATH: '' },
    execFileSync: (file) => {
      if (file === 'ps') return '';
      throw new Error(`unexpected exec: ${file}`);
    },
    resolveAccount: () => ({ accountRef: ACCOUNT_REF, provider: 'agy', cliAccountId: '7' }),
    getProfileDir: () => '/aih-home/run/auth-projections/agy/' + ACCOUNT_REF,
    readAccountNativeAuth: () => ({
      oauthToken: {
        auth_method: 'consumer',
        token: {
          access_token: 'agy-access-test',
          refresh_token: 'agy-refresh-test'
        }
      }
    }),
    writeAgyKeychainCredentials: () => assert.fail('Desktop must not write the shared AGY Keychain')
  });

  const result = launcher.launchAccountApp({ provider: 'agy', accountRef: ACCOUNT_REF, kind: 'desktop' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'launched');
  assert.equal(fakeSpawn.calls.length, 1);
  assert.equal(fsImpl.mkdirCalls.length, 1);
});

test('agy macOS desktop 启动新账号时保留其他实例并通过 app bundle 启动', () => {
  const bundlePath = '/Applications/Antigravity.app';
  const executablePath = `${bundlePath}/Contents/MacOS/Antigravity`;
  const profileDir = `/aih-home/run/auth-projections/agy/${ACCOUNT_REF}`;
  const killCalls = [];
  const { launcher, fakeSpawn } = createLauncher({
    path: nodePath.posix,
    processObj: {
      platform: 'darwin',
      execPath: '/usr/local/bin/node',
      env: {},
      kill(pid, signal) {
        killCalls.push({ pid, signal });
      }
    },
    stopGraceMs: 0,
    fs: createFakeFs([bundlePath, executablePath]),
    env: { HOME: '/Users/x', PATH: '' },
    execFileSync: (file) => {
      if (file === 'ps') {
        return '  9100 Antigravity --user-data-dir=/other/agy/electron-user-data\n';
      }
      throw new Error(`unexpected exec: ${file}`);
    },
    resolveAccount: () => ({ accountRef: ACCOUNT_REF, provider: 'agy', cliAccountId: '7' }),
    getProfileDir: () => profileDir,
    readAccountNativeAuth: () => ({ oauthToken: { token: { refresh_token: 'agy-refresh-test' } } }),
    writeAgyKeychainCredentials: () => assert.fail('Desktop must not write the shared AGY Keychain')
  });

  const result = launcher.launchAccountApp({ provider: 'agy', accountRef: ACCOUNT_REF, kind: 'desktop' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'launched');
  assert.deepEqual(killCalls, []);
  assert.equal(fakeSpawn.calls[0].file, '/usr/bin/open');
  assert.deepEqual(fakeSpawn.calls[0].args, [
    '-n',
    '-a',
    bundlePath,
    '--args',
    `--user-data-dir=${profileDir}/electron-user-data`
  ]);
});

test('agy macOS desktop 同账号实例已运行时只复用该实例，不影响其他账号', () => {
  const bundlePath = '/Applications/Antigravity.app';
  const executablePath = `${bundlePath}/Contents/MacOS/Antigravity`;
  const profileDir = `/aih-home/run/auth-projections/agy/${ACCOUNT_REF}`;
  const killCalls = [];
  const { launcher, fakeSpawn } = createLauncher({
    path: nodePath.posix,
    processObj: {
      platform: 'darwin',
      execPath: '/usr/local/bin/node',
      env: {},
      kill(pid, signal) {
        killCalls.push({ pid, signal });
      }
    },
    stopGraceMs: 0,
    fs: createFakeFs([bundlePath, executablePath]),
    env: { HOME: '/Users/x', PATH: '' },
    execFileSync: (file) => {
      if (file === 'ps') {
        return `  9101 Antigravity --user-data-dir=${profileDir}/electron-user-data\n`;
      }
      throw new Error(`unexpected exec: ${file}`);
    },
    resolveAccount: () => ({ accountRef: ACCOUNT_REF, provider: 'agy', cliAccountId: '7' }),
    getProfileDir: () => profileDir,
    readAccountNativeAuth: () => ({
      oauthToken: {
        auth_method: 'consumer',
        token: {
          access_token: 'new-access-test',
          refresh_token: 'new-refresh-test',
          expiry: '2030-01-01T00:00:00Z'
        }
      }
    }),
    readAgyKeychainCredentials: () => ({
      auth_method: 'consumer',
      token: {
        access_token: 'old-access-test',
        refresh_token: 'old-refresh-test',
        expiry: '2029-01-01T00:00:00Z'
      }
    }),
    writeAgyKeychainCredentials: () => assert.fail('Desktop must not write the shared AGY Keychain')
  });

  const result = launcher.launchAccountApp({ provider: 'agy', accountRef: ACCOUNT_REF, kind: 'desktop' });

  assert.deepEqual(result, { ok: true, status: 'already_running', pids: [9101] });
  assert.deepEqual(killCalls, []);
  assert.equal(fakeSpawn.calls.length, 0);
});

test('agy macOS desktop 两个账号可分别启动且不互相关闭', () => {
  const bundlePath = '/Applications/Antigravity.app';
  const executablePath = `${bundlePath}/Contents/MacOS/Antigravity`;
  const otherRef = 'acct_aaaaaaaaaaaaaaaaaaaa';
  const firstProfile = `/aih-home/run/auth-projections/agy/${ACCOUNT_REF}`;
  const secondProfile = `/aih-home/run/auth-projections/agy/${otherRef}`;
  const first = createLauncher({
    path: nodePath.posix,
    processObj: { platform: 'darwin', execPath: '/usr/local/bin/node', env: {} },
    fs: createFakeFs([bundlePath, executablePath]),
    env: { HOME: '/Users/x', PATH: '' },
    execFileSync: (file) => file === 'ps' ? '' : assert.fail(`unexpected exec: ${file}`),
    resolveAccount: () => ({ accountRef: ACCOUNT_REF, provider: 'agy', cliAccountId: '7' }),
    getProfileDir: () => firstProfile,
    writeAgyKeychainCredentials: () => assert.fail('Desktop must not write the shared AGY Keychain')
  });
  const second = createLauncher({
    path: nodePath.posix,
    processObj: { platform: 'darwin', execPath: '/usr/local/bin/node', env: {} },
    fs: createFakeFs([bundlePath, executablePath]),
    env: { HOME: '/Users/x', PATH: '' },
    execFileSync: (file) => file === 'ps' ? '' : assert.fail(`unexpected exec: ${file}`),
    resolveAccount: () => ({ accountRef: otherRef, provider: 'agy', cliAccountId: '8' }),
    getProfileDir: () => secondProfile,
    writeAgyKeychainCredentials: () => assert.fail('Desktop must not write the shared AGY Keychain')
  });

  const firstResult = first.launcher.launchAccountApp({
    provider: 'agy', accountRef: ACCOUNT_REF, kind: 'desktop'
  });
  const secondResult = second.launcher.launchAccountApp({
    provider: 'agy', accountRef: otherRef, kind: 'desktop'
  });

  assert.equal(firstResult.status, 'launched');
  assert.equal(secondResult.status, 'launched');
  assert.equal(first.fakeSpawn.calls[0].options.env.HOME, firstProfile);
  assert.equal(second.fakeSpawn.calls[0].options.env.HOME, secondProfile);
  assert.notEqual(first.fakeSpawn.calls[0].args[4], second.fakeSpawn.calls[0].args[4]);
  assert.equal(first.fakeSpawn.calls[0].file, '/usr/bin/open');
  assert.equal(second.fakeSpawn.calls[0].file, '/usr/bin/open');
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
  assert.equal(
    fakeSpawn.calls[0].options.env.AIH_ZCODE_SESSION_ATTRIBUTION_SCOPE,
    ACCOUNT_REF
  );
  assert.equal(fakeSpawn.calls[0].options.env.ZCODE_AGENT_SERVER_COMMAND, process.execPath);
  const agentArgs = JSON.parse(fakeSpawn.calls[0].options.env.ZCODE_AGENT_SERVER_ARGS_JSON);
  assert.match(agentArgs[0], /zcode-session-attribution-runner\.js$/);
  assert.equal(
    agentArgs[1],
    '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'
  );
  assert.deepEqual(agentArgs.slice(2), ['app-server', '--stdio']);
});

test('zcode desktop 在 macOS 隔离 HOME 时固定宿主凭据密钥', () => {
  const bundlePath = '/Applications/ZCode.app';
  const expectedExe = '/Applications/ZCode.app/Contents/MacOS/ZCode';
  const profileDir = `/aih-home/run/auth-projections/zcode/${ACCOUNT_REF}`;
  const { launcher, fakeSpawn } = createLauncher({
    path: nodePath.posix,
    processObj: { platform: 'darwin', execPath: '/usr/local/bin/node', env: {} },
    fs: createFakeFs([bundlePath, expectedExe]),
    env: { HOME: '/Users/x', PATH: '' },
    getProfileDir: () => profileDir,
    resolveZcodeCredentialSecret: () => 'host-stable-zcode-secret'
  });

  const result = launcher.launchAccountApp({
    provider: 'zcode', accountRef: ACCOUNT_REF, kind: 'desktop'
  });

  assert.equal(result.ok, true);
  assert.equal(fakeSpawn.calls[0].options.env.HOME, profileDir);
  assert.equal(
    fakeSpawn.calls[0].options.env[ZCODE_CREDENTIAL_SECRET_ENV],
    'host-stable-zcode-secret'
  );
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

test('cli kind 在 Windows 通过 verbatim cmd start 打开新终端运行 aih 启动链路', () => {
  const { launcher, fakeSpawn } = createLauncher({
    resolveAccount: () => ({ accountRef: ACCOUNT_REF, provider: 'codex', cliAccountId: '3' })
  });
  const result = launcher.launchAccountApp({ provider: 'codex', accountRef: ACCOUNT_REF, kind: 'cli' });
  assert.equal(result.ok, true);
  assert.equal(result.pid, 4321);
  const call = fakeSpawn.calls[0];
  assert.equal(call.file, 'cmd.exe');
  assert.deepEqual(call.args.slice(0, 3), ['/d', '/s', '/c']);
  const startLine = call.args[3];
  assert.ok(startLine.includes('start "aih codex 3"'));
  assert.ok(startLine.includes('cmd.exe /d /s /k "set "AIH_ACCOUNT_APP=1"'));
  assert.ok(startLine.includes(nodePath.win32.join('C:\\repo', 'bin', 'ai-home.js')));
  assert.ok(startLine.includes('"C:\\node\\node.exe"'));
  assert.match(startLine, /AIH_ACCOUNT_APP=1/);
  assert.match(startLine, /AIH_PROVIDER_ACCOUNT_REF=/);
  // 回归守卫：libuv 的 \" 转义会让 cmd start 挂死，必须以 verbatim 关闭转义
  assert.equal(call.options.windowsVerbatimArguments, true);
  assert.ok(!startLine.includes('\\"'));
  assert.equal(call.options.env.AIH_ACCOUNT_APP, '1');
  assert.equal(call.options.env.AIH_PROVIDER_ACCOUNT_REF, ACCOUNT_REF);
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
    assert.match(fakeSpawn.calls[0].args[3], /aih codex 12/);
    assert.equal(fakeSpawn.calls[0].options.windowsVerbatimArguments, true);
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

test('action 校验：未知 action 返回 unsupported_action', () => {
  const { launcher } = createLauncher();
  assert.equal(
    launcher.launchAccountApp({ provider: 'zcode', accountRef: ACCOUNT_REF, kind: 'desktop', action: 'restart' }).error,
    'unsupported_action'
  );
});

test('cli close 结束该账号由 Toolkit 打开的全部 CLI 进程树', () => {
  const calls = [];
  const execFileSync = (file, args) => {
    calls.push({ file, args });
    if (file === 'powershell.exe') {
      return JSON.stringify([
        {
          ProcessId: 9501,
          ParentProcessId: 1,
          Name: 'cmd.exe',
          CommandLine: `cmd.exe /c set "AIH_ACCOUNT_APP=1" && set "AIH_PROVIDER_ACCOUNT_REF=${ACCOUNT_REF}" && "C:\\node.exe" "C:\\repo\\bin\\ai-home.js" codex 3`
        },
        {
          ProcessId: 9502,
          ParentProcessId: 9501,
          Name: 'node.exe',
          CommandLine: '"C:\\node.exe" "C:\\repo\\bin\\ai-home.js" codex 3'
        }
      ]);
    }
    if (file === 'taskkill') return '';
    throw new Error(`unexpected exec: ${file}`);
  };
  const { launcher } = createLauncher({
    execFileSync,
    resolveAccount: () => ({ accountRef: ACCOUNT_REF, provider: 'codex', cliAccountId: '3' })
  });
  const result = launcher.launchAccountApp({
    provider: 'codex',
    accountRef: ACCOUNT_REF,
    kind: 'cli',
    action: 'close'
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'closed');
  assert.deepEqual(result.pids, [9501]);
  assert.deepEqual(calls.filter((call) => call.file === 'taskkill'), [{
    file: 'taskkill',
    args: ['/PID', '9501', '/T', '/F']
  }]);
});

test('posix cli close 只结束目标账号的 Toolkit CLI 进程，不影响其他账号', () => {
  const signals = [];
  const otherAccountRef = 'acct_other000000000000000';
  const execFileSync = (file, args) => {
    assert.equal(file, 'ps');
    assert.deepEqual(args, ['-ax', '-o', 'pid=,ppid=,command=']);
    return [
      `9601 1 AIH_ACCOUNT_APP=1 AIH_PROVIDER_ACCOUNT_REF='${ACCOUNT_REF}' /bin/zsh -lc \"/repo/bin/ai-home.js codex 3\"`,
      '9602 9601 /usr/bin/node /repo/bin/ai-home.js codex 3',
      '9603 9602 /opt/homebrew/bin/tmux -L aih-codex-target',
      `9701 1 AIH_ACCOUNT_APP=1 AIH_PROVIDER_ACCOUNT_REF='${otherAccountRef}' /bin/zsh -lc \"/repo/bin/ai-home.js codex 4\"`,
      '9702 9701 /usr/bin/node /repo/bin/ai-home.js codex 4'
    ].join('\n');
  };
  const alive = new Set([9601, 9602, 9603, 9701, 9702]);
  const { launcher } = createLauncher({
    path: nodePath.posix,
    processObj: {
      platform: 'darwin',
      execPath: '/usr/bin/node',
      env: {},
      kill(pid, signal) {
        signals.push([pid, signal]);
        if (signal === 'SIGTERM' || signal === 'SIGKILL') alive.delete(pid);
        if (signal === 0 && !alive.has(pid)) {
          throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        }
      }
    },
    execFileSync,
    stopGraceMs: 0,
    resolveAccount: () => ({ accountRef: ACCOUNT_REF, provider: 'codex', cliAccountId: '3' })
  });
  const result = launcher.launchAccountApp({
    provider: 'codex',
    accountRef: ACCOUNT_REF,
    kind: 'cli',
    action: 'close'
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'closed');
  assert.deepEqual(result.pids, [9603, 9602, 9601]);
  assert.deepEqual(signals, [
    [9603, 'SIGTERM'], [9603, 0],
    [9602, 'SIGTERM'], [9602, 0],
    [9601, 'SIGTERM'], [9601, 0]
  ]);
  assert.equal(alive.has(9701), true);
  assert.equal(alive.has(9702), true);
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

test('app-entries 检测器支持安装完成后的显式失效', () => {
  const exe = 'C:\\Program Files\\ZCode\\ZCode.exe';
  const fsImpl = createFakeFs([exe]);
  const detector = createAppEntryDetector({
    fs: fsImpl,
    path: nodePath,
    processObj: { platform: 'win32', env: {} },
    env: { ProgramFiles: 'C:\\Program Files', PATH: '', USERPROFILE: 'C:\\Users\\x' },
    now: () => 1000
  });

  assert.equal(detector.detect().zcode.desktop, true);
  fsImpl.existsSync = createFakeFs([]).existsSync;
  assert.equal(detector.detect().zcode.desktop, true);
  detector.invalidate();
  assert.equal(detector.detect().zcode.desktop, false);
});

// 回归：后台 Server（launchd/systemd）继承的 PATH 缺少 ~/.local/bin 等
// profile 追加目录，只扫描该 PATH 会把官方安装器装好的 CLI 判成未安装，
// 与真正的启动链路（登录 shell 回落）结论相反。
test('app-entries 检测：CLI 只在登录 shell PATH 上时仍判定为已安装', () => {
  const claudeBin = '/home/alice/.local/bin/claude';
  const execCalls = [];
  const detector = createAppEntryDetector({
    fs: createFakeFs([claudeBin]),
    path: nodePath.posix,
    processObj: { platform: 'linux', env: {} },
    env: { PATH: '/usr/bin:/bin', HOME: '/home/alice' },
    execFileSync: (file, args) => {
      execCalls.push({ file, args });
      return '/home/alice/.local/bin:/usr/bin:/bin';
    },
    now: () => 1000
  });

  assert.equal(detector.detect().claude.cli, true);
  // 登录 shell 每个检测周期只拉起一次，不随 provider 数量放大。
  assert.equal(execCalls.length, 1);
  assert.deepEqual(execCalls[0].args, ['-lc', 'printf %s "$PATH"']);
});

test('app-entries 检测：登录 shell 不可用时降级为宿主 PATH', () => {
  const detector = createAppEntryDetector({
    fs: createFakeFs(['/usr/bin/claude']),
    path: nodePath.posix,
    processObj: { platform: 'linux', env: {} },
    env: { PATH: '/usr/bin', HOME: '/home/alice' },
    execFileSync: () => { throw new Error('sh missing'); },
    now: () => 1000
  });
  const entries = detector.detect();
  assert.equal(entries.claude.cli, true);
  assert.equal(entries.codex.cli, false);
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

test('listRunningDesktopInstances 在 macOS 识别改名后的 ZCode 主进程', () => {
  const applicationName = buildZcodeDesktopApplicationName(ACCOUNT_REF);
  const execFileSync = (file, args) => {
    assert.equal(file, 'ps');
    assert.deepEqual(args, ['-ax', '-o', 'pid=,command=']);
    return [
      `  9251 ${applicationName}`,
      `  9252 ${applicationName} --type=renderer`,
      '  9253 /usr/bin/vim session.txt'
    ].join('\n');
  };

  assert.deepEqual(listRunningDesktopInstances('macos', { execFileSync }), [
    { pid: 9251, applicationName }
  ]);
});

test('findRunningDesktopPids 在 macOS 通过 ZCode application name 定位实例', () => {
  const applicationName = buildZcodeDesktopApplicationName(ACCOUNT_REF);
  const execFileSync = () => `  9261 ${applicationName}\n`;
  const platformConfig = { execNames: ['ZCode'] };

  assert.deepEqual(findRunningDesktopPids(
    '/aih-home/run/auth-projections/zcode/acct_x/electron-user-data',
    platformConfig,
    'macos',
    { execFileSync, applicationName }
  ), [9261]);
});

test('listRunningCliInstances 在 POSIX 通过 marker 和父子进程识别账号 CLI', () => {
  const execFileSync = (file, args) => {
    assert.equal(file, 'ps');
    assert.deepEqual(args, ['-ax', '-o', 'pid=,ppid=,command=']);
    return [
      `  9301 1 aih codex 3 AIH_ACCOUNT_APP=1 AIH_PROVIDER_ACCOUNT_REF=${ACCOUNT_REF}`,
      '  9302 9301 /usr/local/bin/node /repo/bin/ai-home.js codex 3',
      '  9303 9302 codex exec --help',
      '  9304 1 /bin/zsh -c /usr/local/bin/node /repo/bin/ai-home.js claude 4'
    ].join('\n');
  };

  const instances = listRunningCliInstances('linux', { execFileSync });
  assert.deepEqual(instances, [
    { pid: 9301, ppid: 1, provider: 'codex', cliAccountId: '3', accountRef: ACCOUNT_REF, rootPid: 9301 },
    { pid: 9302, ppid: 9301, provider: 'codex', cliAccountId: '3', accountRef: ACCOUNT_REF, rootPid: 9301 },
    { pid: 9303, ppid: 9302, provider: 'codex', cliAccountId: '3', accountRef: ACCOUNT_REF, rootPid: 9301 }
  ]);
});

test('listRunningCliInstances 在 Windows 解析 set marker、ParentProcessId 和子进程', () => {
  const execFileSync = (file, args) => {
    assert.equal(file, 'powershell.exe');
    assert.deepEqual(args, [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'
    ]);
    return JSON.stringify([
      {
        ProcessId: 9401,
        ParentProcessId: 1,
        Name: 'cmd.exe',
        CommandLine: 'cmd.exe /c set "AIH_ACCOUNT_APP=1" && set "AIH_PROVIDER_ACCOUNT_REF=acct_win" && "C:\\node.exe" "C:\\repo\\bin\\ai-home.js" claude 8'
      },
      {
        ProcessId: 9402,
        ParentProcessId: 9401,
        Name: 'node.exe',
        CommandLine: '"C:\\node.exe" "C:\\repo\\bin\\ai-home.js" claude 8'
      },
      {
        ProcessId: 9403,
        ParentProcessId: 9402,
        Name: 'claude.exe',
        CommandLine: 'claude --print'
      },
      {
        ProcessId: 9404,
        ParentProcessId: 1,
        Name: 'node.exe',
        CommandLine: '"C:\\node.exe" "C:\\repo\\bin\\ai-home.js" codex 2'
      }
    ]);
  };

  const instances = listRunningCliInstances('windows', { execFileSync });
  assert.deepEqual(instances, [
    { pid: 9401, ppid: 1, provider: 'claude', cliAccountId: '8', accountRef: 'acct_win', rootPid: 9401 },
    { pid: 9402, ppid: 9401, provider: 'claude', cliAccountId: '8', accountRef: 'acct_win', rootPid: 9401 },
    { pid: 9403, ppid: 9402, provider: 'claude', cliAccountId: '8', accountRef: 'acct_win', rootPid: 9401 }
  ]);
});

test('listRunningCliInstances 在进程扫描失败时返回空数组', () => {
  assert.deepEqual(listRunningCliInstances('linux', {
    execFileSync() {
      throw new Error('ps unavailable');
    }
  }), []);
  assert.deepEqual(listRunningCliInstances('windows', {}), []);
});

test('listRunningDesktopInstances 在扫描失败时返回空数组', () => {
  const execFileSync = () => {
    throw new Error('powershell unavailable');
  };
  assert.deepEqual(listRunningDesktopInstances('windows', { execFileSync }), []);
  assert.deepEqual(listRunningDesktopInstances('linux', {}), []);
});


// kimi 桌面托管登录的启动接线测试使用真实临时目录：kimi 的 launch-profile
// prepare 链路（凭证协调 + config 投影）需要真实 fs 与 SQLite。
function createKimiDesktopLauncherFixture(t, overrides = {}) {
  const rootDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'aih-kimi-launcher-'));
  t.after(() => nodeFs.rmSync(rootDir, { recursive: true, force: true }));
  const aiHomeDir = nodePath.join(rootDir, 'aih');
  const hostHomeDir = nodePath.join(rootDir, 'host');
  const profileDir = nodePath.join(rootDir, 'profile');
  const toolsDir = nodePath.join(rootDir, 'tools');
  nodeFs.mkdirSync(toolsDir, { recursive: true });
  nodeFs.mkdirSync(hostHomeDir, { recursive: true });
  const kimiExe = nodePath.join(toolsDir, 'Kimi.exe');
  nodeFs.writeFileSync(kimiExe, '');
  const accountRef = upsertAccountRef(nodeFs, aiHomeDir, {
    provider: 'kimi',
    cliAccountId: '2',
    identitySeed: 'oauth:kimi:launcher-test@example.com'
  });
  const fakeSpawn = createFakeSpawn();
  const launcher = createAccountAppLauncher({
    fs: nodeFs,
    path: nodePath,
    spawn: fakeSpawn.spawnImpl,
    processObj: { platform: 'win32', execPath: 'C:\\node\\node.exe', env: {} },
    env: { PATH: toolsDir, USERPROFILE: hostHomeDir },
    aiHomeDir,
    hostHomeDir,
    repoRoot: rootDir,
    execFileSync: () => { throw new Error('exec disabled in tests'); },
    resolveAccount: () => ({ accountRef, provider: 'kimi', cliAccountId: '2' }),
    getProfileDir: () => profileDir,
    readAccountEnv: () => ({}),
    adoptKimiDesktopTokensFromProfile: () => null,
    seedKimiDesktopTokenStore: () => ({ seeded: true }),
    ...overrides
  });
  return { launcher, fakeSpawn, accountRef, profileDir, aiHomeDir, hostHomeDir, kimiExe };
}

test('kimi desktop 存在托管 desktopSession 时启动前把 session 种进隔离 profile', (t) => {
  const seeds = [];
  const { launcher, fakeSpawn, accountRef, profileDir, aiHomeDir, kimiExe } = createKimiDesktopLauncherFixture(t, {
    adoptKimiDesktopTokensFromProfile: () => null,
    seedKimiDesktopTokenStore: (payload) => {
      seeds.push(payload);
      return { seeded: true };
    }
  });
  writeDesktopSession(nodeFs, aiHomeDir, accountRef, {
    accessToken: 'web-access',
    refreshToken: 'web-refresh',
    userId: 'u-1'
  });

  const result = launcher.launchAccountApp({ provider: 'kimi', accountRef, kind: 'desktop' });
  assert.equal(result.ok, true);
  assert.equal(fakeSpawn.calls.length, 1);
  assert.equal(fakeSpawn.calls[0].file, kimiExe);
  // 不再使用 CDP 调试端口（App 明确拒绝调试开关）
  assert.equal(fakeSpawn.calls[0].args.includes('--remote-debugging-port=0'), false);

  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].userDataDir, nodePath.join(profileDir, 'electron-user-data'));
  assert.equal(seeds[0].accessToken, 'web-access');
  assert.equal(seeds[0].refreshToken, 'web-refresh');
  assert.equal(seeds[0].userId, 'u-1');
});

test('kimi desktop 无托管 desktopSession 且 profile 未登录时要求先扫码', (t) => {
  const seeds = [];
  const { launcher, fakeSpawn, accountRef } = createKimiDesktopLauncherFixture(t, {
    adoptKimiDesktopTokensFromProfile: () => null,
    hasKimiDesktopTokenStore: () => false,
    seedKimiDesktopTokenStore: (payload) => {
      seeds.push(payload);
      return { seeded: true };
    }
  });

  const result = launcher.launchAccountApp({ provider: 'kimi', accountRef, kind: 'desktop' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'kimi_desktop_session_required');
  assert.equal(fakeSpawn.calls.length, 0);
  assert.equal(seeds.length, 0);
});

test('kimi desktop 旧实例已运行但未登录时仍进入扫码流程', (t) => {
  let userDataDir = '';
  const { launcher, fakeSpawn, accountRef, profileDir } = createKimiDesktopLauncherFixture(t, {
    adoptKimiDesktopTokensFromProfile: () => null,
    hasKimiDesktopTokenStore: () => false,
    execFileSync(file) {
      assert.equal(file, 'powershell.exe');
      return JSON.stringify({
        ProcessId: 9801,
        Name: 'Kimi.exe',
        CommandLine: `Kimi.exe --user-data-dir=${userDataDir}`
      });
    }
  });
  userDataDir = nodePath.join(profileDir, 'electron-user-data');

  const result = launcher.launchAccountApp({ provider: 'kimi', accountRef, kind: 'desktop' });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'kimi_desktop_session_required');
  assert.deepEqual(result.pids, [9801]);
  assert.equal(fakeSpawn.calls.length, 0);
});

test('kimi desktop 扫码成功后只重启该账号未登录的旧实例', (t) => {
  const execCalls = [];
  let userDataDir = '';
  const { launcher, fakeSpawn, accountRef, profileDir, aiHomeDir } = createKimiDesktopLauncherFixture(t, {
    adoptKimiDesktopTokensFromProfile: () => null,
    hasKimiDesktopTokenStore: () => false,
    seedKimiDesktopTokenStore: () => ({ seeded: true }),
    execFileSync(file, args) {
      execCalls.push({ file, args });
      if (file === 'powershell.exe') {
        return JSON.stringify({
          ProcessId: 9802,
          Name: 'Kimi.exe',
          CommandLine: `Kimi.exe --user-data-dir=${userDataDir}`
        });
      }
      if (file === 'taskkill') return '';
      throw new Error(`unexpected exec: ${file}`);
    }
  });
  userDataDir = nodePath.join(profileDir, 'electron-user-data');
  writeDesktopSession(nodeFs, aiHomeDir, accountRef, {
    accessToken: 'web-access',
    refreshToken: 'web-refresh',
    userId: 'u-1'
  });

  const result = launcher.launchAccountApp({ provider: 'kimi', accountRef, kind: 'desktop' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'launched');
  assert.deepEqual(execCalls.filter((call) => call.file === 'taskkill'), [{
    file: 'taskkill',
    args: ['/PID', '9802', '/T', '/F']
  }]);
  assert.equal(fakeSpawn.calls.length, 1);
});

test('kimi desktop 启动时把历史共享 user-data 链接迁回账号私有目录', (t) => {
  const { launcher, accountRef, profileDir, aiHomeDir, kimiExe } = createKimiDesktopLauncherFixture(t);
  const sharedUserDataDir = nodePath.join(
    nodePath.dirname(nodePath.dirname(profileDir)),
    'shared-kimi-user-data'
  );
  const accountUserDataDir = nodePath.join(profileDir, 'electron-user-data');
  nodeFs.mkdirSync(sharedUserDataDir, { recursive: true });
  nodeFs.mkdirSync(profileDir, { recursive: true });
  nodeFs.writeFileSync(nodePath.join(sharedUserDataDir, 'must-survive.txt'), 'shared-state\n', 'utf8');
  nodeFs.symlinkSync(sharedUserDataDir, accountUserDataDir, 'dir');
  writeDesktopSession(nodeFs, aiHomeDir, accountRef, {
    accessToken: 'web-access',
    refreshToken: 'web-refresh',
    userId: 'u-1'
  });

  const result = launcher.launchAccountApp({ provider: 'kimi', accountRef, kind: 'desktop' });

  assert.equal(result.ok, true);
  assert.equal(result.executable, kimiExe);
  assert.equal(nodeFs.lstatSync(accountUserDataDir).isSymbolicLink(), false);
  assert.equal(nodeFs.lstatSync(accountUserDataDir).isDirectory(), true);
  assert.equal(nodeFs.existsSync(nodePath.join(accountUserDataDir, 'must-survive.txt')), false);
  assert.equal(
    nodeFs.readFileSync(nodePath.join(sharedUserDataDir, 'must-survive.txt'), 'utf8'),
    'shared-state\n'
  );
});

test('kimi desktop 在 profile 已有轮换后的 token 时先采纳回托管存储再 seed', (t) => {
  const seeds = [];
  const { launcher, accountRef, aiHomeDir } = createKimiDesktopLauncherFixture(t, {
    adoptKimiDesktopTokensFromProfile: () => ({
      accessToken: 'rotated-access',
      refreshToken: 'rotated-refresh',
      userId: 'u-1'
    }),
    seedKimiDesktopTokenStore: (payload) => {
      seeds.push(payload);
      return { seeded: true };
    }
  });
  writeDesktopSession(nodeFs, aiHomeDir, accountRef, {
    accessToken: 'web-access',
    refreshToken: 'web-refresh',
    userId: 'u-1'
  });

  const result = launcher.launchAccountApp({ provider: 'kimi', accountRef, kind: 'desktop' });
  assert.equal(result.ok, true);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].accessToken, 'rotated-access');
  assert.equal(seeds[0].refreshToken, 'rotated-refresh');

  // 托管存储被更新为轮换后的 token，下次启动沿用
  const { readAccountCredentialRecord } = require('../lib/server/account-credential-store');
  const session = readDesktopSession(readAccountCredentialRecord(nodeFs, aiHomeDir, accountRef));
  assert.equal(session.refreshToken, 'rotated-refresh');
});

test('macOS kimi desktop 已有密文 store 时沿用 profile，不用旧托管 token 覆盖', (t) => {
  const seeds = [];
  const fixture = createKimiDesktopLauncherFixture(t, {
    processObj: { platform: 'darwin', execPath: '/usr/bin/node', env: {} },
    env: { HOME: '' },
    adoptKimiDesktopTokensFromProfile: () => null,
    hasKimiDesktopTokenStore: () => true,
    seedKimiDesktopTokenStore: (payload) => {
      seeds.push(payload);
      return { seeded: true };
    }
  });
  const bundlePath = nodePath.join(fixture.hostHomeDir, 'Applications', 'Kimi.app');
  nodeFs.mkdirSync(nodePath.join(bundlePath, 'Contents', 'MacOS'), { recursive: true });
  writeDesktopSession(nodeFs, fixture.aiHomeDir, fixture.accountRef, {
    accessToken: 'stale-access',
    refreshToken: 'stale-refresh',
    userId: 'u-1'
  });

  const result = fixture.launcher.launchAccountApp({
    provider: 'kimi',
    accountRef: fixture.accountRef,
    kind: 'desktop'
  });

  assert.equal(result.ok, true);
  assert.equal(seeds.length, 0);
  assert.equal(fixture.fakeSpawn.calls.length, 1);
  assert.equal(
    fixture.fakeSpawn.calls[0].file,
    nodePath.join(bundlePath, 'Contents', 'MacOS', 'Kimi')
  );
});

test('kimi desktop seed 抛异常且 profile 无既有登录态时阻止打开登录页', (t) => {
  const { launcher, fakeSpawn, accountRef, aiHomeDir } = createKimiDesktopLauncherFixture(t, {
    adoptKimiDesktopTokensFromProfile: () => {
      throw new Error('boom');
    },
    seedKimiDesktopTokenStore: () => {
      throw new Error('boom');
    }
  });
  writeDesktopSession(nodeFs, aiHomeDir, accountRef, {
    accessToken: 'web-access',
    refreshToken: 'web-refresh',
    userId: 'u-1'
  });
  const result = launcher.launchAccountApp({ provider: 'kimi', accountRef, kind: 'desktop' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'kimi_desktop_session_seed_failed');
  assert.equal(fakeSpawn.calls.length, 0);
});
