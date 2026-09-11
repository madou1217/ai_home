'use strict';

const path = require('node:path');
const { TextDecoder } = require('node:util');
const limits = require('../../contracts/chat-attachments.json');

const ATTACHMENT_KINDS = Object.freeze({
  DOCUMENT: 'document',
  IMAGE: 'image',
  VIDEO: 'video'
});

function createAttachmentValidationError(code, message, details) {
  const error = new Error(message || code);
  error.code = code;
  error.statusCode = 422;
  if (details !== undefined) error.details = details;
  return error;
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function attachmentExtension(name) {
  return path.extname(normalizeString(name)).slice(1).toLowerCase();
}

function resolveChatAttachmentKind(name, mimeType) {
  const mime = normalizeString(mimeType).toLowerCase();
  const extension = attachmentExtension(name);
  if (limits.imageTypes.includes(mime)) return ATTACHMENT_KINDS.IMAGE;
  if (limits.videoTypes.includes(mime)) return ATTACHMENT_KINDS.VIDEO;
  if (mime.startsWith('text/') || limits.textExtensions.includes(extension)) {
    return ATTACHMENT_KINDS.DOCUMENT;
  }
  if (limits.videoExtensionTypes[extension]
      && (!mime || mime === 'application/octet-stream')) {
    return ATTACHMENT_KINDS.VIDEO;
  }
  return '';
}

function imageMimeTypeFromPath(filePath) {
  const extension = attachmentExtension(filePath);
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'gif') return 'image/gif';
  return '';
}

function isSupportedImageMimeType(mimeType) {
  return limits.imageTypes.includes(normalizeString(mimeType).toLowerCase());
}

function videoMimeTypeFromPath(filePath) {
  return limits.videoExtensionTypes[attachmentExtension(filePath)] || '';
}

function attachmentMimeTypeFromPath(filePath) {
  return imageMimeTypeFromPath(filePath) || videoMimeTypeFromPath(filePath);
}

function parseBase64DataUrl(dataUrl) {
  const match = normalizeString(dataUrl).match(/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/i);
  if (!match || match[2].length % 4 === 1) {
    throw createAttachmentValidationError('chat_attachment_data_invalid', '附件编码无效');
  }
  const mimeType = normalizeString(match[1]).toLowerCase();
  const base64 = match[2];
  const buffer = Buffer.from(base64, 'base64');
  const canonical = buffer.toString('base64').replace(/=+$/, '');
  if (canonical !== base64.replace(/=+$/, '')) {
    throw createAttachmentValidationError('chat_attachment_data_invalid', '附件编码无效');
  }
  return { mimeType, buffer };
}

function normalizeChatDocument(document) {
  const name = normalizeString(document && document.name);
  const declaredMimeType = normalizeString(document && document.mimeType).toLowerCase();
  const text = document && document.text;
  if (!name || typeof text !== 'string'
      || resolveChatAttachmentKind(name, declaredMimeType) !== ATTACHMENT_KINDS.DOCUMENT) {
    throw createAttachmentValidationError(
      'chat_attachment_mime_unsupported',
      '请上传 Markdown、文本、代码或文本数据文件',
      { mimeType: declaredMimeType }
    );
  }
  const size = Buffer.byteLength(text, 'utf8');
  assertAttachmentSize(name, ATTACHMENT_KINDS.DOCUMENT, size, { allowEmpty: true });
  if (/[\x00-\x08\x0e-\x1f]/.test(text)) {
    throw createAttachmentValidationError('chat_attachment_binary_text', `${name}：文件包含二进制内容`);
  }
  const extension = attachmentExtension(name);
  return {
    kind: ATTACHMENT_KINDS.DOCUMENT,
    name,
    mimeType: extension === 'md' || extension === 'markdown' ? 'text/markdown' : 'text/plain',
    text,
    size
  };
}

function normalizeChatUpload(upload) {
  const name = normalizeString(upload && upload.name);
  const declaredMimeType = normalizeString(upload && upload.mimeType).toLowerCase();
  if (!name) {
    throw createAttachmentValidationError('chat_attachment_name_required', '附件名称不能为空');
  }
  const kind = resolveChatAttachmentKind(name, declaredMimeType);
  if (!kind) {
    throw createAttachmentValidationError(
      'chat_attachment_mime_unsupported',
      `${name}：支持图片、视频、Markdown、文本、代码及 JSON/CSV 等文本数据文件`,
      { mimeType: declaredMimeType }
    );
  }
  const parsed = parseBase64DataUrl(upload && upload.dataUrl);
  if (kind === ATTACHMENT_KINDS.DOCUMENT) {
    const documentMimeType = declaredMimeType || parsed.mimeType;
    if (parsed.mimeType !== documentMimeType
        && !(declaredMimeType === 'application/octet-stream' && parsed.mimeType.startsWith('text/'))) {
      throw createAttachmentValidationError('chat_attachment_data_invalid', `${name}：文本附件编码无效`);
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(parsed.buffer);
    } catch (_error) {
      throw createAttachmentValidationError('chat_attachment_encoding_invalid', `${name}：请使用 UTF-8 编码的文本文件`);
    }
    const document = normalizeChatDocument({ name, mimeType: documentMimeType, text });
    return { ...document, dataUrl: normalizeString(upload.dataUrl), buffer: parsed.buffer };
  }
  const extensionMimeType = kind === ATTACHMENT_KINDS.VIDEO
    ? limits.videoExtensionTypes[attachmentExtension(name)] || ''
    : '';
  const mimeType = declaredMimeType && declaredMimeType !== 'application/octet-stream'
    ? declaredMimeType
    : extensionMimeType;
  if (!mimeType || (parsed.mimeType !== mimeType
      && !(declaredMimeType === 'application/octet-stream' && parsed.mimeType === mimeType))) {
    throw createAttachmentValidationError('chat_attachment_data_invalid', `${name}：附件 MIME 与编码不一致`);
  }
  assertAttachmentSize(name, kind, parsed.buffer.length);
  return {
    kind,
    name,
    mimeType,
    dataUrl: normalizeString(upload.dataUrl),
    buffer: parsed.buffer,
    size: parsed.buffer.length
  };
}

