const test = require('node:test');
const assert = require('node:assert/strict');

const {
  abortNativeSessionRun,
  readNativeSessionRunEvents,
  startNativeDeviceSession
} = require('../lib/server/control-plane-device-session-start');

function createPendingNativeStream(runId = 'native-run-test') {
  return {
    runId,
    done: new Promise(() => {}),
    writeInput() {},
    resize() {},
    abort() {}
  };
}

test('startNativeDeviceSession registers codex project trust before spawning native CLI', () => {
  const observed = { order: [] };

  const result = startNativeDeviceSession({
    provider: 'codex',
    accountId: '3',
    prompt: 'hello',
    projectPath: '/repo/project',
    model: 'gpt-5.5'
  }, {
    env: { AIH_HOST_HOME: '/host-home' },
    hostHomeDir: '/host-home',
    getProfileDir: (provider, accountId) => `/profiles/${provider}/${accountId}`,
    ensureSessionStoreLinks() {},
    ensureCodexProjectRegistered(projectPath, options) {
      observed.order.push('trust');
      observed.trust = { projectPath, options };
      return { ok: true, updated: true };
    },
    spawnNativeSessionStream(options) {
      observed.order.push('spawn');
      observed.spawn = options;
      return createPendingNativeStream('native-run-codex-trust');
    },
    registerNativeChatRun(run) {
      observed.run = run;
    },
    unregisterNativeChatRun() {}
  });

  assert.equal(result.accepted, true);
  assert.equal(result.runId, 'native-run-codex-trust');
  assert.deepEqual(observed.trust, {
    projectPath: '/repo/project',
    options: {
      hostHomeDir: '/profiles/codex/3',
      codexHomeDir: '/profiles/codex/3/.codex',
      processObj: {
        env: { AIH_HOST_HOME: '/host-home' },
        platform: process.platform
      }
    }
  });
  assert.equal(observed.spawn.provider, 'codex');
  assert.equal(observed.spawn.projectPath, '/repo/project');
  assert.equal(observed.spawn.interactiveCli, true);
  assert.deepEqual(observed.order, ['trust', 'spawn']);
  assert.equal(observed.run.runId, 'native-run-codex-trust');
});

test('startNativeDeviceSession skips codex trust registration for non-codex providers', () => {
  let trustCalls = 0;

  const result = startNativeDeviceSession({
    provider: 'claude',
    accountId: '4',
    prompt: 'hello',
    projectPath: '/repo/project'
  }, {
    getProfileDir: (provider, accountId) => `/profiles/${provider}/${accountId}`,
    ensureCodexProjectRegistered() {
      trustCalls += 1;
      return { ok: true };
    },
    spawnNativeSessionStream() {
      return createPendingNativeStream('native-run-claude');
    },
    registerNativeChatRun() {},
    unregisterNativeChatRun() {}
  });

  assert.equal(result.accepted, true);
  assert.equal(result.runId, 'native-run-claude');
  assert.equal(trustCalls, 0);
});

test('abortNativeSessionRun aborts active run and marks it completed', () => {
  let aborted = false;

  const result = startNativeDeviceSession({
    provider: 'codex',
    accountId: '1',
    prompt: 'hello',
    projectPath: '/repo/project'
  }, {
    getProfileDir: (provider, accountId) => `/profiles/${provider}/${accountId}`,
    ensureCodexProjectRegistered: () => ({ ok: true }),
    spawnNativeSessionStream() {
      return {
        ...createPendingNativeStream('native-run-abort'),
        abort() {
          aborted = true;
        }
      };
    }
  });

  assert.equal(result.accepted, true);
  const abortedResult = abortNativeSessionRun({ runId: result.runId });
  assert.equal(abortedResult.accepted, true);
  assert.equal(aborted, true);

  const events = readNativeSessionRunEvents({ runId: result.runId, cursor: 0 });
  assert.equal(events.completed, true);
  assert.ok(events.events.some((event) => event.type === 'aborted'));
});
