'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServerDaemonService } = require('../lib/cli/services/server/daemon');
const { createServerDaemonController } = require('../lib/server/daemon');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-daemon-service-'));
}

function launchctlQueryResult(args, isLoaded) {
  const operation = String(args[0] || '');
  if (operation !== 'print' && operation !== 'list') return null;
  const target = String(args[1] || '');
  const label = operation === 'print' ? target.split('/').pop() : target;
  return isLoaded(label)
    ? { status: 0, stdout: '', stderr: '' }
    : { status: 1, stdout: '', stderr: `service not found: ${label}` };
}

function makeSourceCheckout(root) {
  const repoDir = path.join(root, 'source-ai-home');
  const entryFilePath = path.join(repoDir, 'lib', 'cli', 'app.js');
  fs.mkdirSync(path.dirname(entryFilePath), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'ai_home' }), 'utf8');
  fs.writeFileSync(entryFilePath, "'use strict';\n", 'utf8');
  return { repoDir, entryFilePath };
}

function makeAihCommandShim(root, repoDir) {
  const binEntryFilePath = path.join(repoDir, 'bin', 'ai-home.js');
  fs.mkdirSync(path.dirname(binEntryFilePath), { recursive: true });
  fs.writeFileSync(binEntryFilePath, "#!/usr/bin/env node\nrequire('../lib/cli/app');\n", 'utf8');
  const shimFilePath = path.join(root, 'homebrew', 'bin', 'aih');
  fs.mkdirSync(path.dirname(shimFilePath), { recursive: true });
  try {
    fs.symlinkSync(binEntryFilePath, shimFilePath);
    return shimFilePath;
  } catch (_error) {
    return binEntryFilePath;
  }
}