function normalizeLegacyChatAttachments(input = {}) {
  const documentInputs = Array.isArray(input.documents) ? input.documents : [];
  const imageInputs = Array.isArray(input.images) ? input.images : [];
  if (documentInputs.length + imageInputs.length === 0) return [];
  if (documentInputs.length + imageInputs.length > limits.maxFiles) {
    throw createAttachmentValidationError('chat_attachment_limit_exceeded', `每次最多附加 ${limits.maxFiles} 个文件`, {
      limit: limits.maxFiles
    });
  }
  const documents = normalizeDocumentBatch(documentInputs, { allowEmpty: true });
  const uploads = imageInputs.map((dataUrl, index) => {
    const parsed = parseBase64DataUrl(dataUrl);
    const kind = resolveChatAttachmentKind('', parsed.mimeType);
    if (kind !== ATTACHMENT_KINDS.IMAGE && kind !== ATTACHMENT_KINDS.VIDEO) {
      throw createAttachmentValidationError(
        'chat_attachment_mime_unsupported',
        '请上传受支持的图片或视频',
        { mimeType: parsed.mimeType }
      );
    }
    const extension = extensionForMimeType(parsed.mimeType, kind);
    const name = kind === ATTACHMENT_KINDS.VIDEO
      ? `video-${index + 1}.${extension}`
      : `image-${index + 1}.${extension}`;
    assertAttachmentSize(name, kind, parsed.buffer.length);
    return {
      kind,
      name,
      mimeType: parsed.mimeType,
      dataUrl: normalizeString(dataUrl),
      buffer: parsed.buffer,
      size: parsed.buffer.length
    };
  });
  return assertAttachmentBatch([...documents, ...uploads]);
}

function normalizeChatUploadBatch(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw createAttachmentValidationError('chat_attachments_required', '请至少附加一个文件');
  }
  return assertAttachmentBatch(value.map(normalizeChatUpload));
}

function normalizeDocumentBatch(value, options = {}) {
  if (!Array.isArray(value)) {
    throw createAttachmentValidationError('chat_attachments_invalid', '附件列表无效');
  }
  if (!options.allowEmpty && value.length === 0) {
    throw createAttachmentValidationError('chat_attachments_required', '请至少附加一个文件');
  }
  return assertAttachmentBatch(value.map(normalizeChatDocument));
}

function assertAttachmentBatch(attachments) {
  if (attachments.length > limits.maxFiles) {
    throw createAttachmentValidationError('chat_attachment_limit_exceeded', `每次最多附加 ${limits.maxFiles} 个文件`, {
      limit: limits.maxFiles
    });
  }
  const totalBytes = attachments.reduce((total, attachment) => total + attachment.size, 0);
  if (totalBytes > limits.maxTotalBytes) {
    throw createAttachmentValidationError(
      'chat_attachment_total_size_exceeded',
      `附件总大小不能超过 ${formatMegabytes(limits.maxTotalBytes)} MB`,
      { limit: limits.maxTotalBytes, actual: totalBytes }
    );
  }
  return attachments;
}

function assertAttachmentSize(name, kind, size, options = {}) {
  const maximum = kind === ATTACHMENT_KINDS.IMAGE
    ? limits.maxImageBytes
    : kind === ATTACHMENT_KINDS.VIDEO ? limits.maxVideoBytes : limits.maxDocumentBytes;
  if (!Number.isSafeInteger(size) || size < 0 || size > maximum) {
    const label = kind === ATTACHMENT_KINDS.IMAGE ? '图片' : kind === ATTACHMENT_KINDS.VIDEO ? '视频' : '文本文件';
    throw createAttachmentValidationError(
      'chat_attachment_size_exceeded',
      `${name}：${label}不能超过 ${formatMegabytes(maximum)} MB`,
      { kind, limit: maximum, actual: size }
    );
  }
  if (size === 0 && options.allowEmpty !== true) {
    const label = kind === ATTACHMENT_KINDS.IMAGE ? '图片' : kind === ATTACHMENT_KINDS.VIDEO ? '视频' : '附件';
    throw createAttachmentValidationError('chat_attachment_empty', `${name}：${label}为空`, { kind });
  }
}

function extensionForMimeType(mimeType, kind) {
  if (kind === ATTACHMENT_KINDS.IMAGE) {
    if (mimeType === 'image/png') return 'png';
    if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return 'jpg';
    if (mimeType === 'image/webp') return 'webp';
    if (mimeType === 'image/gif') return 'gif';
  }
  return Object.keys(limits.videoExtensionTypes)
    .find((extension) => limits.videoExtensionTypes[extension] === mimeType) || 'mp4';
}

function formatMegabytes(bytes) {
  return Math.round(bytes / 1048576);
}

module.exports = {
  ATTACHMENT_KINDS,
  assertAttachmentBatch,
  assertAttachmentSize,
  attachmentMimeTypeFromPath,
  createAttachmentValidationError,
  imageMimeTypeFromPath,
  isSupportedImageMimeType,
  normalizeChatDocument,
  normalizeChatUpload,
  normalizeChatUploadBatch,
  normalizeDocumentBatch,
  normalizeLegacyChatAttachments,
  parseBase64DataUrl,
  resolveChatAttachmentKind,
  videoMimeTypeFromPath
};
