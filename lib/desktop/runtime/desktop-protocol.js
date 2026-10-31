'use strict';

const VERSION = 1;
const MAX_ID = 160;
const MAX_TEXT = 8000;
const MAX_MESSAGE = 1000;
const MAX_GENERATION = 0x7fffffff;
const REQUEST_TYPES = new Set(['translate', 'translate-intent', 'cancel']);
const SAFE_TYPES = new Set([
  'hello', 'ready', 'configure', 'status', 'selection-state', 'translate',
  'translate-intent', 'cancel', 'settings', 'confirmation', 'start',
  'attempt_start', 'delta', 'done', 'error', 'server-target',
  'server-target-error', 'webui-focus', 'request-permission', 'host-translate', 'shutdown',
  'chat.open', 'chat.submit', 'chat.stop', 'chat.close', 'chat.event', 'chat.error'
]);

function bounded(value, max) {
  const text = String(value == null ? '' : value);
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeId(value) {
  const id = bounded(value, MAX_ID).trim();
  return id || '';
}

function negotiateVersion(peerVersion) {
  const version = Number(peerVersion);
  if (version !== VERSION) {
    return { ok: false, version: VERSION, error: { code: 'desktop_protocol_version_unsupported', message: `桌面协议版本不受支持: ${version || 'unknown'}`, retryable: false } };
  }
  return { ok: true, version: VERSION };
}

function normalizeError(input) {
  const source = input && typeof input === 'object' ? input : {};
  const nested = source.error && typeof source.error === 'object' ? source.error : source;
  return {
    code: bounded(nested.code || 'desktop_error', 120).replace(/[^a-zA-Z0-9_.-]/g, '_'),
    message: bounded(nested.message || '桌面进程发生错误', MAX_MESSAGE),
    retryable: nested.retryable !== false
  };
}

function sanitizeValue(value, depth = 0, budget = { remaining: 12000 }) {
  if (budget.remaining <= 0 || depth > 3) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    budget.remaining -= 16;
    return value;
  }
  if (typeof value === 'string') {
    const text = value.length > 400 ? value.slice(0, 400) : value;
    budget.remaining -= text.length + 8;
    return text;
  }
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value.slice(0, 32)) {
      const safe = sanitizeValue(item, depth + 1, budget);
      if (safe !== undefined) result.push(safe);
    }
    return result;
  }
  if (typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).slice(0, 32)) {
      const safe = sanitizeValue(value[key], depth + 1, budget);
      if (safe !== undefined) result[String(key).slice(0, 80)] = safe;
    }
    return result;
  }
  return undefined;
}

