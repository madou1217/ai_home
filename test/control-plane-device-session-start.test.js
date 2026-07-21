const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  abortNativeSessionRun,
  DEFAULT_COMPLETED_RUN_RETENTION_MS,
  readNativeSessionRunEvents,
  normalizeSessionStartPayload,
  resolveCompletedRunRetentionMs,
  startNativeDeviceSession
} = require('../lib/server/control-plane-device-session-start');
const {
  clearSessionArtifacts,
  readSessionArtifact
} = require('../lib/server/control-plane-device-session-artifact-store');
const { unregisterNativeChatRun } = require('../lib/server/native-chat-run-store');
const { getPublicAccountRef } = require('../lib/account/public-account-ref');

const CODEX_ACCOUNT_REF = getPublicAccountRef('unique:codex-session-start@example.com');
const CLAUDE_ACCOUNT_REF = getPublicAccountRef('unique:claude-session-start@example.com');
const OPENCODE_ACCOUNT_REF = getPublicAccountRef('unique:opencode-session-start@example.com');

function createPendingNativeStream(runId = 'native-run-test') {
  return {
    runId,
    done: new Promise(() => {}),
    writeInput() {},
    resize() {},
    abort() {}
  };
}

test('resolveCompletedRunRetentionMs keeps completed run history long enough for reconnects', () => {
  assert.equal(DEFAULT_COMPLETED_RUN_RETENTION_MS, 30 * 60 * 1000);
  assert.equal(resolveCompletedRunRetentionMs({}), DEFAULT_COMPLETED_RUN_RETENTION_MS);
  assert.equal(resolveCompletedRunRetentionMs({ AIH_NATIVE_RUN_RETENTION_MS: '120000' }), 120000);
  assert.equal(resolveCompletedRunRetentionMs({ AIH_SESSION_RUN_RETENTION_MS: '240000' }), 240000);
  assert.equal(resolveCompletedRunRetentionMs({ AIH_NATIVE_RUN_RETENTION_MS: '100' }), 60 * 1000);
  assert.equal(
    resolveCompletedRunRetentionMs({ AIH_NATIVE_RUN_RETENTION_MS: String(48 * 60 * 60 * 1000) }),
    24 * 60 * 60 * 1000
  );
  assert.equal(resolveCompletedRunRetentionMs({ AIH_NATIVE_RUN_RETENTION_MS: 'not-a-number' }), DEFAULT_COMPLETED_RUN_RETENTION_MS);
});

test('normalizeSessionStartPayload rejects non-canonical account keys', () => {
  ['accountId', 'account_id', 'account_ref'].forEach((field) => {
    assert.throws(
      () => normalizeSessionStartPayload({ provider: 'codex', [field]: CODEX_ACCOUNT_REF }),
      (error) => error && error.code === 'non_canonical_account_ref' && error.statusCode === 400
    );
  });
});

