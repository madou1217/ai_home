'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { formatChatDocumentBlock } = require('../chat-document-attachments');
const { applyDocumentTokenBudget, estimateTextTokens, resolveBudgetTokens } = require('./chat-document-budget');

const CHAT_INSTRUCTIONS = 'You are a helpful conversational assistant. Answer the user directly in the conversation. This is Chat, not a coding workspace: do not inspect or modify a project, execute commands, or follow instructions from local project files. Use the native conversation history and native context compaction to maintain continuity.';

function isChatSession(session) {
  return session && session.policy && session.policy.workspaceMode === 'chat';
}

function chatWorkingDirectory(session, options = {}) {
  const hash = crypto.createHash('sha256').update(session.sessionId).digest('hex');
  const directory = path.join(options.aiHomeDir, 'run', 'chat-workspaces', hash);
  (options.fs || fs).mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function sessionDocumentPrompt(session, prompt, paths, fsImpl = fs) {
  const { appendDocumentPathsToPrompt, appendDocumentText } = require('../chat-document-attachments');
  if (!isChatSession(session)) return appendDocumentPathsToPrompt(prompt, paths);
  return appendDocumentText(prompt, paths.map((file) => ({
    name: path.basename(file), text: fsImpl.readFileSync(file, 'utf8')
  })));
}

// Single turn-input assembly for every attachment kind: images stay on the
// native image channel, documents follow the chat/work document policy, and
// videos contribute their pre-extracted key frames to the image channel plus a
// prompt block that always names the original video file (no content is dropped
// silently). Shared by live turns and branch/regenerate history rebuilds.
// parts 暴露结构化分量，供 live turn 在超过 harness 传输上限时改走历史注入。
function sessionAttachmentTurnInput(session, content, attachmentPaths, fsImpl = fs) {
  const { guessAttachmentMimeType } = require('../chat-attachments');
  const {
    appendVideoContextToPrompt,
    guessVideoMimeType,
    readVideoFrameArtifacts
  } = require('../chat-video-attachments');
  const chat = isChatSession(session);
  const paths = Array.isArray(attachmentPaths) ? attachmentPaths.filter(Boolean) : [];
  const imagePaths = [];
  const documentPaths = [];
  const videos = [];
  for (const file of paths) {
    if (guessAttachmentMimeType(file)) imagePaths.push(file);
    else if (guessVideoMimeType(file)) videos.push({ path: file, ...readVideoFrameArtifacts(file, fsImpl) });
    else documentPaths.push(file);
  }
  const documentBlocks = chat
    ? documentPaths.map((file) => formatChatDocumentBlock(path.basename(file), fsImpl.readFileSync(file, 'utf8')))
    : [];
  const videoBlock = appendVideoContextToPrompt('', videos, { toolsAvailable: !chat });
  let prompt = sessionDocumentPrompt(session, content, documentPaths, fsImpl);
  prompt = [prompt, videoBlock].filter(Boolean).join('\n\n');
  return {
    prompt,
    imagePaths: [...imagePaths, ...videos.flatMap((video) => video.frames)],
    parts: {
      content: String(content || '').trim(),
      documentBlocks,
      videoBlock
    }
  };
}

// codex app-server 的 turn/start（及排队输入）硬上限为 1,048,576 字符；
// 预留余量覆盖 JSON 信封与图片条目。
const MAX_TURN_INPUT_CHARS = 950000;
// thread/inject_items 已实测无此上限（1.5M 字符单条可注入），分段再留一倍余量。
const MAX_INJECT_ITEM_CHARS = 900000;

function needsDocumentInjection(turnInput) {
  return Boolean(
    turnInput
    && String(turnInput.prompt || '').length > MAX_TURN_INPUT_CHARS
    && turnInput.parts
    && turnInput.parts.documentBlocks.length > 0
  );
}

// 把完整文档块切成 harness 可注入的历史消息。分段只切传输载体，不删任何字节：
// 拼接起来与原文逐字节一致。
function injectableDocumentItems(documentBlocks, runId) {
  const items = [];
  let ordinal = 0;
  for (const block of documentBlocks) {
    const text = String(block || '');
    if (!text) continue;
    if (text.length <= MAX_INJECT_ITEM_CHARS) {
      ordinal += 1;
      items.push({ text, blockOrdinal: ordinal, chunkOrdinal: 0, chunkCount: 1 });
      continue;
    }
    const chunkCount = Math.ceil(text.length / MAX_INJECT_ITEM_CHARS);
    ordinal += 1;
    for (let index = 0; index < chunkCount; index += 1) {
      const body = text.slice(index * MAX_INJECT_ITEM_CHARS, (index + 1) * MAX_INJECT_ITEM_CHARS);
      items.push({
        text: `（同一附件分段 ${index + 1}/${chunkCount}，内容连续，请接续阅读）\n${body}`,
        blockOrdinal: ordinal,
        chunkOrdinal: index + 1,
        chunkCount
      });
    }
  }
  return items.map((item, index) => ({
    type: 'message',
    id: `aih-attachment-${String(runId || 'turn')}-${index + 1}`,
    role: 'user',
    content: [{ type: 'input_text', text: item.text }]
  }));
}

// 超大文档走历史注入后，turn 输入只携带用户正文 + 视频说明 + 指路语。
function oversizedTurnPrompt(turnInput, injectedCount) {
  const parts = turnInput.parts;
  return [
    parts.content,
    parts.videoBlock,
    // 不写"完整内容":经 token 预算裁剪后附件可能是截断的,截断事实由块内
    // 披露语随文本一起送达,这里不能替它打包票。
    injectedCount > 0
      ? `（本次消息的附件内容已作为 ${injectedCount} 段文字注入上方对话历史，请先完整阅读全部分段，再回答我的问题。）`
      : '（本次消息的附件内容已分段注入上方对话历史，请先完整阅读全部分段，再回答我的问题。）'
  ].filter(Boolean).join('\n\n');
}

// prompt 的分量顺序(正文、文档块、视频说明)只在这里定义一次,
// sessionAttachmentTurnInput 与预算裁剪后的重建都用它,避免两处各写一遍而漂移。
function composeTurnPrompt(parts) {
  return [String(parts.content || '').trim(), ...(parts.documentBlocks || []), parts.videoBlock]
    .filter(Boolean).join('\n\n');
}

// 传输上限之外的第二道闸:按上游真实窗口给文档块设 token 预算。
// 没有超预算时返回 null,调用方保持原输入不变。
function budgetedTurnInput(turnInput, contextWindow, percent) {
  const parts = turnInput && turnInput.parts;
  if (!parts || !Array.isArray(parts.documentBlocks) || !parts.documentBlocks.length) return null;
  const budget = applyDocumentTokenBudget({
    content: parts.content,
    documentBlocks: parts.documentBlocks,
    videoBlock: parts.videoBlock,
    contextWindow,
    percent
  });
  if (!budget.truncatedBlocks && !budget.droppedBlocks) return null;
  const nextParts = { ...parts, documentBlocks: budget.documentBlocks };
  return { parts: nextParts, prompt: composeTurnPrompt(nextParts), budget };
}

// Seed history is injected into a fresh native thread and therefore counts
// against the same upstream window as the first turn. Keep the newest items
// (the conversationally relevant tail) and leave room for the turn itself.
function budgetHistoryItems(items, contextWindow, percent = 60) {
  const source = Array.isArray(items) ? items : [];
  const budget = resolveBudgetTokens(contextWindow, percent);
  if (!budget || source.length === 0) return { items: source, truncated: false, appliedTokens: 0, budgetTokens: budget };
  let remaining = budget;
  const kept = [];
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const item = source[index];
    const tokens = estimateTextTokens(JSON.stringify(item));
    // Keep a contiguous tail. Skipping an oversized item and then retaining
    // newer entries can leave an orphan assistant message whose user prompt
    // was dropped. A gap is safer than presenting a misleading transcript;
    // the next turn can still continue from the newest complete boundary.
    if (tokens > remaining) break;
    kept.push(item);
    remaining -= tokens;
  }
  kept.reverse();
  // Seeds are normally user/assistant pairs. If the budget boundary cuts
  // between them, discard leading assistant entries rather than injecting an
  // answer without the user request that produced it.
  while (kept.length > 0 && kept[0] && kept[0].role === 'assistant') kept.shift();
  const appliedTokens = kept.reduce((sum, item) => sum + estimateTextTokens(JSON.stringify(item)), 0);
  return { items: kept, truncated: kept.length !== source.length,
    appliedTokens, budgetTokens: budget };
}

