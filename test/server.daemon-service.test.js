'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServerDaemonService } = require('../lib/cli/services/server/daemon');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-daemon-service-'));
}

function makeSourceCheckout(root) {
  const repoDir = path.join(root, 'source-ai-home');
  const entryFilePath = path.join(repoDir, 'lib', 'cli', 'app.js');
  fs.mkdirSync(path.dirname(entryFilePath), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'ai_home' }), 'utf8');
  fs.writeFileSync(entryFilePath, "'use strict';\n", 'utf8');
  return { repoDir, entryFilePath };
}

test('daemon service start reuses running server discovered by port when pid file is stale', async () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  fs.writeFileSync(pidFile, '123');

  const spawnCalls = [];
  const spawnSync = (cmd, args) => {
    if (cmd === 'lsof') return { status: 0, stdout: '85022\n', stderr: '' };
    if (cmd === 'ps') {
      return {
        status: 0,
        stdout: '/usr/local/bin/node /repo/lib/cli/app.js server serve\n',
        stderr: ''
      };
    }
    return { status: 1, stdout: '', stderr: '' };
  };

  const processObj = {
    execPath: '/usr/local/bin/node',
    env: process.env,
    platform: process.platform,
    kill(pid) {
      if (Number(pid) === 85022) return;
      throw new Error('ESRCH');
    }
  };

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn(cmd, args, opts) {
      spawnCalls.push({ cmd, args, opts });
      return { pid: 99999, unref() {} };
    },
    spawnSync,
    fetchImpl: async () => ({ ok: true }),
    processObj,
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { port: 8317 }; },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.aih.server',
    launchdPlist: path.join(root, 'com.aih.server.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const result = await daemon.start([]);
  assert.equal(result.alreadyRunning, true);
  assert.equal(result.pid, 85022);
  assert.equal(result.ready, true);
  assert.equal(result.state, 'running');
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), '85022');
  assert.equal(spawnCalls.length, 0);
});

test('daemon service status recovers running pid by listening port when pid file is stale', () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  fs.writeFileSync(pidFile, '42');

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn() { throw new Error('not_used'); },
    spawnSync(cmd) {
      if (cmd === 'lsof') return { status: 0, stdout: '7777\n', stderr: '' };
      if (cmd === 'ps') {
        return {
          status: 0,
          stdout: '/usr/local/bin/node /repo/lib/cli/app.js server serve\n',
          stderr: ''
        };
      }
      return { status: 1, stdout: '', stderr: '' };
    },
    processObj: {
      execPath: '/usr/local/bin/node',
      env: process.env,
      platform: process.platform,
      kill(pid) {
        if (Number(pid) === 7777) return;
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { port: 8317 }; },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.aih.server',
    launchdPlist: path.join(root, 'com.aih.server.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const status = daemon.getStatus();
  assert.equal(status.running, true);
  assert.equal(status.pid, 7777);
  assert.equal(status.ready, true);
  assert.equal(status.state, 'running');
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), '7777');
});

test('daemon service start replaces a tracked AIH server on a legacy port', async () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  fs.writeFileSync(pidFile, '77904');

  const killCalls = [];
  const spawnCalls = [];
  let legacyAlive = true;

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn(cmd, args, opts) {
      spawnCalls.push({ cmd, args, opts });
      return { pid: 95270, unref() {} };
    },
    spawnSync(cmd, args) {
      if (cmd === 'lsof' && args.includes('-iTCP:9527')) return { status: 1, stdout: '', stderr: '' };
      if (cmd === 'ps') {
        return {
          status: 0,
          stdout: '/usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port 8317\n',
          stderr: ''
        };
      }
      return { status: 1, stdout: '', stderr: '' };
    },
    fetchImpl: async () => {
      throw new Error('health probe should stay in background');
    },
    processObj: {
      execPath: '/usr/local/bin/node',
      env: process.env,
      platform: process.platform,
      kill(pid, signal) {
        const numericPid = Number(pid);
        killCalls.push({ pid: numericPid, signal });
        if (numericPid === 77904) {
          if (signal === 0 || signal === undefined) {
            if (legacyAlive) return;
            throw new Error('ESRCH');
          }
          if (signal === 'SIGTERM') {
            legacyAlive = false;
            return;
          }
        }
        if (numericPid === 95270 && (signal === 0 || signal === undefined)) return;
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { host: '127.0.0.1', port: 9527 }; },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.aih.server',
    launchdPlist: path.join(root, 'com.aih.server.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const result = await daemon.start([], { waitForReady: false });

  assert.equal(result.alreadyRunning, false);
  assert.equal(result.started, true);
  assert.equal(result.pid, 95270);
  assert.equal(result.port, 9527);
  assert.equal(result.baseUrl, 'http://127.0.0.1:9527/v1');
  assert.deepEqual(spawnCalls[0].args.slice(-2), ['--port', '9527']);
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), '95270');
  assert.equal(killCalls.some((call) => call.pid === 77904 && call.signal === 'SIGTERM'), true);
});

