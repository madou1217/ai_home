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
const { startOpenCodeServeTurn } = require('../opencode-serve-runner');
const { ChatRuntimeError } = require('./contracts');
const { sessionAttachmentTurnInput } = require('./chat-harness-policy');
const { createNativeSessionEventMapper } = require('./native-session-event-bridge');
const { normalizeApprovalMode } = require('../native-approval-modes');
const { NativeApprovalSurface } = require('./native-approval-surface');
const {
  nativeSessionSpawnOptions,
  resolveNativeSessionLaunchProfile
} = require('../native-session-launch-profile');
const {
  createNativeSessionPreparationHandlers,
  runNativeSessionPreparation
} = require('../native-session-launch-preparation');
const {
  SPAWNER_NATIVE_STREAM,
  SPAWNER_OPENCODE_SERVE,
  createApprovalSpawnerRegistry,
  findApprovalTransport,
  resolveNativeApprovalTransport
} = require('./native-approval-transports');

// 执行器注册表：策略表只写 spawner id，实现放这里（新增执行器 = 加一行，不改派发）。
function createNativeApprovalSpawners(overrides = {}) {
  return createApprovalSpawnerRegistry({
    [SPAWNER_NATIVE_STREAM]: spawnNativeSessionStream,
    [SPAWNER_OPENCODE_SERVE]: startOpenCodeServeTurn,
    ...overrides
  });
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function support(value, reason) {
  return Object.freeze({ support: value, ...(reason ? { reason } : {}) });
}

/** 审批能力快照：来自策略表（声明了通道=原生；未声明/未接线=unsupported + 原因）。 */
function approvalCapabilityFor(provider, spawners) {
  const transport = findApprovalTransport({ provider, approvalMode: 'confirm' });
  if (!transport) return support('unsupported', 'native_session_approval_transport_undeclared');
  if (!transport.spawner) {
    return support('unsupported', transport.unsupportedReason || 'native_session_approval_transport_not_wired');
  }
  if (!spawners.has(transport.spawner)) {
    return support('unsupported', 'native_session_approval_spawner_unavailable');
  }
  return support('native');
}

/** 原生会话能力快照：与 codex 驱动同构，未对齐项显式标 unsupported（不静默缺失）。 */
function nativeSessionCapabilities(runtime, provider, spawners) {
  const approval = spawners
    ? approvalCapabilityFor(provider, spawners)
    : support('unsupported', 'native_session_approval_transport_undeclared');
  return Object.freeze({
    revision: runtime && (runtime.capabilityHash || runtime.fingerprint || runtime.version) || `${provider}-native`,
    capabilities: Object.freeze({
      'session.resume': support('native'),
      'timeline.reasoning': support('native'),
      'timeline.tool': support('native'),
      'timeline.diff': support('unsupported', 'native_session_stream_has_no_diff_events'),
      'mode.plan': support('unsupported', 'native_session_plan_mode_not_wired'),
      'interaction.question': support('unsupported', 'native_session_interaction_not_wired'),
      'interaction.approval': approval,
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
    // 审批面（canonical 交互）：只有声明了审批通道的 provider 才会真正用到。
    this.approvalSurface = typeof options.createApprovalSurface === 'function'
      ? options.createApprovalSurface()
      : null;
    this.spawners = options.approvalSpawners || createNativeApprovalSpawners();
    // 启动准备管线：步骤由档案声明、实现由注册表提供（见 native-session-launch-preparation）。
    this.preparationHandlers = options.preparationHandlers || createNativeSessionPreparationHandlers(options);
    this.diagnostics = typeof options.diagnostics === 'function' ? options.diagnostics : () => {};
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
    // 模型：turn 命令优先，其次会话策略；都没有时用与 legacy 同一处的 provider 默认模型解析。
    // （缺默认模型的代价不是"用错模型"，而是 provider CLI 挂在模型选择上永不返回 —— 2026-10-15 agy 实测。）
    const model = text(payload.model || (this.getSessionPolicy() || this.session.policy || {}).model)
      || text(this.defaultModel(provider));
    // 审批回路：差异全部来自策略表（native-approval-transports），这里不判 provider。
    //   bypass              → 不需要回路
    //   命中且执行器可用     → 用该行的 spawner + launch 参数
    //   未声明 / 通道未接线  → fail closed（明确拒绝，绝不静默降级为无提示直跑）
    const approvalMode = normalizeApprovalMode((this.getSessionPolicy() || this.session.policy || {}).approvalMode);
    const approvalResolution = this.resolveApproval(provider, approvalMode);
    if (approvalResolution.support === 'unsupported') {
      throw new ChatRuntimeError('native_session_approval_bridge_unavailable', 501, {
        provider,
        approvalMode,
        reason: approvalResolution.reason
      });
    }
    if (approvalResolution.support === 'native' && this.approvalSurface) {
      this.approvalSurface.bindRun(context.runId);
    }
    // 启动档案：执行模式 / prompt 投递 / 形态旗标 / 准备步骤，全部来自描述符（驱动不判 provider）。
    const launchProfile = resolveNativeSessionLaunchProfile(provider, {
      isResume: Boolean(this.nativeSessionId)
    });
    // 启动前准备（CLI 路径同款步骤）：缺这一步时「需要投影的 provider」会在首次链接前 fail-closed。
    runNativeSessionPreparation(launchProfile, 'preparation', {
      provider,
      accountRef: this.session.executionAccountRef,
      projectPath: this.session.projectPath,
      prompt,
      nativeSessionId: this.nativeSessionId
    }, { handlers: this.preparationHandlers, diagnostics: this.diagnostics });
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
        handle = this.spawnTurn({
          provider,
          approvalResolution,
          approvalMode,
          runId: context.runId,
          prompt,
          imagePaths,
          model,
          launchProfile,
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
              this.runPostSpawnPreparation(launchProfile, mapped.nativeSessionId, prompt);
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
        () => {
          // 收尾：引擎没发 result 的 provider（只流式输出正文）在这里补 completed 条目，
          // 否则时间线停在 streaming（投影器只认 started/completed 建条目）。
          try {
            const finalized = mapper.finalize();
            if (finalized && finalized.event) emit(finalized.event);
          } catch (_error) { /* 收尾失败不改变轮次结果 */ }
          settle(resolve, { turnId: context.turnId, runId: context.runId, model: text(payload.model) });
        },
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

  /**
   * 审批回路解析：provider / 审批模式 / 账号类型 → 策略表行（native-approval-transports）。
   * 账号类型目前由可选端口提供（未提供即不按账号类型过滤，绝不猜）。
   */
  resolveApproval(provider, approvalMode) {
    const resolution = resolveNativeApprovalTransport({
      provider,
      approvalMode,
      accountType: this.accountType()
    });
    if (resolution.support !== 'native') return resolution;
    if (!this.spawners.has(resolution.spawner)) {
      return Object.freeze({
        support: 'unsupported',
        transport: resolution.transport,
        reason: 'native_session_approval_spawner_unavailable'
      });
    }
    return resolution;
  }

  accountType() {
    const resolve = this.options.resolveAccountType;
    if (typeof resolve !== 'function') return '';
    try {
      return text(resolve(this.session.executionAccountRef));
    } catch (_error) {
      return '';
    }
  }

  /** 账号运行态端口（延迟求值）：native session 的失败判定要能写回账号运行态。 */
  accountRuntimePorts() {
    const resolve = this.options.getAccountRuntimePorts;
    if (typeof resolve !== 'function') return {};
    try {
      const ports = resolve() || {};
      return {
        ...(ports.accountRuntimeEventHub ? { accountRuntimeEventHub: ports.accountRuntimeEventHub } : {}),
        ...(ports.accountStateService ? { accountStateService: ports.accountStateService } : {}),
        ...(ports.accountRuntimeGate ? { accountRuntimeGate: ports.accountRuntimeGate } : {})
      };
    } catch (_error) {
      return {};
    }
  }

  /** provider 默认模型：注入端口（与 legacy 同源）；未装配端口时不猜（返回空）。 */
  defaultModel(provider) {
    const resolve = this.options.resolveDefaultModel;
    if (typeof resolve !== 'function') return '';
    try {
      return text(resolve(provider, this.session.executionAccountRef));
    } catch (_error) {
      return '';
    }
  }

  spawnerFor(approvalResolution) {
    const id = approvalResolution.support === 'native'
      ? approvalResolution.spawner
      : SPAWNER_NATIVE_STREAM;
    const spawner = this.spawners.get(id);
    if (!spawner) {
      throw new ChatRuntimeError('native_session_approval_spawner_unavailable', 501, { spawner: id });
    }
    return spawner;
  }

  /** 执行一次原生轮次：基础参数在此，形态/投递来自启动档案，审批参数来自策略行（驱动不判 provider）。 */
  spawnTurn(input) {
    const spawner = this.spawnerFor(input.approvalResolution);
    const profile = input.launchProfile || resolveNativeSessionLaunchProfile(input.provider, {
      isResume: Boolean(this.nativeSessionId)
    });
    const base = {
      provider: input.provider,
      accountRef: this.session.executionAccountRef,
      gateway: false,
      sessionId: this.nativeSessionId,
      projectDirName: this.session.policy && this.session.policy.projectDirName,
      projectPath: this.session.projectPath,
      ...nativeSessionSpawnOptions(profile, { prompt: input.prompt }),
      imagePaths: input.imagePaths,
      ...(input.model ? { model: input.model } : {}),
      env: this.options.env,
      aiHomeDir: this.options.aiHomeDir,
      hostHomeDir: this.options.hostHomeDir,
      getProfileDir: this.options.getProfileDir,
      ensureSessionStoreLinks: this.options.ensureSessionStoreLinks,
      ...this.accountRuntimePorts(),
      onEvent: input.onEvent
    };
    if (input.approvalResolution.support !== 'native') return spawner(base);
    const launch = input.approvalResolution.launch({
      approvalMode: input.approvalMode,
      approvalRequestUrl: this.options.approvalRequestUrl,
      approvalToolPath: this.options.approvalToolPath,
      runId: input.runId,
      approvalSurface: this.approvalSurface
    });
    return spawner({ ...base, ...(launch && typeof launch === 'object' ? launch : {}) });
  }

  /** 启动后收尾（档案声明）：会话 id 已知后补索引等，best effort，失败只记诊断。 */
  runPostSpawnPreparation(profile, nativeSessionId, prompt) {
    try {
      return runNativeSessionPreparation(profile, 'postSpawn', {
        provider: profile.provider,
        accountRef: this.session.executionAccountRef,
        projectPath: this.session.projectPath,
        prompt,
        nativeSessionId
      }, { handlers: this.preparationHandlers, diagnostics: this.diagnostics });
    } catch (error) {
      this.diagnostics({
        code: 'native_session_post_spawn_preparation_failed',
        provider: profile.provider,
        detail: String((error && error.message) || error || 'unknown_error')
      });
      return [];
    }
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
    if (this.approvalSurface && typeof this.approvalSurface.dispose === 'function') {
      try { this.approvalSurface.dispose(); } catch (_error) { /* best effort */ }
    }
    return true;
  }
}

/** canonical driver entry：形状与 createCodexDriverEntry 一致。 */
function createNativeSessionDriverEntry(options = {}) {
  const spawners = options.approvalSpawners || createNativeApprovalSpawners();
  const driverOptions = {
    ...options,
    approvalSpawners: spawners,
    ...(options.createApprovalSurface ? {} : { createApprovalSurface: () => null })
  };
  const driver = new NativeSessionDriver(driverOptions);
  const provider = text(options.session && options.session.provider).toLowerCase();
  const readModels = typeof options.readModels === 'function' ? options.readModels : null;
  return Object.freeze({
    provider,
    driver,
    capabilities: nativeSessionCapabilities(driver.runtime, provider, spawners),
    composerCatalog: async () => {
      if (!readModels) return { models: [], defaultModel: '' };
      const ids = await readModels(provider, driver.session.executionAccountRef);
      const models = [...new Set(Array.isArray(ids) ? ids : [])]
        .map((id) => ({ id, label: id, supportedEfforts: [], defaultEffort: '' }));
      return { models, defaultModel: models[0] ? models[0].id : '' };
    },
    handlers: driver.approvalSurface ? driver.approvalSurface.handlers() : {}
  });
}

module.exports = {
  NativeSessionDriver,
  NativeApprovalSurface,
  createNativeApprovalSpawners,
  createNativeSessionDriverEntry,
  nativeSessionCapabilities
};

