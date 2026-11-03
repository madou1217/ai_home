'use strict';

// 工具块标签渲染：与会话历史渲染(provider-session-adapters renderToolBlock)同格式，
// 前端 parseMessageBlocks 直接解析成工具卡片。实时流式(native-session-chat 的 exec/JSONL
// 路径与 codex-app-server-runner 的 JSON-RPC 路径)和历史回读共用同一套格式。

function renderNativeToolCallTag(name, input) {
  const toolName = String(name || 'Tool').replace(/["\\\r\n]/g, '').trim() || 'Tool';
  let body = '';
  try {
    body = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  } catch (_error) {
    body = String(input == null ? '' : input);
  }
  return `:::tool{name="${toolName}"}\n${String(body || '').trim()}\n:::`;
}

function extractToolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return typeof part === 'string' ? part : '';
        if (typeof part.text === 'string') return part.text;
        if (part.type === 'image') return '[image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function renderNativeToolResultTag(output) {
  const text = String(extractToolResultText(output) || '').trim();
  return text ? `:::tool-result\n${text}\n:::` : '';
}

module.exports = {
  renderNativeToolCallTag,
  extractToolResultText,
  renderNativeToolResultTag
};
