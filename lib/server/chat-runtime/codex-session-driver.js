'use strict';

const { acquireAppServerClient } = require('../codex-app-server-client-pool');
const {
  createCodexAppServerAccountIdentityValidator
} = require('../codex-app-server-account-identity');
const protocol = require('../codex-app-server-protocol');
const { ChatRuntimeError } = require('./contracts');
const { createCodexCommandPort, createCodexHandlers } = require('./codex-session-command-port');
const { CodexSessionEventBridge } = require('./codex-session-event-bridge');
const { CodexSessionHistorySync } = require('./codex-session-history-sync');
const { CodexNativeModelCatalog } = require('./codex-native-model-catalog');
const { CodexTurnRecovery } = require('./codex-turn-recovery');
const { submitCodexTurn, uncertainSubmissionError } = require('./codex-turn-submission');
const { budgetedTurnInput, budgetHistoryItems, chatThreadParams, chatTurnParams, injectableDocumentItems, needsDocumentInjection, oversizedTurnPrompt, sessionAttachmentTurnInput } = require('./chat-harness-policy');
const {
  approvalMode,
  clientOptions,
  codexCapabilities,
  createActive,
  rejectActive,
  requireRuntime,
  requireSession,
  settleFromNative,
  text
} = require('./codex-session-driver-support');

const TERMINAL_TURN_EVENTS = new Set([
  'turn.completed', 'turn.failed', 'turn.interrupted'
]);
const CONTEXT_WINDOW_FALLBACK = 1048576;

class CodexSessionDriver {
  constructor(options = {}) {
    this.session = requireSession(options.session);
    this.fs = options.fs;
    this.runtime = requireRuntime(options.runtime);
    this.runtimeScope = this.runtime.runtimeScope;
    this.getSessionPolicy = typeof options.getSessionPolicy === 'function'
      ? options.getSessionPolicy
      : () => this.session.policy;
    this.nativeThreadId = text(this.session.runtimeBinding.nativeSessionId);
    this.initialHistory = options.initialHistory || [];
    this.onNativeSessionBound = options.onNativeSessionBound || (() => {});
    this.onNativeTurnStarted = options.onNativeTurnStarted || (() => {});
    this.disposed = false;
    const clientLease = normalizeClientLease(
      (options.clientFactory || acquireAppServerClient)(clientOptions({
        ...options,
        accountIdentityValidator: options.accountIdentityValidator
          || createCodexAppServerAccountIdentityValidator({
            fs: options.fs,
            aiHomeDir: options.credentialAiHomeDir || options.aiHomeDir,
            accountRef: this.session.executionAccountRef,
            getProfileDir: options.getProfileDir
          })
      }, this.session, this.runtime))
    );
    this.client = clientLease.client;
    this.releaseClient = clientLease.release;
    this.modelCatalog = options.modelCatalog || new CodexNativeModelCatalog({
      client: this.client
    });
    this.history = new CodexSessionHistorySync({
      ...options, client: this.client, getThreadId: () => this.nativeThreadId,
      runtimeId: `codex:${this.runtimeScope}`
    });
    this.bridge = new CodexSessionEventBridge({
      ...options,
      provider: 'codex',
      sessionId: this.session.sessionId
    });
    this.active = null;
    // 同一 driver 生命周期内同一 run 只注入一次，避免失败重试把大文档重复写进历史。
    this.injectedDocumentRuns = new Set();
    this.commands = createCodexCommandPort({
      bridge: this.bridge,
      client: this.client,
      getActive: () => this.active,
      getThreadId: () => this.nativeThreadId,
      prewarmRuntime: () => this.modelCatalog.prewarm(),
      syncHistory: () => this.history.run(),
      runtimeScope: this.runtimeScope
    });
    this.recovery = new CodexTurnRecovery({
      bridge: this.bridge,
      client: this.client,
      sessionId: this.session.sessionId,
      getActive: () => this.active,
      setActive: (active) => { this.active = active; },
      getThreadId: () => this.nativeThreadId,
      getApprovalMode: () => approvalMode(this.getSessionPolicy() || this.session.policy),
      importRecoveredHistory: (response, anchor) => this.history.importRecovered(response, anchor),
      anchorRecoveredTurn: (active, nativeTurnId) => this.anchorNativeTurn(active, nativeTurnId),
      bind: (active) => this.bind(active),
      cleanup: (active) => this.cleanup(active)
    });
  }
  recoverTurn(context = {}) {
    if (this.disposed) throw new ChatRuntimeError('codex_driver_closed', 410);
    return this.recovery.recover(context);
  }
  startTurn(context = {}) {
    if (this.disposed) throw new ChatRuntimeError('codex_driver_closed', 410);
    this.requireContext(context);
    if (this.active) throw new ChatRuntimeError('chat_turn_already_active', 409);
    const attachmentPaths = normalizeImagePaths(context.imagePaths);
    const turnInput = sessionAttachmentTurnInput(this.session,
      text(context.command && context.command.payload.content), attachmentPaths, this.fs);
    const prompt = turnInput.prompt;
    const imagePaths = turnInput.imagePaths;
    if (!prompt && imagePaths.length === 0) {
      throw new ChatRuntimeError('chat_turn_content_required', 422);
    }
    const currentPolicy = this.getSessionPolicy() || this.session.policy;
    const model = text(context.command && context.command.payload.model || currentPolicy.model);
    const reasoningEffort = text(context.command && context.command.payload.reasoningEffort || currentPolicy.reasoningEffort);
    const currentApprovalMode = approvalMode(this.getSessionPolicy() || this.session.policy);
    const active = createActive(context, prompt, model, reasoningEffort, imagePaths);
    active.approvalMode = currentApprovalMode;
    active.turnParts = turnInput.parts;
    active.toolOrder = this.bridge.createToolOrder();
    this.active = active;
    this.launch(active).catch((error) => rejectActive(active, error));
    return active.done.finally(() => this.cleanup(active));
  }
  async interruptTurn(context = {}) {
    this.requireContext(context);
    const active = this.active;
    if (active && !active.nativeTurnId && typeof this.client.waitForReconnect === 'function') {
      await this.client.waitForReconnect();
      if (this.active !== active || active.settled) return { alreadySettled: true };
    }
    return this.commands.interruptTurn();
  }

