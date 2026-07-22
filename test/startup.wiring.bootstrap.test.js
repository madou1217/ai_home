const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createStartupWiring } = require('../lib/cli/bootstrap/startup-wiring');

test('createStartupWiring resolves paths, configures encoding, and builds runtime layout', () => {
  const calls = {
    resolveArg: null,
    configured: false,
    profileLayoutArg: null
  };

  const out = createStartupWiring({
    path: {},
    fs: {},
    env: { HOME: '/tmp/home' },
    platform: 'darwin',
    os: {},
    launchdLabel: 'aih.test'
  }, {
    resolveCliPaths: (arg) => {
      calls.resolveArg = arg;
      return {
        hostHomeDir: '/tmp/home',
        aiHomeDir: '/tmp/home/.ai_home',
        serverPidFile: '/tmp/home/.ai_home/run/server.pid',
        serverLogFile: '/tmp/home/.ai_home/logs/server.log',
        serverLaunchdPlist: '/tmp/home/Library/LaunchAgents/aih.test.plist'
      };
    },
    configureConsoleEncoding: () => {
      calls.configured = true;
    },
    createProfileLayoutService: (arg) => {
      calls.profileLayoutArg = arg;
      return {
        ensureDir: () => {},
        getProfileDir: () => '/tmp/home/.ai_home/run/auth-projections/codex/acct_11111111111111111111'
      };
    }
  });

  assert.equal(out.hostHomeDir, '/tmp/home');
  assert.equal(out.aiHomeDir, '/tmp/home/.ai_home');
  assert.equal(out.serverPidFile, '/tmp/home/.ai_home/run/server.pid');
  assert.equal(out.serverLogFile, '/tmp/home/.ai_home/logs/server.log');
  assert.equal(out.serverLaunchdPlist, '/tmp/home/Library/LaunchAgents/aih.test.plist');
  assert.equal(typeof out.ensureDir, 'function');
  assert.equal(typeof out.getProfileDir, 'function');
  assert.equal(calls.resolveArg.launchdLabel, 'aih.test');
  assert.equal(calls.configured, true);
  assert.equal(calls.profileLayoutArg.aiHomeDir, '/tmp/home/.ai_home');
});

test('createStartupWiring decodes encoded Windows codex home before deriving paths', () => {
  const colon = String.fromCharCode(0xf03a);
  const backslash = String.fromCharCode(0xf05c);
  let profileLayoutArg = null;

  const out = createStartupWiring({
    path: path.win32,
    fs: {},
    env: {
      AIH_HOST_HOME: `C${colon}${backslash}Users${backslash}alice${backslash}.codex`
    },
    platform: 'win32',
    os: { userInfo: () => ({ homedir: 'C:\\Users\\fallback' }), homedir: () => 'C:\\Users\\os-home' },
    launchdLabel: 'aih.test'
  }, {
    configureConsoleEncoding: () => {},
    createProfileLayoutService: (arg) => {
      profileLayoutArg = arg;
      return {
        ensureDir: () => {},
        getProfileDir: () => 'C:\\Users\\alice\\.ai_home\\run\\accounts\\codex\\acct_11111111111111111111'
      };
    }
  });

  assert.equal(out.hostHomeDir, 'C:/Users/alice');
  assert.equal(out.aiHomeDir, 'C:\\Users\\alice\\.ai_home');
  assert.equal(profileLayoutArg.aiHomeDir, 'C:\\Users\\alice\\.ai_home');
});

test('createStartupWiring keeps explicit AIH_HOME across Windows elevation home changes', () => {
  let profileLayoutArg = null;

  const out = createStartupWiring({
    path: path.win32,
    fs: {},
    env: {
      AIH_HOME: 'C:\\Users\\alice\\.ai_home',
      USERPROFILE: 'C:\\Windows\\System32\\config\\systemprofile'
    },
    platform: 'win32',
    os: {
      userInfo: () => ({ homedir: 'C:\\Windows\\System32\\config\\systemprofile' }),
      homedir: () => 'C:\\Windows\\System32\\config\\systemprofile'
    },
    launchdLabel: 'aih.test'
  }, {
    configureConsoleEncoding: () => {},
    createProfileLayoutService: (arg) => {
      profileLayoutArg = arg;
      return {
        ensureDir: () => {},
        getProfileDir: () => 'C:\\Users\\alice\\.ai_home\\run\\auth-projections\\codex\\acct_11111111111111111111'
      };
    }
  });

  assert.equal(out.hostHomeDir, 'C:\\Windows\\System32\\config\\systemprofile');
  assert.equal(out.aiHomeDir, 'C:\\Users\\alice\\.ai_home');
  assert.equal(out.serverPidFile, 'C:\\Users\\alice\\.ai_home\\run\\server.pid');
  assert.equal(out.serverLogFile, 'C:\\Users\\alice\\.ai_home\\logs\\server.log');
  assert.equal(profileLayoutArg.aiHomeDir, 'C:\\Users\\alice\\.ai_home');
});
