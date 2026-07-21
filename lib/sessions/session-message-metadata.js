'use strict';

function normalizeMessageModel(value) {
  const model = typeof value === 'string' ? value.trim() : '';
  return model.toLowerCase() === '<synthetic>' ? '' : model;
}

function normalizeModelReference(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const providerId = normalizeMessageModel(value.providerID || value.providerId);
  const modelId = normalizeMessageModel(value.modelID || value.modelId || value.id);
  if (!modelId) return '';
  return providerId ? `${providerId}/${modelId}` : modelId;
}

function normalizeTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? Math.round(value) : Math.round(value * 1000);
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function decorateMessagesWithTurnModels(messages) {
  const decorated = (Array.isArray(messages) ? messages : []).map((message) => {
    const decoratedMessage = { ...message };
    const model = normalizeMessageModel(decoratedMessage.model);
    if (model) decoratedMessage.model = model;
    else delete decoratedMessage.model;
    return decoratedMessage;
  });
  let turnModel = '';
  let turnHasAssistant = false;
  let userMessageIndexes = [];

  decorated.forEach((message, index) => {
    if (message.role === 'user') {
      if (turnHasAssistant) {
        turnModel = '';
        turnHasAssistant = false;
        userMessageIndexes = [];
      }
      userMessageIndexes.push(index);
      const userModel = normalizeMessageModel(message.model);
      if (userModel) turnModel = userModel;
      if (turnModel && !userModel) message.model = turnModel;
      return;
    }

    if (message.role !== 'assistant') return;
    turnHasAssistant = true;
    const assistantModel = normalizeMessageModel(message.model);
    if (assistantModel) turnModel = assistantModel;
    if (!turnModel) return;
    if (!assistantModel) message.model = turnModel;
    userMessageIndexes.forEach((userIndex) => {
      if (!normalizeMessageModel(decorated[userIndex].model)) {
        decorated[userIndex].model = turnModel;
      }
    });
  });

  return decorated;
}

function decorateMessagesWithRecordedTurnModels(messages, records) {
  const decorated = decorateMessagesWithTurnModels(messages);
  const turnStarts = decorated
    .map((message, index) => ({
      index,
      role: message.role,
      timestampMs: normalizeTimestampMs(message.timestamp)
    }))
    .filter((entry) => entry.role === 'user' && entry.timestampMs > 0);
  if (turnStarts.length === 0) return decorated;

  const timeline = (Array.isArray(records) ? records : [])
    .map((record) => ({
      model: normalizeMessageModel(record && record.model),
      timestampMs: normalizeTimestampMs(record && (record.timestampMs || record.timestamp))
    }))
    .filter((record) => record.model && record.timestampMs > 0)
    .sort((left, right) => left.timestampMs - right.timestampMs);

  timeline.forEach((record) => {
    let turnIndex = -1;
    for (let index = 0; index < turnStarts.length; index += 1) {
      if (turnStarts[index].timestampMs > record.timestampMs) break;
      turnIndex = index;
    }
    if (turnIndex < 0) return;

    const start = turnStarts[turnIndex].index;
    const end = turnStarts[turnIndex + 1]
      ? turnStarts[turnIndex + 1].index
      : decorated.length;
    for (let index = start; index < end; index += 1) {
      if (decorated[index].role === 'user' || decorated[index].role === 'assistant') {
        decorated[index].model = record.model;
      }
    }
  });

  return decorated;
}

module.exports = {
  decorateMessagesWithRecordedTurnModels,
  decorateMessagesWithTurnModels,
  normalizeMessageModel,
  normalizeModelReference
};