  compactThread(context = {}) {
    if (this.disposed) throw new ChatRuntimeError('codex_driver_closed', 410);
    this.requireContext(context);
    if (this.active) throw new ChatRuntimeError('chat_turn_already_active', 409);
    if (!this.nativeThreadId && !this.initialHistory.length) throw new ChatRuntimeError('codex_native_session_missing', 422);
    const active = createActive(context, '', '', '');
    active.approvalMode = approvalMode(this.getSessionPolicy());
    active.toolOrder = this.bridge.createToolOrder();
    this.active = active;
    this.launchCompaction(active).catch((error) => rejectActive(active, error));
    return active.done.finally(() => this.cleanup(active));
  }

  async launchCompaction(active) {
    await this.resolveSettings(active);
    await this.acquireThread(active);
    await this.compactNativeThread(active);
    if (!active.settled) {
      active.settled = true;
      active.resolve({ status: 'completed' });
    }
  }

  async readComposerCatalog() {
    const models = await this.modelCatalog.list();
    const defaultEntry = models.find((entry) => entry.isDefault) || models[0];
    return Object.freeze({
      models: Object.freeze(models.map((entry) => Object.freeze({
        id: entry.model,
        label: entry.displayName,
        supportedEfforts: entry.supportedReasoningEfforts,
        defaultEffort: entry.defaultReasoningEffort
      }))),
      defaultModel: defaultEntry ? defaultEntry.model : ''
    });
  }
  async launch(active) {
    await this.resolveSettings(active);
    markTrace(active, 'authReady', { runtimeId: this.runtimeScope });
    await this.acquireThread(active);
    this.applyDocumentTokenBudget(active);
    // A persisted native thread may already contain legacy attachment history
    // that is larger than the current document. Compact before every new
    // document turn so a small, already-budgeted attachment cannot inherit an
    // oversized V23/V24 history and trip the upstream token ceiling.
    const oversized = needsDocumentInjection({ prompt: active.prompt, parts: active.turnParts });
    const budgetTrimmed = Boolean(active.documentBudget
      && (active.documentBudget.truncatedBlocks || active.documentBudget.droppedBlocks));
    const hasDocuments = Boolean(active.turnParts && active.turnParts.documentBlocks
      && active.turnParts.documentBlocks.length > 0);
    if (active.threadHadHistory && (hasDocuments || oversized || budgetTrimmed)) {
      await this.compactNativeThread(active);
    }
    await this.injectOversizedDocuments(active);
    markTrace(active, 'turnSubmitted');
    await submitCodexTurn({ client: this.client, active,
      anchor: (run, id) => this.anchorNativeTurn(run, id),
      params: chatTurnParams(protocol.buildTurnStartParams({
        approvalMode: active.approvalMode,
        clientUserMessageId: active.context.runId,
        model: active.model,
        prompt: active.prompt,
        imagePaths: active.imagePaths,
        reasoningEffort: active.reasoningEffort,
        threadId: active.nativeThreadId
      }), this.session)
    });
  }

