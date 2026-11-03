'use strict';

// 消费者适配：canonical 会话事件 → provider-session-state 的转移事件。
//
// 这是整层第一个真实消费者，也是最初那个问题的答案：交互请求到达时，终端标题
// 应该立刻变成「? 要不要允许…」。标题源读的是 provider-session-state，所以这里
// 只做投影，不直接碰终端——换任何 UI 都复用同一份投影。

const { isPlainObject, nonEmptyString } = require('../contracts');

const MAX_TEXT = 512;

function clip(value, max = MAX_TEXT) {
  const text = nonEmptyString(value);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// 交互 → 标题里那一行问题。approval 用标题，question 再带上正文；
// 太长的 detail 不进标题（标题栏放不下，也会把帧撑爆）。
function questionTextOf(event) {
  const payload = isPlainObject(event.payload) ? event.payload : {};
  const interaction = isPlainObject(payload.payload) ? payload.payload : {};
  const presentation = isPlainObject(interaction.presentation) ? interaction.presentation : {};
  const title = clip(presentation.title);
  if (!title) return '';
  const detail = clip(presentation.message || presentation.description);
  return detail ? `${title} ${detail}` : title;
}

// 只有真的「选项」才进 options：审批的 choices、单选/多选字段的 options。
// 文本框的 label 不是选项，塞进去会让标题出现假的可选项。
function optionsOf(event) {
  const payload = isPlainObject(event.payload) ? event.payload : {};
  const interaction = isPlainObject(payload.payload) ? payload.payload : {};
  if (payload.kind === 'approval') {
    return (interaction.choices || [])
      .map((choice) => clip(choice && choice.label, 80))
      .filter(Boolean)
      .slice(0, 32);
  }
  const fields = Array.isArray(interaction.fields) ? interaction.fields : [];
  const select = fields.find((field) => field && Array.isArray(field.options) && field.options.length > 0);
  if (!select) return [];
  return select.options
    .map((option) => clip(option && option.label, 80))
    .filter(Boolean)
    .slice(0, 32);
}

function projectEvent(event) {
  if (!isPlainObject(event)) return null;
  switch (event.type) {
    case 'turn.started':
      return { type: 'turn-started', payload: {} };
    case 'turn.completed':
      return {
        type: 'turn-completed',
        payload: { stopReason: nonEmptyString(event.payload && event.payload.stopReason) || null }
      };
    case 'turn.failed':
      return {
        type: 'turn-failed',
        payload: {
          message: nonEmptyString(event.payload && event.payload.message) || 'turn failed',
          code: nonEmptyString(event.payload && event.payload.code) || null
        }
      };
    case 'turn.interrupted':
      return { type: 'turn-interrupted', payload: {} };
    case 'interaction.requested': {
      const question = questionTextOf(event);
      if (!question) return null;
      return {
        type: 'question-opened',
        payload: {
          interactionId: nonEmptyString(event.payload && event.payload.interactionId) || null,
          question,
          options: optionsOf(event)
        }
      };
    }
    case 'interaction.resolved':
    case 'interaction.expired':
      return {
        type: 'question-cleared',
        payload: { interactionId: nonEmptyString(event.payload && event.payload.interactionId) || null }
      };
    default:
      return null;
  }
}

function attachSessionStateConsumer(options) {
  const config = isPlainObject(options) ? options : {};
  const bus = config.bus;
  const store = config.store;
  if (!bus || typeof bus.subscribe !== 'function') throw new Error('session_state_bus_required');
  if (!store || typeof store.apply !== 'function') throw new Error('session_state_store_required');
  const session = config.session || {};
  const correlationId = nonEmptyString(config.correlationId);
  const source = nonEmptyString(config.source) || 'agent-session';

  return bus.subscribe((event) => {
    const projection = projectEvent(event);
    if (!projection) return;
    // store 的 normalizeEvent 从**顶层**读 provider/sessionId（不认嵌套 session），
    // 所以这里把会话字段摊平；嵌套写法会被判 invalid_event 静默丢掉。
    const record = Object.assign({}, session, projection, {
      correlationId,
      source,
      at: event.at,
      eventId: event.eventId
    });
    // 有 correlation 走 correlation（会话还没建好时 store 会排队），否则直接落会话键。
    if (correlationId && typeof store.applyByCorrelation === 'function') {
      store.applyByCorrelation(correlationId, record);
      return;
    }
    store.apply(record);
  });
}

module.exports = {
  attachSessionStateConsumer,
  optionsOf,
  projectEvent,
  questionTextOf
};
