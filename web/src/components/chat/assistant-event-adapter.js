import {
  appendAssistantThinking,
  appendAssistantToolContent,
  appendAssistantDelta,
  finalizeAssistantMessage,
  clearPendingAssistant
} from './assistant-live-state.js';
import {
  getThinkingStatusText,
  getProcessingStatusText,
  getGeneratingStatusText
} from './provider-pending-policy.js';

export function applySessionAssistantEvent(messages, event, options = {}) {
  const type = String(event?.type || '');
  const provider = options.provider || '';
  const model = event?.model || options.model;
  if (type === 'assistant_text') {
    const text = String(event.text || event.content || '').trim();
    if (!text) return Array.isArray(messages) ? [...messages] : [];
    const next = Array.isArray(messages) ? [...messages] : [];
    const last = next[next.length - 1];
    if (!last || last.role !== 'assistant') {
      next.push({
        role: 'assistant',
        content: text,
        pending: false,
        statusText: undefined,
        timestamp: event.timestamp,
        ...(model ? { model } : {})
      });
      return next;
    }
    next[next.length - 1] = {
      ...last,
      content: `${String(last.content || '').trim()}${last.content ? '\n\n' : ''}${text}`,
      pending: false,
      statusText: undefined,
      timestamp: last.timestamp || event.timestamp,
      ...(last.model || model ? { model: last.model || model } : {})
    };
    return next;
  }

  if (type === 'assistant_reasoning') {
    return appendAssistantThinking(messages, event.text || event.content || '', {
      createIfMissing: false,
      statusText: options.thinkingStatusText || getThinkingStatusText(provider),
      timestamp: event.timestamp,
      model
    });
  }

  if (type === 'assistant_tool_call' || type === 'assistant_tool_result') {
    return appendAssistantToolContent(messages, event.content || '', {
      pending: Boolean(options.pending),
      statusText: options.pending ? (options.processingStatusText || getProcessingStatusText()) : undefined,
      timestamp: event.timestamp,
      model
    });
  }

  return Array.isArray(messages) ? [...messages] : [];
}

export function applyStreamingAssistantEvent(messages, event, options = {}) {
  const type = String(event?.type || '');
  const provider = options.provider || '';
  const model = event?.model || options.model;

  if (type === 'terminal-output') {
    return Array.isArray(messages) ? [...messages] : [];
  }

  if (type === 'thinking') {
    return appendAssistantThinking(messages, event.thinking || '', {
      createIfMissing: true,
      allowCompletedAssistant: true,
      statusText: options.thinkingStatusText || getThinkingStatusText(provider),
      timestamp: options.timestamp,
      model
    });
  }

  if (type === 'delta') {
    return appendAssistantDelta(messages, event.delta || '', {
      statusText: options.generatingStatusText || getGeneratingStatusText(),
      timestamp: options.timestamp,
      model
    });
  }

  // 工具调用实时流式：turn 进行中把工具卡片追加到当前 pending 气泡(与会话历史同一套 :::tool 渲染)。
  if (type === 'assistant_tool_call' || type === 'assistant_tool_result') {
    return appendAssistantToolContent(messages, event.content || '', {
      pending: true,
      statusText: options.processingStatusText || getProcessingStatusText(),
      timestamp: options.timestamp,
      model
    });
  }

  if (type === 'result') {
    return finalizeAssistantMessage(messages, event.content || '', {
      timestamp: options.timestamp,
      model
    });
  }

  if (type === 'done') {
    if (typeof event.content === 'string' && event.content) {
      return finalizeAssistantMessage(messages, event.content, {
        timestamp: options.timestamp,
        model
      });
    }
    return clearPendingAssistant(messages, {
      timestamp: options.timestamp,
      model
    });
  }

  return Array.isArray(messages) ? [...messages] : [];
}