  // 传输上限(字符)与上游窗口(token)是两回事:一个 80 万字符的中文文档能通过
  // 95 万字符检查,却约 80 万 token,照样被上游以 input token count exceeds 拒绝。
  // 这一步在注入/内联之前按真实窗口裁剪文档块——resolveSettings 已把
  // model_context_window 放进 active.threadConfig,窗口未知时不猜、不动。
  applyDocumentTokenBudget(active) {
    const contextWindow = active.threadConfig && active.threadConfig.model_context_window;
    const policy = this.getSessionPolicy() || this.session.policy;
    const budgeted = budgetedTurnInput(
      { prompt: active.prompt, parts: active.turnParts },
      contextWindow,
      policy && policy.documentBudgetPercent
    );
    if (!budgeted) return;
    active.turnParts = budgeted.parts;
    active.prompt = budgeted.prompt;
    active.documentBudget = budgeted.budget;
  }

  // codex app-server 的 turn/start 输入硬上限 1,048,576 字符（实测
  // codex_app_server_rpc_error）。chat 模式大文档全文内联会超限时，改经
  // thread/inject_items 把完整分段注入历史（该通道实测无上限、条目不属于任何
  // turn、不会作为重复气泡进入 AIH 时间线），turn 输入只带指路语。
  async injectOversizedDocuments(active) {
    const turnInput = { prompt: active.prompt, parts: active.turnParts };
    if (!needsDocumentInjection(turnInput)) return;
    const runId = text(active.context.runId);
    if (this.injectedDocumentRuns.has(runId)) {
      // 重试只恢复指路语，历史里已有完整分段。
      active.prompt = oversizedTurnPrompt(turnInput, 0);
      return;
    }
    const items = injectableDocumentItems(active.turnParts.documentBlocks, runId);
    await this.client.request('thread/inject_items', { threadId: active.nativeThreadId, items });
    this.injectedDocumentRuns.add(runId);
    active.prompt = oversizedTurnPrompt(turnInput, items.length);
  }

  async resolveSettings(active) {
    const policy = this.getSessionPolicy() || this.session.policy;
    const settings = await this.modelCatalog.resolveTurnSettings({
      model: active.model || policy.model,
      reasoningEffort: active.reasoningEffort || policy.reasoningEffort
    });
    active.model = settings.model;
    active.reasoningEffort = settings.reasoningEffort;
    active.threadConfig = settings.threadConfig;
  }

