'use strict';

const SUPPORTED = new Set(['native', 'emulated']);
const QUEUE_COMMAND_TYPES = Object.freeze([
  'queue.add', 'queue.edit', 'queue.remove', 'queue.move', 'queue.dispatch'
]);

function createCapabilityCommandCatalog() {
  return Object.freeze({ list: listCommands });
}

function listCommands(session = {}) {
  const snapshot = record(session.capabilitySnapshot);
  const commands = [{ id: 'turn.submit', type: 'turn.submit' }];
  if (supports(snapshot, 'turn.interrupt')) {
    commands.push({ id: 'turn.interrupt', type: 'turn.interrupt' });
  }
  commands.push(...interveneCommands(snapshot.turnInterveneModes));
  if (supports(snapshot, 'turn.queue')) {
    commands.push(...QUEUE_COMMAND_TYPES.map(commandEntry));
  }
  commands.push(...slashCommands(snapshot.slashCommands));
  return commands;
}

function supports(snapshot, capability) {
  const descriptor = record(record(snapshot.capabilities)[capability]);
  return SUPPORTED.has(descriptor.support);
}

function interveneCommands(values) {
  return uniqueTexts(values).map((mode) => ({
    id: `turn.intervene:${mode}`,
    type: 'turn.intervene',
    mode
  }));
}

function slashCommands(values) {
  return uniqueTexts(values).map((name) => ({
    id: `slash:${name}`,
    type: 'slash.execute',
    name,
    command: `/${name}`
  }));
}

function commandEntry(type) {
  return { id: type, type };
}

function uniqueTexts(values) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map(text).filter(Boolean)));
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

module.exports = { createCapabilityCommandCatalog };
