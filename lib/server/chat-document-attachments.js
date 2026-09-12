'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const limits = require('../../contracts/chat-attachments.json');
const { resolveProviderAttachmentRootDir } = require('./chat-attachments');
const { ensureDirSync } = require('./fs-compat');
const {
  normalizeDocumentBatch: normalizeSharedDocumentBatch
} = require('./chat-attachment-validation');
const {
  atomicWriteFileSync,
  cleanupPersistedAttachments
} = require('./chat-attachment-filesystem');

function invalid(message) {
  return Object.assign(new Error(message), { code: 'invalid_chat_documents', statusCode: 400 });
}

function normalizeChatDocuments(documents = []) {
  try {
    return normalizeSharedDocumentBatch(documents, { allowEmpty: true })
      .map(({ kind, size, ...document }) => document);
  } catch (error) {
    throw invalid(error.message);
  }
}

function documentFromUpload(upload) {
  try {
    const { normalizeChatUpload } = require('./chat-attachment-validation');
    const normalized = normalizeChatUpload(upload);
    return {
      name: normalized.name,
      mimeType: normalized.mimeType,
      text: normalized.text
    };
  } catch (error) {
    throw invalid(error.message);
  }
}

function persistChatDocuments(documents, options) {
  const normalized = normalizeChatDocuments(documents);
  if (!normalized.length) return [];
  const root = resolveProviderAttachmentRootDir(options.fs, options);
  ensureDirSync(options.fs, root);
  const filePaths = [];
  try {
    normalized.forEach((document) => {
      // Preserve readable names without letting uploaded paths escape the attachment root.
      let safeName = document.name.replace(/[/\\\x00-\x1f]/g, '_').slice(-160) || 'document.txt';
      if (!limits.textExtensions.includes(path.extname(safeName).slice(1).toLowerCase())) safeName += '.txt';
      const filePath = path.join(root, `${crypto.randomUUID()}-${safeName}`);
      atomicWriteFileSync(options.fs, filePath, document.text, { encoding: 'utf8', mode: 0o600 });
      filePaths.push(filePath);
    });
    return filePaths;
  } catch (error) {
    cleanupPersistedAttachments(options.fs, filePaths);
    throw error;
  }
}

function appendDocumentPathsToPrompt(prompt, paths) {
  if (!paths.length) return prompt;
  return [prompt, 'Attached document files:', ...paths.map((file) => `- ${file}`),
    'Read these local document files when answering.'].filter(Boolean).join('\n');
}

const DOCUMENT_BLOCK_FOOTER = '（附件结束）';

// 所有 chat 文档文本的唯一漏斗(内联 prompt、harness 历史注入、opencode 代理都经此),
// 因此内嵌 base64 的剥离放在这里一次覆盖三条路径。
// 剥离披露语紧跟标题行:既让模型读正文前就知道图片载荷不可见,也让它在
// 后续 token 预算截断(只截正文)中存活下来。
function formatChatDocumentBlock(name, text) {
  const { elideDataUris, elisionNotice } = require('./chat-document-data-uri');
  const { text: body, count, savedChars } = elideDataUris(text);
  return [`附件 ${JSON.stringify(name)}：`, elisionNotice(count, savedChars), body, DOCUMENT_BLOCK_FOOTER]
    .filter(Boolean).join('\n');
}

// 信封由本模块定义,也只在本模块拆解。截断必须保住结尾标记:掐掉它会让模型
// 收到一个未闭合的附件块;字符数也必须只描述正文,不能把标题行算作附件内容。
function truncateChatDocumentBlock(block, allowedBodyChars) {
  const text = String(block);
  const footer = `\n${DOCUMENT_BLOCK_FOOTER}`;
  const hasFooter = text.endsWith(footer);
  const inner = hasFooter ? text.slice(0, -footer.length) : text;
  const breakAt = inner.indexOf('\n');
  const header = breakAt >= 0 ? inner.slice(0, breakAt + 1) : '';
  const body = breakAt >= 0 ? inner.slice(breakAt + 1) : inner;
  const keep = Math.max(0, Math.min(body.length, Math.floor(allowedBodyChars)));
  if (keep >= body.length) return text;
  return `${header}${body.slice(0, keep)}\n（本附件超出本轮上下文预算，已装载前 ${keep} 字符，`
    + `其余 ${body.length - keep} 字符未装载——请据此回答，不要假设你已看过全文。）`
    + (hasFooter ? footer : '');
}

function appendDocumentText(prompt, documents) {
  return [String(prompt || '').trim(), ...documents.map(({ name, text }) => (
    formatChatDocumentBlock(name, text)
  ))].filter(Boolean).join('\n\n');
}

module.exports = { DOCUMENT_BLOCK_FOOTER, normalizeChatDocuments, documentFromUpload, persistChatDocuments, appendDocumentPathsToPrompt, appendDocumentText, formatChatDocumentBlock, truncateChatDocumentBlock };
