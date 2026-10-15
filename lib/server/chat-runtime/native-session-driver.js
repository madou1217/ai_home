'use strict';

// 原生会话驱动（work 模式）：把既有原生会话引擎（lib/server/native-session-chat.js 的
// spawnNativeSessionStream，legacy 引擎一直在用的那套）包成 canonical driver 契约。
//
// 目标：work 会话在 canonical 里跑得起来（同一套时间线/命令/恢复），从而让 legacy surface
// 可以退役。**复用现有引擎、不改其行为** —— 这里只做「参数适配 + 事件翻译 + 生命周期桥接」。
//
// 尚未对齐的能力（诚实声明，见 docs/plans/2026-10-15-chat-legacy-retirement-readiness.md）：
// - slash.execute：legacy 靠交互式 PTY 跑 slash 全集；本驱动只走 headless/prompt 路径 → unsupported
// - terminal.stream：legacy 有 xterm 面板 → unsupported
// - interaction.approval：legacy 走审批桥；本驱动暂未接线 → unsupported
// - recoverTurn：未实现 → 服务重启后 in-flight 轮次按 idle 处理（不猜）

const { spawnNativeSessionStream } = require('../native-session-chat');
const { ChatRuntimeError } = require('./contracts');
const { sessionAttachmentTurnInput } = require('./chat-harness-policy');
const { createNativeSessionEventMapper } = require('./native-session-event-bridge');
const { normalizeApprovalMode, approvalModeNeedsBridge } = require('../native-approval-modes');

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function support(value, reason) {
  return Object.freeze({ support: value, ...(reason ? { reason } : {}) });
}

/** 原生会话能力快照：与 codex 驱动同构，未对齐项显式标 unsupported（不静默缺失）。 */
function nativeSessionCapabilities(runtime, provider) {
  return Object.freeze({
    revision: runtime && (runtime.capabilityHash || runtime.fingerprint || runtime.version) || `${provider}-native`,
    capabilities: Object.freeze({
      'session.resume': support('native'),
      'timeline.reasoning': support('native'),
      'timeline.tool': support('native'),
      'timeline.diff': support('unsupported', 'native_session_stream_has_no_diff_events'),
      'mode.plan': support('unsupported', 'native_session_plan_mode_not_wired'),
      'interaction.question': support('unsupported', 'native_session_interaction_not_wired'),
      'interaction.approval': support('unsupported', 'native_session_approval_bridge_not_wired'),
      'interaction.plan_confirmation': support('unsupported', 'native_session_plan_mode_not_wired'),
      'turn.interrupt': support('native'),
      'turn.steer.current': support('unsupported', 'native_session_steer_not_wired'),
      'turn.steer.tool_boundary': support('emulated', 'aih_chat_runtime_tool_boundary_queue'),
      'turn.queue': support('emulated', 'aih_chat_runtime_queue'),
      'session.goal': support('emulated', 'aih_session_goal_projection'),
      'slash.execute': support('unsupported', 'native_session_slash_needs_interactive_pty'),
      'terminal.stream': support('unsupported', 'native_session_terminal_panel_retired_with_legacy'),
      'run.adopt': support('native')
    }),
    slashCommands: Object.freeze([]),
    turnInterveneModes: Object.freeze([])
  });
}

class NativeSessionDriver {
  constructor(options = {}) {
    this.session = options.session;
    this.runtime = options.runtime;
    this.runtimeScope = options.runtime && options.runtime.runtimeScope || this.session.executionAccountRef;
    this.getSessionPolicy = typeof options.getSessionPolicy === 'function'
      ? options.getSessionPolicy
      : () => this.session.policy;
    this.nativeSessionId = text(this.session.runtimeBinding && this.session.runtimeBinding.nativeSessionId);
    this.eventSink = typeof options.eventSink === 'function' ? options.eventSink : () => {};
    this.transientEventSink = typeof options.transientEventSink === 'function' ? options.transientEventSink : () => {};
    this.onNativeSessionBound = typeof options.onNativeSessionBound === 'function' ? options.onNativeSessionBound : () => {};
    this.active = null;
    this.disposed = false;
    this.options = options;
  }

