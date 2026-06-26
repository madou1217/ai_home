'use strict';

const fs = require('fs-extra');
const path = require('node:path');

function compactText(value) {
  return String(value || '').replace(/\r\n?/g, '\n').trim();
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value == null ? {} : value);
  } catch (_error) {
    return '{}';
  }
}

function escapeToolName(name) {
  return String(name || 'Unknown').replace(/"/g, '\\"');
}

function renderToolBlock(name, body, result) {
  const toolName = escapeToolName(name);
  const content = compactText(body);
  const output = compactText(result);
  let rendered = `:::tool{name="${toolName}"}\n${content}\n:::`;
  if (output) rendered += `\n\n:::tool-result\n${output}\n:::`;
  return rendered;
}

function renderTagBlock(name, value) {
  const tagName = String(name || '').trim();
  if (!tagName) return '';
  return `<${tagName}>\n${compactText(value)}\n</${tagName}>`;
}

function normalizeChecklistItems(items, contentKey) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const content = compactText(item.content || item.step || item.title || item.task || item.text);
      if (!content) return null;
      return {
        [contentKey]: content,
        status: compactText(item.status || 'pending') || 'pending'
      };
    })
    .filter(Boolean);
}

function renderChecklistBlock(block) {
  if (block.kind === 'todo') {
    return renderToolBlock('TodoWrite', safeJsonStringify({
      todos: normalizeChecklistItems(block.items, 'content')
    }), block.result);
  }
  return renderToolBlock('update_plan', safeJsonStringify({
    explanation: compactText(block.explanation),
    plan: normalizeChecklistItems(block.items, 'step')
  }), block.result);
}

function renderProviderBlocksToLegacyContent(blocks) {
  const parts = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      const text = compactText(block.text);
      if (text) parts.push(text);
    } else if (block.type === 'reasoning') {
      const text = compactText([
        block.title ? `## ${block.title}` : '',
        block.text
      ].filter(Boolean).join('\n\n'));
      if (text) parts.push(`:::thinking\n${text}\n:::`);
    } else if (block.type === 'hidden_reasoning') {
      parts.push(':::thinking\nReasoning hidden by provider.\n:::');
    } else if (block.type === 'tool_call') {
      parts.push(renderToolBlock(block.name, typeof block.args === 'string' ? block.args : safeJsonStringify(block.args), block.result));
    } else if (block.type === 'tool_result') {
      parts.push(renderToolBlock(block.name || 'ToolResult', block.body || '', block.text || block.result));
    } else if (block.type === 'checklist') {
      parts.push(renderChecklistBlock(block));
    } else if (block.type === 'plan_text') {
      parts.push(renderTagBlock('proposed_plan', block.text));
    } else if (block.type === 'question') {
      parts.push(renderToolBlock('request_user_input', safeJsonStringify({ questions: block.questions || [] }), block.result));
    } else if (block.type === 'task_event') {
      parts.push(renderTagBlock('task-notification', safeJsonStringify(block.detail || { status: block.status, summary: block.name })));
    } else if (block.type === 'system_event') {
      parts.push(renderTagBlock(block.name || 'system-event', block.text || safeJsonStringify(block.detail || {})));
    } else if (block.type === 'error') {
      const text = compactText(block.text || block.error);
      if (text) parts.push(`Error: ${text}`);
    }
  }
  return parts.filter(Boolean).join('\n\n').trim();
}

function pushRenderedMessage(messages, role, blocks, timestamp, images = []) {
  const content = renderProviderBlocksToLegacyContent(blocks);
  const normalizedImages = Array.isArray(images) ? images.map(compactText).filter(Boolean) : [];
  if (!content && normalizedImages.length === 0) return;
  const message = { role, content, timestamp };
  if (normalizedImages.length > 0) message.images = normalizedImages;
  messages.push(message);
}

function readJsonlRecords(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(safeJsonParse)
    .filter(Boolean);
}

function normalizeGeminiTextContent(content) {
  if (typeof content === 'string') return compactText(content);
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      if (item.text) return item.text;
      if (item.inlineData) return '[Image]';
      if (item.fileData && item.fileData.fileUri) return `[File: ${item.fileData.fileUri}]`;
      return '';
    })
    .map(compactText)
    .filter(Boolean)
    .join('\n')
    .trim();
}

function normalizeGeminiToolResult(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return '';
  if (toolCall.resultDisplay) return compactText(toolCall.resultDisplay);
  const result = toolCall.result;
  if (!result) return '';
  if (typeof result === 'string') return compactText(result);
  if (Array.isArray(result)) {
    return compactText(result.map((item) => {
      if (typeof item === 'string') return item;
      return safeJsonStringify(item);
    }).join('\n'));
  }
  return safeJsonStringify(result);
}

function geminiRecordToBlocks(record) {
  const blocks = [];
  if (Array.isArray(record.thoughts)) {
    record.thoughts.forEach((thought) => {
      const text = compactText(thought && thought.description);
      if (!text) return;
      blocks.push({
        type: 'reasoning',
        title: compactText(thought.subject),
        text
      });
    });
  }
  const text = normalizeGeminiTextContent(record.content);
  if (text) blocks.push({ type: 'text', role: 'assistant', text });
  if (Array.isArray(record.toolCalls)) {
    record.toolCalls.forEach((toolCall) => {
      if (!toolCall || typeof toolCall !== 'object') return;
      blocks.push({
        type: 'tool_call',
        id: compactText(toolCall.id),
        name: compactText(toolCall.name || toolCall.displayName || 'GeminiTool'),
        args: toolCall.args || {},
        result: normalizeGeminiToolResult(toolCall)
      });
    });
  }
  return blocks;
}

