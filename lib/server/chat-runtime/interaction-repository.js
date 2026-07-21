'use strict';

const { isDeepStrictEqual } = require('node:util');

const { ChatRuntimeError } = require('./contracts');
const {
  normalizeCanonicalInteractionPayload
} = require('./canonical-interaction-payload');
const { withTransaction } = require('./database');
const {
  createInteractionAnswerTimelineEvent
} = require('./interaction-answer-timeline');
const { jsonText, mapInteraction, requiredText } = require('./storage-utils');

const INTERACTION_KINDS = new Set(['question', 'approval', 'plan_confirmation']);

class InteractionRepository {
  constructor(context, events) {
    this.context = context;
    this.events = events;
  }

  create(input = {}) {
    return withTransaction(this.context.db, () => {
      const kind = requiredText(input.kind, 'chat_interaction_kind_required');
      if (!INTERACTION_KINDS.has(kind)) {
        throw new ChatRuntimeError('invalid_chat_interaction_kind', 422, { kind });
      }
      const id = String(input.interactionId || '').trim() || this.context.idFactory('interaction');
      const revision = positiveRevision(input.revision === undefined ? 1 : input.revision);
      const payload = normalizeCanonicalInteractionPayload(kind, input.payload);
      const now = this.context.clock();
      this.context.db.prepare(`
        INSERT INTO chat_runtime_interactions (
          interaction_id, session_id, item_id, kind, revision, payload_json,
          state, resolution_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
      `).run(
        id, requiredText(input.sessionId, 'chat_session_id_required'),
        requiredText(input.itemId, 'chat_interaction_item_id_required'),
        kind, revision, jsonText(payload), now, now
      );
      const interaction = this.get(id);
      this.appendEvent(interaction.sessionId, 'interaction.requested', interaction);
      return interaction;
    });
  }

  resolve(interactionId, input = {}) {
    return withTransaction(this.context.db, () => {
      const current = this.validate(interactionId, input);
      return this.commitResolution(current, input.resolution);
    });
  }

  claimResolution(interactionId, input) {
    return withTransaction(this.context.db, () => {
      const current = this.validate(interactionId, input);
      const sessionId = requiredText(input.sessionId, 'chat_session_id_required');
      const update = this.context.db.prepare(`
        UPDATE chat_runtime_interactions
        SET state = 'resolving', resolution_json = ?, updated_at = ?
        WHERE interaction_id = ? AND session_id = ? AND revision = ? AND state = 'pending'
      `).run(
        jsonText(input.resolution), this.context.clock(),
        current.interactionId, sessionId, current.revision
      );
      if (!update.changes) throw new ChatRuntimeError('stale_interaction', 409);
      const interaction = this.get(current.interactionId);
      this.appendEvent(interaction.sessionId, 'interaction.updated', interaction);
      return interaction;
    });
  }

  finishResolution(current) {
    return withTransaction(this.context.db, () => {
      const update = this.context.db.prepare(`
        UPDATE chat_runtime_interactions SET state = 'answered', updated_at = ?
        WHERE interaction_id = ? AND session_id = ? AND revision = ? AND state = 'resolving'
      `).run(
        this.context.clock(), current.interactionId, current.sessionId, current.revision
      );
      if (!update.changes) return this.requireFinishedClaim(current);
      const interaction = this.get(current.interactionId);
      this.appendResolutionEvents(interaction);
      return interaction;
    });
  }

  releaseResolution(current) {
    return withTransaction(this.context.db, () => {
      const update = this.context.db.prepare(`
        UPDATE chat_runtime_interactions
        SET state = 'pending', resolution_json = NULL, updated_at = ?
        WHERE interaction_id = ? AND session_id = ? AND revision = ? AND state = 'resolving'
      `).run(
        this.context.clock(), current.interactionId, current.sessionId, current.revision
      );
      if (!update.changes) return this.get(current.interactionId);
      const interaction = this.get(current.interactionId);
      this.appendEvent(interaction.sessionId, 'interaction.updated', interaction);
      return interaction;
    });
  }

