'use strict';

const crypto = require('node:crypto');

const { ChatRuntimeError } = require('./contracts');
const { CHAT_INSTRUCTIONS } = require('./chat-harness-policy');
const { sanitizeDiagnosticText } = require('./canonical-diagnostic-sanitizer');
const { isGatewayRuntimeScope } = require('../../account/runtime-target');

// Go 轮次驱动：把 canonical 的一轮 turn.submit 交给 Go 的 webuichatapi 执行。
//
// 边界：
//   - Go 负责账号征召、上游请求、改流、失败分类与用量记账；
//   - Node 继续拥有会话/队列/事件总线：本驱动只把 Go 的增量翻译成既有 canonical
//     事件形状，由 TurnLifecycle 照常结算（202 与独立 SSE 的语义不变）。
//
// Go 切片没有会话存储，所以历史消息、system prompt 和模型必须由 Node 每次随指令带上；
// Go 也没有附件仓库，带附件的轮次在这里显式拒绝，绝不静默丢掉用户上传的文件。

// 一次请求最多携带的历史消息数与正文总量（约 2 万 token）。Go 侧还有同量级上限，
// 这里先裁剪是为了避免把超大历史发出去再被 422。
const MAX_HISTORY_MESSAGES = 60;
const MAX_HISTORY_CHARS = 80000;

class GoChatDriver {
  constructor(options = {}) {
    this.session = options.session || {};
    this.getSessionPolicy = typeof options.getSessionPolicy === 'function'
      ? options.getSessionPolicy
      : () => this.session.policy || {};
    this.eventSink = requirePort(options.eventSink, 'eventSink');
    this.readChatHistory = requirePort(options.readChatHistory, 'readChatHistory');
    this.streamTurn = requirePort(options.streamTurn, 'streamTurn');
    this.createItemId = typeof options.createItemId === 'function'
      ? options.createItemId
      : () => `item-${crypto.randomUUID()}`;
    this.disposed = false;
    this.active = null;
  }

  startTurn(context = {}) {
    if (this.disposed) throw new ChatRuntimeError('chat_runtime_closed', 410);
    this.requireContext(context);
    if (this.active) throw new ChatRuntimeError('chat_turn_already_active', 409);
    const payload = (context.command && context.command.payload) || {};
    // 附件交给 Go 只会得到 503；与其让上游看到一份缺了图片的提问，不如在本地
    // 明确拒绝，前端拿到的是同码错误而不是一段看似正常的回答。
    const attachmentIds = Array.isArray(payload.attachmentIds) ? payload.attachmentIds : [];
    const imagePaths = Array.isArray(context.imagePaths) ? context.imagePaths : [];
    if (attachmentIds.length > 0 || imagePaths.length > 0) {
      throw new ChatRuntimeError('chat_attachment_store_unavailable', 503);
    }
    const content = String(payload.content || '').trim();
    if (!content) throw new ChatRuntimeError('chat_turn_content_required', 422);
    // 这两项必须在 submit 内同步校验：进到异步 run 之后就只能变成 turn.failed 事件，
    // 前端拿不到 422，也就无法在提交阶段纠正（例如模型为空）。
    const policy = this.getSessionPolicy() || this.session.policy || {};
    const model = String(payload.model || policy.model || '').trim();
    if (!model) throw new ChatRuntimeError('chat_turn_model_required', 422);
    const reasoningEffort = String(payload.reasoningEffort || policy.reasoningEffort || '').trim();

    const active = {
      context,
      turnId: context.turnId,
      runId: context.runId,
      controller: new AbortController(),
      cancelRequested: false,
      settled: false,
      resolve: null,
      reject: null
    };
    active.done = new Promise((resolve, reject) => {
      active.resolve = resolve;
      active.reject = reject;
    });
    this.active = active;
    // 先返回 promise 再开始执行：TurnLifecycle 要先写 turn.started，再等本轮结束。
    Promise.resolve().then(() => this.run(active, content, { model, reasoningEffort, policy })).catch((error) => {
      // 用户中断时连接会被 abort：这不是失败，必须按 interrupted 结算，
      // 否则 turn.interrupt 会显示成一条上游错误。
      if (active.cancelRequested) return this.finish(active, { status: 'interrupted' }, null);
      this.finish(active, null, this.normalizeError(error));
    });
    return active.done;
  }

