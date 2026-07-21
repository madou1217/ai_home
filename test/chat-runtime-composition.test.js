'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  createChatRuntimeComposition
} = require('../lib/server/chat-runtime-composition');
const {
  createNativeInteractionId
} = require('../lib/server/chat-runtime/native-interaction-id');

function interactionId(sessionId, requestId) {
  return createNativeInteractionId({
    provider: 'codex',
    sessionId,
    nativeThreadId: 'native-thread-1',
    nativeRequestId: String(requestId)
  });
}

test('composition wires the Codex driver to persistent, transient, and binding ports', async (t) => {
  const fixture = createFixture(t);
  const transient = [];
  const session = await fixture.service.createSession({
    sessionId: 'session-1',
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo'
  });
  fixture.service.subscribe(session.sessionId, (event) => {
    if (event.type === 'stream.error') transient.push(event);
  });

  await fixture.service.dispatchCommand(session.sessionId, {
    commandId: 'command-1',
    type: 'turn.submit',
    payload: { content: 'work' }
  });
  await waitFor(() => fixture.client.binding('native-thread-1'));
  await waitFor(() => (
    fixture.service.getSnapshot(session.sessionId).activeTurn.nativeTurnId
  ));
  assert.equal(
    fixture.service.getSnapshot(session.sessionId).activeTurn.nativeTurnId,
    'native-turn-1'
  );
  assert.equal(
    fixture.service.getSnapshot(session.sessionId).activeTurn.clientUserMessageId,
    fixture.client.params('turn/start').clientUserMessageId
  );

  fixture.client.notify('item/started', {
    threadId: 'native-thread-1',
    turnId: 'native-turn-1',
    item: { id: 'item-1', type: 'agentMessage', text: 'hello', status: 'inProgress' }
  });
  fixture.client.notify('item/future', { threadId: 'native-thread-1' });
  fixture.client.requestFromServer(41, 'item/commandExecution/requestApproval', {
    threadId: 'native-thread-1',
    turnId: 'native-turn-1',
    itemId: 'approval-item-1',
    command: 'npm test',
    cwd: '/repo',
    availableDecisions: ['accept']
  });
  await waitFor(() => fixture.service.getSnapshot(session.sessionId).interactions.length === 1);
  const pendingApproval = fixture.service.getSnapshot(session.sessionId).interactions[0];
  assert.equal(pendingApproval.interactionId, interactionId(session.sessionId, 41));
  assert.equal(pendingApproval.state, 'pending');
  fixture.service.store.context.db.exec(`
    CREATE TRIGGER reject_native_resolution_event
    BEFORE INSERT ON chat_runtime_events
    WHEN NEW.type = 'interaction.resolved'
    BEGIN SELECT RAISE(ABORT, 'reject_event'); END
  `);
  await assert.rejects(fixture.service.dispatchCommand(session.sessionId, {
    commandId: 'command-approve',
    type: 'approval.decide',
    payload: {
      interactionId: pendingApproval.interactionId,
      revision: pendingApproval.revision,
      choiceId: 'choice-0'
    }
  }), /reject_event/);
  const resolving = fixture.service.store.interactions.get(pendingApproval.interactionId);
  assert.equal(resolving.state, 'resolving');
  assert.deepEqual(resolving.resolution, { choiceId: 'choice-0' });
  fixture.service.store.context.db.exec('DROP TRIGGER reject_native_resolution_event');
  fixture.client.notify('serverRequest/resolved', {
    threadId: 'native-thread-1',
    requestId: 41
  });
  await waitFor(() => (
    fixture.service.store.interactions.get(pendingApproval.interactionId).state === 'answered'
  ));
  fixture.client.requestFromServer(42, 'item/fileChange/requestApproval', {
    threadId: 'native-thread-1',
    turnId: 'native-turn-1',
    itemId: 'approval-item-2',
    changes: [{ path: '/repo/file.js' }]
  });
  await waitFor(() => fixture.service.getSnapshot(session.sessionId).interactions.length === 1);
  fixture.client.notify('serverRequest/resolved', {
    threadId: 'native-thread-1',
    requestId: 42
  });
  await waitFor(() => fixture.service.getSnapshot(session.sessionId).interactions.length === 0);
  fixture.client.notify('turn/completed', {
    threadId: 'native-thread-1',
    turn: { id: 'native-turn-1', status: 'completed' }
  });
  await fixture.service.actors.records.get(session.sessionId).actor.waitForIdle();

  const snapshot = fixture.service.getSnapshot(session.sessionId);
  assert.equal(snapshot.runtimeBinding.nativeSessionId, 'native-thread-1');
  assert.deepEqual(snapshot.interactions, []);
  assert.deepEqual(
    fixture.service.store.interactions.get(interactionId(session.sessionId, 42)).resolution,
    { reason: 'resolved_elsewhere' }
  );
  assert.equal(snapshot.timeline[0].id, 'item-1');
  assert.equal(snapshot.timeline[0].content, 'hello');
  assert.equal(transient.length, 1);
  assert.equal(transient[0].sessionId, session.sessionId);
  assert.equal(transient[0].seq, 0);
  assert.deepEqual(transient[0].source, {
    provider: 'codex',
    runtimeId: 'codex:account-1'
  });
  assert.equal(
    fixture.service.readEvents(session.sessionId).events.some((event) => event.type === 'stream.error'),
    false
  );
  assert.equal(fixture.client.responses.length, 1);
  assert.equal(fixture.client.responses[0].id, 41);
  assert.strictEqual(fixture.clientOptions.aiHomeDir, fixture.aiHomeDir);
  assert.strictEqual(fixture.clientOptions.accountRef, 'account-1');
  assert.strictEqual(fixture.clientOptions.getProfileDir, fixture.getProfileDir);
  assert.strictEqual(fixture.clientOptions.env, fixture.env);
  assert.strictEqual(fixture.clientOptions.spawnSyncImpl, fixture.spawnSync);
});

