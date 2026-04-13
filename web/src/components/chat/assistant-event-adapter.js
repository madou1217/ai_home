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
        timestamp: event.timestamp
      });
      return next;
    }
    next[next.length - 1] = {
      ...last,
      content: `${String(last.content || '').trim()}${last.content ? '\n\n' : ''}${text}`,
      pending: false,
      statusText: undefined,
      timestamp: last.timestamp || event.timestamp
    };
    return next;
  }

  if (type === 'assistant_reasoning') {
    return appendAssistantThinking(messages, event.text || event.content || '', {
      createIfMissing: false,
      statusText: options.thinkingStatusText || getThinkingStatusText(provider),
      timestamp: event.timestamp
    });
  }

  if (type === 'assistant_tool_call' || type === 'assistant_tool_result') {
    return appendAssistantToolContent(messages, event.content || '', {
      pending: Boolean(options.pending),
      statusText: options.pending ? (options.processingStatusText || getProcessingStatusText()) : undefined,
      timestamp: event.timestamp
    });
  }

  return Array.isArray(messages) ? [...messages] : [];
}

export function applyStreamingAssistantEvent(messages, event, options = {}) {
  const type = String(event?.type || '');
  const provider = options.provider || '';

  if (type === 'terminal-output') {
    const chunk = String(event.text || '');
    if (!chunk) return Array.isArray(messages) ? [...messages] : [];
    const next = Array.isArray(messages) ? [...messages] : [];
    const last = next[next.length - 1];
    if (!last || last.role !== 'assistant') {
      next.push({
        role: 'assistant',
        content: chunk,
        pending: true,
        statusText: options.processingStatusText || getProcessingStatusText(),
        timestamp: options.timestamp
      });
      return next;
    }
    next[next.length - 1] = {
      ...last,
      content: `${last.content || ''}${chunk}`,
      pending: true,
      statusText: options.processingStatusText || getProcessingStatusText(),
      timestamp: last.timestamp || options.timestamp
    };
    return next;
  }

  if (type === 'thinking') {
    return appendAssistantThinking(messages, event.thinking || '', {
      createIfMissing: true,
      allowCompletedAssistant: true,
      statusText: options.thinkingStatusText || getThinkingStatusText(provider),
      timestamp: options.timestamp
    });
  }

  if (type === 'delta') {
    return appendAssistantDelta(messages, event.delta || '', {
      statusText: options.generatingStatusText || getGeneratingStatusText(),
      timestamp: options.timestamp
    });
  }

  if (type === 'result') {
    return finalizeAssistantMessage(messages, event.content || '', {
      timestamp: options.timestamp
    });
  }

  if (type === 'done') {
    if (typeof event.content === 'string' && event.content) {
      return finalizeAssistantMessage(messages, event.content, {
        timestamp: options.timestamp
      });
    }
    return clearPendingAssistant(messages, {
      timestamp: options.timestamp
    });
  }

  return Array.isArray(messages) ? [...messages] : [];
}
