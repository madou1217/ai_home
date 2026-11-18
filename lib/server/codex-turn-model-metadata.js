'use strict';

const { normalizeMessageModel } = require('../sessions/session-message-metadata');

function readCodexTurnModelContext(entry) {
  if (!entry || entry.type !== 'turn_context' || !isRecord(entry.payload)) return null;
  const turnId = text(entry.payload.turn_id);
  const model = normalizeMessageModel(entry.payload.model);
  return turnId && model ? { turnId, model } : null;
}

function collectCodexTurnModels(rolloutText) {
  const models = new Map();
  for (const line of String(rolloutText || '').split(/\r?\n/)) {
    const context = readCodexTurnModelContext(parseJson(line));
    if (context) models.set(context.turnId, context.model);
  }
  return models;
}

function applyCodexTurnModels(turns, models) {
  if (!Array.isArray(turns) || !(models instanceof Map) || models.size === 0) {
    return { changed: false, turns };
  }
  let changed = false;
  const projected = turns.map((turn) => {
    if (!isRecord(turn)) return turn;
    const model = normalizeMessageModel(models.get(text(turn && turn.id)));
    if (!model || turn.model === model) return turn;
    changed = true;
    return { ...turn, model };
  });
  return { changed, turns: changed ? projected : turns };
}

function patchCodexThreadTurnModelsResponse(line, context = {}, options = {}) {
  // Complete response policy and rollout selection have one native owner.
  try {
    return require('./codex-rollout-native-reader').readTurnModelResponseNative(line, context, options);
  } catch (_error) {
    return line;
  }
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

module.exports = {
  applyCodexTurnModels,
  collectCodexTurnModels,
  patchCodexThreadTurnModelsResponse,
  readCodexTurnModelContext
};