test('composition resolves session attachments before starting a native Codex turn', async (t) => {
  const fixture = createFixture(t);
  const session = await fixture.service.createSession({
    sessionId: 'session-images',
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo'
  });
  const [attachment] = fixture.service.store.createAttachments(session.sessionId, [{
    filePath: '/tmp/shot.png', name: 'shot.png', mimeType: 'image/png'
  }]);

  await fixture.service.dispatchCommand(session.sessionId, {
    commandId: 'command-images',
    type: 'turn.submit',
    payload: { content: '', attachmentIds: [attachment.attachmentId] }
  });
  await waitFor(() => fixture.client.params('turn/start'));

  assert.deepEqual(fixture.client.params('turn/start').input, [
    { type: 'text', text: '' },
    { type: 'localImage', path: '/tmp/shot.png' }
  ]);
  fixture.client.notify('turn/completed', {
    threadId: 'native-thread-1',
    turn: { id: 'native-turn-1', status: 'completed' }
  });
  await fixture.service.actors.records.get(session.sessionId).actor.waitForIdle();
});

test('external native resolution finalizes a durable resolving interaction once', async (t) => {
  const fixture = createFixture(t);
  const session = await fixture.service.createSession({
    sessionId: 'session-external-resolution',
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo'
  });
  await fixture.service.dispatchCommand(session.sessionId, {
    commandId: 'turn-external-resolution',
    type: 'turn.submit',
    payload: { content: 'work' }
  });
  await waitFor(() => fixture.client.binding('native-thread-1'));
  fixture.client.requestFromServer(51, 'item/fileChange/requestApproval', {
    threadId: 'native-thread-1',
    turnId: 'native-turn-1',
    itemId: 'approval-external-resolution',
    changes: [{ path: '/repo/file.js' }]
  });
  const pendingId = interactionId(session.sessionId, 51);
  const pending = await waitFor(() => fixture.service.store.interactions.get(pendingId));
  assert.equal(pending.state, 'pending');
  assert.equal(pending.revision, 1);
  fixture.service.store.context.db.exec(`
    CREATE TRIGGER reject_external_resolution_event
    BEFORE INSERT ON chat_runtime_events
    WHEN NEW.type = 'interaction.resolved'
    BEGIN SELECT RAISE(ABORT, 'reject_event'); END
  `);

  await assert.rejects(fixture.service.dispatchCommand(session.sessionId, {
    commandId: 'approve-external-resolution',
    type: 'approval.decide',
    payload: {
      interactionId: pendingId,
      revision: 1,
      choiceId: 'choice-0'
    }
  }), /reject_event/);
  assert.equal(
    fixture.service.store.interactions.get(pendingId).state,
    'resolving'
  );
  assert.equal(fixture.client.responses.length, 1);
  fixture.service.store.context.db.exec('DROP TRIGGER reject_external_resolution_event');

  fixture.client.notify('serverRequest/resolved', {
    threadId: 'native-thread-1',
    requestId: 51
  });
  await waitFor(() => (
    fixture.service.store.interactions.get(pendingId).state === 'answered'
  ));

  const resolved = fixture.service.store.interactions.get(pendingId);
  assert.deepEqual(resolved.resolution, { choiceId: 'choice-0' });
  assert.equal(fixture.client.responses.length, 1);
  assert.equal(fixture.service.store.listEvents(session.sessionId).filter(({ type }) => (
    type === 'interaction.resolved'
  )).length, 1);

  fixture.client.notify('turn/completed', {
    threadId: 'native-thread-1',
    turn: { id: 'native-turn-1', status: 'completed' }
  });
  await fixture.service.actors.records.get(session.sessionId).actor.waitForIdle();
});

