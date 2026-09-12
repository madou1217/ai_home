'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  appServerEnvSignature,
  appServerSocketName,
  appServerStatePath,
  ensureCodexAppServerEndpoint,
  invalidateCodexAppServerEndpoint,
  readAppServerState,
  writeAppServerState,
  waitForAppServerReady
} = require('../lib/server/codex-app-server-endpoint');
const { writeServerConfig } = require('../lib/server/server-config-store');

test('app-server auth invalidation stops only the matching account runtime', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-app-invalidate-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const targetRef = 'acct_11111111111111111111';
  const otherRef = 'acct_22222222222222222222';
  writeAppServerState(aiHomeDir, targetRef, {
    accountRef: targetRef,
    runtimeScope: targetRef,
    multiplexer: 'tmux',
    port: 43121,
    socket: appServerSocketName(targetRef)
  });
  writeAppServerState(aiHomeDir, otherRef, {
    accountRef: otherRef,
    runtimeScope: otherRef,
    multiplexer: 'tmux',
    port: 43122,
    socket: appServerSocketName(otherRef)
  });
  const calls = [];

  const result = invalidateCodexAppServerEndpoint({
    aiHomeDir,
    accountRef: targetRef,
    spawnSyncImpl(command, args) {
      calls.push({ command, args });
      if (args[0] === '-V') return { status: 0 };
      if (args.includes('has-session')) return { status: 1 };
      return { status: 0 };
    }
  });

  assert.deepEqual(result, {
    ok: true,
    invalidated: true,
    accountRef: targetRef,
    runtimeScope: targetRef
  });
  assert.ok(calls.some(({ args }) => (
    args.includes('-L')
    && args.includes(appServerSocketName(targetRef))
    && args.includes('kill-server')
  )));
  assert.ok(calls.some(({ args }) => (
    args.includes('-L')
    && args.includes(appServerSocketName(targetRef))
    && args.includes('has-session')
  )));
  assert.equal(calls.some(({ args }) => args.includes(appServerSocketName(otherRef))), false);
  assert.equal(fs.existsSync(appServerStatePath(aiHomeDir, targetRef)), false);
  assert.equal(fs.existsSync(appServerStatePath(aiHomeDir, otherRef)), true);
});

test('app-server readiness returns as soon as readyz succeeds', async () => {
  let livenessChecks = 0;

  await waitForAppServerReady(9527, 'aih-codexapp-test', {
    checkReadyz: async () => true,
    hasRunSession: () => {
      livenessChecks += 1;
      return true;
    }
  });

  assert.equal(livenessChecks, 0);
});

test('app-server readiness fails immediately when the tmux process exits', async () => {
  let delayCalls = 0;
  const multiplexerBinding = { name: 'herdr' };

  await assert.rejects(
    waitForAppServerReady(9527, 'aih-codexapp-test', {
      checkReadyz: async () => false,
      hasRunSession: (_socket, options) => {
        assert.strictEqual(options.multiplexerBinding, multiplexerBinding);
        return false;
      },
      multiplexerBinding,
      delay: async () => {
        delayCalls += 1;
      },
      logPath: '/tmp/codex-app-server.log'
    }),
    (error) => error.code === 'codex_app_server_process_exited'
      && error.message.includes('/tmp/codex-app-server.log')
  );
  assert.equal(delayCalls, 0);
});

test('app-server state: persists Herdr, defaults legacy state to tmux, rejects unknown backend', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-app-state-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const written = writeAppServerState(aiHomeDir, 'gateway', {
    gateway: true,
    runtimeScope: 'gateway',
    multiplexer: 'herdr',
    port: 43123,
    socket: 'aih-codexapp-gateway'
  });
  assert.equal(written.multiplexer, 'herdr');
  assert.equal(readAppServerState(aiHomeDir, 'gateway').multiplexer, 'herdr');

  fs.writeFileSync(appServerStatePath(aiHomeDir, 'gateway'), JSON.stringify({
    gateway: true,
    runtimeScope: 'gateway',
    port: 43123,
    socket: 'aih-codexapp-gateway'
  }));
  assert.equal(readAppServerState(aiHomeDir, 'gateway').multiplexer, 'tmux');

  fs.writeFileSync(appServerStatePath(aiHomeDir, 'gateway'), JSON.stringify({
    gateway: true,
    runtimeScope: 'gateway',
    multiplexer: 'unknown',
    port: 43123,
    socket: 'aih-codexapp-gateway'
  }));
  assert.equal(readAppServerState(aiHomeDir, 'gateway').multiplexer, '');
});

