'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  APPROVAL_SMOKE_PROMPT,
  buildAuthIsolationEvidence,
  buildQuestionSettlement,
  buildRuntimeExecutionEvidence,
  buildSmokeIsolationEnvPatch,
  buildSmokeIsolationLayout,
  buildSmokeQuestionAnswers,
  interactionEvidenceSatisfied,
  loadNativeModelCatalog,
  prepareSmokeProject,
  projectPublicAccountIdentity,
  sanitizeSmokeMainError,
  selectSafeApprovalChoiceId,
  selectNativeModel,
  summarizeCanonicalFailure,
  summarizePlanEvidence,
  summarizeTurn
} = require('../scripts/chat-runtime-real-codex-smoke');

test('real Codex smoke chooses a safe canonical approval choice by intent', () => {
  assert.equal(selectSafeApprovalChoiceId({
    payload: {
      choices: [
        { id: 'allow-once', label: 'Allow once', intent: 'accept' },
        { id: 'decline', label: 'Decline', intent: 'deny' }
      ]
    }
  }), 'decline');
  assert.equal(selectSafeApprovalChoiceId({
    payload: {
      choices: [
        { id: 'cancel', label: 'Cancel', intent: 'cancel' }
      ]
    }
  }), 'cancel');
  assert.throws(() => selectSafeApprovalChoiceId({
    payload: {
      choices: [
        { id: 'allow-once', label: 'Allow once', intent: 'accept' }
      ]
    }
  }), /approval_smoke_safe_decision_unavailable/);
});

test('real Codex smoke settles canonical questions without provider-private fields', () => {
  const payload = {
    fields: [
      {
        id: 'target', label: 'Target', type: 'single_select',
        required: true, allowOther: false, secret: false,
        options: [{ value: 'web', label: 'Web' }]
      },
      {
        id: 'retry', label: 'Retry', type: 'integer',
        required: false, allowOther: false, secret: false
      }
    ],
    actions: ['submit'],
    answerShape: 'object'
  };

  assert.deepEqual(buildQuestionSettlement(payload), {
    action: 'submit',
    answer: { target: 'web', retry: 1 }
  });
  assert.deepEqual(buildSmokeQuestionAnswers({
    ...payload,
    answerShape: 'answers'
  }), { target: ['web'], retry: ['1'] });
  assert.deepEqual(buildQuestionSettlement({
    fields: [], actions: ['cancel', 'submit'], answerShape: 'none'
  }), { action: 'cancel' });
});

test('real Codex approval smoke installs its instruction fixture only in an owned project', () => {
  const writes = [];
  const fileSystem = {
    mkdirSync: (...args) => { writes.push(['mkdir', ...args]); },
    writeFileSync: (...args) => { writes.push(['write', ...args]); }
  };
  assert.deepEqual(prepareSmokeProject(
    { interaction: true },
    '/tmp/owned-smoke',
    fileSystem
  ), {
    interactionFixtureInstalled: true,
    projectPath: '/tmp/owned-smoke/project'
  });

  assert.equal(writes[0][0], 'mkdir');
  assert.equal(writes[1][0], 'write');
  assert.match(writes[1][1], /AGENTS\.md$/);
  assert.match(writes[1][2], /tool call itself is the native human-approval request/);
  assert.match(APPROVAL_SMOKE_PROMPT, /Do not ask for confirmation in chat/);
  assert.throws(
    () => prepareSmokeProject({ interaction: true, projectPath: '/user/project' }, '/tmp/smoke'),
    /interaction_smoke_requires_owned_project/
  );
});