test('composition records a safe diagnostic when provider failure cannot release its claim', async (t) => {
  const fixture = createFixture(t, { respondFailure: true });
  const session = await fixture.service.createSession({
    sessionId: 'session-release-diagnostic',
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo'
  });
  await fixture.service.dispatchCommand(session.sessionId, {
    commandId: 'turn-release-diagnostic',
    type: 'turn.submit',
    payload: { content: 'work' }
  });
  await waitFor(() => fixture.client.binding('native-thread-1'));
  fixture.client.requestFromServer(61, 'item/fileChange/requestApproval', {
    threadId: 'native-thread-1',
    turnId: 'native-turn-1',
    itemId: 'approval-release-diagnostic',
    changes: [{ path: '/repo/file.js' }]
  });
  const pendingId = interactionId(session.sessionId, 61);
  await waitFor(() => fixture.service.store.interactions.get(pendingId));
  fixture.service.store.context.db.exec(`
    CREATE TRIGGER reject_release_diagnostic
    BEFORE UPDATE OF state ON chat_runtime_interactions
    WHEN OLD.state = 'resolving' AND NEW.state = 'pending'
    BEGIN SELECT RAISE(ABORT, 'sensitive database detail'); END
  `);

  await assert.rejects(fixture.service.dispatchCommand(session.sessionId, {
    commandId: 'approve-release-diagnostic',
    type: 'approval.decide',
    payload: {
      interactionId: pendingId,
      revision: 1,
      choiceId: 'choice-0'
    }
  }), (error) => error.code === 'codex_app_server_disconnected');

  const diagnostic = fixture.serverLog.find(({ kind }) => (
    kind === 'chat_runtime_interaction_release_failed'
  ));
  assert.deepEqual(diagnostic && {
    kind: diagnostic.kind,
    code: diagnostic.code,
    interactionId: diagnostic.interactionId,
    revision: diagnostic.revision,
    sessionId: diagnostic.sessionId
  }, {
    kind: 'chat_runtime_interaction_release_failed',
    code: 'chat_interaction_release_failed',
    interactionId: pendingId,
    revision: 1,
    sessionId: session.sessionId
  });
  assert.equal(JSON.stringify(diagnostic).includes('sensitive database detail'), false);
});

