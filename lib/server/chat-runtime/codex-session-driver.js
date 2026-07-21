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

class CodexSessionDriver {
  constructor(options = {}) {
    this.session = requireSession(options.session);
    this.runtime = requireRuntime(options.runtime);
    this.runtimeScope = this.runtime.runtimeScope;
    this.getSessionPolicy = typeof options.getSessionPolicy === 'function'
      ? options.getSessionPolicy
      : () => this.session.policy;
    this.nativeThreadId = text(this.session.runtimeBinding.nativeSessionId);
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
    const prompt = text(context.command && context.command.payload.content);
    const imagePaths = normalizeImagePaths(context.imagePaths);
    if (!prompt && imagePaths.length === 0) {
      throw new ChatRuntimeError('chat_turn_content_required', 422);
    }
    const model = text(context.command && context.command.payload.model);
    const reasoningEffort = text(context.command && context.command.payload.reasoningEffort);
    const currentApprovalMode = approvalMode(this.getSessionPolicy() || this.session.policy);
    const active = createActive(context, prompt, model, reasoningEffort, imagePaths);
    active.approvalMode = currentApprovalMode;
    this.active = active;
    this.launch(active).catch((error) => rejectActive(active, error));
    return active.done.finally(() => this.cleanup(active));
  }
  interruptTurn(context = {}) {
    this.requireContext(context);
    return this.commands.interruptTurn();
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
    const settings = await this.modelCatalog.resolveTurnSettings({
      model: active.model,
      reasoningEffort: active.reasoningEffort
    });
    active.model = settings.model;
    active.reasoningEffort = settings.reasoningEffort;
    markTrace(active, 'authReady', { runtimeId: this.runtimeScope });
    await this.acquireThread(active);
    markTrace(active, 'turnSubmitted');
    const result = await this.client.request('turn/start', protocol.buildTurnStartParams({
      approvalMode: active.approvalMode,
      clientUserMessageId: active.context.runId,
      model: active.model,
      prompt: active.prompt,
      imagePaths: active.imagePaths,
      reasoningEffort: active.reasoningEffort,
      threadId: active.nativeThreadId
    }));
    const nativeTurnId = text(result && result.turn && result.turn.id);
    if (!nativeTurnId) throw new ChatRuntimeError('codex_native_turn_missing', 502);
    await this.anchorNativeTurn(active, nativeTurnId);
  }

  async acquireThread(active) {
    if (this.nativeThreadId) {
      active.nativeThreadId = this.nativeThreadId;
      await this.history.run();
      this.bind(active);
      await this.client.request(
        'thread/resume',
        this.resumeParams(active.approvalMode)
      );
      markTrace(active, 'sessionBound', { runtimeId: this.runtimeScope });
      return;
    }
    const result = await this.client.request('thread/start', protocol.buildThreadStartParams({
      approvalMode: active.approvalMode,
      cwd: this.session.projectPath
    }));
    const threadId = text(result && result.thread && result.thread.id);
    if (!threadId) throw new ChatRuntimeError('codex_native_session_missing', 502);
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
      onDisconnected: (error) => rejectActive(active, error),
      onNotification: (message) => this.observe(active, message, false),
      onServerRequest: (message) => this.observe(active, message, true),
      resumeParams: this.resumeParams(active.approvalMode)
    });
  }

  observe(active, message, serverRequest) {
    if (this.active !== active || active.settled) return;
    const context = providerEventContext(active);
    const observed = serverRequest
      ? this.bridge.forwardServerRequest(message, context, this.client)
      : this.bridge.forwardNotification(message, context);
    observeTrace(active, observed.event);
    let persisted = observed.persisted;
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
        () => settleFromNative(active, observed.mapped),
        (error) => rejectActive(active, error)
      );
      return;
    }
    persisted.catch((error) => rejectActive(active, error));
  }

  resumeParams(currentApprovalMode) {
    return protocol.buildThreadResumeParams({
      approvalMode: currentApprovalMode,
      excludeTurns: true,
      threadId: this.nativeThreadId
    });
  }

  cleanup(active) {
    this.bridge.cancelExpectedReplays();
    if (active.nativeThreadId) this.client.unbindTurn(active.nativeThreadId);
    if (this.active === active) this.active = null;
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
    if (this.active) {
      const active = this.active;
      this.cleanup(active);
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

function providerEventContext(active) {
  return {
    ...active.context,
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
