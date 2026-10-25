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
  'server-target-error', 'webui-focus', 'request-permission', 'host-translate', 'shutdown'
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
  if (type === 'status') {
    if (typeof input.trusted === 'boolean') event.trusted = input.trusted;
    if (input.detail !== undefined) event.detail = bounded(input.detail, MAX_MESSAGE);
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
    for (const key of ['from', 'to', 'fromLabel', 'toLabel', 'model']) if (input[key] !== undefined) event[key] = bounded(input[key], 240);
  }
  if (type === 'configure') {
    const fields = ['target', 'autoCopy', 'copyScope', 'executionTarget', 'serverTarget', 'serverTargets', 'languages', 'port'];
    for (const key of fields) {
      if (input[key] === undefined) continue;
      if (typeof input[key] === 'string') event[key] = bounded(input[key], MAX_MESSAGE);
      else if (typeof input[key] === 'boolean' || typeof input[key] === 'number') event[key] = input[key];
      else if (Array.isArray(input[key])) event[key] = sanitizeValue(input[key]);
      else if (input[key] && typeof input[key] === 'object') event[key] = sanitizeValue(input[key]);
    }
  }
  return event;
}

module.exports = { VERSION, negotiateVersion, normalizeError, normalizeDesktopEvent };