  async acquireThread(active) {
    if (this.nativeThreadId) {
      // A persisted native thread is already an established conversation.
      // `thread/resume` intentionally uses excludeTurns:true, so its response
      // may omit turns; never infer an empty history from that response.
      active.threadHadHistory = true;
      active.nativeThreadId = this.nativeThreadId;
      await this.history.run();
      this.bind(active);
      await this.client.request(
        'thread/resume',
        this.resumeParams(active.approvalMode, active)
      );
      markTrace(active, 'sessionBound', { runtimeId: this.runtimeScope });
      return;
    }
    const params = chatThreadParams(protocol.buildThreadStartParams({
      approvalMode: active.approvalMode,
      cwd: this.session.projectPath,
      experimentalRawEvents: true
    }), this.currentSession(), active);
    const result = await this.client.request('thread/start', params);
    const threadId = text(result && result.thread && result.thread.id);
    if (!threadId) throw new ChatRuntimeError('codex_native_session_missing', 502);
    if (this.initialHistory.length) {
      const policy = this.getSessionPolicy() || this.session.policy;
      const history = budgetHistoryItems(this.initialHistory,
        active.threadConfig?.model_context_window, policy && policy.documentBudgetPercent);
      await this.client.request('thread/inject_items', { threadId, items: history.items });
      active.threadHadHistory = true;
    }
    this.nativeThreadId = threadId;
    active.nativeThreadId = threadId;
    await this.onNativeSessionBound(threadId, {
      runtimeFingerprint: this.runtime.fingerprint,
      sessionId: this.session.sessionId
    });
    this.bind(active);
    markTrace(active, 'sessionBound', { runtimeId: this.runtimeScope });
  }

  bind(active) {
    this.client.bindTurn(active.nativeThreadId, {
      onDisconnected: (error) => rejectActive(active,
        active.submissionUncertain ? uncertainSubmissionError(error) : error),
      onNotification: (message) => this.observe(active, message, false),
      onServerRequest: (message) => this.observe(active, message, true),
      onReconnectResume: (response) => this.recovery.reconnect(active, response),
      resumeParams: { ...this.resumeParams(active.approvalMode, active), excludeTurns: false }
    });
  }

  observe(active, message, serverRequest) {
    if (this.active !== active || active.settled) return;
    if (message.method === 'thread/tokenUsage/updated'
      && (!active.nativeTurnId || message.params?.turnId !== active.nativeTurnId)) return;
    const context = providerEventContext(active);
    const observed = serverRequest
      ? this.bridge.forwardServerRequest(message, context, this.client)
      : this.bridge.forwardNotification(message, context);
    observeTrace(active, observed.event);
    let persisted = observed.persisted;
    if (observed.compaction) {
      persisted.catch((error) => rejectActive(active, error));
      return;
    }
    if (observed.mapped.type === 'turn.started' && observed.providerTurnId) {
      persisted = Promise.all([
        persisted,
        this.anchorNativeTurn(active, observed.providerTurnId)
      ]);
    }
    if (TERMINAL_TURN_EVENTS.has(observed.mapped.type)) {
      Promise.all([
        persisted,
        this.requireTerminalAnchorTail(active, observed.providerTurnId)
      ]).then(
        async () => {
          if (observed.mapped.type === 'turn.failed'
            && isContextLengthFailure(observed.mapped)
            && !active.contextOverflowRetried) {
            try {
              await this.retryAfterContextOverflow(active);
              return;
            } catch (error) {
              rejectActive(active, error);
              return;
            }
          }
          settleFromNative(active, observed.mapped);
        },
        (error) => rejectActive(active, error)
      );
      return;
    }
    persisted.catch((error) => rejectActive(active, error));
  }

  /**
   * `thread/compact/start` acknowledges scheduling only. The app-server runs
   * compaction as its own turn and emits the actual lifecycle notifications
   * afterwards. Keep that internal turn separate from the user turn so its
   * `turn/completed` cannot settle (or anchor) the pending chat request.
   */
  async compactNativeThread(active) {
    const wait = this.bridge.waitForCompaction(active.nativeThreadId);
    try {
      await this.client.request('thread/compact/start', { threadId: active.nativeThreadId });
      await wait;
    } catch (error) {
      this.bridge.cancelCompactionWaiters(error);
      throw error;
    }
  }