function readGeminiJsonlSessionMessages(filePath) {
  const messages = [];
  for (const record of readJsonlRecords(filePath)) {
    if (record.type === 'user') {
      const text = normalizeGeminiTextContent(record.content);
      if (text) messages.push({ role: 'user', content: text, timestamp: record.timestamp });
      continue;
    }
    if (record.type === 'gemini') {
      pushRenderedMessage(messages, 'assistant', geminiRecordToBlocks(record), record.timestamp);
    }
  }
  return messages;
}

function readGeminiJsonSessionMessages(filePath) {
  const data = safeJsonParse(fs.readFileSync(filePath, 'utf8'));
  const messages = [];
  for (const record of Array.isArray(data && data.messages) ? data.messages : []) {
    if (record.type === 'user') {
      const text = normalizeGeminiTextContent(record.content);
      if (text) messages.push({ role: 'user', content: text, timestamp: record.timestamp });
      continue;
    }
    if (record.type === 'gemini') {
      pushRenderedMessage(messages, 'assistant', geminiRecordToBlocks(record), record.timestamp);
    }
  }
  return messages;
}

function readGeminiSessionMessagesFromFile(filePath) {
  if (String(filePath || '').endsWith('.jsonl')) return readGeminiJsonlSessionMessages(filePath);
  return readGeminiJsonSessionMessages(filePath);
}

function extractAgyUserContent(content) {
  const text = compactText(content);
  const match = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  return compactText(match && match[1] ? match[1] : text);
}

function extractAgyFilePath(content) {
  const text = String(content || '');
  const match = text.match(/File Path:\s*`file:\/\/([^`]+)`/i) || text.match(/File Path:\s*([^\n]+)/i);
  return compactText(match && match[1] ? match[1] : '');
}

function normalizeAgyArgs(args) {
  if (!args || typeof args !== 'object') return {};
  return Object.fromEntries(Object.entries(args).map(([key, value]) => {
    if (typeof value !== 'string') return [key, value];
    const trimmed = value.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return [key, trimmed.slice(1, -1)];
    }
    return [key, value];
  }));
}

function agyExecutionRecordToBlock(record) {
  const content = compactText(record.content || record.error);
  if (!content) return null;
  if (record.type === 'RUN_COMMAND') return { type: 'tool_result', name: 'Terminal', text: content };
  if (record.type === 'VIEW_FILE') return { type: 'tool_result', name: 'Read', body: extractAgyFilePath(content), text: content };
  if (record.type === 'GREP_SEARCH') return { type: 'tool_result', name: 'Grep', text: content };
  if (record.type === 'LIST_DIRECTORY') return { type: 'tool_result', name: 'Read', text: content };
  if (record.type === 'CODE_ACTION') return { type: 'tool_result', name: 'Edit', text: content };
  return null;
}

function readAgySessionMessagesFromFile(filePath) {
  const messages = [];
  let assistantBlocks = [];
  let assistantTimestamp = '';

  const flushAssistant = () => {
    if (assistantBlocks.length === 0) return;
    pushRenderedMessage(messages, 'assistant', assistantBlocks, assistantTimestamp);
    assistantBlocks = [];
    assistantTimestamp = '';
  };

  for (const record of readJsonlRecords(filePath)) {
    if (record.type === 'USER_INPUT') {
      flushAssistant();
      const content = extractAgyUserContent(record.content);
      if (content) messages.push({ role: 'user', content, timestamp: record.created_at });
      continue;
    }

    if (!assistantTimestamp && record.created_at) assistantTimestamp = record.created_at;

    if (record.type === 'PLANNER_RESPONSE') {
      if (compactText(record.content)) {
        assistantBlocks.push({ type: 'text', role: 'assistant', text: record.content });
      }
      if (Array.isArray(record.tool_calls)) {
        record.tool_calls.forEach((toolCall) => {
          if (!toolCall || typeof toolCall !== 'object') return;
          assistantBlocks.push({
            type: 'tool_call',
            name: compactText(toolCall.name || 'AGYTool'),
            args: normalizeAgyArgs(toolCall.args || {})
          });
        });
      }
      continue;
    }

    const executionBlock = agyExecutionRecordToBlock(record);
    if (executionBlock) {
      assistantBlocks.push(executionBlock);
      continue;
    }

    if (record.type === 'CHECKPOINT') {
      assistantBlocks.push({
        type: 'system_event',
        name: 'checkpoint',
        text: record.content
      });
      continue;
    }

    if (record.type === 'ERROR_MESSAGE') {
      assistantBlocks.push({ type: 'error', text: record.error || record.content });
      continue;
    }

    if ((record.type === 'GENERIC' || record.type === 'SYSTEM_MESSAGE') && compactText(record.content)) {
      assistantBlocks.push({
        type: 'system_event',
        name: record.type.toLowerCase(),
        text: record.content
      });
    }
  }

  flushAssistant();
  return messages;
}

module.exports = {
  readAgySessionMessagesFromFile,
  readGeminiSessionMessagesFromFile,
  renderProviderBlocksToLegacyContent
};
