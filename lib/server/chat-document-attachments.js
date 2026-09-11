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

function formatChatDocumentBlock(name, text) {
  return `附件 ${JSON.stringify(name)}：\n${text}\n（附件结束）`;
}

function appendDocumentText(prompt, documents) {
  return [String(prompt || '').trim(), ...documents.map(({ name, text }) => (
    formatChatDocumentBlock(name, text)
  ))].filter(Boolean).join('\n\n');
}

module.exports = { normalizeChatDocuments, documentFromUpload, persistChatDocuments, appendDocumentPathsToPrompt, appendDocumentText, formatChatDocumentBlock };
