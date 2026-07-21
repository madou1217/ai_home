'use strict';

const CHAT_EVENT_SCHEMA = 'aih.chat.event.v1';

const COMMAND_TYPES = new Set([
  'runtime.prewarm', 'turn.submit', 'turn.intervene', 'turn.interrupt',
  'queue.add', 'queue.edit', 'queue.remove', 'queue.move', 'queue.dispatch',
  'interaction.answer', 'approval.decide', 'slash.execute', 'session.policy.set'
]);

const EVENT_TYPES = new Set([
  'session.created', 'session.runtime.bound', 'session.runtime.rebound',
  'session.policy.changed', 'session.closed', 'session.snapshot.reset',
  'turn.queued', 'turn.started', 'turn.phase.changed',
  'turn.interrupt.requested', 'turn.interrupted', 'turn.completed', 'turn.failed',
  'queue.item.added', 'queue.item.updated', 'queue.item.moved',
  'queue.item.removed', 'queue.item.dispatched',
  'timeline.item.started', 'timeline.item.delta',
  'timeline.item.updated', 'timeline.item.completed',
  'interaction.requested', 'interaction.updated', 'interaction.resolved', 'interaction.expired',
  'run.detached', 'run.reattached', 'run.adopted', 'run.lost',
  'runtime.prewarm.started', 'runtime.prewarm.ready', 'runtime.prewarm.failed',
  'stream.error'
]);

const SESSION_STATES = new Set([
  'idle', 'starting', 'running', 'waiting_input', 'interrupting',
  'completing', 'recovering', 'closed'
]);

const TIMELINE_KINDS = new Set([
  'message', 'reasoning', 'plan', 'tool', 'shell', 'diff', 'file_change',
  'terminal', 'question', 'approval', 'subagent', 'command', 'attachment',
  'artifact', 'notice', 'error'
]);

const TIMELINE_STATUSES = new Set([
  'pending', 'running', 'waiting_input', 'completed', 'failed', 'cancelled'
]);

const EVENT_ENVELOPE_FIELDS = Object.freeze([
  'schema', 'eventId', 'sessionId', 'seq', 'type', 'at',
  'turnId', 'runId', 'itemId', 'source', 'payload'
]);

const SNAPSHOT_FIELDS = Object.freeze([
  'sessionId', 'state', 'throughSeq', 'runtimeBinding',
  'capabilitySnapshot', 'activeTurn', 'policy', 'queue', 'interactions', 'timeline',
  'timelineHasMore', 'timelineNextBefore'
]);

class ChatRuntimeError extends Error {
  constructor(code, statusCode = 400, details) {
    super(code);
    this.name = 'ChatRuntimeError';
    this.code = code;
    this.statusCode = statusCode;
    if (details !== undefined) this.details = details;
  }
}

module.exports = {
  CHAT_EVENT_SCHEMA,
  COMMAND_TYPES,
  EVENT_ENVELOPE_FIELDS,
  EVENT_TYPES,
  SESSION_STATES,
  SNAPSHOT_FIELDS,
  TIMELINE_KINDS,
  TIMELINE_STATUSES,
  ChatRuntimeError
};