function normalizeDesktopEvent(input, { expectedVersion = VERSION } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const version = input.version === undefined ? VERSION : Number(input.version);
  if (version !== expectedVersion) return null;
  const type = String(input.type || '').trim();
  if (!SAFE_TYPES.has(type)) return null;
  const event = { version: VERSION, type };
  const id = normalizeId(input.id);
  if (id) event.id = id;
  if (input.generation !== undefined) {
    if (!Number.isSafeInteger(input.generation) || input.generation < 0 || input.generation > MAX_GENERATION) return null;
    event.generation = input.generation;
  }
  if (type === 'error') return { ...event, ...normalizeError(input) };
  if (REQUEST_TYPES.has(type)) {
    if (!id && type !== 'cancel') return null;
    if (type !== 'cancel') {
      const rawText = String(input.text == null ? '' : input.text);
      if (!rawText || rawText.length > MAX_TEXT) return null;
      const text = rawText;
      event.text = text;
    }
    if (input.target !== undefined) event.target = bounded(input.target, 100);
    if (input.targetPolicy !== undefined) event.targetPolicy = bounded(input.targetPolicy, 40);
    if (input.model !== undefined) event.model = bounded(input.model, 200);
    if (input.provider !== undefined) event.provider = bounded(input.provider, 100);
    return event;
  }
  if (type === 'host-translate') {
    if (!id) return null;
    const rawText = String(input.text == null ? '' : input.text);
    if (!rawText || rawText.length > MAX_TEXT) return null;
    event.text = rawText;
    if (input.target !== undefined) event.target = bounded(input.target, 100);
    return event;
  }
  if (type === 'delta') {
    event.content = bounded(input.content, MAX_TEXT);
    return event;
  }
  if (type === 'done') {
    if (input.text !== undefined) event.text = bounded(input.text, MAX_TEXT);
    if (input.usage && typeof input.usage === 'object') event.usage = sanitizeValue(input.usage);
    return event;
  }
  if (type === 'settings') {
    const action = String(input.action || '').trim();
    if (!['save', 'close'].includes(action)) return null;
    event.action = action;
    if (action === 'save' && input.patch && typeof input.patch === 'object' && !Array.isArray(input.patch)) {
      const patch = sanitizeValue(input.patch);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;
      event.patch = patch;
    }
    return event;
  }
  if (type.startsWith('chat.')) return normalizeChatEvent(event, input);
  if (type === 'status') {
    if (typeof input.trusted === 'boolean') event.trusted = input.trusted;
    if (input.detail !== undefined) event.detail = bounded(input.detail, MAX_MESSAGE);
    for (const key of ['platform', 'permission', 'shortcut', 'nativeShortcut']) {
      if (input[key] !== undefined) event[key] = bounded(input[key], 120);
    }
    if (Array.isArray(input.captureModes)) event.captureModes = input.captureModes.slice(0, 16).map((value) => bounded(value, 80)).filter(Boolean);
  }
  if (type === 'selection-state') {
    for (const key of ['outcome', 'application']) if (input[key] !== undefined) event[key] = bounded(input[key], 120);
    for (const key of ['hitPID', 'focusPID', 'x', 'y']) if (Number.isFinite(Number(input[key]))) event[key] = Number(input[key]);
  }
  if (type === 'server-target') {
    for (const key of ['origin', 'serverId', 'label']) if (input[key] !== undefined) event[key] = bounded(input[key], 240);
  }
  if (type === 'server-target-error') event.message = bounded(input.message || '', MAX_MESSAGE);
  if (type === 'webui-focus' && Number.isFinite(Number(input.until))) event.until = Number(input.until);
  if (type === 'confirmation') {
    for (const key of ['state', 'detected', 'confidence', 'target']) if (input[key] !== undefined) event[key] = bounded(input[key], 120);
    if (Array.isArray(input.suggestedTargets)) event.suggestedTargets = input.suggestedTargets.slice(0, 16).map((value) => bounded(value, 40));
  }
  if (type === 'start' || type === 'attempt_start') {
    for (const key of ['from', 'to', 'fromLabel', 'toLabel', 'model', 'provider']) if (input[key] !== undefined) event[key] = bounded(input[key], 240);
  }
  if (type === 'configure') {
    const fields = ['target', 'autoCopy', 'copyScope', 'executionTarget', 'shortcut', 'shortcutEnabled', 'chatShortcut', 'chatShortcutEnabled', 'serverTarget', 'serverTargets', 'chatTarget', 'chatModel', 'models', 'defaultModel', 'defaultProvider', 'model', 'provider', 'languages', 'port', 'platform', 'captureModes', 'permission', 'nativeShortcut', 'largePasteChars', 'readingTheme', 'quickChatOrigin', 'quickChatKey'];
    for (const key of fields) {
      if (input[key] === undefined) continue;
      if (typeof input[key] === 'string') event[key] = bounded(input[key], MAX_MESSAGE);
      else if (typeof input[key] === 'boolean' || typeof input[key] === 'number') event[key] = input[key];
      else if (key === 'chatTarget' && input[key] && typeof input[key] === 'object' && !Array.isArray(input[key])) {
        const target = normalizeChatTarget(input[key]);
        if (target) event[key] = target;
      }
      else if (key === 'models' && Array.isArray(input[key])) event[key] = input[key].slice(0, 256).map((item) => ({ id: bounded(item?.id, 200), provider: bounded(item?.provider, 100), label: bounded(item?.label || item?.id, 240) }));
      else if (key === 'captureModes' && Array.isArray(input[key])) event[key] = input[key].slice(0, 16).map((item) => bounded(item, 80)).filter(Boolean);
      else if (Array.isArray(input[key])) event[key] = sanitizeValue(input[key]);
      else if (input[key] && typeof input[key] === 'object') event[key] = sanitizeValue(input[key]);
    }
  }
  return event;
}

