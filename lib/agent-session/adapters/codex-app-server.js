'use strict';

// Codex app-server adapter：把 WS JSON-RPC 翻译成 agent-session 契约。
//
// 这里刻意**不**重写协议：方法名、审批策略、参数构造、通知映射、回复形状全部复用
// lib/server 里已有的纯函数。adapter 只负责三件协议层不管的事：
//   1. 生命周期（连接 → initialize → thread/start|resume → 绑定通知/请求）；
//   2. 把 server request 变成「一次有 id 的交互请求」，把归一化决策变回 JSON-RPC result；
//   3. 把通知筛成契约事件，turn.* 与 interaction.* 留给外壳/路由器发（它们各自拥有）。
//
// 传输层可注入：context.client / context.transport 直接给现成 client，
// context.createClient 给工厂；都没有时才去连真 WS。测试因此不碰网络与子进程。

const { isPlainObject, nonEmptyString } = require('../contracts');
const protocol = require('../../server/codex-app-server-protocol');
const { mapCodexAppServerMessage } = require('../../server/codex-app-server-canonical');
const {
  adaptCodexInteractionRequest
} = require('../../server/chat-runtime/codex-interaction-request-adapter');
const {
  adaptCodexServerResponse
} = require('../../server/chat-runtime/codex-server-response-adapters');

const ADAPTER_ID = 'codex-app-server';

// 审批模式的真值源是协议里的 APPROVAL_MODE_POLICIES，但它没有从
// codex-app-server-protocol 导出（只导出了 buildApprovalPolicyParams）。所以这里只列 id，
// 是否受支持一律问协议函数：模式被删/改名时 describeModes 会自动不再宣传它，
// setMode/open 也会直接拒绝，不会出现「UI 能选、发出去 400」。
const MODE_CANDIDATES = Object.freeze(['bypass', 'confirm', 'plan']);
const MODE_LABELS = Object.freeze({
  bypass: 'Bypass approvals',
  confirm: 'Ask before running commands',
  plan: 'Plan only'
});
const MODE_IDS = Object.freeze(MODE_CANDIDATES.filter((id) => isSupportedMode(id)));
// 与仓库既有默认一致（native-approval-modes 的 normalizeApprovalMode 也落 bypass）：
// 要看到审批必须显式传 mode: 'confirm'，adapter 不替调用方改默认行为。
const DEFAULT_APPROVAL_MODE = 'bypass';
// 只有这些模式下，turn/plan/updated 才代表「等人批准计划」。bypass/confirm 下
// plan 只是进度展示，弹确认会把每个计划更新变成一次打扰。
const PLAN_CONFIRMATION_MODES = new Set(['plan']);
const PLAN_CHOICE_FIELD_ID = 'choice';
const PLAN_CHOICES = Object.freeze([
  Object.freeze({ value: 'implement', label: 'Implement this plan' }),
  Object.freeze({ value: 'revise', label: 'Keep planning' })
]);

// 这些事件的所有者是外壳：turn.* 由 session.js 在 prompt 前后成对发出，
// interaction.* 由 interaction-router 发出。adapter 再发一遍就会出现
// 「一个 turn 两个 completed」「一次交互两个 requested」，监听方按 seq 去重也救不回来。
const SHELL_OWNED_EVENT_TYPES = new Set([
  'turn.started', 'turn.completed', 'turn.failed', 'turn.interrupted',
  'interaction.requested', 'interaction.updated', 'interaction.resolved', 'interaction.expired'
]);

function codedError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

// 只有没有 code 的异常才需要兜底；已有 code 的（client 的 codex_app_server_disconnected、
// 映射层的 invalid_codex_*）必须原样上抛，否则调用方拿到的错误码是假的。
function asCoded(error, fallbackCode) {
  if (error && typeof error.code === 'string' && error.code) return error;
  const message = String(error && error.message ? error.message : error);
  return Object.assign(new Error(message || fallbackCode), { code: fallbackCode });
}

function createDeferred() {
  const deferred = {};
  deferred.promise = new Promise((resolve, reject) => {
    deferred.resolve = resolve;
    deferred.reject = reject;
  });
  return deferred;
}

// 用协议的参数构造函数当校验器：它内部查 APPROVAL_MODE_POLICIES，
// 未支持的模式会抛 codex_approval_mode_unsupported。这样模式名单只在这一处有字面量。
function isSupportedMode(modeId) {
  try {
    protocol.buildApprovalPolicyParams(modeId);
    return true;
  } catch (_error) {
    return false;
  }
}

