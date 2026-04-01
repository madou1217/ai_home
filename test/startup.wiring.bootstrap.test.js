const test = require('node:test');
const assert = require('node:assert/strict');
const { createStartupWiring } = require('../lib/cli/bootstrap/startup-wiring');

test('createStartupWiring resolves paths, configures encoding, and builds profile layout', () => {
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
        profilesDir: '/tmp/home/.ai_home/profiles',
        serverPidFile: '/tmp/home/.ai_home/server.pid',
        serverLogFile: '/tmp/home/.ai_home/server.log',
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
        getProfileDir: () => '/tmp/home/.ai_home/profiles/codex/10086'
      };
    }
  });

  assert.equal(out.hostHomeDir, '/tmp/home');
  assert.equal(out.aiHomeDir, '/tmp/home/.ai_home');
  assert.equal(out.profilesDir, '/tmp/home/.ai_home/profiles');
  assert.equal(out.serverPidFile, '/tmp/home/.ai_home/server.pid');
  assert.equal(out.serverLogFile, '/tmp/home/.ai_home/server.log');
  assert.equal(out.serverLaunchdPlist, '/tmp/home/Library/LaunchAgents/aih.test.plist');
  assert.equal(typeof out.ensureDir, 'function');
  assert.equal(typeof out.getProfileDir, 'function');
  assert.equal(calls.resolveArg.launchdLabel, 'aih.test');
  assert.equal(calls.configured, true);
  assert.equal(calls.profileLayoutArg.profilesDir, '/tmp/home/.ai_home/profiles');
});