function normalizeChatEvent(event, input) {
  const requestId = normalizeId(input.requestId);
  if (!requestId) return null;
  event.requestId = requestId;
  if (input.generation !== undefined) event.generation = input.generation;
  if (input.sessionId !== undefined) {
    const sessionId = normalizeId(input.sessionId);
    if (!sessionId) return null;
    event.sessionId = sessionId;
  }
  if (input.commandId !== undefined) {
    const commandId = normalizeId(input.commandId);
    if (!commandId) return null;
    event.commandId = commandId;
  }
  if (event.type === 'chat.open') {
    if (!input.target || typeof input.target !== 'object' || Array.isArray(input.target)) return null;
    event.target = normalizeChatTarget(input.target);
    if (!event.target) return null;
    return event;
  }
  if (event.type === 'chat.submit') {
    if (!event.sessionId || !event.commandId) return null;
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    const reference = normalizeDesktopFileReference(input.fileReference);
    if (reference && reference.error) {
      return {
        ...event,
        type: 'chat.error',
        code: reference.error,
        message: '大文本附件引用无效，请重试'
      };
    }
    if (!text || text.length > MAX_TEXT) return null;
    event.text = text;
    if (reference) event.fileReference = reference;
    return event;
  }
  if (event.type === 'chat.stop') {
    if (!event.sessionId || !event.commandId) return null;
    return event;
  }
  if (event.type === 'chat.close') return event;
  if (event.type === 'chat.event') {
    if (!event.sessionId || !input.event || typeof input.event !== 'object' || Array.isArray(input.event)) return null;
    event.event = normalizeChatRuntimeEvent(input.event);
    if (!event.event) return null;
    if (event.event.type === 'stream.error' && event.event.payload.error === 'chat_event_too_large') {
      const { event: runtimeEvent, ...identity } = event;
      return { ...identity, type: 'chat.error', code: runtimeEvent.payload.error, message: runtimeEvent.payload.message };
    }
    return event;
  }
  if (event.type === 'chat.error') {
    const code = normalizeId(input.code);
    if (!code) return null;
    event.code = code;
    if (input.message !== undefined) event.message = bounded(input.message, MAX_MESSAGE);
    return event;
  }
  return null;
}

function normalizeDesktopFileReference(input) {
  if (input === undefined) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'chat_file_reference_invalid' };
  const name = bounded(input.name, 240).trim();
  const mimeType = bounded(input.mimeType || 'text/plain', 120).trim();
  const path = typeof input.path === 'string' ? input.path.trim() : '';
  const text = typeof input.text === 'string' ? input.text : '';
  if (!name || !mimeType || (!path && !text)) return { error: 'chat_file_reference_invalid' };
  if (path && path.length > 2048) return { error: 'chat_file_reference_path_invalid' };
  if (text && Buffer.byteLength(text, 'utf8') > 16 * 1024) return { error: 'chat_file_reference_too_large' };
  return { name, mimeType, ...(path ? { path } : { text }) };
}

function normalizeChatTarget(input) {
  const target = {};
  for (const key of ['kind', 'label', 'origin', 'serverId']) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string') return null;
    const value = input[key].trim();
    // Local targets legitimately have no remote profile id. Settings persist
    // absent optional fields as empty strings; omit them on the wire instead
    // of discarding the entire chat.open request without an acknowledgement.
    if (!value && key !== 'kind') continue;
    if (!value || value.length > 240) return null;
    target[key] = value;
  }
  return Object.keys(target).length > 0 ? target : null;
}

function normalizeChatRuntimeEvent(input) {
  const event = {};
  for (const key of ['schema', 'type', 'eventId', 'sessionId']) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 240) return null;
    event[key] = input[key].trim();
  }
  for (const key of ['seq', 'at']) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 0) return null;
    event[key] = input[key];
  }
  for (const key of ['itemId', 'turnId', 'runId']) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 240) return null;
    event[key] = input[key];
  }
  if (!input.source || typeof input.source !== 'object' || Array.isArray(input.source)) return null;
  const source = {};
  for (const key of ['provider', 'runtimeId']) {
    if (typeof input.source[key] !== 'string' || !input.source[key].trim() || input.source[key].length > 240) return null;
    source[key] = input.source[key].trim();
  }
  event.source = source;
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) return null;
  // Canonical message text is not settings metadata: the generic sanitizer's
  // 400-character/depth-three limits corrupt long deltas and nested history.
  // Preserve complete frames within the native JSONL boundary, and surface an
  // explicit error for oversized frames instead of displaying truncated text.
  const payload = redactSensitive(input.payload);
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, 'utf8') > 90000) {
    event.type = 'stream.error';
    event.payload = { error: 'chat_event_too_large', message: '这条聊天内容超出桌面窗口传输限制，请在完整聊天页查看。' };
  } else {
    event.payload = payload;
  }
  return event;
}

function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (/secret|token|credential|authorization|password|api[-_]?key/i.test(key)) continue;
    result[key] = redactSensitive(child);
  }
  return result;
}

module.exports = { VERSION, negotiateVersion, normalizeError, normalizeDesktopEvent };
