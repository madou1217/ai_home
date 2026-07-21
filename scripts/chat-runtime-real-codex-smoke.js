#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { readDefaultAccountRef } = require('../lib/account/default-account-store');
const {
  listCliAccountCredentialRecords
} = require('../lib/cli/services/account/credential-records');
const {
  DefaultProviderRuntimeResolver
} = require('../lib/runtime/default-provider-runtime');
const {
  resolveAccountRuntimeDir
} = require('../lib/runtime/aih-storage-layout');
const {
  buildProviderRuntimeEnv
} = require('../lib/cli/services/ai-cli/provider-runtime-env');
const {
  CODEX_APP_SERVER_PASSTHROUGH_ENV
} = require('../lib/server/codex-app-server-hook-wrapper');
const {
  createChatRuntimeComposition
} = require('../lib/server/chat-runtime-composition');
const {
  sanitizeTraceText
} = require('../lib/server/codex-remote-control-proxy');
const {
  acquireAppServerClient
} = require('../lib/server/codex-app-server-runner');
const {
  buildQuestionSettlement,
  buildSmokeQuestionAnswers,
  selectSafeApprovalChoiceId
} = require('./chat-runtime-smoke-interaction');
const {
  auditPublicProtocolBoundary,
  summarizePrewarmEvidence
} = require('./chat-runtime-smoke-evidence');
const {
  runSecretPersistenceProbe
} = require('./chat-runtime-smoke-secret-probe');

const TURN_TIMEOUT_MS = 120000;
const INTERACTION_TIMEOUT_MS = 90000;
const READY_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 50;
const FAILURE_CODE_MAX_LENGTH = 96;
const FAILURE_MESSAGE_MAX_LENGTH = 240;
const TERMINAL_EVENT_TYPES = new Set([
  'turn.completed',
  'turn.failed',
  'turn.interrupted'
]);
const APPROVAL_SMOKE_INSTRUCTIONS = `# AIH Chat Runtime Approval Smoke

This temporary project exists only to verify the native approval transport.

When asked to run the marker command:
- Immediately submit exactly one shell tool call with the requested command.
- The shell tool call itself is the native human-approval request. Do not ask for confirmation in chat.
- Do not create the marker through a file-edit tool or any alternative path.
`;
const APPROVAL_SMOKE_PROMPT = [
  'Submit exactly one shell tool call that runs',
  '`/bin/sh -c "touch aih-chat-runtime-smoke-marker"` in the current directory.',
  'The native approval interceptor will pause the tool call.',
  'Do not ask for confirmation in chat and do not use another tool or method.'
].join(' ');

function parseArgs(argv) {
  const options = {
    sourceAiHomeDir: path.join(os.homedir(), '.ai_home'),
    interaction: true
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--source-aih-home') {
      options.sourceAiHomeDir = path.resolve(requiredArg(argv[++index], token));
    } else if (token === '--account-ref') {
      options.accountRef = requiredArg(argv[++index], token);
    } else if (token === '--project') {
      options.projectPath = path.resolve(requiredArg(argv[++index], token));
    } else if (token === '--skip-interaction') {
      options.interaction = false;
    } else {
      throw new Error(`unknown option: ${token}`);
    }
  }
  return options;
}

