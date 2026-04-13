import { appendThinkingChunk, stripThinkingBlock } from './live-message-state.js';

function cloneMessages(messages) {
  return Array.isArray(messages) ? [...messages] : [];
}

function getLastAssistant(messages) {
  const next = cloneMessages(messages);
  const last = next[next.length - 1];
  const isAssistant = Boolean(last && last.role === 'assistant');
  return {
    next,
    last,
    isAssistant
  };
}

export function appendAssistantText(messages, text, options = {}) {
  const cleanText = String(text || '').trim();
  if (!cleanText) return cloneMessages(messages);

  const { next, last, isAssistant } = getLastAssistant(messages);
  if (!isAssistant) {
    next.push({
      role: 'assistant',
      content: cleanText,
      pending: Boolean(options.pending),
      statusText: options.statusText,
      timestamp: options.timestamp
    });
    return next;
  }

  next[next.length - 1] = {
    ...last,
    content: `${String(last.content || '').trim()}${last.content ? '\n\n' : ''}${cleanText}`,
    pending: Boolean(options.pending),
    statusText: options.statusText,
    timestamp: last.timestamp || options.timestamp
  };
  return next;
}

export function appendAssistantThinking(messages, text, options = {}) {
  const cleanText = String(text || '').trim();
  if (!cleanText) return cloneMessages(messages);

  const { next, last, isAssistant } = getLastAssistant(messages);
  if (!isAssistant) {
    if (!options.createIfMissing) return next;
    next.push({
      role: 'assistant',
      content: appendThinkingChunk('', cleanText),
      pending: true,
      statusText: options.statusText,
      timestamp: options.timestamp
    });
    return next;
  }

  if (!last.pending && !options.allowCompletedAssistant) {
    if (!options.createIfMissing) return next;
    next.push({
      role: 'assistant',
      content: appendThinkingChunk('', cleanText),
      pending: true,
      statusText: options.statusText,
      timestamp: options.timestamp
    });
    return next;
  }

  next[next.length - 1] = {
    ...last,
    content: appendThinkingChunk(String(last.content || ''), cleanText),
    pending: true,
    statusText: options.statusText,
    timestamp: last.timestamp || options.timestamp
  };
  return next;
}

export function appendAssistantToolContent(messages, text, options = {}) {
  const cleanText = String(text || '').trim();
  if (!cleanText) return cloneMessages(messages);

  const { next, last, isAssistant } = getLastAssistant(messages);
  if (!isAssistant) {
    next.push({
      role: 'assistant',
      content: cleanText,
      pending: Boolean(options.pending),
      statusText: options.statusText,
      timestamp: options.timestamp
    });
    return next;
  }

  const existingContent = String(last.content || '').trim();
  const alreadyIncluded = existingContent.includes(cleanText);
  next[next.length - 1] = {
    ...last,
    content: alreadyIncluded
      ? existingContent
      : `${existingContent}${existingContent ? '\n\n' : ''}${cleanText}`,
    pending: Boolean(options.pending),
    statusText: options.statusText,
    timestamp: last.timestamp || options.timestamp
  };
  return next;
}

export function appendAssistantDelta(messages, delta, options = {}) {
  const text = String(delta || '');
  if (!text) return cloneMessages(messages);

  const { next, last, isAssistant } = getLastAssistant(messages);
  if (!isAssistant) {
    next.push({
      role: 'assistant',
      content: text,
      pending: true,
      statusText: options.statusText,
      timestamp: options.timestamp
    });
    return next;
  }

  const baseContent = last.pending ? stripThinkingBlock(String(last.content || '')) : String(last.content || '');
  next[next.length - 1] = {
    ...last,
    content: `${baseContent}${baseContent ? '\n\n' : ''}${text}`.trim(),
    pending: true,
    statusText: options.statusText,
    timestamp: last.timestamp || options.timestamp
  };
  return next;
}

export function finalizeAssistantMessage(messages, content, options = {}) {
  const finalContent = String(content || '').trim();
  const { next, last, isAssistant } = getLastAssistant(messages);

  if (!isAssistant) {
    if (!finalContent) return next;
    next.push({
      role: 'assistant',
      content: finalContent,
      pending: false,
      timestamp: options.timestamp
    });
    return next;
  }

  next[next.length - 1] = {
    ...last,
    content: finalContent || String(last.content || ''),
    pending: false,
    statusText: undefined,
    timestamp: last.timestamp || options.timestamp
  };
  return next;
}

export function clearPendingAssistant(messages, options = {}) {
  const { next, last, isAssistant } = getLastAssistant(messages);
  if (!isAssistant) return next;

  next[next.length - 1] = {
    ...last,
    pending: false,
    statusText: undefined,
    timestamp: last.timestamp || options.timestamp
  };
  return next;
}