function makeGhostSupervisorFixture(t, options = {}) {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { repoDir, entryFilePath } = makeSourceCheckout(root);
  const aihCommandPath = makeAihCommandShim(root, repoDir);
  const aiHomeDir = path.join(root, '.ai_home');
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  const launchdLabel = 'com.clawdcodex.ai_home';
  const launchdPlist = path.join(root, 'Library', 'LaunchAgents', `${launchdLabel}.plist`);
  const supervisorCommand = `/usr/local/bin/node ${aihCommandPath} __background run`;
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(pidFile, '2001', 'utf8');

  const runtime = {
    launchdLoaded: true,
    currentPid: 2001,
    respawnCount: 0
  };
  const launchctlCalls = [];
  const killCalls = [];
  const spawnCalls = [];
  const respawnOnKill = options.respawnOnKill !== false;
  const daemon = createServerDaemonService({
    fs,
    path,
    spawn(cmd, args, spawnOptions) {
      spawnCalls.push({ cmd, args, options: spawnOptions });
      return { pid: 3001, unref() {} };
    },
    spawnSync(cmd, args) {
      if (cmd === 'launchctl') {
        launchctlCalls.push(args.slice());
        const queryResult = launchctlQueryResult(
          args,
          (label) => label === launchdLabel && runtime.launchdLoaded
        );
        if (queryResult) return queryResult;
        if (args[0] === 'bootout' || args[0] === 'unload') {
          runtime.launchdLoaded = false;
          runtime.currentPid = 0;
          return { status: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'bootstrap' || args[0] === 'load') {
          runtime.launchdLoaded = true;
          runtime.currentPid = 2002;
          return { status: 0, stdout: '', stderr: '' };
        }
      }
      if (String(cmd).endsWith('/lsregister')) return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'lsof' && args.includes('-iTCP:9527')) {
        return runtime.currentPid > 0
          ? { status: 0, stdout: `${runtime.currentPid}\n`, stderr: '' }
          : { status: 1, stdout: '', stderr: '' };
      }
      if (cmd === 'ps' && args[0] === '-axo') {
        return {
          status: 0,
          stdout: runtime.currentPid > 0 ? `${runtime.currentPid} ${supervisorCommand}\n` : '',
          stderr: ''
        };
      }
      if (cmd === 'ps' && args[0] === '-p') {
        const pid = Number(args[1]);
        return pid === runtime.currentPid && runtime.currentPid > 0
          ? { status: 0, stdout: `${supervisorCommand}\n`, stderr: '' }
          : { status: 1, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'service not found' };
    },
    fetchImpl: async () => ({ ok: true }),
    processObj: {
      execPath: '/usr/local/bin/node',
      env: {
        AIH_CLI_PATH: aihCommandPath,
        HOME: root,
        PATH: '/opt/homebrew/bin:/usr/bin'
      },
      platform: 'darwin',
      cwd() { return root; },
      getuid() { return 501; },
      kill(pid, signal) {
        const numericPid = Number(pid);
        killCalls.push({ pid: numericPid, signal });
        if (signal === 0 || signal === undefined) {
          if (numericPid === runtime.currentPid && runtime.currentPid > 0) return;
          throw new Error('ESRCH');
        }
        if (numericPid !== runtime.currentPid || runtime.currentPid <= 0) throw new Error('ESRCH');
        if (runtime.launchdLoaded && respawnOnKill) {
          runtime.respawnCount += 1;
          runtime.currentPid = 2002;
          return;
        }
        runtime.currentPid = 0;
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { host: '127.0.0.1', port: 9527 }; },
    readServerConfig() { return { host: '127.0.0.1', port: 9527 }; },
    buildServerArgsFromConfig() { return ['--host', '127.0.0.1', '--port', '9527']; },
    aiHomeDir,
    hostHomeDir: root,
    pidFile,
    logFile,
    launchdLabel,
    launchdPlist,
    entryFilePath
  });

  return {
    daemon,
    killCalls,
    launchctlCalls,
    launchdPlist,
    pidFile,
    runtime,
    spawnCalls
  };
}

test('daemon service start heals a loaded macOS supervisor ghost instead of reusing its pid', async (t) => {
  const fixture = makeGhostSupervisorFixture(t);

  const result = await fixture.daemon.start([], { waitForReady: false, gracefulStopWaitMs: 20 });

  assert.equal(result.started, true);
  assert.equal(result.alreadyRunning, false);
  assert.equal(result.pid, 2002);
  assert.equal(fixture.launchctlCalls.filter((args) => args[0] === 'bootout').length, 1);
  assert.equal(fixture.launchctlCalls.filter((args) => args[0] === 'bootstrap').length, 1);
  assert.equal(fixture.spawnCalls.length, 0);
  assert.equal(fs.existsSync(fixture.launchdPlist), true);
  assert.equal(fixture.runtime.launchdLoaded, true);
});

test('daemon service stop unloads a macOS supervisor ghost before it can respawn', (t) => {
  const fixture = makeGhostSupervisorFixture(t);

  const result = fixture.daemon.stop({ gracefulStopWaitMs: 20 });

  assert.equal(result.stopped, true);
  assert.equal(fixture.launchctlCalls.filter((args) => args[0] === 'bootout').length, 1);
  assert.equal(fixture.spawnCalls.length, 0);
  assert.equal(fixture.killCalls.some((call) => call.signal === 'SIGTERM' || call.signal === 'SIGKILL'), false);
  assert.equal(fs.existsSync(fixture.launchdPlist), false);
  assert.equal(fixture.runtime.launchdLoaded, false);
  assert.equal(fixture.runtime.currentPid, 0);
  assert.equal(fixture.runtime.respawnCount, 0);
});

test('daemon service restart heals a loaded macOS supervisor ghost without server-only spawn', async (t) => {
  const fixture = makeGhostSupervisorFixture(t, { respawnOnKill: false });

  const result = await fixture.daemon.restart([], { waitForReady: false, gracefulStopWaitMs: 20 });

  assert.equal(result.started, true);
  assert.equal(result.pid, 2002);
  assert.equal(fixture.launchctlCalls.filter((args) => args[0] === 'bootout').length, 1);
  assert.equal(fixture.launchctlCalls.filter((args) => args[0] === 'bootstrap').length, 1);
  assert.equal(fixture.spawnCalls.length, 0);
  assert.equal(fs.existsSync(fixture.launchdPlist), true);
  assert.equal(fixture.runtime.launchdLoaded, true);
});

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
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
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

test('daemon service manages server launched through global aih shim', async () => {
  const root = makeTempDir();
  const { repoDir, entryFilePath } = makeSourceCheckout(root);
  const aihCommandPath = makeAihCommandShim(root, repoDir);
  const command = `/usr/local/bin/node ${aihCommandPath} server serve --host 127.0.0.1 --port 9527`;
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  const killCalls = [];
  let alive = true;

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn() { throw new Error('not_used'); },
    spawnSync(cmd, args) {
      if (cmd === 'lsof' && args.includes('-iTCP:9527')) {
        return alive ? { status: 0, stdout: '1001\n', stderr: '' } : { status: 1, stdout: '', stderr: '' };
      }
      if (cmd === 'ps' && args[0] === '-axo') {
        return alive ? { status: 0, stdout: `1001 ${command}\n`, stderr: '' } : { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'ps') {
        const pidIndex = args.indexOf('-p');
        const pid = pidIndex >= 0 ? Number(args[pidIndex + 1]) : 0;
        if (pid === 1001 && alive) return { status: 0, stdout: `${command}\n`, stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    },
    fetchImpl: async () => ({ ok: true }),
    processObj: {
      execPath: '/usr/local/bin/node',
      env: process.env,
      platform: process.platform,
      kill(pid, signal) {
        const numericPid = Number(pid);
        killCalls.push({ pid: numericPid, signal });
        if (numericPid === 1001 && (signal === 0 || signal === undefined)) {
          if (alive) return;
          throw new Error('ESRCH');
        }
        if (numericPid === 1001 && signal === 'SIGTERM') {
          alive = false;
          return;
        }
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { port: 9527 }; },
    readServerConfig() { return { host: '127.0.0.1', port: 9527 }; },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
    entryFilePath
  });

  const started = await daemon.start([], { waitForReady: false });
  assert.equal(started.alreadyRunning, true);
  assert.equal(started.pid, 1001);
  assert.equal(started.ready, true);
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), '1001');

  const status = daemon.getStatus();
  assert.equal(status.running, true);
  assert.equal(status.pid, 1001);
  assert.equal(status.ready, true);
  assert.equal(status.port, 9527);
  assert.equal(fs.realpathSync(status.entryFilePath), fs.realpathSync(entryFilePath));

  const stopped = daemon.stop({ gracefulStopWaitMs: 20 });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.pid, 1001);
  assert.equal(stopped.reason, '');
  assert.equal(killCalls.some((call) => call.pid === 1001 && call.signal === 'SIGTERM'), true);
});

test('daemon service reuses the single-process background supervisor', async () => {
  const root = makeTempDir();
  const { repoDir, entryFilePath } = makeSourceCheckout(root);
  const aihCommandPath = makeAihCommandShim(root, repoDir);
  const command = `/usr/local/bin/node ${aihCommandPath} __background run`;
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  fs.writeFileSync(pidFile, '2001');
  const spawnCalls = [];

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn(cmd, args, opts) {
      spawnCalls.push({ cmd, args, opts });
      return { pid: 3001, unref() {} };
    },
    spawnSync(cmd, args) {
      if (cmd === 'lsof' && args.includes('-iTCP:9527')) {
        return { status: 0, stdout: '2001\n', stderr: '' };
      }
      if (cmd === 'ps' && args[0] === '-axo') {
        return { status: 0, stdout: `2001 ${command}\n`, stderr: '' };
      }
      if (cmd === 'ps') {
        return { status: 0, stdout: `${command}\n`, stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    },
    fetchImpl: async () => ({ ok: true }),
    processObj: {
      execPath: '/usr/local/bin/node',
      env: process.env,
      platform: process.platform,
      kill(pid) {
        if (Number(pid) === 2001) return;
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { host: '0.0.0.0', port: 9527 }; },
    readServerConfig() { return { host: '0.0.0.0', port: 9527 }; },
    buildServerArgsFromConfig() { return ['--host', '0.0.0.0', '--port', '9527']; },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
    entryFilePath
  });

  const result = await daemon.start([], { waitForReady: false });

  assert.equal(result.alreadyRunning, true);
  assert.equal(result.pid, 2001);
  assert.equal(result.ready, true);
  assert.equal(result.port, 9527);
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
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
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
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
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

test('daemon service status reports the discovered AIH server even when it runs on a legacy port', () => {
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
      if (cmd === 'lsof' && args.includes('-iTCP:8317')) return { status: 0, stdout: '77904\n', stderr: '' };
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
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const status = daemon.getStatus();

  assert.equal(status.running, true);
  assert.equal(status.ready, true);
  assert.equal(status.state, 'running');
  assert.equal(status.pid, 77904);
  assert.equal(status.port, 8317);
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), '77904');
});

test('daemon service start migrates a discovered legacy AIH listener back to the configured port', async () => {
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
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const status = daemon.getStatus();
  assert.equal(status.running, true);
  assert.equal(status.pid, 77904);
  assert.equal(status.port, 8317);

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
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
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
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const status = daemon.getStatus();
  assert.equal(status.running, true);
  assert.equal(status.pid, 4567);
  assert.equal(status.ready, false);
  assert.equal(status.state, 'starting');
});

test('daemon service status reports configured port when server is stopped', () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn() { throw new Error('not_used'); },
    spawnSync() {
      return { status: 1, stdout: '', stderr: '' };
    },
    processObj: {
      execPath: '/usr/local/bin/node',
      env: process.env,
      platform: process.platform,
      kill() {
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { port: 9527 }; },
    readServerConfig() {
      return { host: '127.0.0.1', port: 9531 };
    },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const status = daemon.getStatus();
  assert.equal(status.running, false);
  assert.equal(status.port, 9531);
  assert.equal(status.baseUrl, 'http://127.0.0.1:9531/v1');
});

test('daemon service status prefers configured-port AIH server when multiple instances exist', () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn() { throw new Error('not_used'); },
    spawnSync(cmd, args) {
      if (cmd === 'lsof' && args.includes('-iTCP:9527')) return { status: 0, stdout: '1001\n', stderr: '' };
      if (cmd === 'lsof' && args.includes('-iTCP:9531')) return { status: 0, stdout: '2002\n', stderr: '' };
      if (cmd === 'ps' && args[0] === '-axo') {
        return {
          status: 0,
          stdout: [
            '1001 /usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port 9527',
            '2002 /usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port 9531'
          ].join('\n'),
          stderr: ''
        };
      }
      if (cmd === 'ps') {
        const pidIndex = args.indexOf('-p');
        const pid = pidIndex >= 0 ? Number(args[pidIndex + 1]) : 0;
        if (pid === 1001) {
          return {
            status: 0,
            stdout: '/usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port 9527\n',
            stderr: ''
          };
        }
        if (pid === 2002) {
          return {
            status: 0,
            stdout: '/usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port 9531\n',
            stderr: ''
          };
        }
      }
      return { status: 1, stdout: '', stderr: '' };
    },
    processObj: {
      execPath: '/usr/local/bin/node',
      env: process.env,
      platform: process.platform,
      kill(pid, signal) {
        if ((Number(pid) === 1001 || Number(pid) === 2002) && (signal === 0 || signal === undefined)) return;
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { port: 9527 }; },
    readServerConfig() {
      return { host: '127.0.0.1', port: 9531 };
    },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const status = daemon.getStatus();
  assert.equal(status.running, true);
  assert.equal(status.ready, true);
  assert.equal(status.pid, 2002);
  assert.equal(status.port, 9531);
  assert.equal(status.extraServers, 1);
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), '2002');
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
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
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

test('daemon service start fails when the preferred port belongs to another process', async () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  const spawnCalls = [];

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
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  await assert.rejects(
    () => daemon.start([], { waitForReady: false }),
    (error) => {
      assert.equal(error.code, 'server_port_in_use');
      assert.equal(error.port, 9527);
      assert.deepEqual(error.pids, [1111]);
      return true;
    }
  );
  assert.deepEqual(spawnCalls, []);
});

test('daemon service restart does not stop current AIH server when target port is external', async () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  fs.writeFileSync(pidFile, '1001');
  const killCalls = [];
  const spawnCalls = [];

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn(cmd, args, opts) {
      spawnCalls.push({ cmd, args, opts });
      return { pid: 95270, unref() {} };
    },
    spawnSync(cmd, args) {
      if (cmd === 'lsof' && args.includes('-iTCP:9527')) return { status: 0, stdout: '2222\n', stderr: '' };
      if (cmd === 'ps' && args[0] === '-axo') {
        return {
          status: 0,
          stdout: '1001 /usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port 8317\n',
          stderr: ''
        };
      }
      if (cmd === 'ps') {
        const pidIndex = args.indexOf('-p');
        const pid = pidIndex >= 0 ? Number(args[pidIndex + 1]) : 0;
        if (pid === 1001) {
          return {
            status: 0,
            stdout: '/usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port 8317\n',
            stderr: ''
          };
        }
        if (pid === 2222) {
          return {
            status: 0,
            stdout: '/usr/bin/python -m http.server 9527\n',
            stderr: ''
          };
        }
      }
      return { status: 1, stdout: '', stderr: '' };
    },
    processObj: {
      execPath: '/usr/local/bin/node',
      env: process.env,
      platform: process.platform,
      kill(pid, signal) {
        killCalls.push({ pid: Number(pid), signal });
        if ((Number(pid) === 1001 || Number(pid) === 2222) && (signal === 0 || signal === undefined)) return;
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { host: '127.0.0.1', port: 9527 }; },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  await assert.rejects(
    () => daemon.restart([], { waitForReady: false }),
    (error) => {
      assert.equal(error.code, 'server_port_in_use');
      assert.equal(error.port, 9527);
      assert.deepEqual(error.pids, [2222]);
      return true;
    }
  );
  assert.equal(killCalls.some((call) => call.pid === 1001 && call.signal === 'SIGTERM'), false);
  assert.deepEqual(spawnCalls, []);
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), '1001');
});

