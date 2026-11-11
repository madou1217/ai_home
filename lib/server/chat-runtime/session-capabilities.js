'use strict';

const {
  getProviderSlashCommands,
  isSlashPassthroughProvider
} = require('../native-slash-commands');
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
  const slashPassthrough = isChatSession(session)
    ? false
    : isSlashPassthroughProvider(session && session.provider);
  if (slashCommands.length === previous.length
    && slashCommands.every((name, index) => name === previous[index])
    && nextCapabilities === capabilities
    && current.slashPassthrough === slashPassthrough) return current;
  return {
    ...current,
    capabilities: nextCapabilities,
    slashCommands,
    slashPassthrough
  };
}

function providerSlashNames(provider) {
  return getProviderSlashCommands(provider)
    .map((entry) => String(entry && entry.command || '').replace(/^\//, '').trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 创建 / 换账号时落库的能力快照：按会话当前模型的路由目标求值。
 *
 * 注册快照（entry.capabilities）只是驱动构造时刻的值；会话一出生就带着某个模型，
 * 重启后没有 actor 时快照只读这份持久化数据，沿用它会让 relay 模型的会话在重启后
 * 谎报 tools / approval / plan。求值失败退回注册快照：写库不能因为路由证据缺失失败。
 */
function entryCapabilities(entry, session) {
  const registered = entry && entry.capabilities && typeof entry.capabilities === 'object'
    ? entry.capabilities
    : null;
  if (!entry || typeof entry.capabilitiesFor !== 'function') return registered;
  try {
    return entry.capabilitiesFor(session) || registered;
  } catch (_error) {
    return registered;
  }
}

/** 同一求值函数产出的快照键序稳定，直接比 JSON 即可判断「能力有没有变」。 */
function sameCapabilitySnapshot(left, right) {
  return JSON.stringify(left || {}) === JSON.stringify(right || {});
}

module.exports = { entryCapabilities, refreshSlashCapabilities, sameCapabilitySnapshot };