test('real Codex smoke confines every runtime home to its owned temp root', () => {
  const tempRoot = path.join('/tmp', 'owned-smoke');
  const layout = buildSmokeIsolationLayout(tempRoot);

  assert.deepEqual(layout, {
    aiHomeDir: tempRoot,
    codexHome: path.join(tempRoot, 'profile', '.codex'),
    codexSqliteHome: path.join(tempRoot, 'home', '.codex'),
    homeDir: path.join(tempRoot, 'home'),
    profileDir: path.join(tempRoot, 'profile'),
    tempAuthPath: path.join(tempRoot, 'profile', '.codex', 'auth.json')
  });
  assert.deepEqual(buildSmokeIsolationEnvPatch(layout), {
    AIH_CODEX_APP_SERVER_PASSTHROUGH: '1',
    AIH_HOME: tempRoot,
    CODEX_HOME: layout.codexHome,
    CODEX_SQLITE_HOME: layout.codexSqliteHome,
    HOME: layout.homeDir,
    USERPROFILE: layout.homeDir
  });
});

test('real Codex smoke reports execution of the exact resolved PATH binary', () => {
  const runtime = {
    executablePath: '/default/path/codex',
    binaryHash: 'binary-sha256'
  };

  assert.deepEqual(buildRuntimeExecutionEvidence(runtime, '/default/path/codex'), {
    binaryHash: 'binary-sha256',
    launchMode: 'default-path',
    spawnMatchesResolvedPath: true
  });
  assert.equal(
    buildRuntimeExecutionEvidence(runtime, '/temporary/wrapper/codex').spawnMatchesResolvedPath,
    false
  );
});

test('real Codex smoke verifies the copied auth projection without reporting its hash', () => {
  assert.deepEqual(buildAuthIsolationEvidence({
    sourceAuthHashBefore: 'same-hash',
    sourceAuthHashAfter: 'same-hash',
    tempAuthHash: 'same-hash',
    tempAuthMode: 0o600
  }), {
    authFileMode: '0600',
    sourceAuthUnchanged: true,
    tempAuthMatchesSource: true,
    verified: true
  });
  assert.equal(buildAuthIsolationEvidence({
    sourceAuthHashBefore: 'before',
    sourceAuthHashAfter: 'after',
    tempAuthHash: 'before',
    tempAuthMode: 0o600
  }).verified, false);
  assert.equal(buildAuthIsolationEvidence({
    sourceAuthHashBefore: 'same-hash',
    sourceAuthHashAfter: 'same-hash',
    tempAuthHash: 'same-hash',
    tempAuthMode: 0o644
  }).verified, false);
});

test('real Codex smoke reports only public identity assurance fields', () => {
  assert.deepEqual(projectPublicAccountIdentity({
    verified: true,
    kind: 'oauth',
    assurance: 'identity',
    identityHash: 'must-not-leak',
    runtimeHomeHash: 'must-not-leak',
    email: 'must-not-leak@example.com'
  }), {
    verified: true,
    kind: 'oauth',
    assurance: 'identity'
  });
  assert.equal(projectPublicAccountIdentity(null), null);
});

test('real Codex smoke sanitizes its main error without exposing a raw stack', () => {
  const secret = 'header.payload.signature';
  const error = new Error(`Authorization: Bearer ${secret}`);
  error.stack = `Error: Authorization: Bearer ${secret}\n    at /private/source/auth.json:1:1`;

  const message = sanitizeSmokeMainError(error);

  assert.match(message, /Bearer \[redacted\]/);
  assert.equal(message.includes(secret), false);
  assert.equal(message.includes('/private/source/auth.json'), false);
  assert.equal(message.includes('\n'), false);
});

test('real Codex smoke requires recovered and settled approval evidence when enabled', () => {
  const evidence = {
    attempted: true,
    triggered: true,
    replayMethodObserved: true,
    pendingAfterRecovery: true,
    pendingAfterSettlement: 0,
    commandExecuted: false,
    terminalType: 'turn.completed'
  };

  assert.equal(interactionEvidenceSatisfied(evidence, true), true);
  assert.equal(interactionEvidenceSatisfied({ ...evidence, triggered: false }, true), false);
  assert.equal(interactionEvidenceSatisfied({ ...evidence, commandExecuted: true }, true), false);
  assert.equal(interactionEvidenceSatisfied({ attempted: false }, false), true);
});

