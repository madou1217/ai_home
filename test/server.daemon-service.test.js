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
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), '7777');
});
