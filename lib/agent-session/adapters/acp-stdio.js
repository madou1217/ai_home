'use strict';

// ACP（stdio）adapter + 共享协议核。
//
// 与 lib/server/acp-session-runner.js 的分工：runner 是引擎侧「跑一轮」的胶水，
// 它的 onNotification/onRequest 是**单槽**的（第二次注册静默覆盖第一次），只够一个
// 消费者；本层要同时喂时间线、终端标题、看门狗，所以 adapter 自己持有唯一协议
// handler，向上再经 session 的 event-bus 多播。事件名与交互形状走 contracts，不另
// 起一套。session/load 的时机也与 runner 一致：**load 之后才激活事件映射**，因为
// load 会在响应前重放整段历史（重复事件比丢事件更难排查）。
//
// 传输可注入：spawn 从 context 传入（默认 child_process.spawn），测试不碰子进程；
// acp-http-sse 复用同一个协议核，只把 transport 换成 HTTP/SSE 通道。

const { spawn: defaultSpawn } = require('node:child_process');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { acpChoices } = require('../../server/acp-session-runner');
const { buildAcpEntryArgs, getAcpLayout } = require('../../runtime/acp-layouts');

const ACP_PROTOCOL_VERSION = 1;
// 握手单步超时；**prompt 轮次不设客户端超时** —— 模型思考时长不可预估，超时交给上层。
const ACP_HANDSHAKE_TIMEOUT_MS = 30000;
// 温和 kill 不生效时升级 SIGKILL（bun 编译体不响应 SIGTERM 的实测见 runner）。
const KILL_ESCALATION_MS = 5000;
const STDERR_TAIL_LIMIT = 4096;
const TOOL_DETAIL_LIMIT = 600;
const PROTOCOL_FRAME_LIMIT = 200;

// adapter 传输名 → acp-layouts 的传输词汇。做成数据表，任何 provider 差异都只走
// 布局表，adapter 里不出现 provider 分支。
const LAYOUT_TRANSPORT_BY_ADAPTER = Object.freeze({
  'acp-stdio': 'stdio-ndjson',
  'acp-http-sse': 'http-sse'
});

// ACP tool_call.status → canonical 时间线状态。未知状态记 unknown，
// 绝不把不认识的状态猜成 completed（那会让界面显示一个没跑完的工具已成功）。
const TOOL_STATUS = Object.freeze({
  pending: 'pending',
  in_progress: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled'
});

// ACP plan 条目状态与 codex 计划适配器同口径（in_progress 不是 running）。
const PLAN_STATUS = Object.freeze({
  pending: 'pending',
  in_progress: 'in_progress',
  completed: 'completed'
});