test('real Codex smoke loads model/list only after the resident OAuth identity gate', async () => {
  const calls = [];
  let connected = false;
  const journal = [];
  const client = {
    async ensureConnected() {
      calls.push('ensureConnected');
      connected = true;
    },
    getVerifiedAccountIdentity() {
      calls.push('getVerifiedAccountIdentity');
      return connected ? {
        verified: true,
        kind: 'oauth',
        assurance: 'identity'
      } : null;
    },
    async request(method, params) {
      calls.push({ method, params });
      return { data: [{
        model: 'native-default',
        isDefault: true,
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: [
          { reasoningEffort: 'medium' },
          { reasoningEffort: 'high' }
        ]
      }] };
    }
  };

  assert.deepEqual(await loadNativeModelCatalog(client, journal), {
    model: 'native-default',
    availableModels: ['native-default'],
    reasoningEffort: 'high',
    supportedReasoningEfforts: ['medium', 'high']
  });
  assert.deepEqual(calls, [
    'ensureConnected',
    'getVerifiedAccountIdentity',
    { method: 'model/list', params: { includeHidden: false } }
  ]);
  assert.equal(journal[0].identityVerified, true);
  assert.equal(journal[0].response.selectedModel, 'native-default');
});

test('real Codex smoke selects the account-filtered native default model', () => {
  const selected = selectNativeModel({
    data: [
      { model: 'gpt-first', isDefault: false },
      {
        model: 'gpt-account-default',
        isDefault: true,
        defaultReasoningEffort: 'xhigh',
        supportedReasoningEfforts: [
          { reasoningEffort: 'high' },
          { reasoningEffort: 'xhigh' }
        ]
      }
    ]
  });

  assert.deepEqual(selected, {
    model: 'gpt-account-default',
    availableModels: ['gpt-first', 'gpt-account-default'],
    reasoningEffort: 'xhigh',
    supportedReasoningEfforts: ['high', 'xhigh']
  });
});

test('real Codex smoke falls back to the first native model without hardcoding an id', () => {
  assert.deepEqual(selectNativeModel({
    data: [{
      model: 'gpt-current-first',
      isDefault: false,
      defaultReasoningEffort: 'max',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium' }]
    }]
  }), {
    model: 'gpt-current-first',
    availableModels: ['gpt-current-first'],
    reasoningEffort: 'medium',
    supportedReasoningEfforts: ['medium']
  });
});

test('real Codex smoke fails closed when model/list returns no usable model', () => {
  assert.throws(
    () => selectNativeModel({ data: [{ model: '   ', isDefault: true }] }),
    /codex_native_model_catalog_empty/
  );
  assert.throws(
    () => selectNativeModel({ data: [{ model: 'gpt-no-effort', isDefault: true }] }),
    /codex_native_reasoning_catalog_empty/
  );
});

test('real Codex smoke summarizes projected plan updates for one canonical run', () => {
  const planItem = {
    id: 'codex-plan:native-turn-plan',
    turnId: 'native-turn-plan',
    kind: 'plan',
    status: 'completed',
    detail: {
      explanation: 'Smoke plan',
      steps: [
        { step: 'Inspect the target', status: 'completed' },
        { step: 'Describe the change', status: 'completed' }
      ]
    }
  };

  assert.deepEqual(summarizePlanEvidence({
    timeline: [
      { id: 'message-1', kind: 'message', status: 'completed' },
      planItem,
      { ...planItem, id: 'codex-plan:other-turn', turnId: 'other-turn' }
    ]
  }, [
    {
      type: 'timeline.item.updated',
      runId: 'run-other',
      itemId: planItem.id,
      payload: { item: planItem }
    },
    {
      type: 'timeline.item.updated',
      runId: 'run-plan',
      itemId: planItem.id,
      payload: { item: planItem }
    }
  ], 'run-plan'), {
    observed: true,
    terminalEventCount: 1,
    itemCount: 1,
    items: [{
      itemId: 'codex-plan:native-turn-plan',
      status: 'completed',
      state: '',
      explanation: 'Smoke plan',
      contentLength: 0,
      hasContent: true,
      stepCount: 2,
      completedStepCount: 2
    }]
  });
});