test('composition registers only Codex and emits sanitized command traces to the server log', async (t) => {
  const fixture = createFixture(t);

  await assert.rejects(fixture.service.createSession({
    provider: 'claude', executionAccountRef: 'account-1', projectPath: '/repo'
  }), (error) => error.code === 'chat_provider_driver_unavailable');
  const session = await fixture.service.createSession({
    provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo'
  });
  await fixture.service.dispatchCommand(session.sessionId, {
    commandId: 'command-prewarm', type: 'runtime.prewarm', payload: { token: 'secret' }
  });

  assert.deepEqual(
    fixture.service.readEvents(session.sessionId).events
      .map((event) => event.type)
      .filter((type) => type.startsWith('runtime.prewarm.')),
    ['runtime.prewarm.started', 'runtime.prewarm.ready']
  );
  assert.equal(fixture.serverLog.length, 1);
  assert.equal(fixture.serverLog[0].kind, 'chat_runtime_trace');
  assert.equal(fixture.serverLog[0].provider, 'codex');
  assert.equal(fixture.serverLog[0].sessionId, session.sessionId);
  assert.equal(fixture.serverLog[0].commandId, 'command-prewarm');
  assert.equal(JSON.stringify(fixture.serverLog[0]).includes('secret'), false);
});

test('composition exposes the bound capability catalog and explicit artifact degradation', async (t) => {
  const fixture = createFixture(t);
  const session = await fixture.service.createSession({
    provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo'
  });

  const commands = await fixture.service.getCommandCatalog(session.sessionId);

  assert.equal(commands.some((entry) => (
    entry.type === 'slash.execute' && entry.command === '/compact'
  )), true);
  assert.equal(commands.some((entry) => entry.type === 'artifact.read'), false);
  await assert.rejects(
    fixture.service.readArtifact('artifact-1'),
    (error) => error.code === 'chat_artifact_unsupported' && error.statusCode === 501
  );
});

test('composition refreshes Codex history before native resume without republishing duplicates', async (t) => {
  const fixture = createFixture(t);
  const { session } = await fixture.service.resolveSession({
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo',
    nativeSessionId: 'native-thread-history'
  });
  const published = [];
  fixture.service.subscribe(session.sessionId, (event) => {
    if (event.eventId.startsWith('history-')) published.push(event.eventId);
  });

  await fixture.service.dispatchCommand(session.sessionId, {
    commandId: 'history-prewarm', type: 'runtime.prewarm', payload: {}
  });
  const beforeTurn = fixture.client.calls.length;
  await fixture.service.dispatchCommand(session.sessionId, {
    commandId: 'history-turn', type: 'turn.submit', payload: { content: 'continue' }
  });
  await waitFor(() => fixture.client.binding('native-thread-history'));
  await waitFor(() => fixture.client.params('turn/start'));

  const turnCalls = fixture.client.calls.slice(beforeTurn).map(({ method }) => method);
  assert.deepEqual(turnCalls.slice(0, 3), ['thread/read', 'thread/resume', 'turn/start']);
  assert.equal(
    fixture.client.calls.filter(({ method }) => method === 'model/list').length,
    1
  );
  assert.equal(fixture.service.getSnapshot(session.sessionId).timeline[0].content, 'history');
  assert.equal(published.length, 1);

  fixture.client.notify('turn/completed', {
    threadId: 'native-thread-history',
    turn: { id: 'native-turn-1', status: 'completed' }
  });
  await fixture.service.actors.records.get(session.sessionId).actor.waitForIdle();
});

