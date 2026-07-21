'use strict';

function toPlainText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function readAnthropicToolUseId(part) {
  return toPlainText(part && part.id || '').trim();
}

function readAnthropicToolResultId(part) {
  return toPlainText(part && (part.tool_use_id || part.toolUseId) || '').trim();
}

function stringifyAnthropicToolResultContent(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object' && content.type === 'text') {
      return toPlainText(content.text || '');
    }
    try {
      return JSON.stringify(content);
    } catch (_error) {
      return toPlainText(content);
    }
  }
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && part.type === 'text') return toPlainText(part.text || '');
      try {
        return JSON.stringify(part);
      } catch (_error) {
        return '';
      }
    })
    .filter(Boolean)
    .join('\n');
}

function createAnthropicOrphanToolResultTextPart(part) {
  const toolUseId = readAnthropicToolResultId(part);
  const suffix = toolUseId ? ` (${toolUseId})` : '';
  const content = stringifyAnthropicToolResultContent(part && part.content);
  return {
    type: 'text',
    text: content ? `Tool result${suffix}:\n${content}` : `Tool result${suffix}:`
  };
}

function normalizeAnthropicMessageContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content.filter(Boolean) : [];
}

function collectAnthropicToolUseRefs(message, messageIndex) {
  return (Array.isArray(message && message.content) ? message.content : [])
    .map((part, partIndex) => {
      if (!part || part.type !== 'tool_use') return null;
      const id = readAnthropicToolUseId(part);
      return id ? { id, messageIndex, partIndex, consumed: false } : null;
    })
    .filter(Boolean);
}

function removeUnansweredAnthropicToolUses(messages, pendingToolUses) {
  const groups = new Map();
  (Array.isArray(pendingToolUses) ? pendingToolUses : []).forEach((toolUse) => {
    if (!toolUse || toolUse.consumed) return;
    if (!groups.has(toolUse.messageIndex)) groups.set(toolUse.messageIndex, new Set());
    groups.get(toolUse.messageIndex).add(toolUse.partIndex);
  });
  let removedCount = 0;
  Array.from(groups.keys()).sort((a, b) => b - a).forEach((messageIndex) => {
    const message = messages[messageIndex];
    if (!message || !Array.isArray(message.content)) return;
    const partIndexes = groups.get(messageIndex);
    const content = message.content.filter((_part, partIndex) => !partIndexes.has(partIndex));
    removedCount += message.content.length - content.length;
    if (content.length > 0) {
      messages[messageIndex] = { ...message, content };
      return;
    }
    messages.splice(messageIndex, 1);
  });
  return removedCount;
}

function consumeAnthropicToolResult(part, pendingToolUses) {
  const toolUseId = readAnthropicToolResultId(part);
  if (!toolUseId) return false;
  const match = pendingToolUses.find((toolUse) => toolUse && !toolUse.consumed && toolUse.id === toolUseId);
  if (!match) return false;
  match.consumed = true;
  return true;
}

function shouldDropTrailingUnansweredToolUses(options) {
  return !options || options.dropTrailingUnansweredToolUses !== false;
}

function sanitizeAnthropicToolHistoryWithStats(messages, options = {}) {
  const out = [];
  let pendingToolUses = [];
  const stats = {
    droppedUnansweredToolUseCount: 0,
    orphanToolResultCount: 0
  };

  (Array.isArray(messages) ? messages : []).forEach((message) => {
    if (!message || typeof message !== 'object') return;
    const role = String(message.role || '').trim().toLowerCase() === 'assistant' ? 'assistant' : 'user';
    const content = normalizeAnthropicMessageContent(message.content);
    if (role === 'assistant') {
      stats.droppedUnansweredToolUseCount += removeUnansweredAnthropicToolUses(out, pendingToolUses);
      pendingToolUses = [];
      if (content.length === 0) return;
      const messageIndex = out.length;
      out.push({ role, content });
      pendingToolUses = collectAnthropicToolUseRefs(out[messageIndex], messageIndex);
      return;
    }

    const matchedToolResults = [];
    const otherParts = [];
    content.forEach((part) => {
      if (part && part.type === 'tool_result') {
        if (consumeAnthropicToolResult(part, pendingToolUses)) {
          matchedToolResults.push(part);
          return;
        }
        stats.orphanToolResultCount += 1;
        otherParts.push(createAnthropicOrphanToolResultTextPart(part));
        return;
      }
      otherParts.push(part);
    });

    stats.droppedUnansweredToolUseCount += removeUnansweredAnthropicToolUses(out, pendingToolUses);
    pendingToolUses = [];
    const nextContent = matchedToolResults.length > 0 ? [...matchedToolResults, ...otherParts] : otherParts;
    if (nextContent.length > 0) out.push({ role, content: nextContent });
  });

  if (shouldDropTrailingUnansweredToolUses(options)) {
    stats.droppedUnansweredToolUseCount += removeUnansweredAnthropicToolUses(out, pendingToolUses);
  }
  return { messages: out, stats };
}

function sanitizeAnthropicToolHistory(messages, options = {}) {
  return sanitizeAnthropicToolHistoryWithStats(messages, options).messages;
}

module.exports = {
  createAnthropicOrphanToolResultTextPart,
  readAnthropicToolResultId,
  readAnthropicToolUseId,
  sanitizeAnthropicToolHistory,
  sanitizeAnthropicToolHistoryWithStats,
  stringifyAnthropicToolResultContent,
  __private: {
    collectAnthropicToolUseRefs,
    consumeAnthropicToolResult,
    normalizeAnthropicMessageContent,
    removeUnansweredAnthropicToolUses,
    shouldDropTrailingUnansweredToolUses
  }
};
