'use strict';

const fs = require('node:fs');
const {
  guessAttachmentMimeType,
  persistChatImages
} = require('../chat-attachments');
const { ChatRuntimeError } = require('./contracts');

const MAX_ATTACHMENTS_PER_TURN = 8;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'
]);

class ChatRuntimeAttachmentService {
  constructor(options) {
    this.store = options.store;
    this.fs = options.fs || fs;
    this.aiHomeDir = options.aiHomeDir;
    this.hostHomeDir = options.hostHomeDir;
    this.persistImages = options.persistImages || persistChatImages;
  }

  upload(sessionId, input = {}) {
    const session = requireSession(this.store, sessionId);
    const uploads = normalizeUploads(input.attachments);
    const filePaths = this.persistImages(uploads.map(({ dataUrl }) => dataUrl), {
      fs: this.fs,
      provider: session.provider,
      aiHomeDir: this.aiHomeDir,
      hostHomeDir: this.hostHomeDir,
      projectPath: session.projectPath
    });
    if (!Array.isArray(filePaths) || filePaths.length !== uploads.length) {
      throw new ChatRuntimeError('chat_attachment_persistence_failed', 500);
    }
    return this.store.createAttachments(session.sessionId, uploads.map((upload, index) => ({
      filePath: filePaths[index],
      name: upload.name,
      mimeType: guessAttachmentMimeType(filePaths[index]) || upload.mimeType
    })));
  }
}

function normalizeUploads(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ChatRuntimeError('chat_attachments_required', 422);
  }
  if (value.length > MAX_ATTACHMENTS_PER_TURN) {
    throw new ChatRuntimeError('chat_attachment_limit_exceeded', 422, {
      limit: MAX_ATTACHMENTS_PER_TURN
    });
  }
  return value.map((upload) => {
    const name = String(upload && upload.name || '').trim();
    const mimeType = String(upload && upload.mimeType || '').trim().toLowerCase();
    const dataUrl = String(upload && upload.dataUrl || '').trim();
    if (!name) throw new ChatRuntimeError('chat_attachment_name_required', 422);
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
      throw new ChatRuntimeError('chat_attachment_mime_unsupported', 422, { mimeType });
    }
    if (!dataUrl.startsWith(`data:${mimeType};base64,`)) {
      throw new ChatRuntimeError('chat_attachment_data_invalid', 422);
    }
    return { name, mimeType, dataUrl };
  });
}

function requireSession(store, sessionId) {
  const session = store.getSession(sessionId);
  if (!session) throw new ChatRuntimeError('chat_session_not_found', 404);
  return session;
}

module.exports = {
  ChatRuntimeAttachmentService,
  MAX_ATTACHMENTS_PER_TURN
};