  /**
   * A provider can reject `thread/compact/start` itself when the resident
   * native thread is already beyond the provider window. In that case there
   * is no useful in-place recovery: create a clean native thread, carry over
   * only a bounded message tail, and replay the same user turn once.
   */
  async retryAfterContextOverflow(active) {
    active.contextOverflowRetried = true;
    const previousThreadId = active.nativeThreadId;
    const seed = await this.readBoundedNativeSeed(previousThreadId, active);
    const params = chatThreadParams(protocol.buildThreadStartParams({
      approvalMode: active.approvalMode,
      cwd: this.session.projectPath,
      experimentalRawEvents: true
    }), this.currentSession(), active);
    const result = await this.client.request('thread/start', params);
    const nextThreadId = text(result && result.thread && result.thread.id);
    if (!nextThreadId) throw new ChatRuntimeError('codex_native_session_missing', 502);
    if (seed.length > 0) {
      await this.client.request('thread/inject_items', {
        threadId: nextThreadId,
        items: seed
      });
    }
    if (previousThreadId) this.client.unbindTurn(previousThreadId);
    this.nativeThreadId = nextThreadId;
    active.nativeThreadId = nextThreadId;
    active.nativeTurnId = '';
    active.persistedNativeTurnId = '';
    active.anchorPromise = null;
    active.threadHadHistory = seed.length > 0;
    const runId = text(active.context && active.context.runId);
    this.injectedDocumentRuns.delete(runId);
    await this.onNativeSessionBound(nextThreadId, {
      runtimeFingerprint: this.runtime.fingerprint,
      sessionId: this.session.sessionId
    });
    this.bind(active);
    await this.injectOversizedDocuments(active);
    markTrace(active, 'turnSubmitted', { retry: 'context_length_exceeded' });
    await submitCodexTurn({ client: this.client, active,
      anchor: (run, id) => this.anchorNativeTurn(run, id),
      params: chatTurnParams(protocol.buildTurnStartParams({
        approvalMode: active.approvalMode,
        clientUserMessageId: active.context.runId,
        model: active.model,
        prompt: active.prompt,
        imagePaths: active.imagePaths,
        reasoningEffort: active.reasoningEffort,
        threadId: active.nativeThreadId
      }), this.session)
    });
  }

  async readBoundedNativeSeed(threadId, active) {
    if (!threadId) return [];
    const response = await this.client.request('thread/read', {
      threadId,
      includeTurns: true
    });
    const turns = response && response.thread && Array.isArray(response.thread.turns)
      ? response.thread.turns : [];
    const items = turns
      .filter((turn) => text(turn && turn.id) !== text(active.nativeTurnId))
      .flatMap((turn) => Array.isArray(turn && turn.items) ? turn.items : [])
      .map(nativeMessageSeed)
      .filter(Boolean);
    const policy = this.getSessionPolicy() || this.session.policy;
    const contextWindow = active.threadConfig?.model_context_window
      || policy?.contextState?.contextWindow
      || CONTEXT_WINDOW_FALLBACK;
    return budgetHistoryItems(items, contextWindow, policy && policy.documentBudgetPercent).items;
  }

  resumeParams(currentApprovalMode, active) {
    const params = chatThreadParams(protocol.buildThreadResumeParams({
      approvalMode: currentApprovalMode,
      excludeTurns: true,
      threadId: this.nativeThreadId
    }), this.currentSession(), active);
    return params;
  }

  currentSession() { return { ...this.session, policy: this.getSessionPolicy() || this.session.policy }; }

  async cleanup(active) {
    this.bridge.cancelExpectedReplays();
    if (typeof this.bridge.cancelCompactionWaiters === 'function') {
      this.bridge.cancelCompactionWaiters();
    }
    try {
      await this.bridge.flushToolOrder(active.toolOrder);
    } finally {
      if (active.nativeThreadId) this.client.unbindTurn(active.nativeThreadId);
      if (this.active === active) this.active = null;
    }
  }

