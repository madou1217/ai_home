'use strict';

const fs = require('node:fs');
const { persistChatImages } = require('./chat-attachments');
const { persistChatDocuments } = require('./chat-document-attachments');
const { persistChatVideos, prepareChatVideo } = require('./chat-video-attachments');
const { ATTACHMENT_KINDS } = require('./chat-attachment-validation');
const { cleanupPersistedAttachments } = require('./chat-attachment-filesystem');

async function materializeChatAttachments(attachments, options = {}) {
  const fsImpl = options.fs || fs;
  const persistImages = options.persistImages || persistChatImages;
  const persistDocuments = options.persistDocuments || persistChatDocuments;
  const persistVideos = options.persistVideos || persistChatVideos;
  const prepareVideo = options.prepareVideo || ((filePath) => prepareChatVideo(filePath, {
    fs: fsImpl,
    ...(options.videoTools || {})
  }));
  const materialized = [];
  const persistedPaths = [];
  try {
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
      let paths;
      if (attachment.kind === ATTACHMENT_KINDS.IMAGE) {
        paths = persistImages([attachment.dataUrl], options);
      } else if (attachment.kind === ATTACHMENT_KINDS.DOCUMENT) {
        paths = persistDocuments([attachment], options);
      } else if (attachment.kind === ATTACHMENT_KINDS.VIDEO) {
        paths = persistVideos([attachment], options);
      } else {
        throw persistenceError('chat_attachment_kind_invalid');
      }
      const filePath = requireSinglePath(paths);
      persistedPaths.push(filePath);
      const prepared = attachment.kind === ATTACHMENT_KINDS.VIDEO
        ? normalizePreparedVideo(await prepareVideo(filePath), filePath)
        : null;
      materialized.push({ attachment, filePath, prepared });
    }
    return materialized;
  } catch (error) {
    cleanupPersistedAttachments(fsImpl, persistedPaths);
    throw error;
  }
}

function requireSinglePath(paths) {
  if (!Array.isArray(paths) || paths.length !== 1 || typeof paths[0] !== 'string' || !paths[0]) {
    throw persistenceError('chat_attachment_persistence_failed');
  }
  return paths[0];
}

function normalizePreparedVideo(value, filePath) {
  const prepared = value && typeof value === 'object' ? value : {};
  return {
    filePath,
    frames: Array.isArray(prepared.frames) ? prepared.frames.filter(Boolean) : [],
    metadata: prepared.metadata && typeof prepared.metadata === 'object' ? prepared.metadata : {},
    framesReady: prepared.framesReady === true
  };
}

function persistenceError(code) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = 500;
  return error;
}

module.exports = { materializeChatAttachments };