test('real Codex smoke accepts the native completed plan item shape and requires its projection', () => {
  const completed = {
    type: 'timeline.item.completed',
    runId: 'run-plan',
    itemId: 'codex-plan:native-turn-plan',
    payload: {
      item: {
        id: 'codex-plan:native-turn-plan',
        kind: 'plan',
        content: '# Native plan',
        status: 'completed',
        detail: { state: 'proposed' }
      }
    }
  };

  assert.deepEqual(summarizePlanEvidence({ timeline: [] }, [completed], 'run-plan'), {
    observed: false,
    terminalEventCount: 1,
    itemCount: 0,
    items: []
  });

  assert.deepEqual(summarizePlanEvidence({
    timeline: [completed.payload.item]
  }, [completed], 'run-plan'), {
    observed: true,
    terminalEventCount: 1,
    itemCount: 1,
    items: [{
      itemId: 'codex-plan:native-turn-plan',
      status: 'completed',
      state: 'proposed',
      explanation: '',
      contentLength: 13,
      hasContent: true,
      stepCount: 0,
      completedStepCount: 0
    }]
  });
});

test('real Codex smoke reports a bounded redacted canonical turn failure', () => {
  const secret = 'header.payload.signature';
  const summary = summarizeCanonicalFailure({
    type: 'turn.failed',
    payload: {
      error: {
        code: 'codex_turn_failed',
        message: `Unsupported OAuth model. Authorization: Bearer ${secret} ${'x'.repeat(400)}`
      }
    }
  });

  assert.equal(summary.code, 'codex_turn_failed');
  assert.match(summary.message, /Unsupported OAuth model/);
  assert.match(summary.message, /Bearer \[redacted\]/);
  assert.equal(summary.message.includes(secret), false);
  assert.ok(summary.message.length <= 243);
  assert.equal(summarizeCanonicalFailure({ type: 'turn.completed' }), null);
});

test('real Codex smoke promotes internal native turn evidence and canonical first text latency', () => {
  const summary = summarizeTurn({
    acceptedAt: 100,
    settledAt: 500,
    accepted: { result: { runId: 'run-1' } },
    terminal: {
      type: 'turn.completed',
      payload: {}
    }
  }, {
    runtimeBinding: { nativeSessionId: 'thread-1' }
  }, [{
    method: 'turn/start',
    requestedModel: 'native-model',
    requestedReasoningEffort: 'high',
    response: { nativeTurnId: 'turn-1' }
  }], [{
    runId: 'run-1',
    stages: [],
    durations: { firstTextDeltaMs: 123 }
  }], 0);

  assert.equal(summary.nativeTurnId, 'turn-1');
  assert.equal(summary.ttftMs, 123);
  assert.equal(summary.trace.durations.firstTextDeltaMs, 123);
});

test('real Codex smoke derives native turn evidence from its internal request journal', () => {
  const summary = summarizeTurn({
    acceptedAt: 100,
    settledAt: 200,
    accepted: { result: { runId: 'run-journal' } },
    terminal: {
      type: 'turn.completed',
      payload: { result: { nativeTurnId: 'public-terminal-id' } }
    }
  }, {
    runtimeBinding: { nativeSessionId: 'thread-journal' }
  }, [{
    method: 'turn/start',
    response: { nativeTurnId: 'native-journal-id' }
  }], [], 0);

  assert.equal(summary.nativeTurnId, 'native-journal-id');
});