test('daemon service restart replaces own listener on the configured target port', async () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  fs.writeFileSync(pidFile, '1001');
  const killCalls = [];
  const spawnCalls = [];
  let oldAlive = true;

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn(cmd, args, opts) {
      spawnCalls.push({ cmd, args, opts });
      return { pid: 1002, unref() {} };
    },
    spawnSync(cmd, args) {
      if (cmd === 'lsof' && args.includes('-iTCP:9527')) {
        return oldAlive ? { status: 0, stdout: '1001\n', stderr: '' } : { status: 1, stdout: '', stderr: '' };
      }
      if (cmd === 'ps' && args[0] === '-axo') {
        return oldAlive
          ? {
            status: 0,
            stdout: '1001 /usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port 9527\n',
            stderr: ''
          }
          : { status: 1, stdout: '', stderr: '' };
      }
      if (cmd === 'ps') {
        const pidIndex = args.indexOf('-p');
        const pid = pidIndex >= 0 ? Number(args[pidIndex + 1]) : 0;
        if (pid === 1001 && oldAlive) {
          return {
            status: 0,
            stdout: '/usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port 9527\n',
            stderr: ''
          };
        }
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
        if (numericPid === 1001) {
          if (signal === 0 || signal === undefined) {
            if (oldAlive) return;
            throw new Error('ESRCH');
          }
          if (signal === 'SIGTERM') {
            oldAlive = false;
            return;
          }
        }
        if (numericPid === 1002 && (signal === 0 || signal === undefined)) return;
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { host: '127.0.0.1', port: 9527 }; },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const result = await daemon.restart([], { waitForReady: false, gracefulStopWaitMs: 20 });
  assert.equal(result.started, true);
  assert.equal(result.pid, 1002);
  assert.equal(result.port, 9527);
  assert.equal(result.stoppedForRestart.stopped, true);
  assert.equal(result.stoppedForRestart.pid, 1001);
  assert.equal(killCalls.some((call) => call.pid === 1001 && call.signal === 'SIGTERM'), true);
  assert.deepEqual(spawnCalls[0].args.slice(-2), ['--port', '9527']);
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), '1002');
});