test('composition keeps a turn trace until native text and terminal events arrive', async (t) => {
  const fixture = createFixture(t);
  const session = await fixture.service.createSession({
    sessionId: 'session-trace',
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo'
  });

  await fixture.service.dispatchCommand(session.sessionId, {
    commandId: 'command-trace',
    type: 'turn.submit',
    payload: { content: 'work' }
  });
  await waitFor(() => fixture.client.binding('native-thread-1'));
  assert.equal(fixture.serverLog.length, 0);

  fixture.client.notify('item/started', {
    threadId: 'native-thread-1', turnId: 'native-turn-1',
    item: { id: 'message-1', type: 'agentMessage', text: '', status: 'inProgress' }
  });
  fixture.client.notify('item/agentMessage/delta', {
    threadId: 'native-thread-1', turnId: 'native-turn-1',
    itemId: 'message-1', delta: 'hello'
  });
  fixture.client.notify('turn/completed', {
    threadId: 'native-thread-1',
    turn: { id: 'native-turn-1', status: 'completed' }
  });
  await fixture.service.actors.records.get(session.sessionId).actor.waitForIdle();

  assert.equal(fixture.serverLog.length, 1);
  const trace = fixture.serverLog[0];
  assert.equal(trace.runId.startsWith('run-'), true);
  assert.deepEqual(trace.stages.map(({ stage }) => stage), [
    'requestAccepted',
    'commandPersisted',
    'actorDequeued',
    'runtimeAcquired',
    'authReady',
    'sessionBound',
    'turnSubmitted',
    'firstProviderEvent',
    'firstVisibleItem',
    'firstTextDelta',
    'completed'
  ]);
  assert.notEqual(trace.durations.commandAckMs, null);
  assert.notEqual(trace.durations.providerFirstEventMs, null);
  assert.notEqual(trace.durations.providerToVisibleMs, null);
  assert.notEqual(trace.durations.firstTextDeltaMs, null);
  assert.notEqual(trace.durations.totalMs, null);
});

test('composition passes the host runtime dependencies to the default resolver', (t) => {
  const fixture = createFixture(t, { useDefaultResolver: true });
  const resolver = fixture.service.actors.runtimeResolver.descriptorResolver;

  assert.strictEqual(resolver.fs, fs);
  assert.strictEqual(resolver.env, fixture.env);
  assert.strictEqual(resolver.spawn, fixture.spawn);
  assert.strictEqual(resolver.spawnSync, fixture.spawnSync);
  assert.equal(resolver.nativeCliOptions.projectFallback, false);
});

test('composition resolver returns complete descriptors with hashed auth revisions', async (t) => {
  const snapshots = [];
  let authSha = 'auth-sha-v1';
  const accountArtifactHooks = {
    snapshotAccountAuthArtifacts(provider, accountRef) {
      snapshots.push({ provider, accountRef });
      return {
        '/profiles/codex/auth.json': {
          exists: true,
          sha256: authSha,
          token: 'must-never-leave-the-hook'
        }
      };
    }
  };
  const fixture = createFixture(t, { accountArtifactHooks, useDefaultResolver: true });
  const resolver = fixture.service.actors.runtimeResolver;

  const first = await resolver.resolve('codex', { runtimeScope: 'account-1' });
  const same = await resolver.resolve('codex', { runtimeScope: 'account-1' });
  authSha = 'auth-sha-v2';
  const changed = await resolver.resolve('codex', { runtimeScope: 'account-1' });

  assert.equal(first.protocolVersion, 'aih-codex-app-server-adapter-v1');
  assert.match(first.capabilityHash, /^[a-f0-9]{64}$/);
  assert.match(first.authRevision, /^[a-f0-9]{64}$/);
  assert.equal(same.capabilityHash, first.capabilityHash);
  assert.equal(same.authRevision, first.authRevision);
  assert.equal(same.generation, 1);
  assert.notEqual(changed.authRevision, first.authRevision);
  assert.equal(changed.generation, 2);
  assert.equal(JSON.stringify([first, same, changed]).includes('must-never-leave-the-hook'), false);
  assert.deepEqual(snapshots, [
    { provider: 'codex', accountRef: 'account-1' },
    { provider: 'codex', accountRef: 'account-1' },
    { provider: 'codex', accountRef: 'account-1' }
  ]);
});