  acknowledgeExternal(interactionId) {
    return withTransaction(this.context.db, () => {
      const current = this.get(interactionId);
      if (!current || !['pending', 'resolving'].includes(current.state)) return current;
      const update = this.context.db.prepare(`
        UPDATE chat_runtime_interactions
        SET state = 'answered',
            resolution_json = CASE WHEN state = 'pending' THEN ? ELSE resolution_json END,
            updated_at = ?
        WHERE interaction_id = ? AND state IN ('pending', 'resolving')
      `).run(
        jsonText({ reason: 'resolved_elsewhere' }),
        this.context.clock(),
        current.interactionId
      );
      if (!update.changes) return this.get(current.interactionId);
      const interaction = this.get(current.interactionId);
      this.appendEvent(interaction.sessionId, 'interaction.resolved', interaction);
      return interaction;
    });
  }

  validate(interactionId, input = {}) {
    const current = this.get(interactionId);
    const revision = positiveRevision(input.revision);
    if (!current || current.state !== 'pending' || current.revision !== revision) {
      throw new ChatRuntimeError('stale_interaction', 409, { interactionId, revision });
    }
    const sessionId = String(input.sessionId || '').trim();
    if (sessionId && current.sessionId !== sessionId) {
      throw new ChatRuntimeError('stale_interaction', 409, { interactionId, revision });
    }
    const kind = String(input.kind || '').trim();
    if (kind && current.kind !== kind) {
      throw new ChatRuntimeError('chat_interaction_kind_mismatch', 409, {
        actual: current.kind,
        expected: kind,
        interactionId
      });
    }
    return current;
  }

  requireFinishedClaim(claim) {
    const current = this.get(claim.interactionId);
    if (
      current
      && current.sessionId === claim.sessionId
      && current.revision === claim.revision
      && current.state === 'answered'
      && isDeepStrictEqual(current.resolution, claim.resolution)
    ) {
      return current;
    }
    throw new ChatRuntimeError('stale_interaction', 409);
  }

  commitResolution(current, resolution) {
    const update = this.context.db.prepare(`
      UPDATE chat_runtime_interactions
      SET state = 'answered', resolution_json = ?, updated_at = ?
      WHERE interaction_id = ? AND revision = ? AND state = 'pending'
    `).run(
      jsonText(resolution), this.context.clock(), current.interactionId, current.revision
    );
    if (!update.changes) throw new ChatRuntimeError('stale_interaction', 409);
    const interaction = this.get(current.interactionId);
    this.appendResolutionEvents(interaction);
    return interaction;
  }

  get(interactionId) {
    return mapInteraction(this.context.db.prepare(`
      SELECT * FROM chat_runtime_interactions WHERE interaction_id = ?
    `).get(interactionId));
  }

  listActive(sessionId) {
    return this.context.db.prepare(`
      SELECT * FROM chat_runtime_interactions
      WHERE session_id = ? AND state IN ('pending', 'resolving')
      ORDER BY created_at, interaction_id
    `).all(sessionId).map(mapInteraction);
  }

  appendEvent(sessionId, type, interaction) {
    this.events.appendInTransaction(sessionId, {
      type,
      itemId: interaction.itemId,
      source: { provider: 'aih', runtimeId: 'chat-runtime' },
      payload: { interaction }
    });
  }

  appendResolutionEvents(interaction) {
    this.appendEvent(interaction.sessionId, 'interaction.resolved', interaction);
    const answerEvent = createInteractionAnswerTimelineEvent(interaction);
    if (answerEvent) this.events.appendInTransaction(interaction.sessionId, answerEvent);
  }
}

function positiveRevision(value) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new ChatRuntimeError('invalid_chat_interaction_revision', 422);
  }
  return revision;
}

module.exports = { InteractionRepository };