test('app-server lifecycle: cleans legacy tmux, binds new Herdr, and persists backend before readiness', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-app-binding-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const socket = appServerSocketName('gateway');
  writeAppServerState(aiHomeDir, 'gateway', {
    gateway: true,
    runtimeScope: 'gateway',
    multiplexer: 'tmux',
    port: 43000,
    socket,
    startedAt: 1
  });

  const calls = [];
  const spawnSyncImpl = (command, args, spawnOptions) => {
    calls.push([command, args]);
    if (command === 'tmux' && args[0] === '-V') return { status: 0 };
    if (command === 'tmux' && args.includes('kill-server')) return { status: 0 };
    if (command === 'herdr' && args[0] === '--version') return { status: 0 };
    if (command === 'herdr' && args[0] === 'spawn') {
      assert.equal(spawnOptions.env.HOME, aiHomeDir, 'await asynchronous account environment before spawn');
      return { status: 0 };
    }
    return { status: 1 };
  };
  let readyChecks = 0;
  const result = await ensureCodexAppServerEndpoint({
    gateway: true,
    aiHomeDir,
    env: {},
    getProfileDir: () => aiHomeDir,
    runtimeExecutablePath: '/usr/bin/codex',
    buildProviderEnvImpl: async () => ({ HOME: aiHomeDir }),
    pickFreePortImpl: async () => 43123,
    checkReadyzImpl: async () => {
      readyChecks += 1;
      // 状态驱动就绪（不再按调用次数）：复用探测与 spawn 后首轮 readyz 都会进来，
      // 只有 herdr 后端身份随新端口落盘后才就绪——这正是本用例要守的语义。
      const state = readAppServerState(aiHomeDir, 'gateway');
      if (!state || Number(state.port) !== 43123) return false;
      assert.equal(state.multiplexer, 'herdr', 'backend persisted before readiness');
      return true;
    },
    spawnSyncImpl
  });

  assert.deepEqual(result, { port: 43123, reused: false });
  const tmuxKillIndex = calls.findIndex(([command, args]) => command === 'tmux' && args.includes('kill-server'));
  const herdrSpawnIndex = calls.findIndex(([command, args]) => command === 'herdr' && args[0] === 'spawn');
  assert.ok(tmuxKillIndex >= 0);
  assert.ok(herdrSpawnIndex > tmuxKillIndex);
  assert.equal(readAppServerState(aiHomeDir, 'gateway').multiplexer, 'herdr');
});

test('app-server lifecycle: unknown persisted backend fails closed', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-app-invalid-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(appServerStatePath(aiHomeDir, 'gateway')), { recursive: true });
  fs.writeFileSync(appServerStatePath(aiHomeDir, 'gateway'), JSON.stringify({
    gateway: true,
    runtimeScope: 'gateway',
    multiplexer: 'unknown',
    socket: appServerSocketName('gateway')
  }));

  await assert.rejects(
    ensureCodexAppServerEndpoint({
      gateway: true,
      aiHomeDir,
      getProfileDir: () => aiHomeDir,
      checkReadyzImpl: async () => false,
      spawnSyncImpl: () => {
        throw new Error('invalid state must fail before probing any backend');
      }
    }),
    (error) => error.code === 'codex_app_server_state_invalid'
  );
  assert.ok(fs.existsSync(appServerStatePath(aiHomeDir, 'gateway')));
});

test('app-server lifecycle: healthy endpoint cannot bypass unknown persisted backend', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-app-invalid-healthy-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(appServerStatePath(aiHomeDir, 'gateway')), { recursive: true });
  fs.writeFileSync(appServerStatePath(aiHomeDir, 'gateway'), JSON.stringify({
    gateway: true,
    runtimeScope: 'gateway',
    multiplexer: 'unknown',
    port: 43123,
    socket: appServerSocketName('gateway')
  }));

  await assert.rejects(
    ensureCodexAppServerEndpoint({
      gateway: true,
      aiHomeDir,
      getProfileDir: () => aiHomeDir,
      checkReadyzImpl: async () => true,
      spawnSyncImpl: () => {
        throw new Error('invalid state must fail before probing any backend');
      }
    }),
    (error) => error.code === 'codex_app_server_state_invalid'
  );
  assert.ok(fs.existsSync(appServerStatePath(aiHomeDir, 'gateway')));
});