function fail(code, message, details) {
  const error = Object.assign(new Error(message || code), { code });
  if (details !== undefined) error.details = details;
  return error;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractContentText(content) {
  if (!content) return '';
  if (typeof content.text === 'string') return content.text;
  if (Array.isArray(content)) {
    let out = '';
    for (const part of content) {
      if (part && typeof part.text === 'string') out += part.text;
    }
    return out;
  }
  return '';
}

/**
 * 入口参数只从布局表取：provider 未登记、或该 provider 没声明这个传输，
 * 都返回 null → acp_entry_unsupported（fail closed，绝不猜一个旗标）。
 */
function resolveAcpArgs(provider, adapterTransport) {
  const layoutTransport = LAYOUT_TRANSPORT_BY_ADAPTER[adapterTransport] || '';
  const args = layoutTransport ? buildAcpEntryArgs(provider, { transport: layoutTransport }) : null;
  if (!args) {
    throw fail('acp_entry_unsupported', `${provider} 没有 ${adapterTransport} 入口`, {
      provider,
      transport: adapterTransport
    });
  }
  return { args, layout: getAcpLayout(provider) };
}

// ACP 的模型目录用 modelId，模式目录用 id。这里统一成 { id, name }，
// 调用方不必记住两套字段名。
function normalizeModels(sessionInfo) {
  const state = isRecord(sessionInfo) && isRecord(sessionInfo.models) ? sessionInfo.models : null;
  const available = state && Array.isArray(state.availableModels) ? state.availableModels : [];
  const models = [];
  for (const model of available) {
    if (!isRecord(model)) continue;
    const id = nonEmpty(model.modelId) || nonEmpty(model.id);
    if (!id) continue;
    const entry = { id };
    if (nonEmpty(model.name)) entry.name = nonEmpty(model.name);
    if (nonEmpty(model.description)) entry.description = nonEmpty(model.description);
    models.push(entry);
  }
  return models;
}

function normalizeModes(sessionInfo) {
  const state = isRecord(sessionInfo) && isRecord(sessionInfo.modes) ? sessionInfo.modes : null;
  const available = state && Array.isArray(state.availableModes) ? state.availableModes : [];
  const modes = [];
  for (const mode of available) {
    if (!isRecord(mode)) continue;
    const id = nonEmpty(mode.id) || nonEmpty(mode.modeId);
    if (!id) continue;
    const entry = { id };
    if (nonEmpty(mode.name)) entry.name = nonEmpty(mode.name);
    if (nonEmpty(mode.description)) entry.description = nonEmpty(mode.description);
    modes.push(entry);
  }
  return modes;
}

function describeToolCall(toolCall) {
  const call = isRecord(toolCall) ? toolCall : {};
  const parts = [];
  for (const entry of Array.isArray(call.content) ? call.content : []) {
    const text = isRecord(entry) && isRecord(entry.content) ? nonEmpty(entry.content.text) : '';
    if (text) parts.push(text);
  }
  for (const location of Array.isArray(call.locations) ? call.locations : []) {
    if (isRecord(location) && nonEmpty(location.path)) parts.push(nonEmpty(location.path));
  }
  if (parts.length === 0 && call.rawInput !== undefined) {
    try {
      parts.push(JSON.stringify(call.rawInput));
    } catch (_error) {
      // 循环引用等序列化失败不该让审批请求消失：标题里仍有工具名。
    }
  }
  const detail = parts.join('\n');
  return detail.length > TOOL_DETAIL_LIMIT ? `${detail.slice(0, TOOL_DETAIL_LIMIT)}…` : detail;
}

function permissionTitle(toolCall) {
  const call = isRecord(toolCall) ? toolCall : {};
  const rawInput = isRecord(call.rawInput) ? call.rawInput : {};
  const headline = nonEmpty(call.title)
    || nonEmpty(rawInput.description)
    || nonEmpty(rawInput.command)
    || nonEmpty(rawInput.file_path)
    || nonEmpty(rawInput.path)
    || nonEmpty(call.kind);
  if (!headline) return '需要确认这次工具调用';
  const short = headline.length > 80 ? `${headline.slice(0, 80)}…` : headline;
  return `允许执行「${short}」吗？`;
}

function buildPromptBlocks(text, images) {
  const blocks = [];
  const promptText = typeof text === 'string' ? text : '';
  if (promptText.trim()) blocks.push({ type: 'text', text: promptText });
  for (const image of Array.isArray(images) ? images : []) {
    if (!isRecord(image)) {
      throw fail('acp_prompt_image_invalid', '图片必须是 { data, mimeType }');
    }
    const data = nonEmpty(image.data);
    const mimeType = nonEmpty(image.mimeType) || nonEmpty(image.mediaType);
    if (!data || !mimeType) {
      throw fail('acp_prompt_image_invalid', '图片缺少 data 或 mimeType');
    }
    blocks.push({ type: 'image', data, mimeType });
  }
  if (blocks.length === 0) {
    throw fail('acp_prompt_empty', 'prompt 需要文本或图片');
  }
  return blocks;
}

/**
 * session/update → canonical 事件。
 *
 * 为什么不只发 delta：canonical 的 timeline-projector 只在收到
 * timeline.item.started/completed 时建条目，纯 delta 找不到条目会被丢掉
 * （见 lib/server/chat-runtime/native-session-event-bridge.js 的同一条注释）。
 * 所以每条消息/推理流先补一条 started，轮次收尾再补 completed。
 */
function createSessionUpdateMapper(options) {
  const config = isRecord(options) ? options : {};
  const now = typeof config.now === 'function' ? config.now : () => Date.now();
  const openItems = new Map();
  let turnId = '';

  function turnField() {
    return turnId ? { turnId } : {};
  }

  function itemIdFor(prefix) {
    return `acp-${prefix}-${turnId || 'session'}`;
  }

  function startItem(itemId, kind) {
    openItems.set(itemId, { kind, content: '' });
    return Object.assign(turnField(), {
      type: 'timeline.item.started',
      itemId,
      payload: {
        item: Object.assign(
          { id: itemId, kind, createdAt: now(), updatedAt: now(), status: 'running', content: '' },
          turnId ? { turnId } : {},
          { detail: { role: 'assistant' } }
        )
      }
    });
  }

  function mapStreamingChunk(update, kind) {
    const chunk = extractContentText(update.content);
    if (!chunk) return [];
    const itemId = itemIdFor(kind);
    const events = [];
    if (!openItems.has(itemId)) events.push(startItem(itemId, kind));
    openItems.get(itemId).content += chunk;
    events.push(Object.assign(turnField(), {
      type: 'timeline.item.delta',
      itemId,
      payload: { itemId, chunk, kind }
    }));
    return events;
  }

  function mapToolCall(update, isUpdate) {
    const callId = nonEmpty(update.toolCallId);
    const itemId = callId ? `acp-tool-${callId}` : itemIdFor('tool');
    const status = TOOL_STATUS[nonEmpty(update.status)] || 'unknown';
    const name = nonEmpty(update.title) || nonEmpty(update.kind) || 'tool';
    const detail = { name };
    if (callId) detail.toolCallId = callId;
    if (nonEmpty(update.kind)) detail.toolKind = nonEmpty(update.kind);
    if (isRecord(update.rawInput)) detail.rawInput = update.rawInput;
    if (update.rawOutput !== undefined) detail.rawOutput = update.rawOutput;
    const item = Object.assign(
      {
        id: itemId,
        kind: 'tool',
        createdAt: now(),
        updatedAt: now(),
        status,
        content: name,
        detail
      },
      turnId ? { turnId } : {}
    );
    return [Object.assign(turnField(), {
      type: isUpdate ? 'timeline.item.updated' : 'timeline.item.started',
      itemId,
      payload: { item }
    })];
  }

  function mapPlan(update) {
    const entries = Array.isArray(update.entries) ? update.entries : [];
    const steps = [];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const step = nonEmpty(entry.content) || nonEmpty(entry.step);
      if (!step) continue;
      const normalized = { step, status: PLAN_STATUS[nonEmpty(entry.status)] || 'pending' };
      if (nonEmpty(entry.priority)) normalized.priority = nonEmpty(entry.priority);
      steps.push(normalized);
    }
    const itemId = itemIdFor('plan');
    const complete = steps.length > 0 && steps.every((step) => step.status === 'completed');
    return [Object.assign(turnField(), {
      type: 'timeline.item.updated',
      itemId,
      payload: {
        item: Object.assign(
          {
            id: itemId,
            kind: 'plan',
            createdAt: now(),
            updatedAt: now(),
            status: complete ? 'completed' : 'running',
            detail: { steps }
          },
          turnId ? { turnId } : {}
        )
      }
    })];
  }

  function map(update) {
    if (!isRecord(update)) return [];
    const kind = nonEmpty(update.sessionUpdate);
    if (kind === 'agent_message_chunk') return mapStreamingChunk(update, 'message');
    if (kind === 'agent_thought_chunk') return mapStreamingChunk(update, 'reasoning');
    if (kind === 'tool_call') return mapToolCall(update, false);
    if (kind === 'tool_call_update') return mapToolCall(update, true);
    if (kind === 'plan') return mapPlan(update);
    // user_message_chunk / session_info_update / available_commands_update：
    // 不进 canonical 时间线（历史由 load 重放或 transcript 负责）。
    return [];
  }

  function finishTurn(status) {
    const events = [];
    for (const [itemId, item] of openItems) {
      events.push(Object.assign(turnField(), {
        type: 'timeline.item.completed',
        itemId,
        payload: {
          item: Object.assign(
            {
              id: itemId,
              kind: item.kind,
              createdAt: now(),
              updatedAt: now(),
              status,
              content: item.content,
              detail: { role: 'assistant' }
            },
            turnId ? { turnId } : {}
          )
        }
      }));
    }
    openItems.clear();
    return events;
  }

  return {
    map,
    beginTurn(id) {
      turnId = nonEmpty(id);
      openItems.clear();
    },
    finishTurn,
    get turnId() {
      return turnId;
    }
  };
}