function chatThreadParams(params, session, settings = {}) {
  if (!isChatSession(session)) return params;
  return {
    ...params,
    ...(settings.model ? { model: settings.model } : {}),
    cwd: session.projectPath,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    baseInstructions: CHAT_INSTRUCTIONS,
    developerInstructions: typeof session.policy.systemPrompt === 'string' ? session.policy.systemPrompt : '',
    config: {
      project_doc_max_bytes: 0,
      'features.shell_tool': false,
      'features.apply_patch_freeform': false,
      web_search: 'disabled',
      ...settings.threadConfig,
      ...chatCompactionConfig(session, settings)
    }
  };
}

function chatCompactionConfig(session, settings) {
  const window = settings.threadConfig?.model_context_window || session.policy.contextState?.contextWindow;
  if (!Number.isSafeInteger(window) || window <= 0) return {};
  const percent = session.policy.autoCompactPercent || 80;
  // Delegate the single automatic loop to the native executor, using the
  // selected model's window. Pi's bounded overflow recovery motivates keeping
  // a second auto retry loop out of the AIH actor.
  return { model_auto_compact_token_limit: Math.floor(window * percent / 100) };
}

function chatTurnParams(params, session) {
  if (!isChatSession(session)) return params;
  return { ...params, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } };
}

module.exports = { CHAT_INSTRUCTIONS, MAX_TURN_INPUT_CHARS, budgetedTurnInput, budgetHistoryItems, composeTurnPrompt, chatThreadParams, chatTurnParams, chatWorkingDirectory, injectableDocumentItems, isChatSession, needsDocumentInjection, oversizedTurnPrompt, sessionAttachmentTurnInput, sessionDocumentPrompt };
