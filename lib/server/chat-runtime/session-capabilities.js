'use strict';

const { getProviderSlashCommands } = require('../native-slash-commands');
const { isChatSession } = require('./chat-harness-policy');

// Chat sessions run through the Codex app-server harness regardless of the
// selected model provider. Keep the durable commands available to sessions
// created before the slash capability was added; the snapshot is refreshed on
// read without touching updated_at.
const CANONICAL_CHAT_SLASH_COMMANDS = Object.freeze(['compact', 'goal', 'plan']);

function refreshSlashCapabilities(session) {
  const current = session && session.capabilitySnapshot && typeof session.capabilitySnapshot === 'object'
    ? session.capabilitySnapshot
    : {};
  const names = isChatSession(session)
    ? CANONICAL_CHAT_SLASH_COMMANDS
    : providerSlashNames(session && session.provider);
  if (names.length === 0) return current;

  const previous = Array.isArray(current.slashCommands) ? current.slashCommands : [];
  const slashCommands = Array.from(new Set([...previous, ...names]));
  const capabilities = current.capabilities && typeof current.capabilities === 'object'
    ? current.capabilities
    : {};
  const slashSupport = capabilities['slash.execute'];
  const nextCapabilities = slashSupport
    ? capabilities
    : { ...capabilities, 'slash.execute': { support: 'native' } };
  if (slashCommands.length === previous.length
    && slashCommands.every((name, index) => name === previous[index])
    && nextCapabilities === capabilities) return current;
  return {
    ...current,
    capabilities: nextCapabilities,
    slashCommands,
    ...(isChatSession(session) ? { slashPassthrough: false } : {})
  };
}

function providerSlashNames(provider) {
  return getProviderSlashCommands(provider)
    .map((entry) => String(entry && entry.command || '').replace(/^\//, '').trim().toLowerCase())
    .filter(Boolean);
}

module.exports = { refreshSlashCapabilities };
