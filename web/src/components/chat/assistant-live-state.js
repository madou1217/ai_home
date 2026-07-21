import { appendThinkingChunk } from './live-message-state.js';

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

function getModelPatch(message, options) {
  const model = String(message?.model || options?.model || '').trim();
  return model ? { model } : {};
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
      timestamp: options.timestamp,
      ...getModelPatch(null, options)
    });
    return next;
  }

  next[next.length - 1] = {
    ...last,
    content: `${String(last.content || '').trim()}${last.content ? '\n\n' : ''}${cleanText}`,
    pending: Boolean(options.pending),
    statusText: options.statusText,
    timestamp: last.timestamp || options.timestamp,
    ...getModelPatch(last, options)
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
      timestamp: options.timestamp,
      ...getModelPatch(null, options)
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
      timestamp: options.timestamp,
      ...getModelPatch(null, options)
    });
    return next;
  }

  next[next.length - 1] = {
    ...last,
    content: appendThinkingChunk(String(last.content || ''), cleanText),
    pending: true,
    statusText: options.statusText,
    timestamp: last.timestamp || options.timestamp,
    ...getModelPatch(last, options)
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
      timestamp: options.timestamp,
      ...getModelPatch(null, options)
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
    timestamp: last.timestamp || options.timestamp,
    ...getModelPatch(last, options)
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
      timestamp: options.timestamp,
      ...getModelPatch(null, options)
    });
    return next;
  }

  const baseContent = String(last.content || '');
  next[next.length - 1] = {
    ...last,
    content: `${baseContent}${text}`.trim(),
    pending: true,
    statusText: options.statusText,
    timestamp: last.timestamp || options.timestamp,
    ...getModelPatch(last, options)
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
      timestamp: options.timestamp,
      ...getModelPatch(null, options)
    });
    return next;
  }

  // 流式中已把工具调用(:::tool 块)追加进 content;而 result 的 finalContent 只有纯文本。
  // 若直接用 finalContent 覆盖会把实时显示的工具卡片抹掉(等历史回读才回来 → 闪一下)。
  // 已含工具块时保留累积内容(更完整),否则用最终文本。
  const existing = String(last.content || '');
  const hasToolBlocks = existing.includes(':::tool');
  next[next.length - 1] = {
    ...last,
    content: hasToolBlocks ? (existing || finalContent) : (finalContent || existing),
    pending: false,
    statusText: undefined,
    timestamp: last.timestamp || options.timestamp,
    ...getModelPatch(last, options)
  };
  return next;
}

export function clearPendingAssistant(messages, options = {}) {
  const { next, last, isAssistant } = getLastAssistant(messages);
  if (!isAssistant) return next;
  if (last.pending && !String(last.content || '').trim()) {
    next.pop();
    return next;
  }

  next[next.length - 1] = {
    ...last,
    pending: false,
    statusText: undefined,
    timestamp: last.timestamp || options.timestamp,
    ...getModelPatch(last, options)
  };
  return next;
}