test('default descriptor refreshes the session actor when account auth changes', async (t) => {
  let authSha = 'auth-sha-v1';
  const fixture = createFixture(t, {
    useDefaultResolver: true,
    accountArtifactHooks: {
      snapshotAccountAuthArtifacts() {
        return {
          '/profiles/codex/auth.json': {
            exists: true,
            sha256: authSha,
            credentials: 'must-never-enter-the-descriptor'
          }
        };
      }
    }
  });
  const session = await fixture.service.createSession({
    sessionId: 'session-runtime-refresh',
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo'
  });
  const initial = fixture.service.actors.records.get(session.sessionId).runtime;

  authSha = 'auth-sha-v2';
  await fixture.service.dispatchCommand(session.sessionId, {
    commandId: 'command-runtime-refresh', type: 'runtime.prewarm', payload: {}
  });
  const refreshed = fixture.service.actors.records.get(session.sessionId).runtime;
  const binding = fixture.service.store.getSession(session.sessionId).runtimeBinding;

  assert.equal(initial.protocolVersion, 'aih-codex-app-server-adapter-v1');
  assert.match(initial.capabilityHash, /^[a-f0-9]{64}$/);
  assert.match(initial.authRevision, /^[a-f0-9]{64}$/);
  assert.equal(initial.generation, 1);
  assert.equal(refreshed.generation, 2);
  assert.notEqual(refreshed.authRevision, initial.authRevision);
  assert.notEqual(refreshed.fingerprint, initial.fingerprint);
  assert.equal(binding.runtimeGeneration, 2);
  assert.equal(binding.fingerprint, refreshed.fingerprint);
  assert.equal(JSON.stringify([initial, refreshed]).includes('must-never-enter'), false);
});

test('Codex exits sticky Plan mode after canonical policy returns to confirm', async (t) => {
  const fixture = createFixture(t);
  const session = await fixture.service.createSession({
    sessionId: 'session-policy-refresh',
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo',
    policy: { approvalMode: 'confirm' }
  });
  await fixture.service.dispatchCommand(session.sessionId, {
    commandId: 'policy-plan',
    type: 'session.policy.set',
    payload: { key: 'approvalMode', value: 'plan' }
  });

  await fixture.service.dispatchCommand(session.sessionId, {
    commandId: 'turn-plan',
    type: 'turn.submit',
    payload: { content: 'prepare a plan', model: 'gpt-5.3-codex' }
  });
  await waitFor(() => fixture.client.binding('native-thread-1'));

  assert.equal(
    fixture.client.params('turn/start').collaborationMode.mode,
    'plan'
  );
  fixture.client.notify('turn/completed', {
    threadId: 'native-thread-1',
    turn: { id: 'native-turn-1', status: 'completed' }
  });
  await fixture.service.actors.records.get(session.sessionId).actor.waitForIdle();

  await fixture.service.dispatchCommand(session.sessionId, {
    commandId: 'policy-confirm',
    type: 'session.policy.set',
    payload: { key: 'approvalMode', value: 'confirm' }
  });
  await fixture.service.dispatchCommand(session.sessionId, {
    commandId: 'turn-confirm',
    type: 'turn.submit',
    payload: { content: 'implement the plan' }
  });
  await waitFor(() => (
    fixture.client.calls.filter(({ method }) => method === 'turn/start').length === 2
  ));

  assert.equal(fixture.client.params('turn/start').collaborationMode.mode, 'default');
  assert.equal(fixture.client.params('turn/start').effort, 'medium');
  assert.equal(
    fixture.client.calls.filter(({ method }) => method === 'model/list').length,
    1
  );
  fixture.client.notify('turn/completed', {
    threadId: 'native-thread-1',
    turn: { id: 'native-turn-1', status: 'completed' }
  });
  await fixture.service.actors.records.get(session.sessionId).actor.waitForIdle();
});

