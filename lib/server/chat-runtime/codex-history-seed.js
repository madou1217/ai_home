'use strict';

const fs = require('node:fs');
const { ChatRuntimeError } = require('./contracts');
const { readCodexHistoryResponse } = require('./codex-session-history');
const { budgetHistoryItems } = require('./chat-harness-policy');
const { guessAttachmentMimeType } = require('../chat-attachments');

async function readCodexHistorySeed(client, threadId, options = {}) {
  const response = await readCodexHistoryResponse(client, threadId);
  // Injected branch seeds need not appear in typed turns. Keep AIH's immutable
  // seed alongside native turns, deduplicating only explicit item identities.
  const items = [...(options.initialHistory || [])];
  const ids = new Set(items.map((item) => item.id).filter(Boolean));
  for (const turn of response.thread.turns) {
    if (turn.id === options.excludeTurnId) continue;
    for (const item of turn.items) {
      if (ids.has(item.id)) continue;
      items.push(await responseItem(item, options));
      ids.add(item.id);
    }
  }
  return budgetHistoryItems(items, options.contextWindow, options.percent).items;
}

async function responseItem(item, options) {
  if (item.type === 'agentMessage' && typeof item.text === 'string') {
    return { id: item.id, type: 'message', role: 'assistant',
      ...(item.phase ? { phase: item.phase } : {}),
      content: [{ type: 'output_text', text: item.text }] };
  }
  if (item.type === 'userMessage' && Array.isArray(item.content)) {
    return { id: item.id, type: 'message', role: 'user', content: item.content.map(inputItem) };
  }
  if (item.type === 'reasoning' && options.readNativeItem) {
    const raw = await options.readNativeItem(item.id);
    if (raw?.type === 'reasoning' && raw.id === item.id) return raw;
  }
  // Never replace a missing tool/result, encrypted reasoning, compaction or
  // unknown multimodal shape with an empty history and silently retry.
  throw new ChatRuntimeError('codex_history_seed_unsupported', 422, { itemType: item.type, itemId: item.id });
}

function inputItem(input) {
  if (input.type === 'text' && typeof input.text === 'string') return { type: 'input_text', text: input.text };
  const detail = input.detail ? { detail: input.detail } : {};
  if (input.type === 'image' && typeof input.url === 'string') return { type: 'input_image', image_url: input.url, ...detail };
  if (input.type === 'localImage' && typeof input.path === 'string') {
    const mime = guessAttachmentMimeType(input.path);
    if (mime) return { type: 'input_image', image_url: `data:${mime};base64,${fs.readFileSync(input.path).toString('base64')}`, ...detail };
  }
  throw new ChatRuntimeError('codex_history_seed_input_unsupported', 422, { inputType: input.type });
}

module.exports = { readCodexHistorySeed };