function requiredArg(value, option) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${option} requires a value`);
  return normalized;
}

function prepareSmokeProject(options, tempRoot, fileSystem = fs) {
  if (options.projectPath && options.interaction) {
    throw new Error('interaction_smoke_requires_owned_project');
  }
  const projectPath = options.projectPath || path.join(tempRoot, 'project');
  fileSystem.mkdirSync(projectPath, { recursive: true });
  if (options.interaction) {
    fileSystem.writeFileSync(path.join(projectPath, 'AGENTS.md'), APPROVAL_SMOKE_INSTRUCTIONS);
  }
  return {
    interactionFixtureInstalled: Boolean(options.interaction),
    projectPath
  };
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function resolveAccountRef(options) {
  const requested = String(options.accountRef || '').trim();
  if (requested) {
    requireReadableProjection(options.sourceAiHomeDir, requested);
    return requested;
  }
  const defaultRef = readDefaultAccountRef(fs, options.sourceAiHomeDir, 'codex');
  const records = listCliAccountCredentialRecords(
    fs,
    options.sourceAiHomeDir,
    'codex'
  );
  const candidates = [defaultRef, ...records.map((record) => record.accountRef)].filter(Boolean);
  const accountRef = candidates.find((candidate) => hasReadableProjection(
    options.sourceAiHomeDir,
    candidate
  ));
  if (!accountRef) throw new Error('codex_oauth_projection_not_found');
  return accountRef;
}

function projectionDir(sourceAiHomeDir, accountRef) {
  return resolveAccountRuntimeDir(sourceAiHomeDir, 'codex', accountRef);
}

function projectionAuthPath(sourceAiHomeDir, accountRef) {
  return path.join(projectionDir(sourceAiHomeDir, accountRef), '.codex', 'auth.json');
}

function hasReadableProjection(sourceAiHomeDir, accountRef) {
  try {
    fs.accessSync(projectionAuthPath(sourceAiHomeDir, accountRef), fs.constants.R_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

function requireReadableProjection(sourceAiHomeDir, accountRef) {
  if (!hasReadableProjection(sourceAiHomeDir, accountRef)) {
    throw new Error('codex_oauth_projection_not_found');
  }
}

function redactAccountRef(accountRef) {
  const value = String(accountRef || '');
  return value.length > 10 ? `${value.slice(0, 7)}...${value.slice(-4)}` : 'redacted';
}

function buildSmokeIsolationLayout(tempRoot) {
  const root = text(tempRoot);
  if (!root) throw new Error('smoke_temp_root_required');
  const homeDir = path.join(root, 'home');
  const profileDir = path.join(root, 'profile');
  const codexHome = path.join(profileDir, '.codex');
  return {
    aiHomeDir: root,
    codexHome,
    codexSqliteHome: path.join(homeDir, '.codex'),
    homeDir,
    profileDir,
    tempAuthPath: path.join(codexHome, 'auth.json')
  };
}

function buildSmokeIsolationEnvPatch(layout) {
  return {
    [CODEX_APP_SERVER_PASSTHROUGH_ENV]: '1',
    AIH_HOME: layout.aiHomeDir,
    CODEX_HOME: layout.codexHome,
    CODEX_SQLITE_HOME: layout.codexSqliteHome,
    HOME: layout.homeDir,
    USERPROFILE: layout.homeDir
  };
}

function prepareSmokeIsolation(layout, sourceAuthPath, fileSystem = fs) {
  fileSystem.mkdirSync(layout.codexHome, { recursive: true, mode: 0o700 });
  fileSystem.mkdirSync(layout.codexSqliteHome, { recursive: true, mode: 0o700 });
  fileSystem.copyFileSync(sourceAuthPath, layout.tempAuthPath);
  fileSystem.chmodSync(layout.tempAuthPath, 0o600);
}

function buildSmokeRuntimeEnv(context) {
  const isolation = buildSmokeIsolationEnvPatch(context.layout);
  return {
    ...buildProviderRuntimeEnv('codex', context.layout.profileDir, process.env, {
      fs,
      aiHomeDir: context.layout.aiHomeDir,
      accountRef: context.accountRef,
      codexConfigDir: context.layout.codexHome,
      codexSqliteHome: context.layout.codexSqliteHome,
      hostHomeDir: context.layout.homeDir,
      extraEnv: isolation
    }),
    ...isolation
  };
}

function buildRuntimeExecutionEvidence(runtime = {}, spawnedExecutablePath) {
  return {
    binaryHash: text(runtime.binaryHash),
    launchMode: 'default-path',
    spawnMatchesResolvedPath: Boolean(
      text(spawnedExecutablePath)
      && text(spawnedExecutablePath) === text(runtime.executablePath)
    )
  };
}

function buildAuthIsolationEvidence(input = {}) {
  const mode = Number(input.tempAuthMode);
  const authFileMode = Number.isSafeInteger(mode)
    ? mode.toString(8).padStart(4, '0')
    : 'unknown';
  const sourceAuthUnchanged = Boolean(
    input.sourceAuthHashBefore
    && input.sourceAuthHashBefore === input.sourceAuthHashAfter
  );
  const tempAuthMatchesSource = Boolean(
    input.sourceAuthHashBefore
    && input.sourceAuthHashBefore === input.tempAuthHash
  );
  return {
    authFileMode,
    sourceAuthUnchanged,
    tempAuthMatchesSource,
    verified: sourceAuthUnchanged && tempAuthMatchesSource && mode === 0o600
  };
}

function projectPublicAccountIdentity(identity) {
  if (!identity || typeof identity !== 'object') return null;
  return {
    verified: identity.verified === true,
    kind: text(identity.kind),
    assurance: text(identity.assurance)
  };
}

function sanitizeSmokeMainError(error) {
  const value = error && (error.code || error.message) || error || 'chat_runtime_smoke_failed';
  return sanitizeDiagnosticText(value, FAILURE_MESSAGE_MAX_LENGTH)
    || 'chat_runtime_smoke_failed';
}

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function probeReady(port) {
  return new Promise((resolve) => {
    const request = http.get({
      host: '127.0.0.1',
      port,
      path: '/readyz',
      timeout: 1000
    }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.once('error', () => resolve(false));
    request.once('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForReady(port, child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`codex_app_server_exited:${child.exitCode}`);
    }
    if (await probeReady(port)) return;
    await delay(100);
  }
  throw new Error('codex_app_server_ready_timeout');
}

function startAppServer(endpoint, context, resolvedExecutablePath) {
  const output = fs.openSync(context.appServerLogPath, 'a');
  const child = spawn(resolvedExecutablePath, [
    'app-server',
    '--listen',
    endpoint
  ], {
    cwd: context.projectPath,
    detached: true,
    env: context.runtimeEnv,
    stdio: ['ignore', output, output]
  });
  child.once('spawn', () => fs.closeSync(output));
  child.once('error', () => {
    try { fs.closeSync(output); } catch (_error) {}
  });
  return child;
}

function stopOwnedProcessGroup(child) {
  if (!child || child.exitCode !== null || !child.pid) return Promise.resolve();
  try { process.kill(-child.pid, 'SIGTERM'); } catch (_error) {}
  return Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(3000).then(() => {
      if (child.exitCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_error) {}
      }
    })
  ]);
}

function createRecordingClientFactory(endpoint, journal, clients) {
  return (options) => {
    const lease = acquireAppServerClient({ ...options, endpoint });
    const client = lease.client;
    clients.add(client);
    const wrapped = Object.create(client);
    Object.defineProperty(wrapped, 'request', {
      async value(method, params) {
        const entry = {
          at: Date.now(),
          method: String(method || ''),
          threadId: String(params && params.threadId || ''),
          turnId: String(
            params && (params.turnId || params.expectedTurnId) || ''
          ),
          ...(method === 'turn/start' ? {
            requestedModel: text(params && params.model),
            requestedReasoningEffort: text(
              params && params.effort
              || params && params.collaborationMode
                && params.collaborationMode.settings
                && params.collaborationMode.settings.reasoning_effort
            )
          } : {})
        };
        journal.push(entry);
        const result = await client.request(method, params);
        entry.response = summarizeNativeResponse(method, result);
        return result;
      }
    });
    return { client: wrapped, release: lease.release };
  };
}

async function loadNativeModelCatalog(client, journal) {
  await client.ensureConnected();
  const identity = client.getVerifiedAccountIdentity();
  if (
    !identity
    || identity.verified !== true
    || identity.kind !== 'oauth'
    || identity.assurance !== 'identity'
  ) {
    throw new Error('codex_native_model_identity_not_verified');
  }
  const entry = {
    at: Date.now(),
    method: 'model/list',
    identityVerified: true
  };
  journal.push(entry);
  const selected = selectNativeModel(await client.request('model/list', {
    includeHidden: false
  }));
  entry.response = {
    modelCount: selected.availableModels.length,
    selectedModel: selected.model,
    selectedReasoningEffort: selected.reasoningEffort
  };
  return selected;
}

function selectNativeModel(response) {
  const entries = Array.isArray(response && response.data) ? response.data : [];
  const availableModels = entries.map((entry) => text(entry && entry.model)).filter(Boolean);
  const preferred = entries.find((entry) => entry && entry.isDefault && text(entry.model));
  const selected = preferred || entries.find((entry) => text(entry && entry.model));
  const model = text(selected && selected.model) || '';
  if (!model) throw new Error('codex_native_model_catalog_empty');
  const supportedReasoningEfforts = (Array.isArray(selected.supportedReasoningEfforts)
    ? selected.supportedReasoningEfforts
    : []
  ).map((entry) => text(entry && entry.reasoningEffort)).filter(Boolean);
  const nativeDefaultReasoningEffort = text(selected.defaultReasoningEffort);
  const reasoningEffort = supportedReasoningEfforts.includes(nativeDefaultReasoningEffort)
    ? nativeDefaultReasoningEffort
    : supportedReasoningEfforts[0] || nativeDefaultReasoningEffort;
  if (!reasoningEffort) throw new Error('codex_native_reasoning_catalog_empty');
  return { model, availableModels, reasoningEffort, supportedReasoningEfforts };
}

function createService(context, journal, traces, clients) {
  return createChatRuntimeComposition({
    aiHomeDir: context.tempRoot,
    credentialAiHomeDir: context.sourceAiHomeDir,
    env: context.runtimeEnv,
    endpoint: context.endpoint,
    getProfileDir: () => context.layout.profileDir,
    codexClientFactory: createRecordingClientFactory(context.endpoint, journal, clients),
    appendServerLog(trace) {
      traces.push(trace);
    }
  });
}

function summarizeNativeResponse(method, result) {
  const response = result && typeof result === 'object' ? result : {};
  const thread = response.thread && typeof response.thread === 'object' ? response.thread : {};
  const turn = response.turn && typeof response.turn === 'object' ? response.turn : {};
  return {
    responseKeys: Object.keys(response).sort(),
    ...(method === 'thread/start' || method === 'thread/resume' ? {
      threadKeys: Object.keys(thread).sort(),
      threadModel: String(thread.model || thread.modelId || ''),
      turnCount: Array.isArray(thread.turns) ? thread.turns.length : null
    } : {}),
    ...(method === 'turn/start' ? {
      turnKeys: Object.keys(turn).sort(),
      nativeTurnId: String(turn.id || ''),
      turnModel: String(turn.model || turn.modelId || '')
    } : {})
  };
}

function captureEvents(service, sessionId, target) {
  return service.subscribe(sessionId, (event) => {
    target.push({
      at: Date.now(),
      seq: event.seq,
      type: event.type,
      turnId: String(event.turnId || ''),
      runId: String(event.runId || ''),
      ...(event.type === 'stream.error' ? {
        errorCode: String(event.payload && event.payload.error || '')
      } : {})
    });
  });
}

async function runTerminalTurn(service, sessionId, command, timeoutMs = TURN_TIMEOUT_MS) {
  const acceptedAt = Date.now();
  const accepted = await service.dispatchCommand(sessionId, command);
  await withTimeout(service.waitForActorIdle(sessionId), timeoutMs, 'turn_settlement_timeout');
  const events = service.readEvents(sessionId).events;
  const terminal = events.findLast((event) => (
    event.runId === accepted.result.runId && TERMINAL_EVENT_TYPES.has(event.type)
  ));
  if (!terminal) throw new Error('terminal_event_missing');
  return {
    acceptedAt,
    accepted,
    terminal,
    settledAt: Date.now()
  };
}

async function waitForInteractionOrTerminal(service, sessionId, runId) {
  const deadline = Date.now() + INTERACTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const snapshot = service.getSnapshot(sessionId);
    const interaction = snapshot.interactions[0];
    if (interaction) return { interaction, snapshot };
    const terminal = service.readEvents(sessionId).events.findLast((event) => (
      event.runId === runId && TERMINAL_EVENT_TYPES.has(event.type)
    ));
    if (terminal) return { terminal, snapshot };
    await delay(POLL_INTERVAL_MS);
  }
  return { timeout: true, snapshot: service.getSnapshot(sessionId) };
}

async function settleInteraction(service, sessionId, interaction) {
  const command = interaction.kind === 'approval'
    ? {
      commandId: `smoke-deny-${Date.now()}`,
      type: 'approval.decide',
      payload: {
        interactionId: interaction.interactionId,
        revision: interaction.revision,
        choiceId: selectSafeApprovalChoiceId(interaction)
      }
    }
    : {
      commandId: `smoke-cancel-${Date.now()}`,
      type: 'interaction.answer',
      payload: {
        interactionId: interaction.interactionId,
        revision: interaction.revision,
        ...buildQuestionSettlement(interaction.payload)
      }
    };
  await service.dispatchCommand(sessionId, command);
  await withTimeout(service.waitForActorIdle(sessionId), TURN_TIMEOUT_MS, 'interaction_turn_timeout');
}

async function attemptInteractionReplay(context, sessionId, service, reportState) {
  await service.dispatchCommand(sessionId, {
    commandId: `smoke-confirm-policy-${Date.now()}`,
    type: 'session.policy.set',
    payload: { key: 'approvalMode', value: 'confirm' }
  });
  const submitted = await service.dispatchCommand(sessionId, {
    commandId: `smoke-interaction-turn-${Date.now()}`,
    type: 'turn.submit',
    payload: {
      content: APPROVAL_SMOKE_PROMPT,
      model: context.selectedModel,
      reasoningEffort: context.selectedReasoningEffort
    }
  });
  const observed = await waitForInteractionOrTerminal(
    service,
    sessionId,
    submitted.result.runId
  );
  if (!observed.interaction) {
    if (observed.timeout) {
      await service.dispatchCommand(sessionId, {
        commandId: `smoke-interrupt-${Date.now()}`,
        type: 'turn.interrupt',
        payload: { reason: 'smoke_interaction_timeout' }
      });
      await withTimeout(service.waitForActorIdle(sessionId), TURN_TIMEOUT_MS, 'interrupt_timeout');
    }
    return {
      attempted: true,
      triggered: false,
      commandExecuted: fs.existsSync(path.join(context.projectPath, 'aih-chat-runtime-smoke-marker')),
      terminalType: observed.terminal && observed.terminal.type || '',
      reason: observed.timeout ? 'interaction_timeout' : 'provider_completed_without_interaction'
    };
  }

  const pending = observed.interaction;
  const nativeThreadId = observed.snapshot.runtimeBinding.nativeSessionId;
  service.close();
  reportState.closed = true;

  const recoveryJournalStart = reportState.journal.length;
  const reopened = createService(
    context,
    reportState.journal,
    reportState.traces,
    reportState.clients
  );
  reportState.service = reopened;
  const [recovery] = await withTimeout(
    reopened.waitForRecovery(),
    30000,
    'interaction_recovery_timeout'
  );
  const recovered = reopened.getSnapshot(sessionId);
  const replayed = recovered.interactions.find((entry) => (
    entry.interactionId === pending.interactionId
  ));
  if (!replayed) throw new Error('replayed_interaction_missing');
  await settleInteraction(reopened, sessionId, replayed);
  const finalSnapshot = reopened.getSnapshot(sessionId);
  const terminal = reopened.readEvents(sessionId).events.findLast((event) => (
    event.runId === submitted.result.runId && TERMINAL_EVENT_TYPES.has(event.type)
  ));
  return {
    attempted: true,
    triggered: true,
    commandExecuted: fs.existsSync(path.join(context.projectPath, 'aih-chat-runtime-smoke-marker')),
    kind: pending.kind,
    revision: pending.revision,
    nativeThreadId,
    recoveryStatus: recovery && recovery.status || 'fulfilled',
    replayMethodObserved: reportState.journal
      .slice(recoveryJournalStart)
      .some((entry) => entry.method === 'thread/resume'),
    pendingAfterRecovery: Boolean(replayed),
    pendingAfterSettlement: finalSnapshot.interactions.length,
    terminalType: terminal && terminal.type || ''
  };
}

function traceForRun(traces, runId) {
  const trace = traces.findLast((entry) => entry.runId === runId);
  if (!trace) return null;
  return {
    stages: trace.stages.map((entry) => entry.stage),
    durations: trace.durations
  };
}

function summarizeTurn(turn, snapshot, journal, traces, journalStart) {
  const runId = turn.accepted.result.runId;
  const nativeJournal = journal.slice(journalStart);
  const turnStart = nativeJournal.find((entry) => entry.method === 'turn/start');
  const trace = traceForRun(traces, runId);
  const nativeTurnId = text(
    turnStart && turnStart.response && turnStart.response.nativeTurnId
  );
  const failure = summarizeCanonicalFailure(turn.terminal);
  return {
    runId,
    nativeThreadId: String(snapshot.runtimeBinding.nativeSessionId || ''),
    nativeTurnId,
    requestedModel: text(turnStart && turnStart.requestedModel),
    requestedReasoningEffort: text(turnStart && turnStart.requestedReasoningEffort),
    terminalType: turn.terminal.type,
    ...(failure ? { failure } : {}),
    ttftMs: firstTextDeltaMs(trace),
    elapsedMs: turn.settledAt - turn.acceptedAt,
    nativeMethods: nativeJournal.map((entry) => entry.method),
    nativeResponses: nativeJournal
      .filter((entry) => entry.response)
      .map((entry) => ({ method: entry.method, ...entry.response })),
    trace
  };
}

function firstTextDeltaMs(trace) {
  const value = trace && trace.durations && trace.durations.firstTextDeltaMs;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function summarizeCanonicalFailure(terminal = {}) {
  if (terminal.type !== 'turn.failed') return null;
  const error = terminal.payload && terminal.payload.error;
  const code = sanitizeDiagnosticText(
    error && error.code || 'chat_turn_failed',
    FAILURE_CODE_MAX_LENGTH
  );
  const message = sanitizeDiagnosticText(
    error && error.message || code,
    FAILURE_MESSAGE_MAX_LENGTH
  );
  return { code, message };
}

function sanitizeDiagnosticText(value, maxLength) {
  return sanitizeTraceText(String(value || ''), maxLength).replace(/\s+/gu, ' ').trim();
}

function summarizePlanEvidence(snapshot = {}, events = [], runId) {
  const canonicalRunId = text(runId);
  const terminalPlanEvents = (Array.isArray(events) ? events : []).filter((event) => (
    text(event && event.runId) === canonicalRunId
      && (event.type === 'timeline.item.updated' || event.type === 'timeline.item.completed')
      && event.payload
      && event.payload.item
      && event.payload.item.kind === 'plan'
  ));
  const planItemIds = new Set(terminalPlanEvents.map((event) => (
    text(event.itemId) || text(event.payload && event.payload.item && event.payload.item.id)
  )).filter(Boolean));
  const timeline = Array.isArray(snapshot && snapshot.timeline) ? snapshot.timeline : [];
  const items = timeline.filter((item) => (
    item && item.kind === 'plan' && planItemIds.has(text(item.id))
  )).map(summarizePlanItem);
  return {
    observed: terminalPlanEvents.length > 0 && items.some((item) => item.hasContent),
    terminalEventCount: terminalPlanEvents.length,
    itemCount: items.length,
    items
  };
}

function summarizePlanItem(item) {
  const detail = item && item.detail && typeof item.detail === 'object' ? item.detail : {};
  const steps = Array.isArray(detail.steps) ? detail.steps : [];
  return {
    itemId: text(item && item.id),
    status: text(item && item.status),
    state: text(detail.state),
    explanation: text(detail.explanation),
    contentLength: text(item && item.content).length,
    hasContent: Boolean(text(item && item.content) || steps.length > 0),
    stepCount: steps.length,
    completedStepCount: steps.filter((step) => step && step.status === 'completed').length
  };
}

function interactionEvidenceSatisfied(interaction, required) {
  if (!required) return true;
  return Boolean(
    interaction
    && interaction.attempted === true
    && interaction.triggered === true
    && interaction.replayMethodObserved === true
    && interaction.pendingAfterRecovery === true
    && interaction.pendingAfterSettlement === 0
    && interaction.commandExecuted === false
    && TERMINAL_EVENT_TYPES.has(interaction.terminalType)
  );
}

async function run(options) {
  const startedAt = Date.now();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-runtime-real-smoke-'));
  const journal = [];
  const traces = [];
  const clients = new Set();
  const events = [];
  const reportState = { journal, traces, clients, service: null, closed: false };
  let child;
  try {
    const project = prepareSmokeProject(options, tempRoot);
    const projectPath = project.projectPath;
    const accountRef = resolveAccountRef(options);
    const sourceAuthPath = projectionAuthPath(options.sourceAiHomeDir, accountRef);
    const sourceAuthHashBefore = fileHash(sourceAuthPath);
    const layout = buildSmokeIsolationLayout(tempRoot);
    prepareSmokeIsolation(layout, sourceAuthPath);
    const runtime = await new DefaultProviderRuntimeResolver().resolve('codex', {
      runtimeScope: accountRef
    });
    const spawnedExecutablePath = runtime.executablePath;
    const runtimeExecution = buildRuntimeExecutionEvidence(runtime, spawnedExecutablePath);
    const port = await pickFreePort();
    const endpoint = `ws://127.0.0.1:${port}`;
    const context = {
      accountRef,
      appServerLogPath: path.join(tempRoot, 'codex-app-server.log'),
      endpoint,
      layout,
      projectPath,
      sourceAiHomeDir: options.sourceAiHomeDir,
      tempRoot
    };
    context.runtimeEnv = buildSmokeRuntimeEnv(context);
    child = startAppServer(endpoint, context, spawnedExecutablePath);
    await waitForReady(port, child);
    const readyAt = Date.now();
    let service = createService(context, journal, traces, clients);
    reportState.service = service;
    const session = await service.createSession({
      provider: 'codex',
      executionAccountRef: accountRef,
      projectPath,
      policy: { approvalMode: 'bypass' }
    });
    captureEvents(service, session.sessionId, events);
    const prewarmEventCursor = service.getSnapshot(session.sessionId).throughSeq;
    const prewarmJournalStart = journal.length;
    const prewarmStartedAt = Date.now();
    await service.dispatchCommand(session.sessionId, {
      commandId: `smoke-prewarm-${Date.now()}`,
      type: 'runtime.prewarm',
      payload: {}
    });
    await service.waitForActorIdle(session.sessionId);
    const prewarm = {
      ...summarizePrewarmEvidence(
        service.readEvents(session.sessionId, { after: prewarmEventCursor }).events,
        journal,
        prewarmJournalStart
      ),
      elapsedMs: Date.now() - prewarmStartedAt
    };
    const residentClient = [...clients].at(-1);
    if (!residentClient) throw new Error('codex_resident_client_missing');
    const nativeModelCatalog = await loadNativeModelCatalog(residentClient, journal);
    const selectedModel = nativeModelCatalog.model;
    const selectedReasoningEffort = nativeModelCatalog.reasoningEffort;
    context.selectedModel = selectedModel;
    context.selectedReasoningEffort = selectedReasoningEffort;

    let journalStart = journal.length;
    const first = await runTerminalTurn(service, session.sessionId, {
      commandId: `smoke-first-${Date.now()}`,
      type: 'turn.submit',
      payload: {
        content: 'Reply with exactly AIH_CHAT_RUNTIME_SMOKE_OK. Do not use tools.',
        model: selectedModel,
        reasoningEffort: selectedReasoningEffort
      }
    });
    const firstSnapshot = service.getSnapshot(session.sessionId);
    const firstSummary = summarizeTurn(first, firstSnapshot, journal, traces, journalStart);

    journalStart = journal.length;
    const steady = await runTerminalTurn(service, session.sessionId, {
      commandId: `smoke-steady-${Date.now()}`,
      type: 'turn.submit',
      payload: {
        content: 'Reply with exactly AIH_CHAT_RUNTIME_STEADY_OK. Do not use tools.',
        model: selectedModel,
        reasoningEffort: selectedReasoningEffort
      }
    });
    const steadySnapshot = service.getSnapshot(session.sessionId);
    const steadySummary = summarizeTurn(
      steady,
      steadySnapshot,
      journal,
      traces,
      journalStart
    );

    service.close();
    reportState.closed = true;
    journalStart = journal.length;
    service = createService(context, journal, traces, clients);
    reportState.service = service;
    reportState.closed = false;
    await service.waitForRecovery();
    captureEvents(service, session.sessionId, events);
    const reopenedBeforeTurn = service.getSnapshot(session.sessionId);
    const second = await runTerminalTurn(service, session.sessionId, {
      commandId: `smoke-reopen-${Date.now()}`,
      type: 'turn.submit',
      payload: {
        content: 'Reply with exactly AIH_CHAT_RUNTIME_REOPEN_OK. Do not use tools.',
        model: selectedModel,
        reasoningEffort: selectedReasoningEffort
      }
    });
    const reopenedAfterTurn = service.getSnapshot(session.sessionId);
    const secondSummary = summarizeTurn(
      second,
      reopenedAfterTurn,
      journal,
      traces,
      journalStart
    );

    await service.dispatchCommand(session.sessionId, {
      commandId: `smoke-plan-policy-${Date.now()}`,
      type: 'session.policy.set',
      payload: { key: 'approvalMode', value: 'plan' }
    });
    journalStart = journal.length;
    const plan = await runTerminalTurn(service, session.sessionId, {
      commandId: `smoke-plan-${Date.now()}`,
      type: 'turn.submit',
      payload: {
        content: [
          'Create a concise two-step implementation plan for adding a file named AIH_SMOKE_PLAN.md.',
          'Use the native plan update mechanism, do not modify files, do not use shell tools,',
          'do not ask questions, and finish after presenting the plan.'
        ].join(' '),
        model: selectedModel,
        reasoningEffort: selectedReasoningEffort
      }
    });
    const planSnapshot = service.getSnapshot(session.sessionId);
    const planEvents = service.readEvents(session.sessionId).events;
    const planSummary = {
      ...summarizeTurn(plan, planSnapshot, journal, traces, journalStart),
      evidence: summarizePlanEvidence(
        planSnapshot,
        planEvents,
        plan.accepted.result.runId
      )
    };

    const interaction = options.interaction
      ? await attemptInteractionReplay(context, session.sessionId, service, reportState)
      : { attempted: false, reason: 'disabled' };
    service = reportState.service;
    const finalSnapshot = service.getSnapshot(session.sessionId);
    const secretPersistence = await runSecretPersistenceProbe({
      service,
      sessionId: session.sessionId,
      tempRoot
    });
    const canonicalEvents = service.readEvents(session.sessionId).events;
    const publicProtocolBoundary = auditPublicProtocolBoundary(
      service.getSnapshot(session.sessionId),
      canonicalEvents
    );
    const verifiedIdentity = [...clients]
      .map((client) => client.getVerifiedAccountIdentity())
      .filter(Boolean)
      .at(-1) || null;
    const authIsolation = buildAuthIsolationEvidence({
      sourceAuthHashBefore,
      sourceAuthHashAfter: fileHash(sourceAuthPath),
      tempAuthHash: fileHash(layout.tempAuthPath),
      tempAuthMode: fs.statSync(layout.tempAuthPath).mode & 0o777
    });
    const turnStartEntries = journal.filter((entry) => entry.method === 'turn/start');
    const expectedTurnStartCount = options.interaction ? 5 : 4;
    const selectedModelRequestedByAllTurns = turnStartEntries.length >= expectedTurnStartCount
      && turnStartEntries.every((entry) => entry.requestedModel === selectedModel);
    const selectedReasoningRequestedByAllTurns = turnStartEntries.length >= expectedTurnStartCount
      && turnStartEntries.every((entry) => (
        entry.requestedReasoningEffort === selectedReasoningEffort
      ));
    const interactionVerified = interactionEvidenceSatisfied(interaction, options.interaction);
    const ttft = {
      freshMs: firstSummary.ttftMs,
      steadyMs: steadySummary.ttftMs,
      reopenMs: secondSummary.ttftMs
    };
    const ttftVerified = Object.values(ttft).every(Number.isFinite);
    const report = {
      ok: firstSummary.terminalType === 'turn.completed'
        && steadySummary.terminalType === 'turn.completed'
        && secondSummary.terminalType === 'turn.completed'
        && planSummary.terminalType === 'turn.completed'
        && planSummary.evidence.observed
        && selectedModelRequestedByAllTurns
        && selectedReasoningRequestedByAllTurns
        && interactionVerified
        && prewarm.verified
        && publicProtocolBoundary.verified
        && secretPersistence.verified
        && runtimeExecution.spawnMatchesResolvedPath
        && authIsolation.verified
        && ttftVerified
        && firstSummary.nativeThreadId
        && firstSummary.nativeThreadId === steadySummary.nativeThreadId
        && firstSummary.nativeThreadId === secondSummary.nativeThreadId
        && firstSummary.nativeThreadId === planSummary.nativeThreadId,
      runtime: {
        executablePath: runtime.executablePath,
        realPath: runtime.realPath,
        version: runtime.version,
        generation: runtime.generation,
        ...runtimeExecution
      },
      nativeModelCatalog: {
        selectedModel,
        availableModels: nativeModelCatalog.availableModels,
        selectedReasoningEffort,
        supportedReasoningEfforts: nativeModelCatalog.supportedReasoningEfforts,
        requestedByAllTurns: selectedModelRequestedByAllTurns,
        reasoningRequestedByAllTurns: selectedReasoningRequestedByAllTurns,
        expectedTurnStartCount,
        turnStartCount: turnStartEntries.length
      },
      accountIdentity: projectPublicAccountIdentity(verifiedIdentity),
      isolation: {
        tempRoot,
        projectPath,
        interactionFixtureInstalled: project.interactionFixtureInstalled,
        appStatePath: path.join(tempRoot, 'app-state.db'),
        appServerLogPath: context.appServerLogPath,
        randomPort: port,
        sourceAccount: redactAccountRef(accountRef),
        ...authIsolation
      },
      timings: {
        appServerReadyMs: readyAt - startedAt,
        prewarmMs: prewarm.elapsedMs,
        ttft,
        ttftVerified,
        totalMs: Date.now() - startedAt
      },
      session: {
        sessionId: session.sessionId,
        nativeThreadIdPersistedBeforeReopen: firstSummary.nativeThreadId,
        nativeThreadIdLoadedAfterReopen: String(
          reopenedBeforeTurn.runtimeBinding.nativeSessionId || ''
        ),
        nativeThreadIdFinal: String(finalSnapshot.runtimeBinding.nativeSessionId || ''),
        reopenReattached: secondSummary.nativeMethods.includes('thread/resume')
          && firstSummary.nativeThreadId === secondSummary.nativeThreadId
      },
      firstTurn: firstSummary,
      prewarm,
      steadyTurn: steadySummary,
      reopenedTurn: secondSummary,
      planTurn: planSummary,
      interaction: { ...interaction, verified: interactionVerified },
      publicProtocolBoundary,
      secretPersistence,
      observedEventTypes: [...new Set(events.map((event) => event.type))],
      streamErrors: events.filter((event) => event.type === 'stream.error')
        .map(({ errorCode }) => ({ errorCode }))
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  } finally {
    if (reportState.service && !reportState.closed) {
      try { reportState.service.close(); } catch (_error) {}
    }
    for (const client of clients) {
      try { client.destroy(); } catch (_error) {}
    }
    try {
      await stopOwnedProcessGroup(child);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

function withTimeout(promise, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (require.main === module) {
  run(parseArgs(process.argv.slice(2))).then(
    (exitCode) => { process.exitCode = exitCode; },
    (error) => {
      process.stderr.write(`[chat-runtime-real-codex-smoke] ${sanitizeSmokeMainError(error)}\n`);
      process.exitCode = 1;
    }
  );
}

module.exports = {
  APPROVAL_SMOKE_PROMPT,
  buildAuthIsolationEvidence,
  buildQuestionSettlement,
  buildRuntimeExecutionEvidence,
  buildSmokeIsolationEnvPatch,
  buildSmokeIsolationLayout,
  buildSmokeQuestionAnswers,
  loadNativeModelCatalog,
  interactionEvidenceSatisfied,
  parseArgs,
  prepareSmokeProject,
  projectPublicAccountIdentity,
  redactAccountRef,
  run,
  sanitizeSmokeMainError,
  selectSafeApprovalChoiceId,
  selectNativeModel,
  summarizeCanonicalFailure,
  summarizePlanEvidence,
  summarizeTurn
};