/**
 * 协议核：JSON-RPC 关联 + ACP 消息分发 + 审批往返。传输只提供
 * send/onMessage/onClose（可选 onProtocolError），所以 stdio 与 HTTP/SSE 共用。
 */
function createAcpProtocol(options) {
  const config = isRecord(options) ? options : {};
  const transport = config.transport;
  if (!transport || typeof transport.send !== 'function' || typeof transport.onMessage !== 'function') {
    throw fail('acp_transport_invalid', 'ACP 传输缺少 send/onMessage');
  }
  const emit = typeof config.emit === 'function' ? config.emit : () => {};
  const getInteractionHandlers = typeof config.getInteractionHandlers === 'function'
    ? config.getInteractionHandlers
    : () => [];
  const mapper = createSessionUpdateMapper({ now: config.now });
  const fsImpl = config.fs || nodeFs;
  const pathImpl = config.path || nodePath;

  let nextRequestId = 1;
  let nextInteractionSeq = 0;
  let active = false;
  let closed = false;
  let closing = false;
  let closeInfo = null;
  const pendingRequests = new Map();
  const pendingInteractions = new Map();

  function closeError() {
    const info = isRecord(closeInfo) ? closeInfo : {};
    const details = {};
    if (info.exitCode !== undefined) details.exitCode = info.exitCode;
    if (info.signal) details.signal = info.signal;
    return fail(
      nonEmpty(info.code) || 'acp_transport_closed',
      nonEmpty(info.message) || 'ACP 传输已关闭',
      details
    );
  }

  function handleClose(info) {
    if (closed) return;
    closed = true;
    closeInfo = isRecord(info) ? info : {};
    const error = closeError();
    for (const waiter of Array.from(pendingRequests.values())) {
      try {
        waiter.reject(error);
      } catch (_ignored) {
        // 结算回调自己抛错不能影响其它等待者。
      }
    }
    pendingRequests.clear();
    pendingInteractions.clear();
    // 主动 dispose 引发的关闭不算故障；其余（进程退出、SSE 断流）必须让上层看见，
    // 否则界面会永远停在「正在生成」。
    if (closing) return;
    emit({
      type: 'stream.error',
      payload: Object.assign(
        { source: 'agent-session', code: error.code, message: error.message },
        closeInfo.exitCode !== undefined ? { exitCode: closeInfo.exitCode } : {},
        closeInfo.stderr ? { stderr: String(closeInfo.stderr).slice(-STDERR_TAIL_LIMIT) } : {}
      )
    });
  }

  const offMessage = transport.onMessage(handleMessage);
  const offClose = typeof transport.onClose === 'function' ? transport.onClose(handleClose) : null;
  const offProtocolError = typeof transport.onProtocolError === 'function'
    ? transport.onProtocolError((info) => {
      if (closing || closed) return;
      const line = isRecord(info) ? String(info.line || '') : '';
      emit({
        type: 'stream.error',
        payload: {
          source: 'agent-session',
          code: 'acp_protocol_frame_invalid',
          message: 'ACP 输出不是合法的 JSON-RPC 帧',
          line: line.slice(0, PROTOCOL_FRAME_LIMIT)
        }
      });
    })
    : null;

  function request(method, params, requestOptions) {
    const settings = isRecord(requestOptions) ? requestOptions : {};
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(closeError());
        return;
      }
      const id = nextRequestId;
      nextRequestId += 1;
      const timeoutMs = Number(settings.timeoutMs) || 0;
      let timer = null;
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        pendingRequests.delete(id);
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          reject(fail('acp_request_timeout', `ACP 请求超时: ${method}`, { method, timeoutMs }));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
      pendingRequests.set(id, {
        method,
        resolve(value) {
          cleanup();
          resolve(value);
        },
        reject(error) {
          cleanup();
          reject(error);
        }
      });
      if (transport.send({ jsonrpc: '2.0', id, method, params }) === false) {
        cleanup();
        reject(fail('acp_transport_unavailable', `ACP 传输不可写: ${method}`, { method }));
      }
    });
  }

  function notify(method, params) {
    if (closed) return false;
    return transport.send({ jsonrpc: '2.0', method, params }) !== false;
  }

  function reply(id, result) {
    if (closed) return false;
    return transport.send({ jsonrpc: '2.0', id, result }) !== false;
  }

  function replyError(id, code, message) {
    if (closed) return false;
    return transport.send({ jsonrpc: '2.0', id, error: { code, message } }) !== false;
  }

  function handleMessage(message) {
    if (!isRecord(message)) return;
    if (typeof message.method === 'string') {
      if (message.id !== undefined && message.id !== null) {
        handleAgentRequest(message);
        return;
      }
      if (nonEmpty(message.method) === 'session/update') {
        // 未激活前的 update 是 session/load 的历史回放：丢弃，避免时间线重复。
        if (!active) return;
        const update = isRecord(message.params) ? message.params.update : null;
        for (const event of mapper.map(update)) emit(event);
      }
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const waiter = pendingRequests.get(message.id);
    if (!waiter) return;
    pendingRequests.delete(message.id);
    if (message.error) {
      waiter.reject(fail('acp_request_failed', String(message.error.message || 'acp_request_failed'), {
        method: waiter.method,
        acpError: message.error
      }));
      return;
    }
    waiter.resolve(message.result);
  }

  function handleAgentRequest(message) {
    const method = nonEmpty(message.method);
    if (method === 'session/request_permission') {
      handlePermission(message);
      return;
    }
    // ACP 的编辑类工具由**客户端**落盘（agent 通过 fs/* 请求），不是 agent 自己写。
    // 不实现这两个方法时，gemini 的 write_file 会直接失败（2026-11-03 实机复现：
    // 审批通过后 tool_call_update 变 failed，文件根本没创建）。
    if (method === 'fs/read_text_file') {
      handleReadTextFile(message);
      return;
    }
    if (method === 'fs/write_text_file') {
      handleWriteTextFile(message);
      return;
    }
    replyError(message.id, -32601, `method not supported: ${method}`);
  }

  function handleReadTextFile(message) {
    const params = isRecord(message.params) ? message.params : {};
    const filePath = nonEmpty(params.path);
    if (!filePath) {
      replyError(message.id, -32602, 'path required');
      return;
    }
    try {
      reply(message.id, { content: String(fsImpl.readFileSync(filePath, 'utf8')) });
    } catch (error) {
      replyError(message.id, -32603, String((error && error.message) || error));
    }
  }

  function handleWriteTextFile(message) {
    const params = isRecord(message.params) ? message.params : {};
    const filePath = nonEmpty(params.path);
    if (!filePath) {
      replyError(message.id, -32602, 'path required');
      return;
    }
    const content = typeof params.content === 'string' ? params.content : '';
    try {
      fsImpl.mkdirSync(pathImpl.dirname(filePath), { recursive: true });
      fsImpl.writeFileSync(filePath, content, 'utf8');
      reply(message.id, {});
    } catch (error) {
      replyError(message.id, -32603, String((error && error.message) || error));
    }
  }

  function handlePermission(message) {
    const params = isRecord(message.params) ? message.params : {};
    const choices = acpChoices(params.options);
    // agent 没给任何可选项：没有「允许」可回，只能 cancelled（不是放行）。
    if (choices.length === 0) {
      reply(message.id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    const handlers = getInteractionHandlers().filter((handler) => typeof handler === 'function');
    if (handlers.length === 0) {
      // fail closed：没人能回答就不回答「允许」，回 cancelled 并显式报错。
      reply(message.id, { outcome: { outcome: 'cancelled' } });
      emit({
        type: 'stream.error',
        payload: {
          source: 'agent-session',
          code: 'acp_interaction_handler_unavailable',
          message: '收到 ACP 审批请求，但没有注册交互处理器'
        }
      });
      return;
    }
    const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
    nextInteractionSeq += 1;
    const interactionId = `acp-permission-${nextInteractionSeq}`;
    const toolCallId = nonEmpty(toolCall.toolCallId);
    // detail 为空时必须整个省掉：canonical 校验把空字符串当非法（不是「没内容」）。
    const presentation = { title: permissionTitle(toolCall) };
    const detail = describeToolCall(toolCall);
    if (detail) presentation.detail = detail;
    const request = {
      interactionId,
      kind: 'approval',
      payload: { presentation, choices }
    };
    if (mapper.turnId) request.turnId = mapper.turnId;
    if (toolCallId) request.itemId = `acp-tool-${toolCallId}`;
    pendingInteractions.set(interactionId, { rpcId: message.id, choices });
    try {
      for (const handler of handlers) handler(request);
    } catch (_error) {
      // 路由器/上层拒绝这次交互（例如 payload 非法）：同样按 fail closed 回 cancelled。
      pendingInteractions.delete(interactionId);
      reply(message.id, { outcome: { outcome: 'cancelled' } });
    }
  }

  function respond(interactionId, decision) {
    const id = nonEmpty(interactionId);
    const record = pendingInteractions.get(id);
    if (!record) {
      throw fail('acp_interaction_unknown', `未知或已结束的交互: ${id}`, { interactionId: id });
    }
    const choiceId = nonEmpty(decision && decision.choiceId);
    if (!choiceId) {
      throw fail('acp_decision_choice_required', '审批决策缺少 choiceId', { interactionId: id });
    }
    // 不认识的选择一律拒绝，且**保持交互 pending**：用户还可以选一个合法项，
    // 也不能把未知 optionId 原样回给 agent（那等于让它自己解释）。
    if (!record.choices.some((choice) => choice.id === choiceId)) {
      throw fail('acp_decision_choice_unknown', `agent 没有提供选项 ${choiceId}`, {
        interactionId: id,
        choiceId
      });
    }
    pendingInteractions.delete(id);
    reply(record.rpcId, { outcome: { outcome: 'selected', optionId: choiceId } });
    return { interactionId: id, optionId: choiceId };
  }

  // 用户中断整轮时，挂着的审批按协议回 cancelled，否则 agent 会一直等审批。
  function cancelInteractions() {
    let count = 0;
    for (const [interactionId, record] of Array.from(pendingInteractions.entries())) {
      pendingInteractions.delete(interactionId);
      reply(record.rpcId, { outcome: { outcome: 'cancelled' } });
      count += 1;
    }
    return count;
  }

  function dispose(reason) {
    if (closed) return;
    closing = true;
    const error = fail('acp_session_disposed', `会话已释放${reason ? `: ${reason}` : ''}`);
    for (const waiter of Array.from(pendingRequests.values())) {
      try {
        waiter.reject(error);
      } catch (_ignored) {
        // 同上：单个等待者失败不影响其它结算。
      }
    }
    pendingRequests.clear();
    pendingInteractions.clear();
    closed = true;
    if (typeof offMessage === 'function') offMessage();
    if (typeof offClose === 'function') offClose();
    if (typeof offProtocolError === 'function') offProtocolError();
    if (typeof transport.close === 'function') {
      try {
        transport.close();
      } catch (_ignored) {
        // 关闭失败不能再抛给调用方：dispose 必须是幂等收尾。
      }
    }
  }

  // router 侧超时/收尾时调用：不回包的话 agent 会一直等这个审批。
  function expire(interactionId) {
    const id = nonEmpty(interactionId);
    const record = pendingInteractions.get(id);
    if (!record) return { interactionId: id, expired: false };
    pendingInteractions.delete(id);
    reply(record.rpcId, { outcome: { outcome: 'cancelled' } });
    return { interactionId: id, expired: true };
  }

  return {
    request,
    notify,
    respond,
    expire,
    dispose,
    cancelInteractions,
    activate() {
      active = true;
    },
    beginTurn(turnId) {
      mapper.beginTurn(turnId);
    },
    finishTurn(status) {
      return mapper.finishTurn(status || 'completed');
    },
    get turnId() {
      return mapper.turnId;
    },
    get closed() {
      return closed;
    }
  };
}

/**
 * stdio 传输：spawn 一个 ACP 进程，stdout 上的 NDJSON 是协议帧（不透传给上层），
 * stderr 只留尾部用于错误详情（认证失败原因常在这里）。
 */
function createStdioTransport(options) {
  const config = isRecord(options) ? options : {};
  const spawn = typeof config.spawn === 'function' ? config.spawn : defaultSpawn;
  const command = nonEmpty(config.command);
  if (!command) throw fail('acp_command_unavailable', 'ACP 入口命令为空');
  const args = Array.isArray(config.args) ? config.args.map((arg) => String(arg)) : [];
  const cwd = nonEmpty(config.cwd) || process.cwd();
  const env = isRecord(config.env) ? config.env : process.env;

  let proc;
  try {
    proc = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (error) {
    throw fail('acp_spawn_failed', `无法启动 ${command}`, {
      command,
      cause: String((error && error.message) || error)
    });
  }
  if (!proc || !proc.stdin || !proc.stdout) {
    throw fail('acp_spawn_failed', `无法启动 ${command}: 缺少 stdio 管道`, { command });
  }

  const messageHandlers = new Set();
  const closeHandlers = new Set();
  const protocolErrorHandlers = new Set();
  let stdoutBuffer = '';
  let stderrTail = '';
  let closed = false;
  let killTimer = null;

  function dispatch(handlers, payload) {
    for (const handler of Array.from(handlers)) {
      try {
        handler(payload);
      } catch (_ignored) {
        // handler 抛错不能打断帧解析。
      }
    }
  }

  function finish(info) {
    if (closed) return;
    closed = true;
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    const payload = Object.assign({}, info);
    if (stderrTail) payload.stderr = stderrTail;
    dispatch(closeHandlers, payload);
  }

  proc.stdout.on('data', (chunk) => {
    stdoutBuffer += String(chunk);
    let index;
    while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, index).trim();
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (!line) continue;
      let message = null;
      try {
        message = JSON.parse(line);
      } catch (_error) {
        // 非帧行（启动横幅/调试输出）也显式报协议错误，不静默丢。
        dispatch(protocolErrorHandlers, { line });
        continue;
      }
      dispatch(messageHandlers, message);
    }
  });
  proc.stderr.on('data', (chunk) => {
    stderrTail = `${stderrTail}${String(chunk)}`.slice(-STDERR_TAIL_LIMIT);
  });
  // 对端退出后写 stdin 会异步抛 EPIPE：吞掉，避免打崩宿主进程。
  proc.stdin.on('error', () => {});
  proc.on('exit', (code, signal) => {
    finish({
      code: 'acp_process_exited',
      message: `ACP 进程已退出（code=${code}）`,
      exitCode: typeof code === 'number' ? code : -1,
      signal: signal || null
    });
  });
  proc.on('error', (error) => {
    finish({
      code: 'acp_spawn_failed',
      message: `ACP 进程错误: ${(error && error.message) || error}`,
      cause: error && error.code ? String(error.code) : null
    });
  });

  function subscribe(handlers, handler) {
    if (typeof handler !== 'function') return () => {};
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  return {
    send(message) {
      if (closed) return false;
      try {
        proc.stdin.write(`${JSON.stringify(message)}\n`);
        return true;
      } catch (_error) {
        return false;
      }
    },
    onMessage(handler) {
      return subscribe(messageHandlers, handler);
    },
    onClose(handler) {
      return subscribe(closeHandlers, handler);
    },
    onProtocolError(handler) {
      return subscribe(protocolErrorHandlers, handler);
    },
    close() {
      if (closed) return;
      // 先温和结束 stdin（让对端有机会收尾），再 SIGTERM；不响应则升级 SIGKILL。
      try {
        proc.stdin.end();
      } catch (_ignored) {
        // stdin 可能已关。
      }
      try {
        proc.kill();
      } catch (_ignored) {
        // 进程可能已退出。
      }
      if (closed) return;
      if (!killTimer) {
        killTimer = setTimeout(() => {
          killTimer = null;
          if (!closed) {
            try {
              proc.kill('SIGKILL');
            } catch (_ignored) {
              // 同上。
            }
          }
        }, KILL_ESCALATION_MS);
        if (typeof killTimer.unref === 'function') killTimer.unref();
      }
    }
  };
}

/**
 * 两种传输共用的 adapter 主体：握手、会话打开、prompt、审批、模式/模型。
 * 差异只有 createTransport（stdio 起进程 / HTTP 接通道）。
 */
function createAcpAdapter(options) {
  const config = isRecord(options) ? options : {};
  const id = nonEmpty(config.id);
  const provider = nonEmpty(config.provider).toLowerCase();
  const transportName = nonEmpty(config.transport);
  const sessionId = nonEmpty(config.sessionId);
  if (!id || !provider || !transportName || !sessionId) {
    throw fail('agent_session_adapter_descriptor_incomplete', 'ACP adapter 描述符不完整', {
      id,
      provider,
      transport: transportName,
      sessionId
    });
  }
  const context = isRecord(config.context) ? config.context : {};
  const createTransport = typeof config.createTransport === 'function' ? config.createTransport : null;
  if (!createTransport) throw fail('acp_transport_factory_required', 'ACP adapter 缺少 createTransport');
  const handshakeTimeoutMs = Number(context.handshakeTimeoutMs) > 0
    ? Number(context.handshakeTimeoutMs)
    : ACP_HANDSHAKE_TIMEOUT_MS;

  const listeners = new Set();
  const interactionHandlers = new Set();
  let protocol = null;
  let activeSessionId = '';
  let opened = false;
  let disposed = false;

  function emit(event) {
    for (const listener of Array.from(listeners)) {
      try {
        listener(event);
      } catch (_ignored) {
        // 单个 listener 抛错不能打断协议处理（多播隔离在 bus，但 adapter 也不许崩）。
      }
    }
  }

  function requireProtocol(operation) {
    if (disposed) {
      throw fail('agent_session_disposed', `会话已释放，不能 ${operation}`, { operation });
    }
    if (!opened || !protocol) {
      throw fail('acp_session_not_open', `ACP 会话尚未打开，不能 ${operation}`, { operation });
    }
    return protocol;
  }

  async function startSession(openConfig, cwd) {
    if (openConfig.newSession === true) {
      const created = await protocol.request('session/new', { cwd, mcpServers: [] }, {
        timeoutMs: handshakeTimeoutMs
      });
      activeSessionId = nonEmpty(created && created.sessionId);
      if (!activeSessionId) throw fail('acp_session_new_missing_id', 'ACP session/new 未返回 sessionId');
      return created;
    }
    // load：优先用 harness 侧会话 id（context.acpSessionId）。本地 id 与 ACP id
    // 同域时允许退回本地 id，但跨域调用方必须显式传，否则会 load 到别人的会话。
    const target = nonEmpty(context.acpSessionId) || sessionId;
    const params = { sessionId: target, mcpServers: [] };
    if (cwd) params.cwd = cwd;
    const loaded = await protocol.request('session/load', params, { timeoutMs: handshakeTimeoutMs });
    activeSessionId = target;
    return loaded;
  }

  async function applyMode(value, modes) {
    const mode = nonEmpty(value);
    if (!mode) return;
    const available = modes.map((entry) => entry.id);
    // 模式是 agent 自己声明的封闭枚举：声明了却不含目标值，直接拒绝，
    // 不装作切过去了（界面会显示错的权限策略）。
    if (available.length > 0 && !available.includes(mode)) {
      throw fail('acp_mode_unsupported', `agent 未声明模式 ${mode}`, { mode, available });
    }
    try {
      await protocol.request('session/set_mode', { sessionId: activeSessionId, modeId: mode }, {
        timeoutMs: handshakeTimeoutMs
      });
    } catch (error) {
      throw fail('acp_mode_set_failed', `切换模式失败: ${mode}`, {
        mode,
        cause: (error && error.code) || String((error && error.message) || error)
      });
    }
  }

  async function applyModel(value) {
    const model = nonEmpty(value);
    if (!model) return;
    // 模型目录可能落后于宿主（网关能接目录外 id），所以不按目录过滤；
    // 但 agent 明确拒绝时必须失败——open() 要把「实际生效的模型」如实报给调用方。
    try {
      await protocol.request('session/set_model', { sessionId: activeSessionId, modelId: model }, {
        timeoutMs: handshakeTimeoutMs
      });
    } catch (error) {
      throw fail('acp_model_set_failed', `切换模型失败: ${model}`, {
        model,
        cause: (error && error.code) || String((error && error.message) || error)
      });
    }
  }

  async function open(openOptions) {
    if (disposed) throw fail('agent_session_disposed', '会话已释放，不能 open');
    if (opened) throw fail('acp_session_already_open', 'ACP 会话已经打开', { sessionId });
    const openConfig = isRecord(openOptions) ? openOptions : {};
    const cwd = nonEmpty(openConfig.cwd) || nonEmpty(context.cwd) || process.cwd();
    let transport = null;
    try {
      const created = await createTransport({ provider, context, sessionId, options: openConfig, cwd });
      transport = created && created.transport;
      if (!transport) throw fail('acp_transport_invalid', 'ACP 传输工厂没有返回 transport');
      protocol = createAcpProtocol({
        transport,
        emit,
        getInteractionHandlers: () => Array.from(interactionHandlers),
        fs: context.fs,
        path: context.path
      });
      await protocol.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
      }, { timeoutMs: handshakeTimeoutMs });
      const authMethod = nonEmpty(context.authMethod);
      if (authMethod) {
        await protocol.request('authenticate', { methodId: authMethod }, { timeoutMs: handshakeTimeoutMs });
      }
      const sessionInfo = await startSession(openConfig, cwd);
      const modes = normalizeModes(sessionInfo);
      const models = normalizeModels(sessionInfo);
      await applyMode(openConfig.mode, modes);
      await applyModel(openConfig.model);
      // 硬顺序：session/load 会在响应前重放整段历史，事件映射必须在这之后才生效。
      protocol.activate();
      opened = true;
      return { sessionId: activeSessionId, models, modes };
    } catch (error) {
      if (protocol) {
        protocol.dispose('open_failed');
        protocol = null;
      } else if (transport && typeof transport.close === 'function') {
        try {
          transport.close();
        } catch (_ignored) {
          // 握手失败时的收尾，关闭错误没有信息量。
        }
      }
      if (error && !error.code) error.code = 'acp_open_failed';
      throw error;
    }
  }

  async function prompt(promptOptions) {
    const client = requireProtocol('prompt');
    const promptConfig = isRecord(promptOptions) ? promptOptions : {};
    const blocks = buildPromptBlocks(promptConfig.text, promptConfig.images);
    client.beginTurn(nonEmpty(promptConfig.turnId));
    let finalStatus = 'failed';
    try {
      const result = await client.request('session/prompt', {
        sessionId: activeSessionId,
        prompt: blocks
      });
      const stopReason = nonEmpty(result && result.stopReason) || null;
      finalStatus = stopReason === 'cancelled' ? 'cancelled' : 'completed';
      return { stopReason };
    } finally {
      // 无论成功失败都收口：否则时间线会停在 running（projector 不会自己关条目）。
      for (const event of client.finishTurn(finalStatus)) emit(event);
    }
  }

  async function cancel(reason) {
    const client = requireProtocol('cancel');
    // ACP 的 cancel 是**通知**（没有回执）；结果体现在 session/prompt 的
    // stopReason=cancelled。挂着的审批先按协议回 cancelled，否则 agent 卡在等审批。
    client.cancelInteractions();
    client.notify('session/cancel', { sessionId: activeSessionId });
    return { cancelled: true, reason: nonEmpty(reason) || null };
  }

  function respond(interactionId, decision) {
    return requireProtocol('respond').respond(interactionId, decision);
  }

  function expire(interactionId, reason) {
    if (!client) return { interactionId: nonEmpty(interactionId), expired: false };
    return client.expire(interactionId, reason);
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw fail('agent_session_listener_invalid', 'listener 必须是函数');
    listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
    };
  }

  function onInteractionRequest(handler) {
    if (typeof handler !== 'function') throw fail('agent_session_interaction_handler_invalid', 'handler 必须是函数');
    interactionHandlers.add(handler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      interactionHandlers.delete(handler);
    };
  }

  async function setMode(modeId) {
    const client = requireProtocol('setMode');
    const mode = nonEmpty(modeId);
    if (!mode) throw fail('acp_mode_required', 'setMode 需要 modeId');
    await client.request('session/set_mode', { sessionId: activeSessionId, modeId: mode }, {
      timeoutMs: handshakeTimeoutMs
    });
    return { modeId: mode };
  }

  async function setModel(modelId) {
    const client = requireProtocol('setModel');
    const model = nonEmpty(modelId);
    if (!model) throw fail('acp_model_required', 'setModel 需要 modelId');
    await client.request('session/set_model', { sessionId: activeSessionId, modelId: model }, {
      timeoutMs: handshakeTimeoutMs
    });
    return { modelId: model };
  }

  function dispose(reason) {
    if (disposed) return;
    disposed = true;
    opened = false;
    if (protocol) {
      protocol.dispose(reason);
      protocol = null;
    }
  }

  return {
    id,
    provider,
    transport: transportName,
    open,
    prompt,
    cancel,
    respond,
    expire,
    subscribe,
    onInteractionRequest,
    dispose,
    setMode,
    setModel
  };
}

/** stdio 传输工厂：命令来自 context.command（CLI 定位链的产物），参数来自布局表。 */
function createStdioTransportFor(input) {
  const { args, layout } = resolveAcpArgs(input.provider, 'acp-stdio');
  const command = nonEmpty(input.context.command)
    || nonEmpty(layout && layout.binaryNames && layout.binaryNames[0]);
  if (!command) {
    throw fail('acp_command_unavailable', 'ACP 入口二进制未知', { provider: input.provider });
  }
  return {
    transport: createStdioTransport({
      command,
      args,
      cwd: input.cwd,
      env: input.context.env,
      spawn: input.context.spawn
    }),
    command,
    args
  };
}

function createAdapter(options) {
  return createAcpAdapter(Object.assign({}, options, {
    id: 'acp-stdio',
    transport: 'acp-stdio',
    createTransport: createStdioTransportFor
  }));
}

module.exports = {
  ACP_HANDSHAKE_TIMEOUT_MS,
  createAcpAdapter,
  createAcpProtocol,
  createAdapter,
  createSessionUpdateMapper,
  createStdioTransport,
  resolveAcpArgs
};