test('app-server readiness preserves the bounded timeout for a live process', async () => {
  let timestamp = 0;

  await assert.rejects(
    waitForAppServerReady(9527, 'aih-codexapp-test', {
      timeoutMs: 2,
      pollIntervalMs: 0,
      now: () => timestamp++,
      checkReadyz: async () => false,
      hasRunSession: () => true,
      delay: async () => {}
    }),
    (error) => error.code === 'codex_app_server_not_ready'
      && error.message.includes('2ms')
  );
});

test('app-server lifecycle on win32: writes launcher .cmd and spawns cmd.exe pane without sh', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-app-win32-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const calls = [];
  const spawnSyncImpl = (command, args) => {
    calls.push([command, args]);
    if (command === 'psmux' && args[0] === '-V') return { status: 0 };
    if (command === 'psmux' && args.includes('new-session')) return { status: 0 };
    if (command === 'psmux' && args.includes('has-session')) return { status: 0 };
    return { status: 1 };
  };

  const result = await ensureCodexAppServerEndpoint({
    gateway: true,
    aiHomeDir,
    env: {},
    platform: 'win32',
    getProfileDir: () => aiHomeDir,
    runtimeExecutablePath: 'C:\\Users\\u\\codex.exe',
    buildProviderEnvImpl: async () => ({ HOME: aiHomeDir }),
    pickFreePortImpl: async () => 43124,
    checkReadyzImpl: async () => true,
    spawnSyncImpl
  });

  assert.deepEqual(result, { port: 43124, reused: false });
  const spawnCall = calls.find(([command, args]) => command === 'psmux' && args.includes('new-session'));
  assert.ok(spawnCall, 'psmux new-session spawn expected');
  const paneArgv = spawnCall[1].slice(spawnCall[1].indexOf('--') + 1);
  assert.deepEqual(paneArgv.slice(0, 3), ['cmd.exe', '/d', '/c']);
  assert.equal(paneArgv.includes('sh'), false);

  const launcherPath = paneArgv[3];
  assert.ok(launcherPath.endsWith('.run.cmd'));
  assert.equal(launcherPath.includes(' '), false);
  const content = fs.readFileSync(launcherPath, 'utf8');
  assert.match(content, /^@echo off\r\n/);
  assert.match(content, /codex\.exe/);
  assert.match(content, /"app-server"/);
  assert.match(content, /"--listen" "ws:\/\/127\.0\.0\.1:43124"/);
  assert.match(content, />> ".*\.log" 2>&1\r\n$/);
  assert.equal(content.includes('exec '), false);
});

test('app-server launch env always carries the gateway client key even when the account has none', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-app-env-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  writeServerConfig({ apiKey: 'client-key-1234' }, { fs, aiHomeDir });

  let spawnEnv = null;
  let spawnArgs = null;
  const spawnSyncImpl = (command, args, spawnOptions) => {
    if (args[0] === '-V') return { status: 0 };
    if (args.includes('new-session')) {
      spawnEnv = (spawnOptions && spawnOptions.env) || null;
      spawnArgs = args;
      return { status: 0 };
    }
    if (args.includes('has-session') || args.includes('kill-server')) return { status: 0 };
    return { status: 1 };
  };

  const result = await ensureCodexAppServerEndpoint({
    gateway: true,
    aiHomeDir,
    env: {},
    getProfileDir: () => aiHomeDir,
    runtimeExecutablePath: '/usr/bin/codex',
    // 账号凭证不含 OPENAI_API_KEY（qodercn 等 OAuth 形态）：旧逻辑 relay 不生效，
    // pane 拿不到 key，网关 401。修复后必须无条件回落到网关 client key。
    buildProviderEnvImpl: async () => ({ HOME: aiHomeDir }),
    pickFreePortImpl: async () => 43125,
    checkReadyzImpl: async () => true,
    spawnSyncImpl
  });

  assert.deepEqual(result, { port: 43125, reused: false });
  assert.ok(spawnEnv, 'pane spawn env expected');
  assert.equal(spawnEnv.OPENAI_API_KEY, 'client-key-1234');
  assert.ok(String(spawnEnv.OPENAI_BASE_URL || '').includes('127.0.0.1'));
  // POSIX 靠 fresh server 进程 env 继承投递，不走 -e（老 tmux <3.2 不认识 -e）。
  assert.equal(spawnArgs.includes('-e'), false);
});

