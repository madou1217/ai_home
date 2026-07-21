'use strict';

const { ChatRuntimeError, normalizeCommand } = require('./contracts');
const { withTransaction } = require('./database');
const { jsonText, mapCommand } = require('./storage-utils');

class CommandRepository {
  constructor(context) {
    this.context = context;
  }

  accept(input) {
    const command = normalizeCommand(input);
    return withTransaction(this.context.db, () => {
      const existing = this.get(command.commandId);
      if (existing) return duplicateResult(existing, command);
      const session = this.context.db.prepare(`
        SELECT last_event_seq FROM chat_runtime_sessions WHERE session_id = ?
      `).get(command.sessionId);
      if (!session) throw new ChatRuntimeError('chat_session_not_found', 404);
      const now = this.context.clock();
      this.context.db.prepare(`
        INSERT INTO chat_runtime_commands (
          command_id, session_id, type, payload_json, status, result_json,
          accepted_seq, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'accepted', NULL, ?, ?, ?)
      `).run(
        command.commandId, command.sessionId, command.type, jsonText(command.payload),
        Number(session.last_event_seq), now, now
      );
      return { duplicate: false, command: this.get(command.commandId) };
    });
  }

  get(commandId) {
    return mapCommand(this.context.db.prepare(`
      SELECT * FROM chat_runtime_commands WHERE command_id = ?
    `).get(commandId));
  }

  complete(commandId, status, result = {}) {
    if (!['completed', 'failed'].includes(status)) {
      throw new ChatRuntimeError('invalid_chat_command_status', 409, { status });
    }
    const update = this.context.db.prepare(`
      UPDATE chat_runtime_commands SET status = ?, result_json = ?, updated_at = ?
      WHERE command_id = ? AND status = 'accepted'
    `).run(status, jsonText(result), this.context.clock(), commandId);
    if (!update.changes) throw new ChatRuntimeError('stale_chat_command', 409);
    return this.get(commandId);
  }
}

function duplicateResult(existing, incoming) {
  const matches = existing.sessionId === incoming.sessionId
    && existing.type === incoming.type
    && jsonText(existing.payload) === jsonText(incoming.payload);
  if (!matches) {
    throw new ChatRuntimeError('chat_command_id_conflict', 409, {
      commandId: incoming.commandId
    });
  }
  return { duplicate: true, command: existing };
}

module.exports = { CommandRepository };