  anchorNativeTurn(active, nativeTurnId) {
    const anchor = () => {
      if (active.nativeTurnId && active.nativeTurnId !== nativeTurnId) {
        throw new ChatRuntimeError('codex_native_turn_anchor_conflict', 409);
      }
      active.nativeTurnId = nativeTurnId;
      if (active.persistedNativeTurnId === nativeTurnId) return undefined;
      return Promise.resolve(this.onNativeTurnStarted({
        clientUserMessageId: active.context.runId,
        nativeTurnId,
        runId: active.context.runId
      })).then(() => {
        active.persistedNativeTurnId = nativeTurnId;
      });
    };
    let next;
    try {
      next = active.anchorPromise
        ? active.anchorPromise.then(anchor)
        : Promise.resolve(anchor());
    } catch (error) {
      next = Promise.reject(error);
    }
    active.anchorPromise = next;
    return next;
  }

  requireTerminalAnchorTail(active, providerTurnId) {
    if (!active.nativeTurnId || providerTurnId !== active.nativeTurnId) {
      return Promise.reject(new ChatRuntimeError(
        'codex_native_turn_anchor_conflict',
        409
      ));
    }
    if (active.anchorPromise) return active.anchorPromise;
    const recoveredNativeTurnId = text(
      active.context && active.context.activeTurn && active.context.activeTurn.nativeTurnId
    );
    return recoveredNativeTurnId === active.nativeTurnId
      ? Promise.resolve()
      : Promise.reject(new ChatRuntimeError('codex_native_turn_anchor_missing', 409));
  }

  dispose() {
    if (this.disposed) return false;
    this.disposed = true;
    this.bridge.cancelExpectedReplays();
    this.bridge.cancelCompactionWaiters();
    if (this.active) {
      const active = this.active;
      this.cleanup(active).catch(() => {});
      rejectActive(active, new ChatRuntimeError('codex_driver_closed', 410));
    }
    this.releaseClient();
    return true;
  }

  requireContext(context) {
    if (text(context.sessionId) !== this.session.sessionId) {
      throw new ChatRuntimeError('chat_actor_session_mismatch', 409);
    }
  }
}

function normalizeImagePaths(value) {
  return Array.isArray(value)
    ? value.map(text).filter(Boolean)
    : [];
}

function isContextLengthFailure(mapped) {
  const error = mapped && mapped.payload && mapped.payload.error;
  const code = text(error && error.code).toLowerCase();
  const message = text(error && error.message).toLowerCase();
  return code === 'context_length_exceeded'
    || code === 'context_window_exceeded'
    || message.includes('input token count exceeds')
    || message.includes('maximum number of tokens allowed')
    || message.includes('context length exceeded');
}

function nativeMessageSeed(item) {
  if (!item || typeof item !== 'object' || item.type !== 'message') return null;
  const role = text(item.role).toLowerCase();
  if (role !== 'user' && role !== 'assistant') return null;
  return item;
}

function providerEventContext(active) {
  return {
    ...active.context,
    toolOrder: active.toolOrder,
    ...(active.model ? { model: active.model } : {})
  };
}

function normalizeClientLease(resource) {
  if (resource && resource.client && typeof resource.release === 'function') {
    return resource;
  }
  return { client: resource, release: () => false };
}

function markTrace(active, stage, details) {
  const trace = active && active.context && active.context.trace;
  if (trace && typeof trace.mark === 'function') trace.mark(stage, details);
}

function observeTrace(active, event) {
  const trace = active && active.context && active.context.trace;
  if (trace && typeof trace.observeProviderEvent === 'function') {
    trace.observeProviderEvent(event);
  }
}

function createCodexDriverEntry(options = {}) {
  const driver = new CodexSessionDriver(options);
  return Object.freeze({
    provider: 'codex',
    driver,
    capabilities: codexCapabilities(driver.runtime),
    composerCatalog: () => driver.readComposerCatalog(),
    handlers: createCodexHandlers(driver.commands, {
      releaseFailureSink: options.interactionReleaseFailureSink
    })
  });
}

module.exports = { CodexSessionDriver, createCodexDriverEntry };