  async interruptTurn() {
    const active = this.active;
    if (!active) throw new ChatRuntimeError('chat_turn_not_active', 409);
    active.cancelRequested = true;
    // 断开 HTTP 连接即取消 Go 的上游读取（Go 侧对内联 SSE 的取消语义就是断线即取消）。
    active.controller.abort();
    return { cancelled: true };
  }

  dispose() {
    if (this.disposed) return false;
    this.disposed = true;
    if (this.active) {
      this.active.cancelRequested = true;
      this.active.controller.abort();
      this.finish(this.active, { status: 'interrupted' }, null);
    }
    return true;
  }

  async run(active, content, settings) {
    const { model, reasoningEffort } = settings;
    const messages = this.buildMessages(content, settings.policy);
    // 用户消息先落时间线：即使上游随后失败，这一轮也确实发生过（与原生桥一致）。
    await this.writeUserMessage(active, content);
    if (active.cancelRequested) return this.finish(active, { status: 'interrupted' }, null);

    // 会话钉了具体账号时把钉选交给 Go：池化是默认，但不能把「用这个账号发」
    // 悄悄变成「随便找个账号发」。
    const accountRef = isGatewayRuntimeScope(this.session.executionAccountRef)
      ? ''
      : String(this.session.executionAccountRef || '').trim();
    const response = await this.streamTurn({
      sessionId: this.session.sessionId,
      ...(accountRef ? { accountRef } : {}),
      body: {
        commandId: active.context.command?.commandId,
        type: 'turn.submit',
        payload: {
          content,
          model,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          messages
        }
      },
      signal: active.controller.signal
    });
    if (!response) throw new ChatRuntimeError('chat_runtime_unavailable', 503);
    if (!response.ok) {
      throw await routeErrorFromResponse(response);
    }
    await this.consume(active, response, { model, reasoningEffort });
    this.finish(active, { status: 'completed' }, null);
  }

  buildMessages(content, policy) {
    const messages = [{ role: 'system', content: CHAT_INSTRUCTIONS }];
    const systemPrompt = String(policy.systemPrompt || '').trim();
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    for (const message of this.history()) messages.push(message);
    messages.push({ role: 'user', content });
    return messages;
  }