  startTurn(context = {}) {
    if (this.disposed) throw new ChatRuntimeError('native_session_driver_closed', 410);
    if (this.active) throw new ChatRuntimeError('chat_turn_already_active', 409);
    const payload = context.command && context.command.payload || {};
    const turnInput = sessionAttachmentTurnInput(
      this.session, text(payload.content), context.imagePaths, this.options.fs
    );
    const prompt = turnInput.prompt;
    const imagePaths = turnInput.imagePaths || [];
    if (!prompt && imagePaths.length === 0) {
      throw new ChatRuntimeError('chat_turn_content_required', 422);
    }
    const provider = text(this.session.provider).toLowerCase();
    // 模型：turn 命令优先，其次会话策略；空则交给 CLI 自己的默认模型。
    const model = text(payload.model || (this.getSessionPolicy() || this.session.policy || {}).model);
    // 审批桥未接线前 fail closed：confirm/plan 需要权限回路，headless 直跑会**静默跳过权限提示**，
    // 那是安全回归，宁可明确拒绝（条件 ④ 完成后放开）。
    const approvalMode = normalizeApprovalMode((this.getSessionPolicy() || this.session.policy || {}).approvalMode);
    if (approvalModeNeedsBridge(approvalMode)) {
      throw new ChatRuntimeError('native_session_approval_bridge_unavailable', 501, {
        provider, approvalMode, reason: 'native_session_approval_bridge_not_wired'
      });
    }
    const mapper = createNativeSessionEventMapper({
      provider,
      turnId: context.turnId,
      assistantItemId: `native-assistant-${context.turnId}`
    });
    const active = { turnId: context.turnId, runId: context.runId, settled: false, handle: null };
    this.active = active;

    const done = new Promise((resolve, reject) => {
      const settle = (fn, value) => {
        if (active.settled) return;
        active.settled = true;
        fn(value);
      };
      const emit = (event) => {
        try { this.eventSink(event); } catch (_error) { /* 事件出口失败不影响上游会话 */ }
      };
      let handle;
      try {
        handle = spawnNativeSessionStream({
          provider,
          accountRef: this.session.executionAccountRef,
          gateway: false,
          sessionId: this.nativeSessionId,
          projectDirName: this.session.policy && this.session.policy.projectDirName,
          projectPath: this.session.projectPath,
          prompt,
          imagePaths,
          ...(model ? { model } : {}),
          env: this.options.env,
          aiHomeDir: this.options.aiHomeDir,
          hostHomeDir: this.options.hostHomeDir,
          getProfileDir: this.options.getProfileDir,
          ensureSessionStoreLinks: this.options.ensureSessionStoreLinks,
          interactiveCli: false,
          onEvent: (event) => {
            const mapped = mapper.map(event);
            for (const canonical of mapped.events) {
              if (canonical.type.startsWith('transient.')) {
                try { this.transientEventSink(canonical); } catch (_error) { /* best effort */ }
              } else {
                emit(canonical);
              }
            }
            if (mapped.nativeSessionId && mapped.nativeSessionId !== this.nativeSessionId) {
              this.nativeSessionId = mapped.nativeSessionId;
              try { this.onNativeSessionBound(mapped.nativeSessionId); } catch (_error) { /* best effort */ }
            }
            if (mapped.error) {
              settle(reject, new ChatRuntimeError('native_session_failed', 502, {
                provider, detail: mapped.error
              }));
            }
          }
        });
      } catch (error) {
        settle(reject, error);
        return;
      }
      active.handle = handle;
      Promise.resolve(handle && handle.done).then(
        () => settle(resolve, { turnId: context.turnId, runId: context.runId, model: text(payload.model) }),
        (error) => settle(reject, error instanceof Error
          ? error
          : new ChatRuntimeError('native_session_failed', 502, { provider, detail: String(error || '') }))
      );
    });
    active.done = done;
    return done.finally(() => {
      if (this.active === active) this.active = null;
    });
  }

  async interruptTurn() {
    const handle = this.active && this.active.handle;
    if (handle && typeof handle.abort === 'function') await handle.abort();
    return { interrupted: true };
  }

  async waitForIdle() {
    const active = this.active;
    if (active && active.done) await active.done.catch(() => {});
  }

  dispose() {
    if (this.disposed) return false;
    this.disposed = true;
    const handle = this.active && this.active.handle;
    try { if (handle && typeof handle.abort === 'function') handle.abort(); } catch (_error) { /* best effort */ }
    this.active = null;
    return true;
  }
}

/** canonical driver entry：形状与 createCodexDriverEntry 一致。 */
function createNativeSessionDriverEntry(options = {}) {
  const driver = new NativeSessionDriver(options);
  const provider = text(options.session && options.session.provider).toLowerCase();
  const readModels = typeof options.readModels === 'function' ? options.readModels : null;
  return Object.freeze({
    provider,
    driver,
    capabilities: nativeSessionCapabilities(driver.runtime, provider),
    composerCatalog: async () => {
      if (!readModels) return { models: [], defaultModel: '' };
      const ids = await readModels(provider, driver.session.executionAccountRef);
      const models = [...new Set(Array.isArray(ids) ? ids : [])]
        .map((id) => ({ id, label: id, supportedEfforts: [], defaultEffort: '' }));
      return { models, defaultModel: models[0] ? models[0].id : '' };
    },
    handlers: {}
  });
}

module.exports = {
  NativeSessionDriver,
  createNativeSessionDriverEntry,
  nativeSessionCapabilities
};