// Windows 实机事故（2026-09-12）：psmux broker server 复用启动时的环境，spawn env 被
// 静默忽略，用户全局 OPENAI_API_KEY 顶掉网关 client key → /v1/responses 401。
// win32 必须用 new-session -e 显式投递鉴权/身份变量，且签名带投递世代强制旧 pane 重建。
test('app-server on win32 delivers gateway auth via new-session -e and versions the env signature', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-app-paneenv-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  writeServerConfig({ apiKey: 'client-key-1234' }, { fs, aiHomeDir });

  let spawnArgs = null;
  const spawnSyncImpl = (command, args) => {
    if (args[0] === '-V') return { status: 0 };
    if (args.includes('new-session')) {
      spawnArgs = args;
      return { status: 0 };
    }
    if (args.includes('has-session') || args.includes('kill-server')) return { status: 0 };
    return { status: 1 };
  };

  const result = await ensureCodexAppServerEndpoint({
    gateway: true,
    aiHomeDir,
    env: {},
    platform: 'win32',
    getProfileDir: () => aiHomeDir,
    runtimeExecutablePath: 'C:\\Users\\u\\codex.exe',
    buildProviderEnvImpl: async () => ({ HOME: aiHomeDir, CODEX_HOME: 'C:\\harness\\.codex' }),
    pickFreePortImpl: async () => 43129,
    checkReadyzImpl: async () => true,
    spawnSyncImpl
  });

  assert.deepEqual(result, { port: 43129, reused: false });
  assert.ok(spawnArgs, 'psmux new-session spawn expected');
  const paneEnv = new Map();
  for (let i = 0; i < spawnArgs.length - 1; i += 1) {
    if (spawnArgs[i] === '-e') {
      const [key, ...rest] = String(spawnArgs[i + 1]).split('=');
      paneEnv.set(key, rest.join('='));
    }
  }
  assert.equal(paneEnv.get('OPENAI_API_KEY'), 'client-key-1234');
  assert.ok(String(paneEnv.get('OPENAI_BASE_URL') || '').includes('127.0.0.1'));
  assert.equal(paneEnv.get('CODEX_HOME'), 'C:\\harness\\.codex');
  assert.equal(paneEnv.get('HOME'), aiHomeDir);
  // gateway 目标不带 passthrough 标记。
  assert.equal(paneEnv.has('AIH_CODEX_APP_SERVER_PASSTHROUGH'), false);
  assert.ok(String(readAppServerState(aiHomeDir, 'gateway').envSignature).endsWith('-paneenv1'));

  // 签名（含世代后缀）匹配 + readyz 正常 → 复用，不重开 pane。
  spawnArgs = null;
  const reused = await ensureCodexAppServerEndpoint({
    gateway: true,
    aiHomeDir,
    env: {},
    platform: 'win32',
    getProfileDir: () => aiHomeDir,
    runtimeExecutablePath: 'C:\\Users\\u\\codex.exe',
    buildProviderEnvImpl: async () => ({ HOME: aiHomeDir }),
    pickFreePortImpl: async () => 43129,
    checkReadyzImpl: async () => true,
    spawnSyncImpl
  });
  assert.deepEqual(reused, { port: 43129, reused: true });
  assert.equal(spawnArgs, null, 'matching generation signature must reuse the resident pane');

  // 旧世代（无 -e 投递）的 state：签名无后缀 → 强制重建。
  const state = readAppServerState(aiHomeDir, 'gateway');
  writeAppServerState(aiHomeDir, 'gateway', { ...state, envSignature: state.envSignature.replace(/-paneenv1$/, '') });
  spawnArgs = null;
  const rebuilt = await ensureCodexAppServerEndpoint({
    gateway: true,
    aiHomeDir,
    env: {},
    platform: 'win32',
    getProfileDir: () => aiHomeDir,
    runtimeExecutablePath: 'C:\\Users\\u\\codex.exe',
    buildProviderEnvImpl: async () => ({ HOME: aiHomeDir }),
    pickFreePortImpl: async () => 43130,
    checkReadyzImpl: async () => true,
    spawnSyncImpl
  });
  assert.deepEqual(rebuilt, { port: 43130, reused: false });
  assert.ok(spawnArgs, 'legacy pane without -e delivery must be rebuilt');
});