  history() {
    let entries;
    try {
      entries = this.readChatHistory(this.session.sessionId);
    } catch (_error) {
      // 历史读不出来不等于本轮不能跑：宁可少一段上下文，也不能让整轮失败。
      return [];
    }
    const messages = [];
    let chars = 0;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const role = String(entry && entry.role || '').trim();
      const content = typeof (entry && entry.content) === 'string' ? entry.content : '';
      if (!['user', 'assistant'].includes(role) || !content.trim()) continue;
      if (messages.length >= MAX_HISTORY_MESSAGES || chars + content.length > MAX_HISTORY_CHARS) break;
      messages.push({ role, content });
      chars += content.length;
    }
    return messages;
  }

  async writeUserMessage(active, content) {
    const now = Date.now();
    const item = {
      id: this.createItemId('item'),
      kind: 'message',
      createdAt: now,
      status: 'running',
      content,
      detail: { role: 'user' },
      turnId: active.turnId
    };
    await this.emit(active, 'timeline.item.started', { item }, item.id);
    await this.emit(active, 'timeline.item.completed', {
      item: { ...item, status: 'completed', updatedAt: now }
    }, item.id);
  }

  async consume(active, response, settings) {
    let failure = null;
    let terminal = false;
    for await (const event of readEventStream(response)) {
      if (active.cancelRequested) {
        return this.finish(active, { status: 'interrupted' }, null);
      }
      if (!event || typeof event.type !== 'string') continue;
      if (event.type === 'timeline.item.started' || event.type === 'timeline.item.completed') {
        const item = this.messageItem(active, event.payload, settings);
        if (!item) continue;
        await this.emit(active, event.type, { item }, item.id);
        if (event.type === 'timeline.item.completed') await this.writeUsage(active, item);
        continue;
      }
      if (event.type === 'timeline.item.delta') {
        await this.emit(active, 'timeline.item.delta', {
          itemId: String(event.payload && event.payload.itemId || ''),
          chunk: String(event.payload && event.payload.chunk || '')
        }, event.payload && event.payload.itemId);
        continue;
      }
      if (event.type === 'turn.completed') {
        terminal = true;
        break;
      }
      if (event.type === 'turn.failed') {
        terminal = true;
        const error = event.payload && event.payload.error || {};
        failure = runtimeError(
          String(error.code || 'chat_turn_failed'),
          502,
          error.message
        );
        break;
      }
      // turn.queued / turn.started 由 Node 的 TurnLifecycle 负责发，忽略；
      // 未知事件同样忽略（Go 侧新增事件不能打断一轮已经开始的流）。
    }
    if (active.cancelRequested) return this.finish(active, { status: 'interrupted' }, null);
    if (failure) throw failure;
    if (!terminal) throw new ChatRuntimeError('chat_upstream_stream_failed', 502);
  }

  messageItem(active, payload, settings) {
    const source = payload && payload.item;
    if (!source || source.kind !== 'message') return null;
    const detail = source.detail && typeof source.detail === 'object' ? source.detail : {};
    return {
      id: String(source.id || this.createItemId('item')),
      kind: 'message',
      createdAt: Number.isSafeInteger(source.createdAt) ? source.createdAt : Date.now(),
      status: String(source.status || 'running'),
      content: String(source.content || ''),
      detail: {
        ...detail,
        ...(settings.model ? { model: settings.model } : {}),
        ...(settings.reasoningEffort ? { effort: settings.reasoningEffort } : {})
      },
      ...(Number.isSafeInteger(source.updatedAt) ? { updatedAt: source.updatedAt } : {}),
      turnId: active.turnId
    };
  }

  async writeUsage(active, item) {
    const metrics = item.detail && item.detail.metrics;
    if (!metrics) return;
    const usage = {};
    for (const field of ['inputTokens', 'outputTokens']) {
      if (Number.isSafeInteger(metrics[field]) && metrics[field] >= 0) usage[field] = metrics[field];
    }
    if (Object.keys(usage).length === 0) return;
    // 只报本轮 token 数，不带 totals：Node 的结算会计在本轮 activeTurn 上，
    // 传会话累计值反而会被当成增量重复累加（见 turn-metrics-repository）。
    await this.emit(active, 'turn.metrics.updated', { metrics: usage });
  }

  async emit(active, type, payload) {
    if (this.disposed) return;
    const itemId = payload && payload.item && payload.item.id
      ? payload.item.id
      : (payload && payload.itemId) || '';
    await this.eventSink({
      type,
      turnId: active.turnId,
      runId: active.runId,
      ...(itemId ? { itemId } : {}),
      payload
    });
  }

  // normalizeError 把传输层错误折成本驱动自己的失败码：
  // 调用方看到的是「Go 通道不可用」而不是一个没有 code 的 Error。
  normalizeError(error) {
    if (error && typeof error.code === 'string' && error.code) return error;
    return runtimeError('chat_runtime_unavailable', 503, error && error.message);
  }

  finish(active, result, error) {
    if (!active || active.settled || this.active !== active) return;
    active.settled = true;
    this.active = null;
    if (error) active.reject(error);
    else active.resolve(result);
  }

  requireContext(context) {
    if (!context || String(context.sessionId || '') !== String(this.session.sessionId || '')) {
      throw new ChatRuntimeError('chat_actor_session_mismatch', 409);
    }
    if (!String(context.turnId || '').trim() || !String(context.runId || '').trim()) {
      throw new ChatRuntimeError('chat_turn_context_invalid', 500);
    }
  }
}

// createGoChatDriverEntry 返回与 codex/native 驱动同形的 entry。
function createGoChatDriverEntry(options = {}) {
  const driver = new GoChatDriver(options);
  return Object.freeze({
    provider: 'go-chat',
    driver,
    capabilities: goChatCapabilities(),
    composerCatalog: typeof options.composerCatalog === 'function' ? options.composerCatalog : undefined,
    handlers: Object.freeze({})
  });
}