function createFixture(t, options = {}) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-composition-'));
  const runtimeExecutablePath = path.join(aiHomeDir, 'codex');
  fs.writeFileSync(runtimeExecutablePath, '#!/usr/bin/env node\n', { mode: 0o755 });
  const env = { PATH: '/test/bin' };
  const spawn = () => successfulVersionProcess('codex 1.0.0');
  const spawnSync = () => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' });
  const getProfileDir = () => path.join(aiHomeDir, 'profiles', 'codex', 'account-1');
  const client = createFakeClient(options);
  const serverLog = [];
  let clientOptions = null;
  const runtimeResolver = options.useDefaultResolver ? undefined : {
    resolve(provider, context) {
      return {
        provider,
        runtimeScope: context.runtimeScope,
        executablePath: '/test/bin/codex',
        version: 'codex 1.0.0',
        fingerprint: `${provider}-runtime`,
        generation: 1
      };
    }
  };
  const service = createChatRuntimeComposition({
    fs,
    aiHomeDir,
    env,
    spawn,
    spawnSync,
    getProfileDir,
    accountArtifactHooks: options.accountArtifactHooks,
    resolveNativeCliPath: options.resolveNativeCliPath || (() => runtimeExecutablePath),
    runtimeResolver,
    codexClientFactory(input) {
      clientOptions = input;
      return client;
    },
    appendServerLog: (entry) => serverLog.push(entry)
  });
  t.after(() => {
    service.close();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });
  return {
    aiHomeDir,
    client,
    env,
    get clientOptions() { return clientOptions; },
    getProfileDir,
    serverLog,
    service,
    spawn,
    spawnSync
  };
}

function successfulVersionProcess(version) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => false;
  setImmediate(() => {
    child.stdout.end(version);
    child.stderr.end();
    child.emit('close', 0, null);
  });
  return child;
}

function createFakeClient(options = {}) {
  const bindings = new Map();
  const calls = [];
  return {
    calls,
    responses: [],
    async ensureConnected() {},
    getVerifiedAccountIdentity() {
      return { verified: true, kind: 'oauth', assurance: 'identity' };
    },
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'model/list') return {
        data: [{
          model: 'gpt-5.3-codex',
          isDefault: true,
          supportedReasoningEfforts: [
            { reasoningEffort: 'low' },
            { reasoningEffort: 'medium' },
            { reasoningEffort: 'high' }
          ],
          defaultReasoningEffort: 'medium'
        }]
      };
      if (method === 'thread/start') return { thread: { id: 'native-thread-1' } };
      if (method === 'thread/read') return historyResponse(params.threadId);
      if (method === 'turn/start') return { turn: { id: 'native-turn-1' } };
      return {};
    },
    bindTurn(threadId, binding) { bindings.set(threadId, binding); },
    unbindTurn(threadId) { bindings.delete(threadId); },
    binding(threadId) { return bindings.get(threadId); },
    notify(method, params) {
      bindings.get(params.threadId).onNotification({ method, params });
    },
    requestFromServer(id, method, params) {
      bindings.get(params.threadId).onServerRequest({ id, method, params });
    },
    params(method) { return calls.findLast((call) => call.method === method)?.params; },
    respond(id, result) {
      if (options.respondFailure) {
        throw Object.assign(new Error('provider response failed'), {
          code: 'codex_app_server_disconnected',
          statusCode: 503
        });
      }
      this.responses.push({ id, result });
      return true;
    },
    respondError: () => true
  };
}

function historyResponse(threadId) {
  return {
    thread: {
      id: threadId,
      updatedAt: 2,
      turns: [{
        id: 'native-history-turn', status: 'completed', startedAt: 1, completedAt: 2,
        items: [{ id: 'native-history-message', type: 'agentMessage', text: 'history' }]
      }]
    }
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition_not_met');
}
