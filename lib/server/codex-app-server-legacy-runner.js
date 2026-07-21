'use strict';

const crypto = require('node:crypto');

const { resolveRuntimeTarget } = require('../account/runtime-target');
const {
  createCodexAppServerAccountIdentityValidator
} = require('./codex-app-server-account-identity');
const { acquireAppServerClient } = require('./codex-app-server-client-pool');
const protocol = require('./codex-app-server-protocol');
const {
  decideApproval,
  registerApprovalRequest,
  toApprovalPrompt
} = require('./native-approval-bridge');
const { defaultSessionEventBus } = require('./session-event-bus');
const { createRetryStatus } = require('./native-retry-status');

const ABORT_SETTLE_TIMEOUT_MS = 8000;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function codedError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function publishApprovalEvent(bus, session, event) {
  try {
    if (bus && typeof bus.publish === 'function' && normalizeString(session.sessionId)) {
      bus.publish(session, { source: 'native-session-chat', ...event });
    }
  } catch (_error) { /* 事件发布失败不阻塞审批往返 */ }
}

function startCodexAppServerTurn(options = {}) {
  const target = resolveRuntimeTarget(options);
  const getProfileDir = options.getProfileDir;
  if (!target || typeof getProfileDir !== 'function') {
    throw codedError(
      'native_session_invalid_context',
      'codex app-server turn 需要账号或 gateway runtime target 与 getProfileDir'
    );
  }
  const { accountRef, gateway, runtimeScope } = target;
  const prompt = String(options.prompt || '');
  if (!prompt.trim()) throw codedError('empty_prompt', 'empty_prompt');

  const runId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `codexapp-run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const requestedSessionId = normalizeString(options.sessionId);
  const projectPath = normalizeString(options.projectPath) || process.cwd();
  const projectDirName = normalizeString(options.projectDirName);
  const approvalMode = normalizeString(options.approvalMode) || 'confirm';
  const sessionEventBus = options.sessionEventBus || defaultSessionEventBus;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const clientLease = acquireLegacyClient(options, target);
  const client = clientLease.client;
  const state = protocol.createTurnObserverState('');
  const approvalRecords = new Map();
  let settled = false;
  let aborted = false;
  let abortTimer = null;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const emit = (event) => {
    if (event) onEvent({ ...event, runId });
  };

  const cleanup = () => {
    if (abortTimer) clearTimeout(abortTimer);
    abortTimer = null;
    if (state.threadId) client.unbindTurn(state.threadId);
    clientLease.release();
  };

  const settleResolve = (value) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveDone(value);
  };

  const settleReject = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectDone(error);
  };

  const requestTurnInterrupt = () => {
    if (!state.threadId || !state.turnId) return;
    client.request('turn/interrupt', protocol.buildTurnInterruptParams({
      threadId: state.threadId,
      turnId: state.turnId
    })).catch(() => { /* interrupt 失败走 abort 兜底定时器 */ });
  };

  const sessionForEvents = () => ({
    provider: 'codex',
    sessionId: state.threadId,
    projectDirName,
    projectPath
  });

  const handleServerRequest = (message) => {
    if (!protocol.isApprovalServerRequest(message)) {
      client.respondError(message.id, -32601, `unhandled server request: ${message.method}`);
      return;
    }
    const requestKey = `${state.threadId}:${message.id}`;
    if (approvalRecords.has(requestKey)) return;
    const mapped = protocol.mapApprovalServerRequest(message, state);
    const record = { approvalId: '', answered: false, requestId: message.id };
    const entry = registerApprovalRequest({
      runId,
      toolName: mapped.toolName,
      input: mapped.input,
      toolUseId: mapped.toolUseId
    }, (decision) => {
      if (record.answered) return;
      record.answered = true;
      client.respond(
        record.requestId,
        protocol.approvalDecisionToResult(decision && decision.behavior)
      );
    });
    record.approvalId = entry.approvalId;
    approvalRecords.set(requestKey, record);
    publishApprovalEvent(sessionEventBus, sessionForEvents(), {
      type: 'session:approval-request',
      phase: 'interactive-prompt',
      at: Date.now(),
      runId,
      promptId: entry.approvalId,
      prompt: toApprovalPrompt(entry)
    });
  };

  const handleNotification = (message) => {
    if (message.method === 'serverRequest/resolved') {
      resolveExternalApproval(message);
      return;
    }
    const events = protocol.mapServerNotification(message, state);
    for (const event of events) {
      if (event.type === 'result') {
        emit({ type: 'result', content: event.content });
        settleResolve({
          content: event.content,
          sessionId: state.threadId,
          afterMessages: []
        });
        continue;
      }
      if (event.type === 'error') {
        emit(event);
        settleReject(codedError('codex_app_server_turn_failed', event.message));
        continue;
      }
      emit(event);
    }
  };

  const resolveExternalApproval = (message) => {
    const requestId = message.params && message.params.requestId;
    const requestKey = `${state.threadId}:${requestId}`;
    const record = approvalRecords.get(requestKey);
    if (!record || record.answered) return;
    record.answered = true;
    decideApproval(record.approvalId, 'deny', 'approval_resolved_elsewhere');
    publishApprovalEvent(sessionEventBus, sessionForEvents(), {
      type: 'session:approval-resolved',
      phase: 'interactive-prompt',
      at: Date.now(),
      runId,
      promptId: record.approvalId,
      reason: 'resolved-elsewhere'
    });
  };

  (async () => {
    const threadId = await acquireThread();
    if (aborted) {
      settleResolve({ content: state.content, sessionId: state.threadId, afterMessages: [] });
      return;
    }
    const turnResult = await client.request('turn/start', protocol.buildTurnStartParams({
      approvalMode,
      threadId,
      prompt,
      model: options.model,
      imagePaths: options.imagePaths
    }));
    const turnId = normalizeString(turnResult && turnResult.turn && turnResult.turn.id);
    if (turnId) {
      state.turnId = turnId;
      if (aborted) requestTurnInterrupt();
    }
  })().catch((error) => {
    settleReject(error && error.code
      ? error
      : codedError('codex_app_server_turn_failed', String(error && error.message || error)));
  });

  async function acquireThread() {
    if (requestedSessionId) {
      state.threadId = requestedSessionId;
      bindTurn(requestedSessionId);
      await client.request('thread/resume', protocol.buildThreadResumeParams({
        threadId: requestedSessionId,
        approvalMode,
        excludeTurns: true
      }));
      return requestedSessionId;
    }
    const started = await client.request('thread/start', protocol.buildThreadStartParams({
      cwd: projectPath,
      approvalMode
    }));
    const threadId = normalizeString(started && started.thread && started.thread.id);
    if (!threadId) {
      throw codedError('codex_app_server_thread_missing', 'thread/start 未返回 thread.id');
    }
    state.threadId = threadId;
    bindTurn(threadId);
    emit({ type: 'session-created', sessionId: threadId });
    return threadId;
  }

  function bindTurn(threadId) {
    client.bindTurn(threadId, {
      resumeParams: protocol.buildThreadResumeParams({
        threadId,
        approvalMode,
        excludeTurns: true
      }),
      onNotification: handleNotification,
      onServerRequest: handleServerRequest,
      onReconnectAttempt: ({ attempt, maxAttempts, delayMs }) => {
        emit(createRetryStatus({
          phase: 'reconnecting',
          source: 'transport',
          provider: 'codex',
          attempt,
          maxAttempts,
          retryAfterMs: delayMs,
          reason: 'app_server_disconnected'
        }));
      },
      onReconnectRecovered: ({ attempt }) => {
        emit(createRetryStatus({
          phase: 'recovered',
          source: 'transport',
          provider: 'codex',
          attempt,
          reason: 'app_server_reconnected'
        }));
      },
      onDisconnected: (error) => {
        settleReject(error && error.code
          ? error
          : codedError('codex_app_server_disconnected', 'codex app-server 连接断开'));
      }
    });
  }

  return {
    runId,
    done,
    getActivePrompt() {
      return null;
    },
    writeInput() {
      throw codedError(
        'native_interactive_prompt_not_active',
        'codex app-server run 不接受交互输入,审批请走 approvals 通道'
      );
    },
    writeSteer(text) {
      if (settled) throw codedError('native_session_run_not_active', 'native_session_run_not_active');
      const value = String(text || '').trim();
      if (!value) throw codedError('native_session_input_empty', 'native_session_input_empty');
      if (!state.threadId || !state.turnId) {
        throw codedError('native_session_run_not_active', '本轮尚未开始,无法 steer');
      }
      client.request('turn/steer', protocol.buildTurnSteerParams({
        threadId: state.threadId,
        turnId: state.turnId,
        text: value
      })).catch(() => { /* steer 失败不致命:turn 继续,前端可重试 */ });
    },
    resize() { /* 无 PTY,尺寸无意义 */ },
    abort() {
      aborted = true;
      if (settled) return;
      requestTurnInterrupt();
      abortTimer = setTimeout(() => {
        settleResolve({ content: state.content, sessionId: state.threadId, afterMessages: [] });
      }, ABORT_SETTLE_TIMEOUT_MS);
      if (typeof abortTimer.unref === 'function') abortTimer.unref();
    }
  };
}

function acquireLegacyClient(options, target) {
  const { accountRef, gateway, runtimeScope } = target;
  return acquireAppServerClient({
    runtimeScope,
    accountRef,
    gateway,
    getProfileDir: options.getProfileDir,
    env: options.env,
    aiHomeDir: options.aiHomeDir,
    spawnSyncImpl: options.spawnSyncImpl,
    endpoint: options.endpoint,
    wsImpl: options.wsImpl,
    accountIdentityValidator: options.accountIdentityValidator || (!gateway
      ? createCodexAppServerAccountIdentityValidator({
        aiHomeDir: options.credentialAiHomeDir || options.aiHomeDir,
        accountRef,
        getProfileDir: options.getProfileDir
      })
      : undefined)
  });
}

module.exports = { startCodexAppServerTurn };