test('daemon service restart reloads loaded launchd autostart with saved serve config', async () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  const launchdPlist = path.join(root, 'Library', 'LaunchAgents', 'com.clawdcodex.ai_home.plist');
  fs.mkdirSync(path.dirname(launchdPlist), { recursive: true });
  fs.writeFileSync(launchdPlist, 'old plist', 'utf8');
  fs.writeFileSync(pidFile, '1001');
  const spawnCalls = [];
  const launchctlCalls = [];
  let oldAlive = true;
  let newAlive = false;
  let launchdLoaded = true;
  const launchdLabel = 'com.clawdcodex.ai_home';

  const commandForPid = (pid) => {
    if (pid === 1001 && oldAlive) {
      return '/usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port 9527';
    }
    if (pid === 2002 && newAlive) {
      return '/usr/local/bin/node /opt/homebrew/bin/aih __background run';
    }
    return '';
  };

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn(cmd, args, opts) {
      spawnCalls.push({ cmd, args, opts });
      return { pid: 3003, unref() {} };
    },
    spawnSync(cmd, args) {
      if (cmd === 'sh' && args[1] === 'command -v aih') {
        return { status: 0, stdout: '/opt/homebrew/bin/aih\n', stderr: '' };
      }
      if (String(cmd).endsWith('/lsregister')) return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'launchctl') {
        launchctlCalls.push(args.slice());
        const queryResult = launchctlQueryResult(
          args,
          (label) => label === launchdLabel && launchdLoaded
        );
        if (queryResult) return queryResult;
        if (args[0] === 'bootout' || args[0] === 'unload') {
          const target = String(args[1] || '');
          if (target === launchdPlist || target.endsWith(`/${launchdLabel}`)) {
            launchdLoaded = false;
            oldAlive = false;
          }
          return { status: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'bootstrap' || args[0] === 'load') {
          launchdLoaded = true;
          newAlive = true;
          return { status: 0, stdout: '', stderr: '' };
        }
      }
      if (cmd === 'lsof' && args.includes('-iTCP:9527')) {
        if (newAlive) return { status: 0, stdout: '2002\n', stderr: '' };
        if (oldAlive) return { status: 0, stdout: '1001\n', stderr: '' };
        return { status: 1, stdout: '', stderr: '' };
      }
      if (cmd === 'ps' && args[0] === '-axo') {
        const rows = [];
        if (oldAlive) rows.push(`1001 ${commandForPid(1001)}`);
        if (newAlive) rows.push(`2002 ${commandForPid(2002)}`);
        return { status: 0, stdout: rows.join('\n'), stderr: '' };
      }
      if (cmd === 'ps') {
        const pidIndex = args.indexOf('-p');
        const pid = pidIndex >= 0 ? Number(args[pidIndex + 1]) : 0;
        const command = commandForPid(pid);
        if (command) return { status: 0, stdout: `${command}\n`, stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    },
    fetchImpl: async () => {
      throw new Error('health probe should stay in background');
    },
    processObj: {
      execPath: '/usr/local/bin/node',
      env: { PATH: '/opt/homebrew/bin:/usr/bin' },
      platform: 'darwin',
      kill(pid, signal) {
        const numericPid = Number(pid);
        if (numericPid === 1001 && (signal === 0 || signal === undefined)) {
          if (oldAlive) return;
          throw new Error('ESRCH');
        }
        if (numericPid === 2002 && (signal === 0 || signal === undefined)) {
          if (newAlive) return;
          throw new Error('ESRCH');
        }
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { host: '0.0.0.0', port: 9527 }; },
    readServerConfig() {
      return { host: '0.0.0.0', port: 9527, apiKey: 'client-secret', managementKey: 'management-secret' };
    },
    buildServerArgsFromConfig(config) {
      return ['--host', config.host, '--port', String(config.port), '--api-key', config.apiKey, '--management-key', config.managementKey];
    },
    aiHomeDir,
    hostHomeDir: root,
    pidFile,
    logFile,
    launchdLabel,
    launchdPlist,
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const result = await daemon.restart([], { waitForReady: false, gracefulStopWaitMs: 20 });
  const plist = fs.readFileSync(launchdPlist, 'utf8');

  assert.equal(result.started, true);
  assert.equal(result.pid, 2002);
  assert.equal(result.ready, false);
  assert.equal(oldAlive, false);
  assert.equal(newAlive, true);
  assert.equal(spawnCalls.length, 0);
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), '2002');
  assert.equal(launchctlCalls.filter((args) => args[0] === 'bootout').length, 1);
  assert.equal(launchctlCalls.some((args) => args[0] === 'bootstrap' && args[2] === launchdPlist), true);
  assert.match(plist, /<string>__background<\/string>\s+<string>run<\/string>/);
  assert.doesNotMatch(plist, /client-secret|management-secret|--host|--management-key/);
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
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
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

test('daemon service start uses stored server config when no serve args are supplied', async () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
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
    parseServeArgs(args) {
      const portIndex = args.indexOf('--port');
      return {
        host: '127.0.0.1',
        port: portIndex >= 0 ? Number(args[portIndex + 1]) : 9527
      };
    },
    readServerConfig() {
      return { host: '127.0.0.1', port: 9531, apiKey: '', managementKey: '', openNetwork: false };
    },
    buildServerArgsFromConfig(config) {
      return ['--host', config.host, '--port', String(config.port)];
    },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const result = await daemon.start([], { waitForReady: false });
  assert.equal(result.started, true);
  assert.equal(result.port, 9531);
  assert.deepEqual(spawnCalls[0].args.slice(-4), ['--host', '127.0.0.1', '--port', '9531']);
});

test('daemon service prepares foreground integrations before spawning the background server', async () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  const events = [];

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn() {
      events.push('spawn');
      return { pid: 45679, unref() {} };
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
        if (Number(pid) === 45679) return;
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { port: 9527 }; },
    prepareBackgroundStart() {
      events.push('prepare');
      return { ok: true };
    },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const result = await daemon.start([], { waitForReady: false });

  assert.equal(result.started, true);
  assert.deepEqual(events, ['prepare', 'spawn']);
});

test('daemon service start replaces same-port server when saved serve config changed', async () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  fs.writeFileSync(pidFile, '1001');
  const spawnCalls = [];
  const killCalls = [];
  let oldServerAlive = true;

  const oldCommand = '/usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port 9527';
  const readOption = (args, name) => {
    const index = args.indexOf(name);
    return index >= 0 ? String(args[index + 1] || '').trim() : '';
  };

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn(cmd, args, opts) {
      spawnCalls.push({ cmd, args, opts });
      return { pid: 45678, unref() {} };
    },
    spawnSync(cmd, args) {
      if (cmd === 'lsof' && args.includes('-iTCP:9527')) {
        return oldServerAlive ? { status: 0, stdout: '1001\n', stderr: '' } : { status: 1, stdout: '', stderr: '' };
      }
      if (cmd === 'ps' && args[0] === '-axo') {
        return oldServerAlive
          ? { status: 0, stdout: `1001 ${oldCommand}\n`, stderr: '' }
          : { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'ps') {
        const pidIndex = args.indexOf('-p');
        const pid = pidIndex >= 0 ? Number(args[pidIndex + 1]) : 0;
        if (pid === 1001 && oldServerAlive) return { status: 0, stdout: `${oldCommand}\n`, stderr: '' };
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
        if (numericPid === 1001) {
          if (signal === 0 || signal === undefined) {
            if (oldServerAlive) return;
            throw new Error('ESRCH');
          }
          if (signal === 'SIGTERM') {
            oldServerAlive = false;
            return;
          }
        }
        if (numericPid === 45678 && (signal === 0 || signal === undefined)) return;
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs(args) {
      return {
        host: readOption(args, '--host') || '127.0.0.1',
        port: Number(readOption(args, '--port') || 9527)
      };
    },
    readServerConfig() {
      return {
        host: '0.0.0.0',
        port: 9527,
        apiKey: 'client-secret',
        managementKey: 'management-secret',
        openNetwork: true
      };
    },
    buildServerArgsFromConfig(config) {
      return [
        '--host', config.host,
        '--port', String(config.port),
        '--api-key', config.apiKey,
        '--management-key', config.managementKey
      ];
    },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const result = await daemon.start([], { waitForReady: false });

  assert.equal(result.alreadyRunning, false);
  assert.equal(result.started, true);
  assert.equal(result.pid, 45678);
  assert.equal(oldServerAlive, false);
  assert.equal(killCalls.some((call) => call.pid === 1001 && call.signal === 'SIGTERM'), true);
  assert.deepEqual(spawnCalls[0].args.slice(3), [
    '--host', '0.0.0.0',
    '--port', '9527',
    '--api-key', 'client-secret',
    '--management-key', 'management-secret'
  ]);
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
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
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
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
    entryFilePath: '/opt/homebrew/lib/node_modules/ai_home/lib/cli/app.js'
  });

  const result = await daemon.start([]);
  assert.equal(result.alreadyRunning, true);
  assert.equal(result.pid, 85022);
  assert.equal(result.ready, true);
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), '85022');
  assert.equal(spawnCalls.length, 0);
});

