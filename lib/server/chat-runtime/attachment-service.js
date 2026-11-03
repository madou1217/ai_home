'use strict';

const fs = require('node:fs');
const {
  guessAttachmentMimeType
} = require('../chat-attachments');
const { ChatRuntimeError } = require('./contracts');
const {
  normalizeChatUploadBatch
} = require('../chat-attachment-validation');
const { materializeChatAttachments } = require('../chat-attachment-persistence');
const { cleanupPersistedAttachments } = require('../chat-attachment-filesystem');

const MAX_ATTACHMENTS_PER_TURN = require('../../../contracts/chat-attachments.json').maxFiles;

class ChatRuntimeAttachmentService {
  constructor(options) {
    this.store = options.store;
    this.fs = options.fs || fs;
    this.aiHomeDir = options.aiHomeDir;
    this.hostHomeDir = options.hostHomeDir;
    this.persistence = options.persistence || {};
    for (const key of ['persistImages', 'persistDocuments', 'persistVideos', 'prepareVideo', 'videoTools']) {
      if (options[key] !== undefined) this.persistence[key] = options[key];
    }
  }

  async upload(sessionId, input = {}) {
    const session = requireSession(this.store, sessionId);
    // Validate the complete batch, including decoded byte sizes, before any
    // persistence function is allowed to touch the filesystem.
    const uploads = normalizeChatUploadBatch(input.attachments);
    const persistenceOptions = {
      fs: this.fs,
      provider: session.provider,
      aiHomeDir: this.aiHomeDir,
      hostHomeDir: this.hostHomeDir,
      projectPath: session.projectPath
    };
    let materialized = [];
    try {
      materialized = await materializeChatAttachments(uploads, {
        ...persistenceOptions,
        ...this.persistence
      });
      return this.store.createAttachments(session.sessionId, materialized.map(({ attachment, filePath }) => ({
        filePath,
        name: attachment.name,
        mimeType: guessAttachmentMimeType(filePath) || attachment.mimeType
      })));
    } catch (error) {
      cleanupPersistedAttachments(this.fs, materialized.map((item) => item.filePath));
      throw error;
    }
  }
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