test('daemon service status does not report a legacy-port pid as the current provider', () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  fs.writeFileSync(pidFile, '77904');

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn() { throw new Error('not_used'); },
    spawnSync(cmd, args) {
      if (cmd === 'lsof' && args.includes('-iTCP:9527')) return { status: 1, stdout: '', stderr: '' };
      if (cmd === 'ps') {
        return {
          status: 0,
          stdout: '/usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port=8317\n',
          stderr: ''
        };
      }
      return { status: 1, stdout: '', stderr: '' };
    },
    processObj: {
      execPath: '/usr/local/bin/node',
      env: process.env,
      platform: process.platform,
      kill(pid, signal) {
        if (Number(pid) === 77904 && (signal === 0 || signal === undefined)) return;
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { host: '127.0.0.1', port: 9527 }; },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.aih.server',
    launchdPlist: path.join(root, 'com.aih.server.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const status = daemon.getStatus();

  assert.equal(status.running, false);
  assert.equal(status.ready, false);
  assert.equal(status.state, 'stopped');
  assert.equal(status.pid, 0);
  assert.equal(fs.existsSync(pidFile), false);
});

test('daemon service start cleans legacy AIH listener even after status cleared pidfile', async () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  fs.writeFileSync(pidFile, '77904');

  const killCalls = [];
  const spawnCalls = [];
  let legacyAlive = true;

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn(cmd, args, opts) {
      spawnCalls.push({ cmd, args, opts });
      return { pid: 95271, unref() {} };
    },
    spawnSync(cmd, args) {
      if (cmd === 'lsof' && args.includes('-iTCP:9527')) return { status: 1, stdout: '', stderr: '' };
      if (cmd === 'lsof' && args.includes('-iTCP:8317')) {
        return legacyAlive ? { status: 0, stdout: '77904\n', stderr: '' } : { status: 1, stdout: '', stderr: '' };
      }
      if (cmd === 'ps') {
        return {
          status: 0,
          stdout: '/usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port 8317\n',
          stderr: ''
        };
      }
      return { status: 1, stdout: '', stderr: '' };
    },
    fetchImpl: async () => {
      throw new Error('health probe should stay in background');
    },
    processObj: {
      execPath: '/usr/local/bin/node',
      env: process.env,
      platform: process.platform,
      kill(pid, signal) {
        const numericPid = Number(pid);
        killCalls.push({ pid: numericPid, signal });
        if (numericPid === 77904) {
          if (signal === 0 || signal === undefined) {
            if (legacyAlive) return;
            throw new Error('ESRCH');
          }
          if (signal === 'SIGTERM') {
            legacyAlive = false;
            return;
          }
        }
        if (numericPid === 95271 && (signal === 0 || signal === undefined)) return;
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { host: '127.0.0.1', port: 9527 }; },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.aih.server',
    launchdPlist: path.join(root, 'com.aih.server.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const status = daemon.getStatus();
  assert.equal(status.running, false);
  assert.equal(fs.existsSync(pidFile), false);

  const result = await daemon.start([], { waitForReady: false });

  assert.equal(result.alreadyRunning, false);
  assert.equal(result.started, true);
  assert.equal(result.pid, 95271);
  assert.equal(result.port, 9527);
  assert.equal(legacyAlive, false);
  assert.equal(killCalls.some((call) => call.pid === 77904 && call.signal === 'SIGTERM'), true);
  assert.deepEqual(spawnCalls[0].args.slice(-2), ['--port', '9527']);
});

test('daemon service status reports stale source when running server has no launch fingerprint', () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  fs.writeFileSync(pidFile, '7777');

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn() { throw new Error('not_used'); },
    spawnSync(cmd) {
      if (cmd === 'lsof') return { status: 0, stdout: '7777\n', stderr: '' };
      if (cmd === 'ps') {
        return {
          status: 0,
          stdout: '/usr/local/bin/node /repo/lib/cli/app.js server serve\n',
          stderr: ''
        };
      }
      return { status: 1, stdout: '', stderr: '' };
    },
    processObj: {
      execPath: '/usr/local/bin/node',
      env: process.env,
      platform: process.platform,
      kill(pid) {
        if (Number(pid) === 7777) return;
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { port: 8317 }; },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.aih.server',
    launchdPlist: path.join(root, 'com.aih.server.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const status = daemon.getStatus();
  assert.equal(status.running, true);
  assert.equal(status.ready, true);
  assert.equal(status.stale, true);
  assert.equal(status.staleReason, 'missing_source_fingerprint');
});

test('daemon service status reports starting when pid exists before port is ready', () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  fs.writeFileSync(pidFile, '4567');

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn() { throw new Error('not_used'); },
    spawnSync(cmd) {
      if (cmd === 'lsof') return { status: 1, stdout: '', stderr: '' };
      if (cmd === 'ps') {
        return {
          status: 0,
          stdout: '/usr/local/bin/node /repo/lib/cli/app.js server serve\n',
          stderr: ''
        };
      }
      return { status: 1, stdout: '', stderr: '' };
    },
    processObj: {
      execPath: '/usr/local/bin/node',
      env: process.env,
      platform: process.platform,
      kill(pid) {
        if (Number(pid) === 4567) return;
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { port: 8317 }; },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.aih.server',
    launchdPlist: path.join(root, 'com.aih.server.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const status = daemon.getStatus();
  assert.equal(status.running, true);
  assert.equal(status.pid, 4567);
  assert.equal(status.ready, false);
  assert.equal(status.state, 'starting');
});

test('daemon service start can skip foreground ready wait for fast restart paths', async () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn() {
      return { pid: 45678, unref() {} };
    },
    spawnSync() {
      return { status: 1, stdout: '', stderr: '' };
    },
    fetchImpl: async () => {
      throw new Error('health probe should stay in background');
    },
    processObj: {
      execPath: '/usr/local/bin/node',
      env: process.env,
      platform: process.platform,
      kill(pid) {
        if (Number(pid) === 45678) return;
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { port: 8317 }; },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.aih.server',
    launchdPlist: path.join(root, 'com.aih.server.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const startedAt = Date.now();
  const result = await daemon.start([], { waitForReady: false, readyTimeoutMs: 3000 });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.alreadyRunning, false);
  assert.equal(result.started, true);
  assert.equal(result.ready, false);
  assert.equal(result.readyCheck, 'background');
  assert.equal(result.state, 'starting');
  assert.equal(result.pid, 45678);
  assert.ok(elapsedMs < 500, `expected fast return, got ${elapsedMs}ms`);
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), '45678');
});

test('daemon service start uses the next port when the preferred port belongs to another process', async () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  const spawnCalls = [];
  const configWrites = [];

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn(cmd, args, opts) {
      spawnCalls.push({ cmd, args, opts });
      return { pid: 45678, unref() {} };
    },
    spawnSync(cmd, args) {
      if (cmd === 'lsof' && args.includes('-iTCP:9527')) return { status: 0, stdout: '1111\n', stderr: '' };
      if (cmd === 'lsof' && args.includes('-iTCP:9528')) return { status: 1, stdout: '', stderr: '' };
      if (cmd === 'ps') {
        return {
          status: 0,
          stdout: '/usr/local/bin/python -m http.server 9527\n',
          stderr: ''
        };
      }
      return { status: 1, stdout: '', stderr: '' };
    },
    fetchImpl: async () => {
      throw new Error('health probe should stay in background');
    },
    processObj: {
      execPath: '/usr/local/bin/node',
      env: process.env,
      platform: process.platform,
      kill(pid) {
        if (Number(pid) === 1111 || Number(pid) === 45678) return;
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { host: '127.0.0.1', port: 9527 }; },
    writeServerConfig(config) {
      configWrites.push(config);
    },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.aih.server',
    launchdPlist: path.join(root, 'com.aih.server.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const result = await daemon.start([], { waitForReady: false });

  assert.equal(result.started, true);
  assert.equal(result.port, 9528);
  assert.equal(result.portChanged, true);
  assert.equal(result.baseUrl, 'http://127.0.0.1:9528/v1');
  assert.deepEqual(configWrites, [{
    host: '127.0.0.1',
    port: 9528,
    apiKey: '',
    managementKey: '',
    openNetwork: false
  }]);
  assert.deepEqual(spawnCalls[0].args.slice(-2), ['--port', '9528']);
});

test('daemon service start can skip foreground ready wait and return immediately', async () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');

  let readyProbeCount = 0;
  const daemon = createServerDaemonService({
    fs,
    path,
    spawn() {
      return { pid: 45678, unref() {} };
    },
    spawnSync() {
      return { status: 1, stdout: '', stderr: '' };
    },
    fetchImpl: async () => {
      readyProbeCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { ok: true };
    },
    processObj: {
      execPath: '/usr/local/bin/node',
      env: process.env,
      platform: process.platform,
      kill(pid) {
        if (Number(pid) === 45678) return;
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { port: 8317 }; },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.aih.server',
    launchdPlist: path.join(root, 'com.aih.server.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const startedAt = Date.now();
  const result = await daemon.start([], { waitForReady: false });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.alreadyRunning, false);
  assert.equal(result.started, true);
  assert.equal(result.readyCheck, 'background');
  assert.equal(result.state, 'starting');
  assert.equal(result.pid, 45678);
  assert.ok(elapsedMs < 120, `expected non-blocking start, got ${elapsedMs}ms`);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(readyProbeCount >= 0);
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), '45678');
});

test('daemon service start prefers ai_home source checkout from cwd over installed entry', async () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  const source = makeSourceCheckout(root);
  const spawnCalls = [];

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn(cmd, args, opts) {
      spawnCalls.push({ cmd, args, opts });
      return { pid: 45678, unref() {} };
    },
    spawnSync() {
      return { status: 1, stdout: '', stderr: '' };
    },
    fetchImpl: async () => ({ ok: true }),
    processObj: {
      execPath: '/usr/local/bin/node',
      env: process.env,
      platform: process.platform,
      cwd() {
        return path.join(source.repoDir, 'web');
      },
      kill(pid) {
        if (Number(pid) === 45678) return;
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { port: 8317 }; },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.aih.server',
    launchdPlist: path.join(root, 'com.aih.server.plist'),
    entryFilePath: '/opt/homebrew/lib/node_modules/ai_home/lib/cli/app.js'
  });

  const result = await daemon.start([], { waitForReady: false });
  assert.equal(result.entryFilePath, source.entryFilePath);
  assert.equal(result.entrySource, 'cwd');
  assert.equal(spawnCalls[0].args[0], source.entryFilePath);
});

test('daemon service start discovers running ai_home server from a different checkout', async () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  const source = makeSourceCheckout(root);
  const spawnCalls = [];

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn(cmd, args, opts) {
      spawnCalls.push({ cmd, args, opts });
      return { pid: 99999, unref() {} };
    },
    spawnSync(cmd) {
      if (cmd === 'lsof') return { status: 0, stdout: '85022\n', stderr: '' };
      if (cmd === 'ps') {
        return {
          status: 0,
          stdout: `/usr/local/bin/node ${source.entryFilePath} server serve\n`,
          stderr: ''
        };
      }
      return { status: 1, stdout: '', stderr: '' };
    },
    fetchImpl: async () => ({ ok: true }),
    processObj: {
      execPath: '/usr/local/bin/node',
      env: process.env,
      platform: process.platform,
      cwd() {
        return root;
      },
      kill(pid) {
        if (Number(pid) === 85022) return;
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { port: 8317 }; },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.aih.server',
    launchdPlist: path.join(root, 'com.aih.server.plist'),
    entryFilePath: '/opt/homebrew/lib/node_modules/ai_home/lib/cli/app.js'
  });

  const result = await daemon.start([]);
  assert.equal(result.alreadyRunning, true);
  assert.equal(result.pid, 85022);
  assert.equal(result.ready, true);
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), '85022');
  assert.equal(spawnCalls.length, 0);
});
