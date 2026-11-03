'use strict';

const { persistChatImages } = require('./chat-attachments');
const { parseBase64DataUrl, assertAttachmentSize, ATTACHMENT_KINDS } = require('./chat-attachment-validation');
const { detectImageMime, normalizeImageMime } = require('./image-data');

function persistTerminalClipboardImage(dataUrl, cwd, fs) {
  const parsed = parseBase64DataUrl(dataUrl);
  assertAttachmentSize('图片', ATTACHMENT_KINDS.IMAGE, parsed.buffer.length);
  const declared = normalizeImageMime(parsed.mimeType);
  const actual = detectImageMime(parsed.buffer);
  if (!declared || !actual || declared !== actual) {
    const error = new Error('图片格式与内容不匹配');
    error.code = 'terminal_image_invalid';
    throw error;
  }
  const paths = persistChatImages([dataUrl], { fs, projectPath: cwd });
  const filePath = String(paths[0] || '').trim();
  if (!filePath) throw new Error('terminal_image_persist_failed');
  return filePath;
}

function formatTerminalClipboardPath(filePath, platform = process.platform) {
  const value = String(filePath || '');
  if (platform === 'win32') return /[\s&()\[\]{}^=;!'+,`~]/.test(value) ? `"${value}"` : value;
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

module.exports = { persistTerminalClipboardImage, formatTerminalClipboardPath };