test('daemon service start reuses target AIH listener and stops extra AIH servers on other ports', async () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  const killCalls = [];
  let extraAlive = true;

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn() { throw new Error('not_used'); },
    spawnSync(cmd, args) {
      if (cmd === 'lsof' && args.includes('-iTCP:9527')) return { status: 0, stdout: '1001\n', stderr: '' };
      if (cmd === 'lsof' && args.includes('-iTCP:8317')) return { status: 1, stdout: '', stderr: '' };
      if (cmd === 'ps' && args[0] === '-axo') {
        return {
          status: 0,
          stdout: [
            '1001 /usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port 9527',
            '1002 /usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port 19629'
          ].join('\n'),
          stderr: ''
        };
      }
      if (cmd === 'ps') {
        const pidIndex = args.indexOf('-p');
        const pid = pidIndex >= 0 ? Number(args[pidIndex + 1]) : 0;
        if (pid === 1001) {
          return {
            status: 0,
            stdout: '/usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port 9527\n',
            stderr: ''
          };
        }
        if (pid === 1002) {
          return {
            status: 0,
            stdout: '/usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port 19629\n',
            stderr: ''
          };
        }
      }
      return { status: 1, stdout: '', stderr: '' };
    },
    fetchImpl: async () => ({ ok: true }),
    processObj: {
      execPath: '/usr/local/bin/node',
      env: process.env,
      platform: process.platform,
      kill(pid, signal) {
        const numericPid = Number(pid);
        killCalls.push({ pid: numericPid, signal });
        if (numericPid === 1001 && (signal === 0 || signal === undefined)) return;
        if (numericPid === 1002) {
          if (signal === 0 || signal === undefined) {
            if (extraAlive) return;
            throw new Error('ESRCH');
          }
          if (signal === 'SIGTERM') {
            extraAlive = false;
            return;
          }
        }
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { host: '127.0.0.1', port: 9527 }; },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const result = await daemon.start([]);
  assert.equal(result.alreadyRunning, true);
  assert.equal(result.pid, 1001);
  assert.equal(result.port, 9527);
  assert.equal(extraAlive, false);
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), '1001');
  assert.equal(killCalls.some((call) => call.pid === 1002 && call.signal === 'SIGTERM'), true);
  assert.deepEqual(result.stoppedExtraServers, [{
    pid: 1002,
    port: 19629,
    stopped: true,
    forced: false,
    reason: ''
  }]);
});

test('daemon service stop clears every discovered AIH server instance', () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  fs.writeFileSync(pidFile, '1002');
  const killCalls = [];
  let targetAlive = true;
  let extraAlive = true;

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn() { throw new Error('not_used'); },
    spawnSync(cmd, args) {
      if (cmd === 'lsof' && args.includes('-iTCP:9527')) return { status: 0, stdout: '1001\n', stderr: '' };
      if (cmd === 'ps' && args[0] === '-axo') {
        return {
          status: 0,
          stdout: [
            '1001 /usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port 9527',
            '1002 /usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port 19629'
          ].join('\n'),
          stderr: ''
        };
      }
      if (cmd === 'ps') {
        const pidIndex = args.indexOf('-p');
        const pid = pidIndex >= 0 ? Number(args[pidIndex + 1]) : 0;
        if (pid === 1001) {
          return {
            status: 0,
            stdout: '/usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port 9527\n',
            stderr: ''
          };
        }
        if (pid === 1002) {
          return {
            status: 0,
            stdout: '/usr/local/bin/node /repo/lib/cli/app.js server serve --host 127.0.0.1 --port 19629\n',
            stderr: ''
          };
        }
      }
      return { status: 1, stdout: '', stderr: '' };
    },
    processObj: {
      execPath: '/usr/local/bin/node',
      env: process.env,
      platform: process.platform,
      kill(pid, signal) {
        const numericPid = Number(pid);
        killCalls.push({ pid: numericPid, signal });
        if (numericPid === 1001) {
          if (signal === 0 || signal === undefined) {
            if (targetAlive) return;
            throw new Error('ESRCH');
          }
          if (signal === 'SIGTERM') {
            targetAlive = false;
            return;
          }
        }
        if (numericPid === 1002) {
          if (signal === 0 || signal === undefined) {
            if (extraAlive) return;
            throw new Error('ESRCH');
          }
          if (signal === 'SIGTERM') {
            extraAlive = false;
            return;
          }
        }
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { host: '127.0.0.1', port: 9527 }; },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const result = daemon.stop({ gracefulStopWaitMs: 20 });
  assert.equal(result.stopped, true);
  assert.equal(result.pid, 1002);
  assert.deepEqual(result.pids, [1001, 1002]);
  assert.equal(targetAlive, false);
  assert.equal(extraAlive, false);
  assert.equal(fs.existsSync(pidFile), false);
  assert.equal(killCalls.some((call) => call.pid === 1001 && call.signal === 'SIGTERM'), true);
  assert.equal(killCalls.some((call) => call.pid === 1002 && call.signal === 'SIGTERM'), true);
});

