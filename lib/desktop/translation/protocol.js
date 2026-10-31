'use strict';

const { normalizeChatMessage } = require('../chat/chat-runtime-protocol');

const VERSION = 1;
const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 8000;
const MAX_TARGET_LENGTH = 100;
const MAX_PATCH_BYTES = 16 * 1024;
const SETTINGS_STRING_LIMITS = {
  source: 100,
  target: MAX_TARGET_LENGTH,
  model: 200,
  provider: 100,
  executionTarget: 80,
  shortcut: 80,
  chatShortcut: 80,
  copyScope: 20,
  targetPolicy: 32
};
const SETTINGS_KEYS = new Set([
  'source', 'target', 'model', 'provider', 'targetPolicy', 'autoCopy', 'copyScope',
  'executionTarget', 'shortcut', 'chatShortcut', 'shortcutEnabled', 'chatShortcutEnabled',
  'routes', 'serverTarget', 'serverTargets', 'readingTheme'
]);
const TARGET_POLICIES = new Set(['saved', 'explicit', 'confirm', 'same-language']);
const COPY_SCOPES = new Set(['selection', 'page', 'all']);
const TRANSLATION_TYPES = new Set(['translate', 'translate-intent']);
const CHAT_TYPES = new Set(['chat.open', 'chat.submit', 'chat.stop', 'chat.close', 'chat.event', 'chat.error']);

function boundedString(value, limit) {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  if (!result || result.length > limit) return null;
  return result;
}

function normalizeId(value, required = false) {
  if (value === undefined && !required) return undefined;
  return boundedString(value, MAX_ID_LENGTH);
}

function normalizeSettingsPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const patch = {};
  for (const key of SETTINGS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    if (key === 'autoCopy') {
      if (typeof value === 'boolean') patch.autoCopy = value;
      continue;
    }
    if (key === 'shortcutEnabled' || key === 'chatShortcutEnabled') {
      if (typeof value === 'boolean') patch[key] = value;
      continue;
    }
    if (key === 'targetPolicy') {
      const normalized = boundedString(value, SETTINGS_STRING_LIMITS.targetPolicy);
      if (normalized && TARGET_POLICIES.has(normalized)) patch.targetPolicy = normalized;
      continue;
    }
    if (key === 'copyScope') {
      const normalized = boundedString(value, SETTINGS_STRING_LIMITS.copyScope);
      if (normalized && COPY_SCOPES.has(normalized)) patch.copyScope = normalized;
      continue;
    }
    if (key === 'readingTheme') {
      const normalized = boundedString(value, 40);
      if (normalized && /^[a-z][a-z-]{0,39}$/.test(normalized)) patch.readingTheme = normalized;
      continue;
    }
    if (key === 'routes') {
      if (!Array.isArray(value) || value.length > 32) continue;
      const routes = value.slice(0, 32).filter((route) => route && typeof route === 'object' && !Array.isArray(route)).map((route) => {
        const normalized = {};
        for (const routeKey of ['id', 'provider', 'model', 'modelProvider', 'enabled', 'priority', 'operations']) {
          if (!Object.prototype.hasOwnProperty.call(route, routeKey)) continue;
          if (routeKey === 'enabled' && typeof route.enabled === 'boolean') normalized.enabled = route.enabled;
          else if (routeKey === 'priority' && Number.isSafeInteger(route.priority)) normalized.priority = route.priority;
          else if (routeKey === 'operations' && Array.isArray(route.operations)) normalized.operations = route.operations.slice(0, 8).filter((item) => typeof item === 'string' && item.length <= 32);
          else if (['id', 'provider', 'model', 'modelProvider'].includes(routeKey) && typeof route[routeKey] === 'string' && route[routeKey].length <= 200) normalized[routeKey] = route[routeKey];
        }
        return normalized;
      });
      patch.routes = routes;
      continue;
    }
    if (key === 'serverTarget' || key === 'serverTargets') {
      if (key === 'serverTargets') {
        if (!Array.isArray(value) || value.length > 32) continue;
        patch.serverTargets = value.slice(0, 32).filter((target) => target && typeof target === 'object' && !Array.isArray(target)).map((target) => {
          const normalized = {};
          for (const targetKey of ['kind', 'label', 'origin', 'serverId']) {
            if (typeof target[targetKey] === 'string' && target[targetKey].length <= 240) normalized[targetKey] = target[targetKey];
          }
          return normalized;
        });
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const normalized = {};
        for (const targetKey of ['kind', 'label', 'origin', 'serverId']) {
          if (typeof value[targetKey] === 'string' && value[targetKey].length <= 240) normalized[targetKey] = value[targetKey];
        }
        patch.serverTarget = normalized;
      }
      continue;
    }
    const limit = SETTINGS_STRING_LIMITS[key] || 200;
    const normalized = boundedString(value, limit);
    if (normalized) patch[key] = normalized;
  }
  try {
    if (Buffer.byteLength(JSON.stringify(patch), 'utf8') > MAX_PATCH_BYTES) return null;
  } catch (_error) {
    return null;
  }
  return patch;
}

