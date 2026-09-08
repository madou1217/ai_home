'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const limits = require('../../contracts/chat-attachments.json');
const { resolveProviderAttachmentRootDir } = require('./chat-attachments');
const { ensureDirSync } = require('./fs-compat');

function invalid(message) {
  return Object.assign(new Error(message), { code: 'invalid_chat_documents', statusCode: 400 });
}

function normalizeChatDocuments(documents = []) {
  if (!Array.isArray(documents) || documents.length > limits.maxFiles) throw invalid('每次最多附加 8 个文件');
  return documents.map((document) => {
    const name = String(document && document.name || '').trim();
    const mimeType = String(document && document.mimeType || '').toLowerCase();
    const extension = path.extname(name).slice(1).toLowerCase();
    const text = document && document.text;
    if (!name || typeof text !== 'string'
        || (!mimeType.startsWith('text/') && !limits.textExtensions.includes(extension))) {
      throw invalid('请上传 Markdown、文本、代码或文本数据文件');
    }
    if (Buffer.byteLength(text, 'utf8') > limits.maxDocumentBytes) throw invalid(`${name}：文本文件不能超过 1 MB`);
    if (/[\x00-\x08\x0e-\x1f]/.test(text)) throw invalid(`${name}：文件包含二进制内容`);
    return { name, mimeType: extension === 'md' || extension === 'markdown' ? 'text/markdown' : 'text/plain', text };
  });
}

function documentFromUpload(upload) {
  const match = String(upload && upload.dataUrl || '').match(/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/);
  if (!match || match[1] !== upload.mimeType || match[2].length > Math.ceil(limits.maxDocumentBytes / 3) * 4) {
    throw invalid('文本附件编码或大小无效');
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(match[2], 'base64')); }
  catch { throw invalid('请使用 UTF-8 编码的文本文件'); }
  return normalizeChatDocuments([{ ...upload, text }])[0];
}

function persistChatDocuments(documents, options) {
  const normalized = normalizeChatDocuments(documents);
  if (!normalized.length) return [];
  const root = resolveProviderAttachmentRootDir(options.fs, options);
  ensureDirSync(options.fs, root);
  return normalized.map((document) => {
    // Preserve readable names without letting uploaded paths escape the attachment root.
    let safeName = document.name.replace(/[/\\\x00-\x1f]/g, '_').slice(-160) || 'document.txt';
    if (!limits.textExtensions.includes(path.extname(safeName).slice(1).toLowerCase())) safeName += '.txt';
    const filePath = path.join(root, `${crypto.randomUUID()}-${safeName}`);
    options.fs.writeFileSync(filePath, document.text, { encoding: 'utf8', mode: 0o600 });
    return filePath;
  });
}

function appendDocumentPathsToPrompt(prompt, paths) {
  if (!paths.length) return prompt;
  return [prompt, 'Attached document files:', ...paths.map((file) => `- ${file}`),
    'Read these local document files when answering.'].filter(Boolean).join('\n');
}

function appendDocumentText(prompt, documents) {
  return [String(prompt || '').trim(), ...documents.map(({ name, text }) => (
    `附件 ${JSON.stringify(name)}：\n${text}\n（附件结束）`
  ))].filter(Boolean).join('\n\n');
}

module.exports = { normalizeChatDocuments, documentFromUpload, persistChatDocuments, appendDocumentPathsToPrompt, appendDocumentText };
