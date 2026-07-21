'use strict';

const { ChatRuntimeError } = require('./contracts');
const { withTransaction } = require('./database');
const { requiredText } = require('./storage-utils');

class AttachmentRepository {
  constructor(context, sessions) {
    this.context = context;
    this.sessions = sessions;
  }

  createMany(sessionId, inputs) {
    const session = this.sessions.require(sessionId);
    const attachments = normalizeAttachments(inputs, this.context);
    return withTransaction(this.context.db, () => attachments.map((attachment) => {
      this.context.db.prepare(`
        INSERT INTO chat_runtime_attachments (
          attachment_id, session_id, file_path, name, mime_type, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        attachment.attachmentId,
        session.sessionId,
        attachment.filePath,
        attachment.name,
        attachment.mimeType,
        attachment.createdAt
      );
      return publicAttachment(attachment, session.sessionId);
    }));
  }

  resolvePaths(sessionId, attachmentIds) {
    const session = this.sessions.require(sessionId);
    const ids = normalizeAttachmentIds(attachmentIds);
    const find = this.context.db.prepare(`
      SELECT file_path FROM chat_runtime_attachments
      WHERE attachment_id = ? AND session_id = ?
    `);
    return ids.map((attachmentId) => {
      const row = find.get(attachmentId, session.sessionId);
      if (!row) {
        throw new ChatRuntimeError('chat_attachment_not_found', 404, { attachmentId });
      }
      return String(row.file_path);
    });
  }
}

function normalizeAttachments(inputs, context) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new ChatRuntimeError('chat_attachments_required', 422);
  }
  return inputs.map((input) => ({
    attachmentId: context.idFactory('attachment'),
    filePath: requiredText(input && input.filePath, 'chat_attachment_path_required'),
    name: requiredText(input && input.name, 'chat_attachment_name_required'),
    mimeType: requiredText(input && input.mimeType, 'chat_attachment_mime_required'),
    createdAt: context.clock()
  }));
}

function normalizeAttachmentIds(values) {
  if (!Array.isArray(values)) {
    throw new ChatRuntimeError('chat_attachment_ids_invalid', 422);
  }
  const ids = values.map((value) => requiredText(value, 'chat_attachment_id_invalid'));
  if (new Set(ids).size !== ids.length) {
    throw new ChatRuntimeError('chat_attachment_ids_duplicate', 422);
  }
  return ids;
}

function publicAttachment(attachment, sessionId) {
  return {
    attachmentId: attachment.attachmentId,
    sessionId,
    name: attachment.name,
    mimeType: attachment.mimeType,
    createdAt: attachment.createdAt
  };
}

module.exports = { AttachmentRepository };