function normalizeTranslationEvent(input, type) {
  const id = normalizeId(input.id, true);
  const text = boundedString(input.text, MAX_TEXT_LENGTH);
  const target = boundedString(input.target, MAX_TARGET_LENGTH);
  if (!id || !text || !target) return null;
  const event = { version: VERSION, type, id, text, target };
  for (const [key, limit] of [['model', 200], ['provider', 100]]) {
    if (input[key] === undefined || input[key] === '') continue;
    const value = boundedString(input[key], limit);
    if (value === null) return null;
    event[key] = value;
  }
  if (input.targetPolicy !== undefined) {
    const targetPolicy = boundedString(input.targetPolicy, 32);
    if (!targetPolicy || !TARGET_POLICIES.has(targetPolicy)) return null;
    event.targetPolicy = targetPolicy;
  }
  return event;
}

function normalizeLifecycleEvent(input) {
  if (input.type === 'status') {
    if (typeof input.trusted !== 'boolean') return null;
    const event = { version: VERSION, type: 'status', trusted: input.trusted };
    for (const key of ['platform', 'permission', 'shortcut', 'nativeShortcut']) {
      const value = boundedString(input[key], 120);
      if (value) event[key] = value;
    }
    if (Array.isArray(input.captureModes)) {
      event.captureModes = input.captureModes.slice(0, 16)
        .map((value) => boundedString(value, 80))
        .filter(Boolean);
    }
    const detail = boundedString(input.detail, 1000);
    if (detail) event.detail = detail;
    return event;
  }
  if (input.type === 'selection-state') {
    const outcome = boundedString(input.outcome, 100);
    if (!outcome) return null;
    const event = { version: VERSION, type: 'selection-state', outcome };
    for (const key of ['application']) {
      const value = boundedString(input[key], 100);
      if (value) event[key] = value;
    }
    for (const key of ['hitPID', 'focusPID']) {
      if (Number.isSafeInteger(input[key]) && input[key] >= 0) event[key] = input[key];
    }
    for (const key of ['x', 'y']) {
      if (Number.isFinite(input[key])) event[key] = input[key];
    }
    return event;
  }
  if (input.type === 'server-target') {
    const origin = boundedString(input.origin, 500);
    if (!origin) return null;
    const event = { version: VERSION, type: 'server-target', origin };
    for (const key of ['serverId', 'label']) {
      const value = boundedString(input[key], 240);
      if (value) event[key] = value;
    }
    return event;
  }
  if (input.type === 'request-permission') return { version: VERSION, type: 'request-permission' };
  return null;
}

function normalizeHelperError(input) {
  const rawCode = boundedString(input.code, 120) || 'desktop_error';
  const code = rawCode.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return {
    version: VERSION,
    type: 'error',
    code,
    message: boundedString(input.message, 1000) || '桌面进程发生错误',
    retryable: input.retryable !== false
  };
}

function normalizeHelperEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const version = input.version === undefined ? VERSION : input.version;
  if (version !== VERSION || typeof input.type !== 'string') return null;
  if (CHAT_TYPES.has(input.type)) {
    try {
      return { version: VERSION, ...normalizeChatMessage(input) };
    } catch (_error) {
      return null;
    }
  }
  if (input.type === 'error') return normalizeHelperError(input);
  if (TRANSLATION_TYPES.has(input.type)) return normalizeTranslationEvent(input, input.type);
  if (['status', 'selection-state', 'server-target', 'request-permission'].includes(input.type)) return normalizeLifecycleEvent(input);
  if (input.type === 'cancel') {
    const id = normalizeId(input.id);
    if (input.id !== undefined && !id) return null;
    return { version: VERSION, type: 'cancel', ...(id ? { id } : {}) };
  }
  if (input.type === 'settings') {
    const action = input.action === 'close' ? 'close' : input.action === 'save' ? 'save' : null;
    if (!action) return null;
    if (action === 'close') return { version: VERSION, type: 'settings', action };
    const patch = normalizeSettingsPatch(input.patch);
    if (!patch) return null;
    return { version: VERSION, type: 'settings', action, patch };
  }
  return null;
}

module.exports = {
  VERSION,
  MAX_ID_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_PATCH_BYTES,
  normalizeHelperEvent,
  normalizeSettingsPatch
};
