'use strict';

// opencode serve 事件流的形状适配器（事件词汇 → 既有 native 流信号）。
//
// 两代事件流的信封与词汇**完全不同**，差异按 eventShape（布局表声明）分派：
//   properties（v1）：`{type, properties}`，中枢事件 = message.updated / message.part.updated /
//                     message.part.delta / permission.asked(legacy 形状) / session.idle / session.error
//   data（v2）：`{id, type, data}`，粗粒度词汇 = session.text.{started,delta,ended} /
//               session.tool.{input.started,called,success,failed} /
//               session.execution.{started,succeeded,failed,interrupted} /
//               permission.asked(v2 形状:{action,resources,source}) / session.retry.scheduled
//               （真机 2.0.29 实测：/api/event 是全局流，事件带 data.sessionID，必须按会话过滤）
//
// 两个适配器对外是同一接口 `{sessionId(可写), state:{content}, handle(event)}`：
// emit 收 {type:'delta'|'assistant_tool_call'|'assistant_tool_result'|'retry-status'} 事件；
// permission.asked / permission.replied / idle / error 经专用回调交给 runner——runner 不感知代际。

const { mapOpenCodeSessionRetry, createRetryStatus } = require('./native-retry-status');

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// 与 native-session-chat 的 renderNativeToolCallTag/renderNativeToolResultTag 同格式
// (:::tool 标签,前端 parseMessageBlocks 直接解析成工具卡片;那边未导出,这里等价实现)。
function renderToolCallTag(name, input) {
  const toolName = String(name || 'Tool').replace(/["\\\r\n]/g, '').trim() || 'Tool';
  let body = '';
  try {
    body = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  } catch (_error) {
    body = String(input == null ? '' : input);
  }
  return `:::tool{name="${toolName}"}\n${String(body || '').trim()}\n:::`;
}

function renderToolResultTag(output) {
  const text = String(output == null ? '' : output).trim();
  return text ? `:::tool-result\n${text}\n:::` : '';
}

// v2 结构化错误（Session.StructuredError）：{type, message, status?, response?}。
function structuredErrorText(error, fallback = '') {
  if (typeof error === 'string') return normalizeString(error) || fallback;
  if (error && typeof error === 'object') {
    return normalizeString(error.message) || normalizeString(error.type) || fallback;
  }
  return fallback;
}

function createPropertiesEventMapper({ sessionId, emit, onPermissionAsked, onPermissionReplied, onIdle, onError }) {
  const messageRoles = new Map(); // messageID → role
  const partTypes = new Map(); // partID → part.type
  const textByPart = new Map(); // partID → 已见全文(去重/补尾)
  const toolParts = new Map(); // partID → {callEmitted,resultEmitted}
  const state = { content: '' };
  const mapper = { sessionId: normalizeString(sessionId), state };

  const appendAssistantText = (partId, nextText) => {
    const previous = textByPart.get(partId) || '';
    const full = String(nextText || '');
    if (!full || full.length <= previous.length || !full.startsWith(previous)) return;
    const delta = full.slice(previous.length);
    textByPart.set(partId, full);
    state.content += delta;
    emit({ type: 'delta', delta });
  };

  const handleToolPart = (part) => {
    const partId = normalizeString(part.id) || `tool:${normalizeString(part.callID)}`;
    const st = part.state && typeof part.state === 'object' ? part.state : {};
    const status = normalizeString(st.status);
    if (status === 'pending') return; // input 未就绪
    let entry = toolParts.get(partId);
    if (!entry) {
      entry = { callEmitted: false, resultEmitted: false };
      toolParts.set(partId, entry);
    }
    if (!entry.callEmitted) {
      entry.callEmitted = true;
      emit({ type: 'assistant_tool_call', content: renderToolCallTag(part.tool || part.name || 'Tool', st.input || {}) });
    }
    if (entry.resultEmitted) return;
    if (status === 'completed') {
      entry.resultEmitted = true;
      const tag = renderToolResultTag(st.output || (st.metadata && st.metadata.output) || '');
      if (tag) emit({ type: 'assistant_tool_result', content: tag });
    } else if (status === 'error') {
      entry.resultEmitted = true;
      const tag = renderToolResultTag(st.error || 'tool error');
      if (tag) emit({ type: 'assistant_tool_result', content: tag });
    }
  };

  const eventSessionId = (event) => {
    const props = event && event.properties && typeof event.properties === 'object' ? event.properties : {};
    return normalizeString(
      props.sessionID
      || (props.info && props.info.sessionID)
      || (props.part && props.part.sessionID)
    );
  };

  mapper.handle = (event) => {
    const type = normalizeString(event && event.type);
    if (!type) return;
    const props = event.properties && typeof event.properties === 'object' ? event.properties : {};
    // 全事件流严格按会话过滤:同一 serve 实例可能并发多个会话(甚至 TUI),
    // 无 sessionID 或不匹配的事件一律不进本 run。
    const sid = eventSessionId(event);
    if (!mapper.sessionId || !sid || sid !== mapper.sessionId) return;

    const retryStatus = mapOpenCodeSessionRetry(event);
    if (retryStatus) {
      emit(retryStatus);
      return;
    }

    if (type === 'message.updated' && props.info && props.info.id) {
      messageRoles.set(String(props.info.id), normalizeString(props.info.role));
      return;
    }
    if (type === 'message.part.updated' && props.part && typeof props.part === 'object') {
      const part = props.part;
      const partId = normalizeString(part.id);
      if (partId) partTypes.set(partId, normalizeString(part.type));
      const role = messageRoles.get(normalizeString(part.messageID)) || '';
      if (role !== 'assistant') return; // 用户自己的 prompt 回显不算回复
      if (part.type === 'text') {
        appendAssistantText(partId, part.text);
      } else if (part.type === 'tool') {
        handleToolPart(part);
      }
      return;
    }
    if (type === 'message.part.delta') {
      // {messageID,partID,field:'text',delta}:reasoning part 的思考流不进正文,text part 才是回复。
      if (normalizeString(props.field) !== 'text') return;
      const partId = normalizeString(props.partID);
      if (partTypes.get(partId) !== 'text') return;
      if (messageRoles.get(normalizeString(props.messageID)) !== 'assistant') return;
      const previous = textByPart.get(partId) || '';
      appendAssistantText(partId, previous + String(props.delta || ''));
      return;
    }
    if (type === 'permission.asked') {
      if (typeof onPermissionAsked === 'function') onPermissionAsked(props);
      return;
    }
    if (type === 'permission.replied') {
      if (typeof onPermissionReplied === 'function') onPermissionReplied(props);
      return;
    }
    if (type === 'session.idle') {
      if (typeof onIdle === 'function') onIdle();
      return;
    }
    if (type === 'session.error') {
      const message = normalizeString(
        (props.error && (props.error.message || (props.error.data && props.error.data.message)))
        || props.message
      ) || 'opencode_serve_session_error';
      if (typeof onError === 'function') onError(message);
    }
  };
  return mapper;
}

function createDataEventMapper({ sessionId, emit, onPermissionAsked, onPermissionReplied, onIdle, onError }) {
  const textBlockKeys = new Map(); // messageID → 已见全文(去重/补尾)
  const toolNames = new Map(); // callID → 工具名（input.started 先于 called）
  const toolCalls = new Map(); // callID → {callEmitted,resultEmitted}
  const state = { content: '' };
  const mapper = { sessionId: normalizeString(sessionId), state };

  const appendAssistantText = (key, nextText) => {
    const previous = textBlockKeys.get(key) || '';
    const full = String(nextText || '');
    if (!full || full.length <= previous.length || !full.startsWith(previous)) return;
    const delta = full.slice(previous.length);
    textBlockKeys.set(key, full);
    state.content += delta;
    emit({ type: 'delta', delta });
  };

  const toolEntry = (callId) => {
    let entry = toolCalls.get(callId);
    if (!entry) {
      entry = { callEmitted: false, resultEmitted: false };
      toolCalls.set(callId, entry);
    }
    return entry;
  };

  const contentText = (content) => {
    if (!Array.isArray(content)) return '';
    return content
      .map((item) => (item && typeof item === 'object' && typeof item.text === 'string' ? item.text : ''))
      .join('');
  };

  mapper.handle = (event) => {
    const type = normalizeString(event && event.type);
    if (!type) return;
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    // v2 事件流是全局的（跨 location）：一律按 data.sessionID 过滤。
    const sid = normalizeString(data.sessionID);
    if (!mapper.sessionId || !sid || sid !== mapper.sessionId) return;

    if (type === 'session.text.delta') {
      const key = `${normalizeString(data.assistantMessageID)}:${data.ordinal == null ? 0 : data.ordinal}`;
      appendAssistantText(key, (textBlockKeys.get(key) || '') + String(data.delta || ''));
      return;
    }
    if (type === 'session.text.ended') {
      const key = `${normalizeString(data.assistantMessageID)}:${data.ordinal == null ? 0 : data.ordinal}`;
      appendAssistantText(key, String(data.text || ''));
      return;
    }
    if (type === 'session.tool.input.started') {
      const callId = normalizeString(data.id);
      if (callId) toolNames.set(callId, normalizeString(data.name));
      return;
    }
    if (type === 'session.tool.called') {
      const callId = normalizeString(data.id);
      if (!callId) return;
      const entry = toolEntry(callId);
      if (entry.callEmitted) return;
      entry.callEmitted = true;
      const name = toolNames.get(callId) || normalizeString(data.tool) || normalizeString(data.name) || 'Tool';
      emit({ type: 'assistant_tool_call', content: renderToolCallTag(name, data.input || {}) });
      return;
    }
    if (type === 'session.tool.success') {
      const callId = normalizeString(data.id);
      if (!callId) return;
      const entry = toolEntry(callId);
      if (entry.resultEmitted) return;
      entry.resultEmitted = true;
      const output = contentText(data.content) || (data.metadata && data.metadata.output) || '';
      const tag = renderToolResultTag(output);
      if (tag) emit({ type: 'assistant_tool_result', content: tag });
      return;
    }
    if (type === 'session.tool.failed') {
      const callId = normalizeString(data.id);
      if (!callId) return;
      const entry = toolEntry(callId);
      if (entry.resultEmitted) return;
      entry.resultEmitted = true;
      const output = contentText(data.content) || structuredErrorText(data.error, 'tool error');
      const tag = renderToolResultTag(output);
      if (tag) emit({ type: 'assistant_tool_result', content: tag });
      return;
    }
    if (type === 'permission.asked') {
      if (typeof onPermissionAsked === 'function') {
        // v2 形状 {id, sessionID, action, resources, save?, metadata?, source:{type,messageID,id}}
        // → 归一成 v1 形状（runner 的审批桥两代同构）。
        const payload = {
          id: normalizeString(data.id),
          permission: normalizeString(data.action),
          patterns: Array.isArray(data.resources) ? data.resources : [],
          tool: {
            callID: normalizeString(data.source && data.source.id),
            messageID: normalizeString(data.source && data.source.messageID)
          }
        };
        if (data.metadata && typeof data.metadata === 'object') payload.metadata = data.metadata;
        onPermissionAsked(payload);
      }
      return;
    }
    if (type === 'permission.replied') {
      if (typeof onPermissionReplied === 'function') {
        onPermissionReplied({
          requestID: normalizeString(data.requestID),
          reply: normalizeString(data.reply)
        });
      }
      return;
    }
    if (type === 'session.retry.scheduled') {
      const error = data.error && typeof data.error === 'object' ? data.error : {};
      emit(createRetryStatus({
        phase: 'scheduled',
        source: 'provider-runtime',
        provider: 'opencode',
        attempt: data.attempt,
        retryAt: data.at,
        status: error.status,
        reason: error.type,
        message: structuredErrorText(data.error)
      }));
      return;
    }
    if (type === 'session.execution.succeeded') {
      if (typeof onIdle === 'function') onIdle();
      return;
    }
    if (type === 'session.execution.failed') {
      if (typeof onError === 'function') {
        onError(structuredErrorText(data.error, 'opencode_serve_session_error'));
      }
      return;
    }
    if (type === 'session.execution.interrupted') {
      if (typeof onError === 'function') {
        const reason = normalizeString(data.reason);
        onError(`opencode serve 会话执行被中断${reason ? `(${reason})` : ''}`);
      }
      return;
    }
    // 防御：老词汇若以 data 信封出现，按同义事件处理。
    if (type === 'session.idle') {
      if (typeof onIdle === 'function') onIdle();
      return;
    }
    if (type === 'session.error') {
      if (typeof onError === 'function') {
        onError(structuredErrorText(data.error, 'opencode_serve_session_error'));
      }
    }
  };
  return mapper;
}

const EVENT_SHAPE_MAPPERS = Object.freeze({
  properties: createPropertiesEventMapper,
  data: createDataEventMapper
});

/**
 * 事件映射器门面：按 eventShape（布局表声明）选适配器。
 * eventShape 可以在拿到 serve 实例后再定（getEventShape 首次 handle 时解析一次），
 * 未知形状 fail closed（布局表是受控数据，出现未知形状说明表/适配器不同步）。
 */
function createServeEventMapper(options = {}) {
  const { sessionId, emit, onPermissionAsked, onPermissionReplied, onIdle, onError } = options;
  const declaredShape = normalizeString(options.eventShape);
  const getEventShape = typeof options.getEventShape === 'function' ? options.getEventShape : null;
  let active = null;

  const resolveMapper = () => {
    const shape = (getEventShape ? normalizeString(getEventShape()) : '') || declaredShape || 'properties';
    const factory = EVENT_SHAPE_MAPPERS[shape];
    if (!factory) {
      const error = new Error(`opencode serve 事件流形状未知:${shape}`);
      error.code = 'opencode_serve_event_shape_unknown';
      throw error;
    }
    return factory({ sessionId, emit, onPermissionAsked, onPermissionReplied, onIdle, onError });
  };

  const facade = {
    sessionId: normalizeString(sessionId),
    get state() {
      return (active || (active = resolveMapper())).state;
    },
    handle(event) {
      const mapper = active || (active = resolveMapper());
      // sessionId 允许在 createSession 后回填（adapter 内部按当前值过滤）。
      mapper.sessionId = facade.sessionId;
      return mapper.handle(event);
    }
  };
  return facade;
}

module.exports = {
  createServeEventMapper,
  renderToolCallTag,
  renderToolResultTag
};
