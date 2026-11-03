'use strict';

const { ChatRuntimeError } = require('./contracts');
const { mapCommand, parseJson } = require('./storage-utils');

// Derive retry state from the durable turn/command journal. Prompts and
// attachments stay server-side; snapshots expose only failure metadata.
class FailedTurnRepository {
  constructor(context) {
    this.context = context;
  }

  read(sessionId) {
    const latest = this.context.db.prepare(`
      SELECT type, turn_id, at, payload_json FROM chat_runtime_events
      WHERE session_id = ? AND type IN (
        'turn.queued', 'turn.started', 'turn.failed', 'turn.completed', 'turn.interrupted', 'run.lost'
      ) ORDER BY seq DESC LIMIT 1
    `).get(sessionId);
    if (!latest || !['turn.failed', 'run.lost'].includes(latest.type) || !latest.turn_id) return null;
    const command = this.findSubmission(sessionId, latest.turn_id);
    const payload = parseJson(latest.payload_json);
    const outcomeUnknown = latest.type === 'run.lost' || payload.outcomeUnknown === true;
    return {
      failure: { turnId: latest.turn_id, failedAt: Number(latest.at),
        error: payload.error || { code: 'chat_turn_failed', message: '本轮执行失败' },
        retryable: Boolean(command) && !outcomeUnknown,
        ...(outcomeUnknown ? { outcomeUnknown: true } : {}) },
      command
    };
  }

  get(sessionId) {
    return this.read(sessionId)?.failure || null;
  }

  requireSubmission(sessionId, sourceTurnId) {
    const session = this.context.db.prepare(`
      SELECT state FROM chat_runtime_sessions WHERE session_id = ?
    `).get(sessionId);
    const latest = this.read(sessionId);
    if (session?.state !== 'idle' || latest?.failure.turnId !== sourceTurnId || !latest.failure.retryable || !latest.command) {
      throw new ChatRuntimeError('chat_retry_not_available', 409);
    }
    return latest.command;
  }

  findSubmission(sessionId, turnId) {
    const queued = this.context.db.prepare(`
      SELECT payload_json FROM chat_runtime_events
      WHERE session_id = ? AND turn_id = ? AND type = 'turn.queued'
      ORDER BY seq LIMIT 1
    `).get(sessionId, turnId);
    const sourceId = queued && parseJson(queued.payload_json).submissionCommandId;
    // Older turns predate submissionCommandId; their accepted command result
    // already records the server-owned turnId, including the reported failure.
    const row = sourceId
      ? this.context.db.prepare(`
        SELECT * FROM chat_runtime_commands
        WHERE session_id = ? AND command_id = ? AND type = 'turn.submit'
      `).get(sessionId, sourceId)
      : this.context.db.prepare(`
        SELECT * FROM chat_runtime_commands
        WHERE session_id = ? AND type = 'turn.submit' AND json_extract(result_json, '$.turnId') = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(sessionId, turnId);
    return row ? mapCommand(row) : null;
  }
}

module.exports = { FailedTurnRepository };