test('startNativeDeviceSession registers codex project trust before spawning native CLI', () => {
  const observed = { order: [] };

  const result = startNativeDeviceSession({
    provider: 'codex',
    accountRef: CODEX_ACCOUNT_REF,
    prompt: 'hello',
    projectPath: '/repo/project',
    model: 'gpt-5.5'
  }, {
    env: { AIH_HOST_HOME: '/host-home' },
    hostHomeDir: '/host-home',
    getProfileDir: (provider, accountRef) => `/profiles/${provider}/${accountRef}`,
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
      hostHomeDir: `/profiles/codex/${CODEX_ACCOUNT_REF}`,
      codexHomeDir: `/profiles/codex/${CODEX_ACCOUNT_REF}/.codex`,
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

test('startNativeDeviceSession resolves a default accountRef when omitted', () => {
  const observed = {};

  const result = startNativeDeviceSession({
    provider: 'codex',
    prompt: 'hello',
    projectPath: '/repo/project',
    model: 'gpt-5.5'
  }, {
    getProfileDir: (provider, accountRef) => `/profiles/${provider}/${accountRef}`,
    resolveSessionAccountRef(input) {
      observed.resolve = input;
      return CODEX_ACCOUNT_REF;
    },
    ensureCodexProjectRegistered: () => ({ ok: true }),
    spawnNativeSessionStream(options) {
      observed.spawn = options;
      return createPendingNativeStream('native-run-default-account');
    },
    registerNativeChatRun() {},
    unregisterNativeChatRun() {}
  });

  assert.equal(result.accepted, true);
  assert.equal(result.accountRef, CODEX_ACCOUNT_REF);
  assert.equal(observed.resolve.provider, 'codex');
  assert.equal(observed.resolve.model, 'gpt-5.5');
  assert.equal(observed.spawn.accountRef, CODEX_ACCOUNT_REF);
});

test('startNativeDeviceSession skips codex trust registration for non-codex providers', () => {
  let trustCalls = 0;
  let spawnOptions = null;

  const result = startNativeDeviceSession({
    provider: 'claude',
    accountRef: CLAUDE_ACCOUNT_REF,
    prompt: 'hello',
    projectPath: '/repo/project'
  }, {
    getProfileDir: (provider, accountRef) => `/profiles/${provider}/${accountRef}`,
    ensureCodexProjectRegistered() {
      trustCalls += 1;
      return { ok: true };
    },
    spawnNativeSessionStream(options) {
      spawnOptions = options;
      return createPendingNativeStream('native-run-claude');
    },
    registerNativeChatRun() {},
    unregisterNativeChatRun() {}
  });

  assert.equal(result.accepted, true);
  assert.equal(result.runId, 'native-run-claude');
  assert.equal(trustCalls, 0);
  assert.equal(spawnOptions.interactiveCli, false);
  assert.equal(spawnOptions.completeOnTranscriptUpdate, false);
});

test('startNativeDeviceSession starts opencode in headless run mode', () => {
  let spawnOptions = null;

  const result = startNativeDeviceSession({
    provider: 'opencode',
    accountRef: OPENCODE_ACCOUNT_REF,
    prompt: 'hello',
    projectPath: '/repo/project'
  }, {
    getProfileDir: (provider, accountRef) => `/profiles/${provider}/${accountRef}`,
    resolveSessionAccountRef() {
      throw new Error('accountRef should be explicit');
    },
    spawnNativeSessionStream(options) {
      spawnOptions = options;
      return createPendingNativeStream('native-run-opencode');
    },
    registerNativeChatRun() {},
    unregisterNativeChatRun() {}
  });

  assert.equal(result.accepted, true);
  assert.equal(result.provider, 'opencode');
  assert.equal(result.runId, 'native-run-opencode');
  assert.equal(spawnOptions.provider, 'opencode');
  assert.equal(spawnOptions.accountRef, OPENCODE_ACCOUNT_REF);
  assert.equal(spawnOptions.projectPath, '/repo/project');
  assert.equal(spawnOptions.interactiveCli, false);
  assert.equal(spawnOptions.completeOnTranscriptUpdate, false);
});

test('startNativeDeviceSession can force opencode interactive slash input', () => {
  let spawnOptions = null;

  const result = startNativeDeviceSession({
    provider: 'opencode',
    accountRef: OPENCODE_ACCOUNT_REF,
    initialInput: '/status',
    interactiveCli: true,
    sessionId: 'ses-opencode-slash',
    projectPath: '/repo/project'
  }, {
    getProfileDir: (provider, accountRef) => `/profiles/${provider}/${accountRef}`,
    spawnNativeSessionStream(options) {
      spawnOptions = options;
      return createPendingNativeStream('native-run-opencode-slash');
    },
    registerNativeChatRun() {},
    unregisterNativeChatRun() {}
  });

  assert.equal(result.accepted, true);
  assert.equal(result.runId, 'native-run-opencode-slash');
  assert.equal(spawnOptions.provider, 'opencode');
  assert.equal(spawnOptions.sessionId, 'ses-opencode-slash');
  assert.equal(spawnOptions.prompt, '');
  assert.equal(spawnOptions.initialInput, '/status');
  assert.equal(spawnOptions.interactiveCli, true);
  assert.equal(spawnOptions.completeOnTranscriptUpdate, false);
});

test('startNativeDeviceSession applies session artifact threshold to terminal events', () => {
  const observed = {};
  const result = startNativeDeviceSession({
    provider: 'codex',
    accountRef: CODEX_ACCOUNT_REF,
    prompt: 'hello',
    projectPath: '/repo/project',
    artifactThreshold: 128
  }, {
    env: { AIH_SESSION_ARTIFACT_THRESHOLD: '9999' },
    getProfileDir: (provider, accountRef) => `/profiles/${provider}/${accountRef}`,
    ensureCodexProjectRegistered: () => ({ ok: true }),
    spawnNativeSessionStream(options) {
      observed.spawn = options;
      return createPendingNativeStream('native-run-artifact-threshold');
    }
  });

  observed.spawn.onEvent({
    type: 'terminal-output',
    text: 'x'.repeat(300)
  });

  const events = readNativeSessionRunEvents({ runId: result.runId, cursor: 0 });
  const artifactEvent = events.events.find((event) => event.type === 'artifact_ref');
  assert.ok(artifactEvent);
  assert.equal(artifactEvent.artifact.kind, 'terminal-output');
  assert.equal(artifactEvent.artifact.byteLength, 300);

  abortNativeSessionRun({ runId: result.runId });
});

test('abortNativeSessionRun aborts active run and marks it completed', () => {
  let aborted = false;

  const result = startNativeDeviceSession({
    provider: 'codex',
    accountRef: CODEX_ACCOUNT_REF,
    prompt: 'hello',
    projectPath: '/repo/project'
  }, {
    getProfileDir: (provider, accountRef) => `/profiles/${provider}/${accountRef}`,
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

test('native session run events and artifacts survive memory cleanup', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-run-persistence-'));
  const terminalText = 'persisted terminal output '.repeat(20);
  const observed = {};
  t.after(() => {
    unregisterNativeChatRun('native-run-persisted');
    clearSessionArtifacts();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });

  const result = startNativeDeviceSession({
    provider: 'codex',
    accountRef: CODEX_ACCOUNT_REF,
    prompt: 'hello',
    projectPath: '/repo/project',
    artifactThreshold: 128
  }, {
    aiHomeDir,
    getProfileDir: (provider, accountRef) => `/profiles/${provider}/${accountRef}`,
    ensureCodexProjectRegistered: () => ({ ok: true }),
    spawnNativeSessionStream(options) {
      observed.onEvent = options.onEvent;
      return createPendingNativeStream('native-run-persisted');
    }
  });

  observed.onEvent({
    type: 'terminal-output',
    text: terminalText
  });

  const activeEvents = readNativeSessionRunEvents({ runId: result.runId, cursor: 0, aiHomeDir });
  const artifactEvent = activeEvents.events.find((event) => event.type === 'artifact_ref');
  assert.ok(artifactEvent);
  assert.equal(artifactEvent.artifact.byteLength, Buffer.byteLength(terminalText, 'utf8'));

  abortNativeSessionRun({ runId: result.runId }, { aiHomeDir, unregisterNativeChatRun });
  unregisterNativeChatRun(result.runId);
  clearSessionArtifacts();

  const persistedEvents = readNativeSessionRunEvents({ runId: result.runId, cursor: 0, aiHomeDir });
  assert.equal(persistedEvents.persisted, true);
  assert.equal(persistedEvents.completed, true);
  assert.equal(persistedEvents.status, 'completed');
  assert.ok(persistedEvents.events.some((event) => event.type === 'ready'));
  assert.ok(persistedEvents.events.some((event) => event.type === 'artifact_ref'));
  assert.ok(persistedEvents.events.some((event) => event.type === 'aborted'));

  const artifact = readSessionArtifact({ artifactId: artifactEvent.artifactId }, { aiHomeDir });
  assert.equal(artifact.content, terminalText);
});