// 能力声明只覆盖本驱动真的能兑现的部分：对外谎报 tool/reasoning 只会让前端
// 渲染一个永远不会出现的事件类型。
function goChatCapabilities() {
  return Object.freeze({
    // 能力集由本文件固定，变更时 bump：会话里持久化的快照据此判断是否需要刷新。
    revision: 'go-chat-v1',
    capabilities: Object.freeze({
      'session.resume': support('unsupported', 'go_chat_turn_is_stateless'),
      'timeline.reasoning': support('unsupported', 'go_chat_completions_ignores_reasoning'),
      'timeline.tool': support('unsupported', 'go_chat_completions_has_no_tools'),
      'timeline.diff': support('unsupported', 'go_chat_completions_has_no_tools'),
      'mode.plan': support('unsupported', 'go_chat_has_no_plan_mode'),
      'interaction.question': support('unsupported', 'go_chat_has_no_interactions'),
      'interaction.approval': support('unsupported', 'go_chat_has_no_interactions'),
      'interaction.plan_confirmation': support('unsupported', 'go_chat_has_no_interactions'),
      'turn.interrupt': support('native'),
      'turn.steer.current': support('unsupported', 'go_chat_turn_is_a_single_request'),
      'turn.steer.tool_boundary': support('unsupported', 'go_chat_has_no_tool_boundary'),
      'turn.queue': support('emulated', 'aih_chat_runtime_queue'),
      'session.goal': support('emulated', 'aih_session_goal_projection'),
      'slash.execute': support('native'),
      'terminal.stream': support('unsupported', 'go_chat_has_no_terminal'),
      'run.adopt': support('unsupported', 'go_chat_turn_cannot_be_adopted')
    }),
    slashCommands: Object.freeze(['goal', 'plan']),
    slashPassthrough: false,
    turnInterveneModes: Object.freeze([])
  });
}

function support(value, reason) {
  return Object.freeze({ support: value, ...(reason ? { reason } : {}) });
}

// readEventStream 把 Go 的 SSE 响应拆成 { type, payload }。
//
// 帧格式与 Node 的 encodeSseEvent 逐字节一致（id:/event:/data: + 空行），
// 心跳是注释行，直接跳过。
async function* readEventStream(response) {
  if (!response || !response.body || typeof response.body.getReader !== 'function') {
    throw new ChatRuntimeError('chat_runtime_stream_unsupported', 502);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseFrame(frame);
        if (event) yield event;
        boundary = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    const event = parseFrame(buffer);
    if (event) yield event;
  } finally {
    try {
      reader.releaseLock();
    } catch (_error) { /* 已经释放 */ }
  }
}

function parseFrame(frame) {
  let type = '';
  const data = [];
  for (const line of String(frame || '').split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      type = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!type || data.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(data.join('\n'));
  } catch (_error) {
    throw new ChatRuntimeError('chat_runtime_stream_invalid', 502);
  }
  // Go 的 data 是完整的 aih.chat.event.v1 信封（与 Node 自己的 encodeSseEvent 同形），
  // 真正的业务载荷在 payload 里。直接把信封当载荷会让 item.started/completed 因为
  // 「没有 item 字段」被整条丢弃、delta 的 chunk 恒为空——表现是轮次成功但回答空白。
  const envelope = parsed && typeof parsed === 'object' && parsed.schema === 'aih.chat.event.v1';
  return { type, payload: envelope ? (parsed.payload || {}) : parsed };
}

async function routeErrorFromResponse(response) {
  let body = null;
  try {
    body = await response.json();
  } catch (_error) { /* 非 JSON 错误体 */ }
  return runtimeError(
    String(body && body.error || 'chat_runtime_failed'),
    Number.isInteger(response.status) && response.status >= 400 ? response.status : 502,
    body && body.message
  );
}

// runtimeError 同时设置码与可读文案：ChatRuntimeError 默认把 message 设成码，
// 而 turn.failed 的诊断直接取 error.message，上游失败的原因会因此丢失。
function runtimeError(code, statusCode, message) {
  const error = new ChatRuntimeError(code, statusCode);
  const text = String(message || '').trim();
  if (text) error.message = sanitizeDiagnosticText(text);
  return error;
}

function requirePort(value, name) {
  if (typeof value !== 'function') throw new Error(`go_chat_driver_${name}_required`);
  return value;
}

module.exports = {
  GoChatDriver,
  createGoChatDriverEntry,
  goChatCapabilities,
  readEventStream
};