function normalizeMode(value) {
  const id = nonEmptyString(value);
  if (!isSupportedMode(id)) {
    throw codedError('agent_session_mode_unknown', `未知审批模式：${id || '(empty)'}`);
  }
  return id;
}

function normalizeImagePaths(images) {
  return (Array.isArray(images) ? images : [])
    .map((image) => (typeof image === 'string' ? image : image && image.path))
    .map((value) => nonEmptyString(value))
    .filter(Boolean);
}

// 归一化决策 → adaptCodexServerResponse 的输入形状。
// approval 只认 choiceId；question 那边协议字段叫 answer（单数），router 给我们的是
// answers（复数），这一处转换是两种形状的唯一边界。
const SERVER_RESOLUTION_BUILDERS = Object.freeze({
  approval: (decision) => ({ choiceId: decision.choiceId }),
  question: (decision) => ({ action: decision.action, answer: decision.answers })
});

function createAdapter(options) {
  const config = isPlainObject(options) ? options : {};
  const sessionId = nonEmptyString(config.sessionId);
  if (!sessionId) throw codedError('agent_session_id_required');
  const provider = nonEmptyString(config.provider);
  if (!provider) throw codedError('agent_session_provider_required');
  const transport = nonEmptyString(config.transport) || ADAPTER_ID;
  const context = isPlainObject(config.context) ? config.context : {};

  const listeners = new Set();
  const handlers = new Set();
  const pendingInteractions = new Map();
  // 同一 turn 只问一次计划：turn/plan/updated 会随步骤推进反复到达，
  // 每次都弹确认等于把用户钉在对话框上。
  const planAskedTurns = new Set();
  // turn/start 的响应与 turn/completed 通知没有先后保证：早到的收尾先存这里。
  const earlyTerminals = new Map();

  let client = null;
  let ownsClient = false;
  let threadId = '';
  let opened = false;
  let disposed = false;
  let mode = DEFAULT_APPROVAL_MODE;
  let model = '';
  let models = [];
  let activeTurn = null;

  function emit(event) {
    for (const listener of Array.from(listeners)) {
      try {
        listener(event);
      } catch (_error) {
        // 监听方异常不能打断协议泵：一次抛错会让后续通知全丢，
        // 与 event-bus 的「listener 之间互相隔离」同一纪律。
      }
    }
  }

  function forward(event) {
    if (!event || SHELL_OWNED_EVENT_TYPES.has(event.type)) return;
    emit(event);
  }

  function resolveClient() {
    if (typeof context.createClient === 'function') {
      return { client: context.createClient({ sessionId, provider, transport, context }), owns: false };
    }
    const injected = context.client || context.transport;
    if (injected && typeof injected.request === 'function') return { client: injected, owns: false };
    // 只有真的要连真 server 时才把 client / 端点那套（tmux、账号投影、端口探测）
    // 拉进来；注入 client 的调用方不该被这些副作用牵连。
    const { createAppServerClient } = require('../../server/codex-app-server-json-rpc-client');
    const created = createAppServerClient({
      wsImpl: context.wsImpl,
      accountIdentityValidator: context.accountIdentityValidator,
      resolveEndpoint: () => resolveEndpoint()
    });
    return { client: created, owns: true };
  }

  async function resolveEndpoint() {
    const injected = nonEmptyString(context.endpoint);
    if (injected) return injected;
    const { ensureCodexAppServerEndpoint } = require('../../server/codex-app-server-endpoint');
    const { port } = await ensureCodexAppServerEndpoint(context);
    return `ws://127.0.0.1:${port}`;
  }

  async function requestOrThrow(method, params, code) {
    if (!client || typeof client.request !== 'function') {
      throw codedError('codex_app_server_client_missing');
    }
    try {
      return await client.request(method, params);
    } catch (error) {
      throw asCoded(error, code);
    }
  }

  async function readModels() {
    const response = await requestOrThrow('model/list', { includeHidden: false }, 'codex_model_catalog_unavailable');
    const data = Array.isArray(response && response.data) ? response.data : [];
    const entries = data.map((value) => {
      const entry = isPlainObject(value) ? value : {};
      const id = nonEmptyString(entry.model);
      if (!id) return null;
      return Object.freeze({
        id,
        label: nonEmptyString(entry.displayName) || id,
        isDefault: entry.isDefault === true
      });
    }).filter(Boolean);
    // 空目录不能当成「没有模型可选」放过去：TUI 会拿到一个空下拉，
    // 用户以为会话可用，实际每轮都失败。
    if (entries.length === 0) throw codedError('codex_model_catalog_empty');
    return entries;
  }

  function requireModel(modelId) {
    const id = nonEmptyString(modelId);
    if (!models.some((entry) => entry.id === id)) {
      throw codedError('agent_session_model_unknown', `模型不在目录里：${id || '(empty)'}`);
    }
    return id;
  }

  async function startThread(request, approvalMode) {
    const params = protocol.buildThreadStartParams({
      approvalMode,
      cwd: nonEmptyString(request.cwd)
    });
    const result = await requestOrThrow('thread/start', params, 'codex_thread_start_failed');
    const id = nonEmptyString(result && result.thread && result.thread.id);
    if (!id) throw codedError('codex_thread_id_missing');
    return id;
  }

  async function resumeThread(request, approvalMode) {
    const id = nonEmptyString(request.threadId)
      || nonEmptyString(context.threadId)
      || nonEmptyString(context.nativeThreadId);
    // 恢复没有 id 就只能新建，而「以为续上了其实开了新会话」比报错更难查。
    if (!id) throw codedError('codex_thread_id_required', '恢复 Codex 会话需要原生 thread id');
    const params = protocol.buildThreadResumeParams({
      threadId: id,
      approvalMode,
      excludeTurns: true
    });
    await requestOrThrow('thread/resume', params, 'codex_thread_resume_failed');
    return id;
  }

  function bindThread() {
    if (!client || typeof client.bindTurn !== 'function') return;
    client.bindTurn(threadId, {
      // resumeParams 用 getter：重连按**当下**的审批模式恢复，
      // 而不是建绑那一刻的模式（用户可能中途 setMode 过）。
      get resumeParams() {
        return protocol.buildThreadResumeParams({ threadId, approvalMode: mode, excludeTurns: true });
      },
      onNotification: handleNotification,
      onServerRequest: handleServerRequest,
      onDisconnected: (error) => {
        const failure = asCoded(error, 'codex_app_server_disconnected');
        // 断线时在飞的 turn 永远不会收到 turn/completed：不主动收尾就是永久挂起。
        failActiveTurn(failure);
        emit({ type: 'stream.error', payload: { code: failure.code, message: failure.message } });
      }
    });
  }

  function handleNotification(message) {
    if (disposed) return;
    const method = nonEmptyString(message && message.method);
    if (!method) return;
    const params = isPlainObject(message.params) ? message.params : {};
    if (method === 'serverRequest/resolved') forgetServerRequest(params);
    const mapped = mapMessage(message);
    if (mapped) {
      // 先发事件再抬交互：监听方应当先看到计划内容，再看到「要不要批准」。
      forward(mapped);
      if (isPlanItemEvent(mapped)) requestPlanConfirmation(mapped);
    }
    if (method === 'turn/started') observeTurnStarted(params);
    if (method === 'turn/completed') observeTurnCompleted(params);
  }

  function mapMessage(message) {
    let mapped;
    try {
      mapped = mapCodexAppServerMessage(message, { provider, sessionId });
    } catch (error) {
      const failure = asCoded(error, 'codex_app_server_mapping_failed');
      return { type: 'stream.error', payload: { code: failure.code, message: failure.message } };
    }
    if (!mapped || mapped.classification === 'known_noop') return null;
    return mapped;
  }

  function isPlanItemEvent(event) {
    const item = event && event.payload && event.payload.item;
    return event.type === 'timeline.item.updated' && Boolean(item) && item.kind === 'plan';
  }

  function requestPlanConfirmation(event) {
    if (!PLAN_CONFIRMATION_MODES.has(mode)) return;
    const turnId = nonEmptyString(event.turnId);
    if (!turnId || planAskedTurns.has(turnId)) return;
    const item = (event.payload && event.payload.item) || {};
    const steps = Array.isArray(item.detail && item.detail.steps) ? item.detail.steps : [];
    if (steps.length === 0) return;
    planAskedTurns.add(turnId);
    const record = {
      interactionId: `codex-plan:${sessionId}:${turnId}`,
      kind: 'plan_confirmation',
      payload: planPayload(item, steps),
      turnId,
      itemId: nonEmptyString(item.id) || null,
      requestId: null,
      envelope: null,
      answered: false
    };
    pendingInteractions.set(record.interactionId, record);
    deliverInteraction(record);
  }

  function planPayload(item, steps) {
    const lines = steps.map((step, index) => `${index + 1}. ${step.step}`);
    const explanation = nonEmptyString(item.content);
    return {
      presentation: {
        title: 'Approve plan?',
        message: [explanation, ...lines].filter(Boolean).join('\n')
      },
      // 与 CLI 的 plan-choice 先例同形（cli-interaction-adapter）：一个 single_select 字段。
      // question 类 payload 的 answerShape 是 answers，没有字段就过不了 canonical 校验。
      fields: [{
        id: PLAN_CHOICE_FIELD_ID,
        label: 'How should we proceed?',
        type: 'single_select',
        required: true,
        allowOther: false,
        secret: false,
        options: PLAN_CHOICES.map((choice) => ({ value: choice.value, label: choice.label }))
      }],
      actions: ['submit', 'cancel'],
      answerShape: 'answers',
      confirmUnanswered: false
    };
  }

  function handleServerRequest(message) {
    if (disposed) return;
    const requestId = message && message.id;
    let adapted;
    try {
      adapted = adaptCodexInteractionRequest({
        method: message && message.method,
        params: message && message.params,
        requestId,
        sessionId
      });
    } catch (error) {
      const failure = asCoded(error, 'codex_interaction_request_invalid');
      // 请求必须被回答，沉默会让 harness 一直等；回错误码是唯一诚实的处置。
      rejectServerRequest({ requestId }, failure.code);
      emit({ type: 'stream.error', payload: { code: failure.code, message: failure.message } });
      return;
    }
    const interaction = adapted.interaction;
    const params = isPlainObject(message.params) ? message.params : {};
    const record = {
      interactionId: interaction.interactionId,
      kind: interaction.kind,
      payload: interaction.payload,
      turnId: nonEmptyString(params.turnId) || null,
      itemId: interaction.itemId,
      requestId,
      envelope: adapted.envelope,
      answered: false
    };
    pendingInteractions.set(record.interactionId, record);
    deliverInteraction(record);
  }

  function deliverInteraction(record) {
    const request = {
      interactionId: record.interactionId,
      kind: record.kind,
      payload: record.payload,
      turnId: record.turnId,
      itemId: record.itemId
    };
    if (handlers.size === 0) {
      pendingInteractions.delete(record.interactionId);
      rejectServerRequest(record, 'agent_session_interaction_handler_missing');
      emit({
        type: 'stream.error',
        payload: {
          code: 'agent_session_interaction_handler_missing',
          message: `交互 ${record.interactionId} 没有接收方，已拒绝`
        }
      });
      return;
    }
    let failure = null;
    for (const handler of Array.from(handlers)) {
      try {
        handler(request);
      } catch (error) {
        failure = error;
      }
    }
    if (!failure) return;
    // 外壳已经为这条请求发过 stream.error（router 校验失败）；这里只负责别让 harness 空等。
    pendingInteractions.delete(record.interactionId);
    rejectServerRequest(record, 'agent_session_interaction_rejected');
  }

  function rejectServerRequest(record, code) {
    if (!record || record.requestId === null || record.requestId === undefined) return;
    if (!client || typeof client.respondError !== 'function') return;
    try {
      client.respondError(record.requestId, -32602, code);
    } catch (_error) {
      // 连接已断时无法回错，交互本身也已经作废。
    }
  }

  function forgetServerRequest(params) {
    const requestId = params && params.requestId;
    if (requestId === undefined || requestId === null) return;
    for (const [interactionId, record] of Array.from(pendingInteractions)) {
      if (record.requestId === null || record.requestId === undefined) continue;
      if (String(record.requestId) === String(requestId)) pendingInteractions.delete(interactionId);
    }
  }

  function observeTurnStarted(params) {
    const turn = activeTurn;
    if (!turn || turn.turnId) return;
    const nativeTurnId = nonEmptyString(params.turn && params.turn.id);
    if (nativeTurnId) turn.turnId = nativeTurnId;
  }

  function observeTurnCompleted(params) {
    const nativeTurn = isPlainObject(params.turn) ? params.turn : {};
    const nativeTurnId = nonEmptyString(nativeTurn.id);
    const turn = activeTurn;
    if (!turn) return;
    if (!turn.turnId) {
      // turn/start 的响应还没回来就先收到了收尾：按 id 存起来，等 id 落地再结算。
      if (nativeTurnId) earlyTerminals.set(nativeTurnId, nativeTurn);
      return;
    }
    // 压缩等内部 turn 的收尾不属于本轮，按 id 过滤掉。
    if (nativeTurnId && nativeTurnId !== turn.turnId) return;
    settleTurn(turn, nativeTurn);
  }

  function settleTurn(turn, nativeTurn) {
    if (!turn || turn.settled) return;
    turn.settled = true;
    if (activeTurn === turn) activeTurn = null;
    const status = nonEmptyString(nativeTurn && nativeTurn.status) || 'completed';
    if (status === 'failed') {
      const error = nativeTurn && nativeTurn.error;
      const message = nonEmptyString(error && (error.message || error.code)) || 'codex_turn_failed';
      turn.done.reject(codedError('codex_turn_failed', message));
      return;
    }
    turn.done.resolve({ stopReason: status === 'interrupted' ? 'cancelled' : 'end_turn' });
  }

  function failActiveTurn(error) {
    const turn = activeTurn;
    if (!turn) return;
    activeTurn = null;
    if (turn.settled) return;
    turn.settled = true;
    turn.done.reject(error);
  }

  async function open(openOptions) {
    if (disposed) throw codedError('agent_session_closed');
    if (opened) throw codedError('agent_session_already_open');
    const request = isPlainObject(openOptions) ? openOptions : {};
    const approvalMode = nonEmptyString(request.mode) ? normalizeMode(request.mode) : mode;
    const resolved = resolveClient();
    client = resolved.client;
    ownsClient = resolved.owns;
    try {
      // ensureConnected 内部完成 WS 握手与 initialize/initialized 往返，
      // 这里不再自己发一遍 initialize（发两次 server 会当成重复初始化）。
      if (typeof client.ensureConnected === 'function') await client.ensureConnected();
      models = await readModels();
      if (nonEmptyString(request.model)) model = requireModel(request.model);
      threadId = request.newSession === false
        ? await resumeThread(request, approvalMode)
        : await startThread(request, approvalMode);
      mode = approvalMode;
      bindThread();
      opened = true;
      return { sessionId: threadId, models: models.slice(), modes: describeModes() };
    } catch (error) {
      // 自己建的 client 必须在这里收掉：open 失败后没人会再持有它，
      // 留着就是一条不会被回收的 WS 连接。
      if (ownsClient && client && typeof client.destroy === 'function') {
        try {
          client.destroy();
        } catch (_error) {
          // 连接可能已经断了，销毁失败不该盖住真正的开仓错误。
        }
      }
      reset();
      throw asCoded(error, 'agent_session_open_failed');
    }
  }

  function describeModes() {
    return MODE_IDS.map((id) => ({ id, label: MODE_LABELS[id] || id }));
  }

  async function prompt(input) {
    if (disposed) throw codedError('agent_session_closed');
    if (!opened || !threadId) throw codedError('agent_session_not_open');
    if (activeTurn) throw codedError('agent_session_turn_in_progress');
    const request = isPlainObject(input) ? input : {};
    const text = typeof request.text === 'string' ? request.text : '';
    const imagePaths = normalizeImagePaths(request.images);
    if (!text.trim() && imagePaths.length === 0) throw codedError('agent_session_prompt_empty');
    const params = protocol.buildTurnStartParams({
      approvalMode: mode,
      threadId,
      prompt: text,
      imagePaths,
      model
    });
    const turn = { turnId: '', settled: false, done: createDeferred() };
    activeTurn = turn;
    try {
      const started = await requestOrThrow('turn/start', params, 'codex_turn_start_failed');
      turn.turnId = nonEmptyString(started && started.turn && started.turn.id);
      if (!turn.turnId) throw codedError('codex_turn_id_missing');
      const early = earlyTerminals.get(turn.turnId);
      if (early) {
        earlyTerminals.delete(turn.turnId);
        settleTurn(turn, early);
      }
      return await turn.done.promise;
    } catch (error) {
      if (activeTurn === turn) activeTurn = null;
      turn.settled = true;
      throw asCoded(error, 'codex_turn_failed');
    }
  }

  async function cancel(reason) {
    if (disposed) throw codedError('agent_session_closed');
    const turn = activeTurn;
    if (!turn) return { cancelled: false };
    // turn/start 还没回 id 时没有可中断的对象：报错而不是猜一个 id 发过去。
    if (!turn.turnId) throw codedError('codex_turn_not_started', 'turn/start 尚未返回，无法中断');
    const params = protocol.buildTurnInterruptParams({ threadId, turnId: turn.turnId });
    await requestOrThrow('turn/interrupt', params, 'codex_turn_interrupt_failed');
    // 外壳把 cancel 当成「本轮的终点」（先迁 interrupting，等这里返回再迁 idle）。
    // 不在这里结算在飞的 prompt，稍后 turn/completed 再迁一次 idle→idle 就会抛
    // agent_session_state_transition_invalid，用户看到的是「点了停止却卡住」。
    // 中断已经发出去了，codex 后续的 turn/completed(interrupted) 只是确认，忽略即可。
    settleTurn(turn, { status: 'interrupted' });
    return { cancelled: true, reason: nonEmptyString(reason) || null };
  }

  function respond(interactionId, decision) {
    const id = nonEmptyString(interactionId);
    const record = pendingInteractions.get(id);
    if (!record) throw codedError('codex_interaction_not_pending', `没有待回答的交互：${id}`);
    if (record.answered) throw codedError('codex_interaction_already_answered', `交互已回答过：${id}`);
    if (record.kind === 'plan_confirmation') {
      // 计划确认由 turn/plan/updated 通知派生，没有 JSON-RPC id 可回：
      // 决策只在本层落账，真正的执行由调用方在下一轮 prompt 里发起。
      record.answered = true;
      pendingInteractions.delete(id);
      return { interactionId: id, responded: true, local: true };
    }
    const buildResolution = SERVER_RESOLUTION_BUILDERS[record.kind];
    if (!buildResolution) throw codedError('codex_interaction_kind_unsupported', record.kind);
    // 先算好 result 再落 answered：映射失败（选项不在允许集合里）时交互必须还能重答。
    const result = adaptCodexServerResponse({
      interactionId: record.interactionId,
      sessionId,
      envelope: record.envelope
    }, buildResolution(decision));
    record.answered = true;
    pendingInteractions.delete(id);
    if (!client || typeof client.respond !== 'function') {
      throw codedError('codex_app_server_client_missing');
    }
    if (client.respond(record.requestId, result) === false) {
      throw codedError('codex_app_server_disconnected');
    }
    return { interactionId: id, responded: true };
  }

  function setMode(modeId) {
    mode = normalizeMode(modeId);
    return { mode };
  }

  function setModel(modelId) {
    model = requireModel(modelId);
    return { model };
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw codedError('agent_session_listener_invalid');
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function onInteractionRequest(handler) {
    if (typeof handler !== 'function') throw codedError('agent_session_interaction_handler_invalid');
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  function reset() {
    pendingInteractions.clear();
    planAskedTurns.clear();
    earlyTerminals.clear();
    client = null;
    ownsClient = false;
    threadId = '';
    opened = false;
    models = [];
  }

  function dispose(reason) {
    if (disposed) return;
    disposed = true;
    // 未决交互不在这里发 expired：那是 router 的职责，两边都发会出现两条 expired。
    failActiveTurn(codedError('agent_session_closed', nonEmptyString(reason) || 'disposed'));
    const closingClient = client;
    const closingThreadId = threadId;
    reset();
    handlers.clear();
    listeners.clear();
    if (closingThreadId && closingClient && typeof closingClient.unbindTurn === 'function') {
      try {
        closingClient.unbindTurn(closingThreadId);
      } catch (_error) {
        // 断线路径由 client 自己收尾，dispose 不能因此抛错。
      }
    }
    if (ownsClient && closingClient && typeof closingClient.destroy === 'function') {
      try {
        closingClient.destroy();
      } catch (_error) {
        // 同上：dispose 只负责尽力关闭。
      }
    }
  }

  return {
    id: ADAPTER_ID,
    provider,
    transport,
    open,
    prompt,
    cancel,
    respond,
    subscribe,
    onInteractionRequest,
    dispose,
    setMode,
    setModel
  };
}

module.exports = { ADAPTER_ID, createAdapter };