test('daemon service stop unloads the macOS supervisor before terminating its residual process', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { repoDir, entryFilePath } = makeSourceCheckout(root);
  const aihCommandPath = makeAihCommandShim(root, repoDir);
  const aiHomeDir = path.join(root, '.ai_home');
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  const launchdLabel = 'com.clawdcodex.ai_home';
  const launchdPlist = path.join(root, 'Library', 'LaunchAgents', `${launchdLabel}.plist`);
  const supervisorCommand = `/usr/local/bin/node ${aihCommandPath} __background run`;
  fs.mkdirSync(path.dirname(launchdPlist), { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(launchdPlist, 'supervisor plist', 'utf8');
  fs.writeFileSync(pidFile, '2002', 'utf8');

  let launchdLoaded = true;
  let supervisorAlive = true;
  let respawnCount = 0;
  const events = [];
  const spawnCalls = [];
  const launchctlCalls = [];
  const daemon = createServerDaemonService({
    fs,
    path,
    spawn(...args) {
      spawnCalls.push(args);
      throw new Error('server-only spawn must not be used');
    },
    spawnSync(cmd, args) {
      if (cmd === 'launchctl') {
        launchctlCalls.push(args.slice());
        const queryResult = launchctlQueryResult(
          args,
          (label) => label === launchdLabel && launchdLoaded
        );
        if (queryResult) return queryResult;
        if (args[0] === 'bootout' && String(args[1] || '').endsWith(`/${launchdLabel}`)) {
          events.push('bootout');
          launchdLoaded = false;
          return { status: 0, stdout: '', stderr: '' };
        }
      }
      if (cmd === 'lsof' && args.includes('-iTCP:9527')) {
        return supervisorAlive
          ? { status: 0, stdout: '2002\n', stderr: '' }
          : { status: 1, stdout: '', stderr: '' };
      }
      if (cmd === 'ps' && args[0] === '-axo') {
        return {
          status: 0,
          stdout: supervisorAlive ? `2002 ${supervisorCommand}\n` : '',
          stderr: ''
        };
      }
      if (cmd === 'ps' && args[0] === '-p') {
        return supervisorAlive
          ? { status: 0, stdout: `${supervisorCommand}\n`, stderr: '' }
          : { status: 1, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'service not found' };
    },
    processObj: {
      execPath: '/usr/local/bin/node',
      env: {
        AIH_CLI_PATH: aihCommandPath,
        HOME: root,
        PATH: '/opt/homebrew/bin:/usr/bin'
      },
      platform: 'darwin',
      cwd() { return root; },
      kill(pid, signal) {
        if (Number(pid) !== 2002) throw new Error('ESRCH');
        if (signal === 0 || signal === undefined) {
          if (supervisorAlive) return;
          throw new Error('ESRCH');
        }
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          events.push(signal.toLowerCase());
          if (launchdLoaded) {
            respawnCount += 1;
            return;
          }
          supervisorAlive = false;
          return;
        }
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { host: '127.0.0.1', port: 9527 }; },
    readServerConfig() { return { host: '127.0.0.1', port: 9527 }; },
    aiHomeDir,
    hostHomeDir: root,
    pidFile,
    logFile,
    launchdLabel,
    launchdPlist,
    entryFilePath
  });

  const result = daemon.stop({ gracefulStopWaitMs: 20 });
  const status = daemon.getStatus();

  assert.equal(result.stopped, true);
  assert.equal(result.pid, 2002);
  assert.equal(result.stoppedAutostart.loaded, false);
  assert.equal(launchdLoaded, false);
  assert.equal(supervisorAlive, false);
  assert.equal(respawnCount, 0);
  assert.ok(events.indexOf('bootout') < events.indexOf('sigterm'));
  assert.equal(launchctlCalls.filter((args) => args[0] === 'bootout').length, 1);
  assert.equal(spawnCalls.length, 0);
  assert.equal(status.running, false);
  assert.equal(fs.existsSync(pidFile), false);
});

test('daemon service stop fails closed when the loaded macOS supervisor cannot be unloaded', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  const launchdLabel = 'com.clawdcodex.ai_home';
  const launchdPlist = path.join(root, 'Library', 'LaunchAgents', `${launchdLabel}.plist`);
  fs.mkdirSync(path.dirname(launchdPlist), { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(launchdPlist, 'supervisor plist', 'utf8');
  fs.writeFileSync(pidFile, '2002', 'utf8');

  const killCalls = [];
  const spawnCalls = [];
  const daemon = createServerDaemonService({
    fs,
    path,
    spawn(...args) {
      spawnCalls.push(args);
      throw new Error('server-only spawn must not be used');
    },
    spawnSync(cmd, args) {
      if (cmd === 'launchctl') {
        const queryResult = launchctlQueryResult(args, (label) => label === launchdLabel);
        if (queryResult) return queryResult;
        if (args[0] === 'bootout' || args[0] === 'unload') {
          return { status: 1, stdout: '', stderr: 'operation not permitted' };
        }
      }
      return { status: 1, stdout: '', stderr: '' };
    },
    processObj: {
      execPath: '/usr/local/bin/node',
      env: { HOME: root, PATH: '/opt/homebrew/bin:/usr/bin' },
      platform: 'darwin',
      cwd() { return root; },
      kill(pid, signal) {
        killCalls.push({ pid: Number(pid), signal });
        if (Number(pid) === 2002 && (signal === 0 || signal === undefined)) return;
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { host: '127.0.0.1', port: 9527 }; },
    readServerConfig() { return { host: '127.0.0.1', port: 9527 }; },
    aiHomeDir,
    hostHomeDir: root,
    pidFile,
    logFile,
    launchdLabel,
    launchdPlist,
    entryFilePath: '/repo/lib/cli/app.js'
  });

  assert.throws(
    () => daemon.stop({ gracefulStopWaitMs: 20 }),
    { code: 'background_launchd_stop_failed' }
  );
  assert.equal(killCalls.length, 0);
  assert.equal(spawnCalls.length, 0);
  assert.equal(fs.readFileSync(pidFile, 'utf8'), '2002');
});

test('daemon service stop does not terminate external process occupying target port', () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  const killCalls = [];

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn() { throw new Error('not_used'); },
    spawnSync(cmd, args) {
      if (cmd === 'lsof' && args.includes('-iTCP:9527')) return { status: 0, stdout: '2222\n', stderr: '' };
      if (cmd === 'ps' && args[0] === '-axo') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'ps') {
        return {
          status: 0,
          stdout: '/usr/bin/python -m http.server 9527\n',
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
        killCalls.push({ pid: Number(pid), signal });
        if (Number(pid) === 2222 && (signal === 0 || signal === undefined)) return;
        throw new Error('ESRCH');
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { host: '127.0.0.1', port: 9527 }; },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const result = daemon.stop({ gracefulStopWaitMs: 20 });
  assert.equal(result.stopped, false);
  assert.equal(result.reason, 'not_running');
  assert.equal(killCalls.some((call) => call.pid === 2222 && call.signal === 'SIGTERM'), false);
});

test('legacy daemon controller delegates port ownership checks to daemon service', async () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  const spawnCalls = [];

  const daemon = createServerDaemonController({
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServerServeArgs() { return { host: '127.0.0.1', port: 9527 }; },
    aiHomeDir,
    pidFile,
    logFile,
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'com.clawdcodex.ai_home.plist'),
    entryScriptPath: '/repo/lib/cli/app.js',
    nodeExecPath: '/usr/local/bin/node',
    spawn(cmd, args, opts) {
      spawnCalls.push({ cmd, args, opts });
      return { pid: 9999, unref() {} };
    },
    spawnSync(cmd, args) {
      if (cmd === 'lsof' && args.includes('-iTCP:9527')) return { status: 0, stdout: '2222\n', stderr: '' };
      if (cmd === 'ps') return { status: 0, stdout: '/usr/bin/python -m http.server 9527\n', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    },
    processObj: {
      execPath: '/usr/local/bin/node',
      env: process.env,
      platform: process.platform,
      kill(pid, signal) {
        if (Number(pid) === 2222 && (signal === 0 || signal === undefined)) return;
        throw new Error('ESRCH');
      }
    }
  });

  await assert.rejects(
    () => daemon.start([]),
    (error) => error && error.code === 'server_port_in_use' && error.port === 9527
  );
  assert.equal(spawnCalls.length, 0);
});

test('daemon service installs the branded macOS background supervisor', (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const launchdPlist = path.join(root, 'Library', 'LaunchAgents', 'com.clawdcodex.ai_home.plist');
  const legacyLaunchdPlist = path.join(root, 'Library', 'LaunchAgents', 'com.aih.server.plist');
  const launchdLabel = 'com.clawdcodex.ai_home';
  const legacyLaunchdLabel = 'com.aih.server';
  fs.mkdirSync(path.dirname(legacyLaunchdPlist), { recursive: true });
  fs.writeFileSync(legacyLaunchdPlist, 'legacy', 'utf8');
  const loadedLabels = new Set([legacyLaunchdLabel]);
  const calls = [];
  const daemon = createServerDaemonService({
    fs,
    path,
    spawn() { throw new Error('not_used'); },
    spawnSync(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      if (cmd === 'sh' && args[1] === 'command -v aih') {
        return { status: 0, stdout: '/opt/homebrew/bin/aih\n', stderr: '' };
      }
      if (String(cmd).endsWith('/lsregister')) return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'launchctl') {
        const queryResult = launchctlQueryResult(args, (label) => loadedLabels.has(label));
        if (queryResult) return queryResult;
        if (args[0] === 'bootout') {
          loadedLabels.delete(String(args[1] || '').split('/').pop());
        }
        if (args[0] === 'unload') {
          loadedLabels.delete(path.basename(String(args[1] || ''), '.plist'));
        }
        if (args[0] === 'bootstrap' || args[0] === 'load') {
          const plistFile = args[0] === 'bootstrap' ? args[2] : args[1];
          loadedLabels.add(path.basename(String(plistFile || ''), '.plist'));
        }
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    },
    processObj: {
      execPath: '/usr/local/bin/node',
      env: { PATH: '/usr/local/bin:/usr/bin' },
      platform: 'darwin',
      cwd() { return root; },
      kill() { throw new Error('ESRCH'); }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { host: '127.0.0.1', port: 9527 }; },
    readServerConfig() { return { host: '127.0.0.1', port: 9527, apiKey: 'dummy' }; },
    buildServerArgsFromConfig() {
      return ['--host', '127.0.0.1', '--port', '9527', '--api-key', 'dummy'];
    },
    aiHomeDir,
    hostHomeDir: root,
    pidFile: path.join(aiHomeDir, 'server.pid'),
    logFile: path.join(aiHomeDir, 'server.log'),
    launchdLabel,
    launchdPlist,
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const status = daemon.installAutostart();
  const plist = fs.readFileSync(launchdPlist, 'utf8');

  assert.equal(status.supported, true);
  assert.equal(status.type, 'launchd');
  assert.equal(status.installed, true);
  assert.equal(status.loaded, true);
  assert.match(plist, /AI Home\.app\/Contents\/MacOS\/AIHomeBackground<\/string>\s+<string>\/opt\/homebrew\/bin\/aih/);
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/aih<\/string>/);
  assert.match(plist, /<string>__background<\/string>\s+<string>run<\/string>/);
  assert.match(
    plist,
    /<key>AssociatedBundleIdentifiers<\/key>\s+<array>\s+<string>com\.aih\.background<\/string>\s+<\/array>/
  );
  assert.match(plist, /<key>KeepAlive<\/key>\s+<dict>\s+<key>SuccessfulExit<\/key>\s+<false\/>\s+<\/dict>/);
  assert.match(plist, /<key>ExitTimeOut<\/key>\s+<integer>20<\/integer>/);
  assert.doesNotMatch(plist, /<string>server<\/string>\s+<string>serve<\/string>/);
  assert.equal(plist.includes('/usr/local/bin/node'), false);
  assert.equal(fs.existsSync(legacyLaunchdPlist), false);
  assert.equal(calls.some((call) => (
    call.cmd === 'launchctl'
      && call.args[0] === 'bootout'
      && call.args[1].endsWith(`/${legacyLaunchdLabel}`)
  )), true);
  assert.equal(calls.some((call) => (
    call.cmd === 'launchctl'
      && call.args[0] === 'unload'
      && call.args[1] === legacyLaunchdPlist
  )), false);
  assert.equal(calls.some((call) => call.cmd === 'launchctl' && call.args[0] === 'bootstrap'), true);

  const appPath = path.join(
    root,
    'Library',
    'Application Support',
    'AI Home',
    'AI Home.app'
  );
  const infoPlist = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
  const appExecutable = path.join(appPath, 'Contents', 'MacOS', 'AIHomeBackground');
  assert.match(infoPlist, /<key>CFBundleDisplayName<\/key>\s+<string>AI Home<\/string>/);
  assert.match(infoPlist, /<key>CFBundleIdentifier<\/key>\s+<string>com\.aih\.background<\/string>/);
  assert.equal(fs.readFileSync(appExecutable, 'utf8'), '#!/bin/sh\nexec "$@"\n');
  assert.equal(fs.existsSync(path.join(appPath, 'Contents', 'Resources', 'AIHome.icns')), true);
});

test('daemon service start reloads an installed macOS supervisor instead of spawning server-only', async (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { repoDir, entryFilePath } = makeSourceCheckout(root);
  const aihCommandPath = makeAihCommandShim(root, repoDir);
  const aiHomeDir = path.join(root, '.ai_home');
  const launchdPlist = path.join(root, 'Library', 'LaunchAgents', 'com.clawdcodex.ai_home.plist');
  fs.mkdirSync(path.dirname(launchdPlist), { recursive: true });
  fs.writeFileSync(launchdPlist, 'legacy server plist', 'utf8');
  let launchdLoaded = false;
  let supervisorAlive = false;
  const launchdLabel = 'com.clawdcodex.ai_home';
  const launchctlCalls = [];
  const spawnCalls = [];
  const supervisorCommand = `/usr/local/bin/node ${aihCommandPath} __background run`;

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn(...args) {
      spawnCalls.push(args);
      throw new Error('server-only spawn must not be used');
    },
    spawnSync(cmd, args) {
      if (cmd === 'launchctl') {
        launchctlCalls.push(args.slice());
        const queryResult = launchctlQueryResult(
          args,
          (label) => label === launchdLabel && launchdLoaded
        );
        if (queryResult) return queryResult;
        if (args[0] === 'bootout' || args[0] === 'unload') {
          const target = String(args[1] || '');
          if (target === launchdPlist || target.endsWith(`/${launchdLabel}`)) {
            launchdLoaded = false;
            supervisorAlive = false;
          }
          return { status: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'bootstrap' || args[0] === 'load') {
          launchdLoaded = true;
          supervisorAlive = true;
          return { status: 0, stdout: '', stderr: '' };
        }
      }
      if (cmd === 'lsof') {
        return supervisorAlive
          ? { status: 0, stdout: '2002\n', stderr: '' }
          : { status: 1, stdout: '', stderr: '' };
      }
      if (cmd === 'ps' && args[0] === '-axo') {
        return {
          status: 0,
          stdout: supervisorAlive ? `2002 ${supervisorCommand}\n` : '',
          stderr: ''
        };
      }
      if (cmd === 'ps' && args[0] === '-p') {
        return supervisorAlive
          ? { status: 0, stdout: `${supervisorCommand}\n`, stderr: '' }
          : { status: 1, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
    fetchImpl: async () => ({ ok: true }),
    processObj: {
      execPath: '/usr/local/bin/node',
      env: {
        AIH_CLI_PATH: aihCommandPath,
        HOME: root,
        PATH: '/opt/homebrew/bin:/usr/bin'
      },
      platform: 'darwin',
      cwd() { return root; },
      kill(pid, signal) {
        if (Number(pid) !== 2002 || !supervisorAlive) throw new Error('ESRCH');
        if (signal === 'SIGTERM') supervisorAlive = false;
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { host: '127.0.0.1', port: 9527 }; },
    readServerConfig() { return { host: '127.0.0.1', port: 9527 }; },
    buildServerArgsFromConfig() { return ['--host', '127.0.0.1', '--port', '9527']; },
    aiHomeDir,
    hostHomeDir: root,
    pidFile: path.join(aiHomeDir, 'server.pid'),
    logFile: path.join(aiHomeDir, 'server.log'),
    launchdLabel,
    launchdPlist,
    entryFilePath
  });

  const result = await daemon.start([]);
  const plist = fs.readFileSync(launchdPlist, 'utf8');

  assert.equal(result.started, true);
  assert.equal(result.ready, true);
  assert.equal(result.pid, 2002);
  assert.equal(spawnCalls.length, 0);
  assert.match(plist, /<string>__background<\/string>\s+<string>run<\/string>/);
  assert.equal(launchctlCalls.some((args) => args[0] === 'bootstrap'), true);
});

test('daemon service installs Linux systemd user autostart with saved serve config', () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  const legacyUnitFile = path.join(root, '.config', 'systemd', 'user', 'com.aih.server.service');
  const deployedLegacyUnitFile = path.join(root, '.config', 'systemd', 'user', 'aih-server.service');
  fs.mkdirSync(path.dirname(legacyUnitFile), { recursive: true });
  fs.writeFileSync(legacyUnitFile, 'legacy', 'utf8');
  fs.writeFileSync(deployedLegacyUnitFile, 'legacy', 'utf8');
  const calls = [];
  const daemon = createServerDaemonService({
    fs,
    path,
    spawn() { throw new Error('not_used'); },
    spawnSync(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      if (cmd === 'sh' && args[1] === 'command -v aih') {
        return { status: 0, stdout: '/usr/local/bin/aih\n', stderr: '' };
      }
      if (cmd === 'systemctl') return { status: 0, stdout: 'enabled\n', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    },
    processObj: {
      execPath: '/usr/bin/node',
      env: { PATH: '/usr/local/bin:/usr/bin' },
      platform: 'linux',
      cwd() { return root; },
      kill() { throw new Error('ESRCH'); }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { host: '127.0.0.1', port: 9527 }; },
    readServerConfig() { return { host: '127.0.0.1', port: 9527, apiKey: 'dummy' }; },
    buildServerArgsFromConfig() {
      return ['--host', '127.0.0.1', '--port', '9527', '--api-key', 'dummy'];
    },
    aiHomeDir,
    hostHomeDir: root,
    pidFile: path.join(aiHomeDir, 'server.pid'),
    logFile: path.join(aiHomeDir, 'server.log'),
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'unused.plist'),
    entryFilePath: '/repo/lib/cli/app.js'
  });

  const status = daemon.installAutostart();
  const unitFile = path.join(root, '.config', 'systemd', 'user', 'com.clawdcodex.ai_home.service');
  const unit = fs.readFileSync(unitFile, 'utf8');

  assert.equal(status.supported, true);
  assert.equal(status.type, 'systemd-user');
  assert.equal(status.installed, true);
  assert.equal(status.enabled, true);
  assert.match(unit, /ExecStart="\/usr\/local\/bin\/aih" "server" "serve"/);
  assert.match(unit, /"--port" "9527"/);
  assert.equal(unit.includes('/usr/bin/node'), false);
  assert.equal(fs.existsSync(legacyUnitFile), false);
  assert.equal(fs.existsSync(deployedLegacyUnitFile), false);
  assert.equal(calls.some((call) => call.cmd === 'systemctl' && call.args.join(' ') === '--user disable --now com.aih.server.service'), true);
  assert.equal(calls.some((call) => call.cmd === 'systemctl' && call.args.join(' ') === '--user disable --now aih-server.service'), true);
  assert.equal(calls.some((call) => call.cmd === 'systemctl' && call.args.join(' ') === '--user enable --now com.clawdcodex.ai_home.service'), true);
});

test('daemon service installs Windows Startup script for login autostart', () => {
  const root = makeTempDir();
  const aiHomeDir = path.join(root, '.ai_home');
  const appData = path.join(root, 'AppData', 'Roaming');
  const legacyScriptPath = path.join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'com.aih.server.cmd'
  );
  fs.mkdirSync(path.dirname(legacyScriptPath), { recursive: true });
  fs.writeFileSync(legacyScriptPath, 'legacy', 'utf8');
  const daemon = createServerDaemonService({
    fs,
    path,
    spawn() { throw new Error('not_used'); },
    spawnSync(cmd, args) {
      if (cmd === 'where' && args[0] === 'aih') {
        return { status: 0, stdout: 'C:\\Users\\model\\AppData\\Roaming\\npm\\aih.cmd\r\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    },
    processObj: {
      execPath: 'C:\\Node\\node.exe',
      env: { APPDATA: appData, PATH: 'C:\\Node' },
      platform: 'win32',
      cwd() { return root; },
      kill() { throw new Error('ESRCH'); }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { host: '127.0.0.1', port: 9527 }; },
    aiHomeDir,
    hostHomeDir: root,
    pidFile: path.join(aiHomeDir, 'server.pid'),
    logFile: path.join(aiHomeDir, 'server.log'),
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'unused.plist'),
    entryFilePath: 'C:\\repo\\lib\\cli\\app.js'
  });

  const status = daemon.installAutostart();
  const scriptPath = path.join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'com.clawdcodex.ai_home.vbs'
  );
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.equal(status.supported, true);
  assert.equal(status.type, 'windows-startup');
  assert.equal(status.installed, true);
  assert.equal(status.loaded, true);
  assert.equal(script.includes('""C:\\Users\\model\\AppData\\Roaming\\npm\\aih.cmd"" ""server"" ""start""'), true);
  assert.equal(script.includes('shell.Run'), true);
  assert.equal(script.includes(', 0, False'), true);
  assert.equal(script.includes('C:\\Node\\node.exe'), false);
  assert.equal(fs.existsSync(legacyScriptPath), false);
});

test('daemon service preserves Windows access denied as a restart elevation signal', async (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { entryFilePath } = makeSourceCheckout(root);
  const aiHomeDir = path.join(root, '.ai_home');
  const pidFile = path.join(aiHomeDir, 'server.pid');
  const logFile = path.join(aiHomeDir, 'server.log');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(pidFile, '9001', 'utf8');
  const commandLine = `"C:\\Program Files\\nodejs\\node.exe" "${entryFilePath}" server serve --host 127.0.0.1 --port 9527`;
  let backgroundSpawnCalls = 0;

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn() {
      backgroundSpawnCalls += 1;
      return { pid: 9002, unref() {} };
    },
    spawnSync(command, args) {
      if (command === 'powershell.exe' && args.includes('-Command')) {
        const script = args[args.indexOf('-Command') + 1];
        if (script.includes('Get-CimInstance Win32_Process |')) {
          return { status: 0, stdout: `9001 ${commandLine}\n`, stderr: '' };
        }
        if (script.includes('ProcessId=9001')) {
          return { status: 0, stdout: `${commandLine}\n`, stderr: '' };
        }
      }
      return { status: 1, stdout: '', stderr: '' };
    },
    fetchImpl: async () => ({ ok: false }),
    processObj: {
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      env: {},
      platform: 'win32',
      cwd: () => root,
      kill() {
        const error = new Error('Access is denied');
        error.code = 'EPERM';
        throw error;
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { host: '127.0.0.1', port: 9527 }; },
    aiHomeDir,
    hostHomeDir: root,
    pidFile,
    logFile,
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'server.plist'),
    entryFilePath
  });

  const result = await daemon.restart([], { waitForReady: false, gracefulStopWaitMs: 20 });
  assert.equal(result.started, false);
  assert.equal(result.stoppedForRestart.stopped, false);
  assert.equal(result.stoppedForRestart.reason, 'permission_denied');
  assert.equal(result.stoppedForRestart.pid, 9001);
  assert.equal(backgroundSpawnCalls, 0);
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), '9001');
});

test('daemon restart elevates when tracked admin pid owns the configured port but command line is unreadable', async (t) => {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { entryFilePath } = makeSourceCheckout(root);
  const aiHomeDir = path.join(root, '.ai_home');
  const pidFile = path.join(aiHomeDir, 'server.pid');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.writeFileSync(pidFile, '3800', 'utf8');

  const daemon = createServerDaemonService({
    fs,
    path,
    spawn() { throw new Error('must not spawn before elevation'); },
    spawnSync(command, args) {
      if (command === 'cmd.exe' && args.some((arg) => String(arg).includes('netstat'))) {
        return { status: 0, stdout: 'TCP 127.0.0.1:9527 0.0.0.0:0 LISTENING 3800\r\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    },
    fetchImpl: async () => ({ ok: false }),
    processObj: {
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      env: {},
      platform: 'win32',
      cwd: () => root,
      kill() {
        const error = new Error('Access is denied');
        error.code = 'EPERM';
        throw error;
      }
    },
    ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); },
    parseServeArgs() { return { host: '127.0.0.1', port: 9527 }; },
    aiHomeDir,
    hostHomeDir: root,
    pidFile,
    logFile: path.join(aiHomeDir, 'server.log'),
    launchdLabel: 'com.clawdcodex.ai_home',
    launchdPlist: path.join(root, 'server.plist'),
    entryFilePath
  });

  const result = await daemon.restart([], { waitForReady: false, gracefulStopWaitMs: 20 });
  assert.equal(result.started, false);
  assert.equal(result.stoppedForRestart.reason, 'permission_denied');
  assert.equal(result.stoppedForRestart.pid, 3800);
  assert.equal(result.stoppedForRestart.port, 9527);
});