test('app-server reuse requires a matching env signature, stale-key panes are rebuilt', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-app-envsig-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  writeServerConfig({ apiKey: 'client-key-1234' }, { fs, aiHomeDir });

  const { readCodexGatewayConnection } = require('../lib/server/codex-gateway-connection');
  const envSignature = appServerEnvSignature(readCodexGatewayConnection(fs, aiHomeDir, '').env);

  const calls = [];
  const spawnSyncImpl = (command, args) => {
    calls.push([command, args]);
    if (args[0] === '-V') return { status: 0 };
    if (args.includes('new-session') || args.includes('kill-server')) return { status: 0 };
    if (args.includes('has-session')) return { status: 1 };
    return { status: 1 };
  };
  const baseOptions = {
    gateway: true,
    aiHomeDir,
    env: {},
    getProfileDir: () => aiHomeDir,
    runtimeExecutablePath: '/usr/bin/codex',
    buildProviderEnvImpl: async () => ({}),
    pickFreePortImpl: async () => 43127,
    checkReadyzImpl: async () => true,
    spawnSyncImpl
  };

  // 旧时代（修复前）的 state：没有 envSignature，端口 readyz 正常 —— 也必须重建。
  writeAppServerState(aiHomeDir, 'gateway', {
    gateway: true,
    runtimeScope: 'gateway',
    multiplexer: 'tmux',
    port: 43126,
    socket: appServerSocketName('gateway'),
    startedAt: 1
  });

  const rebuilt = await ensureCodexAppServerEndpoint(baseOptions);
  assert.deepEqual(rebuilt, { port: 43127, reused: false });
  assert.ok(calls.some(([, args]) => args.includes('kill-server')), 'stale socket cleaned up');
  assert.ok(calls.some(([, args]) => args.includes('new-session')), 'fresh pane spawned');
  assert.equal(readAppServerState(aiHomeDir, 'gateway').envSignature, envSignature);

  // 签名匹配的常驻 pane 才允许复用。
  calls.length = 0;
  const reused = await ensureCodexAppServerEndpoint(baseOptions);
  assert.deepEqual(reused, { port: 43127, reused: true });
  assert.equal(calls.some(([, args]) => args.includes('new-session')), false);
});

test('app-server readiness on win32 ignores pane liveness and waits for readyz', async () => {
  let checks = 0;
  await waitForAppServerReady(9527, 'aih-codexapp-test', {
    platform: 'win32',
    checkReadyz: async () => {
      checks += 1;
      return checks >= 2;
    },
    // psmux 丢 pane 会话但进程仍存活：liveness 恒 false 也不能误判 process_exited。
    hasRunSession: () => false,
    delay: async () => {}
  });
  assert.ok(checks >= 2);
});

test('app-server win32 rebuild kills the stale port owner that psmux cannot reap', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-app-portkill-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  writeServerConfig({ apiKey: 'client-key-1234' }, { fs, aiHomeDir });
  writeAppServerState(aiHomeDir, 'gateway', {
    gateway: true,
    runtimeScope: 'gateway',
    multiplexer: 'tmux',
    port: 43126,
    socket: appServerSocketName('gateway'),
    startedAt: 1
  });

  const calls = [];
  const spawnSyncImpl = (command, args) => {
    calls.push([command, args]);
    if (command === 'psmux' && args[0] === '-V') return { status: 0 };
    if (command === 'psmux' && args.includes('new-session')) return { status: 0 };
    if (command === 'psmux' && args.includes('kill-server')) return { status: 0 };
    if (command === 'netstat') {
      return { status: 0, stdout: '  TCP    127.0.0.1:43126    0.0.0.0:0    LISTENING    4242\r\n' };
    }
    if (command === 'taskkill') return { status: 0 };
    return { status: 1 };
  };

  const result = await ensureCodexAppServerEndpoint({
    gateway: true,
    aiHomeDir,
    env: {},
    platform: 'win32',
    getProfileDir: () => aiHomeDir,
    runtimeExecutablePath: 'C:\\Users\\u\\codex.exe',
    buildProviderEnvImpl: async () => ({ HOME: aiHomeDir }),
    pickFreePortImpl: async () => 43127,
    checkReadyzImpl: async () => true,
    spawnSyncImpl
  });

  assert.deepEqual(result, { port: 43127, reused: false });
  const taskkill = calls.find(([command]) => command === 'taskkill');
  assert.ok(taskkill, 'stale port owner must be taskkilled on win32 rebuild');
  assert.deepEqual(taskkill[1], ['/PID', '4242', '/T', '/F']);
});
