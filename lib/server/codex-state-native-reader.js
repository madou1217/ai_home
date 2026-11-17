'use strict';

// Vendor state is a native read-only query. Do not silently rebuild the old
// Node all-rows arrays when the native snapshot or capability is unavailable.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveGoServerBinary } = require('../cli/services/server/go-core-supervisor');
const { withHiddenWindowsConsole } = require('../runtime/hidden-child-process-options');

let cachedBinary = null;
function nativeError(code) { return Object.assign(new Error(code), { code }); }
function resolveBinary(options = {}, response = false) {
  const env = options.env || (options.processObj && options.processObj.env) || process.env;
  const explicit = options.goServerBinary || env.AIH_GO_CORE_BINARY;
  const standard = resolveGoServerBinary({ binaryPath: explicit });
  const visibility = response === 'visibility';
  const flag = visibility ? '--thread-list-visibility' : response ? '--thread-list-response' : '';
  const capability = visibility ? 'aih-codex-thread-list-visibility-v1'
    : response ? 'aih-codex-thread-list-response-v1' : 'aih-codex-state-page-v1';
  const cacheKey = `${standard}\0${explicit ? 'explicit' : 'default'}\0${capability}`;
  if (cachedBinary && cachedBinary.cacheKey === cacheKey) {
    try {
      const current = fs.statSync(cachedBinary.file);
      if (current.size === cachedBinary.size && current.mtimeMs === cachedBinary.mtimeMs && current.ctimeMs === cachedBinary.ctimeMs) return { file: cachedBinary.file, env };
    } catch (_error) {}
    cachedBinary = null;
  }
  const companion = path.join(path.dirname(standard), process.platform === 'win32' ? 'aih-codex-state-page.exe' : 'aih-codex-state-page');
  for (const file of explicit ? [standard] : [standard, companion]) {
    let stat;
    try { stat = fs.statSync(file); } catch (_error) { continue; }
    const args = ['__codex-state-page', ...(flag ? [flag] : []), '--capabilities'];
    const result = spawnSync(file, args, withHiddenWindowsConsole({
      env, encoding: 'utf8', timeout: 5000, maxBuffer: 16384, ...(response ? { killSignal: 'SIGKILL' } : {})
    }));
    if (!result.error && result.status === 0 && result.stdout.trim() === capability) {
      cachedBinary = { cacheKey, file, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
      return { file, env };
    }
  }
  throw nativeError('codex_state_native_unavailable');
}

function run(operation, codexHome, params = {}, options = {}) {
  const home = String(codexHome || '').trim();
  if (!home) return operation === 'hidden' ? { ids: [] } : { rows: [], hasMore: false, nextCursor: null };
  const { file, env } = resolveBinary(options);
  const requestedLimit = Number(params.limit);
  const list = (value) => Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const request = {
    operation, codexHome: home,
    params: {
      archived: params.archived === true,
      cwd: typeof params.cwd === 'string' ? params.cwd.trim() : '',
      allProjects: params.allProjects === true,
      modelProviders: list(params.modelProviders), sourceKinds: list(params.sourceKinds),
      limit: Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.max(1, Math.floor(requestedLimit)) : 50,
      sortKey: String(params.sortKey || ''), cursor: String(params.cursor || '')
    },
    options: { TitleMaxBytes: Number(options.maxBytes) || 0 }
  };
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 256 * 1024) throw nativeError('codex_state_read_budget_exceeded');
  const result = spawnSync(file, ['__codex-state-page'], withHiddenWindowsConsole({ env, input, encoding: 'utf8', timeout: 16000, maxBuffer: 32 * 1024 * 1024 }));
  if (result.error || result.status !== 0) {
    // Export stable diagnostic codes, never native stderr containing file paths
    // or arbitrary contents from an unreadable/corrupt vendor database.
    const reason = String(result.stderr || '');
    const code = ['codex_state_cursor_invalid', 'codex_state_read_budget_exceeded', 'codex_state_schema_unavailable', 'codex_state_home_invalid']
      .find((candidate) => reason.includes(candidate)) || 'codex_state_read_unavailable';
    throw nativeError(code);
  }
  let value;
  try { value = JSON.parse(result.stdout); } catch (_error) { throw nativeError('codex_state_native_protocol_invalid'); }
  if (operation === 'hidden' ? !Array.isArray(value.ids) : !Array.isArray(value.rows)) throw nativeError('codex_state_native_protocol_invalid');
  return value;
}

function readNativeStatePage(home, params, options) { return run('page', home, params, options); }
function readNativeHiddenIDs(home, options) { return new Set(run('hidden', home, {}, options).ids); }

// Selected only by the existing enabled caller for an AIH-cursor continuation.
// Do not recreate the old row mapper if the new capability is absent or fails.
function readNativeThreadListResponse(codexHome, id, params, options = {}) {
  const { file, env } = resolveBinary(options, true);
  const input = JSON.stringify({
    version: 1, codexHome, id, params,
    options: { TitleMaxBytes: Number(options.maxBytes) || 0 }
  });
  if (Buffer.byteLength(input) > 256 * 1024) throw nativeError('codex_state_read_budget_exceeded');
  const result = spawnSync(file, ['__codex-state-page', '--thread-list-response'], withHiddenWindowsConsole({
    env, input, encoding: 'utf8', timeout: 16000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024
  }));
  if (result.error || result.status !== 0) throw nativeError('codex_state_read_unavailable');
  let value;
  try { value = JSON.parse(result.stdout); } catch (_error) { throw nativeError('codex_state_native_protocol_invalid'); }
  const has = (key) => value && Object.prototype.hasOwnProperty.call(value, key);
  if (!value || Object.keys(value).length !== 2 || !has('id') || JSON.stringify(value.id) !== JSON.stringify(id)
    || has('result') === has('error')) throw nativeError('codex_state_native_protocol_invalid');
  if (has('result')) {
    const page = value.result;
    if (!page || Object.keys(page).length !== 3 || !Array.isArray(page.data) || page.backwardsCursor !== null
      || !(page.nextCursor === null || typeof page.nextCursor === 'string')) throw nativeError('codex_state_native_protocol_invalid');
  } else if (!value.error || !Number.isInteger(value.error.code) || typeof value.error.message !== 'string') {
    throw nativeError('codex_state_native_protocol_invalid');
  }
  return value;
}

// JSON framing only. Visibility, merge, ordering and cursors have one Go owner.
function readNativeThreadListVisibility(codexHome, originalLine, parsed, context, options = {}) {
  if (Buffer.byteLength(originalLine) + 1 > 32 * 1024 * 1024) throw nativeError('codex_state_read_budget_exceeded');
  const input = JSON.stringify({
    version: 1, codexHome, line: JSON.stringify(parsed), context,
    options: { TitleMaxBytes: Number(options.maxBytes) || 0 }
  });
  if (Buffer.byteLength(input) > 32 * 1024 * 1024) throw nativeError('codex_state_read_budget_exceeded');
  const { file, env } = resolveBinary(options, 'visibility');
  const result = spawnSync(file, ['__codex-state-page', '--thread-list-visibility'], withHiddenWindowsConsole({
    env, input, encoding: 'utf8', timeout: 16000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024
  }));
  if (result.error || result.status !== 0) throw nativeError('codex_state_read_unavailable');
  let value;
  try { value = JSON.parse(result.stdout); } catch (_error) { throw nativeError('codex_state_native_protocol_invalid'); }
  if (!value || typeof value.unchanged !== 'boolean'
    || Object.keys(value).length !== (value.unchanged ? 1 : 2)
    || (!value.unchanged && typeof value.line !== 'string')) throw nativeError('codex_state_native_protocol_invalid');
  if (value.unchanged) return originalLine;
  if (Buffer.byteLength(value.line) + 1 > 32 * 1024 * 1024) throw nativeError('codex_state_read_budget_exceeded');
  let output;
  try { output = JSON.parse(value.line); } catch (_error) { throw nativeError('codex_state_native_protocol_invalid'); }
  const has = (obj, key) => obj && Object.prototype.hasOwnProperty.call(obj, key);
  if (!output || typeof output !== 'object' || Array.isArray(output)
    || has(parsed, 'id') !== has(output, 'id')
    || (has(parsed, 'id') && JSON.stringify(output.id) !== JSON.stringify(parsed.id))) {
    throw nativeError('codex_state_native_protocol_invalid');
  }
  return value.line;
}

module.exports = { readNativeStatePage, readNativeHiddenIDs, readNativeThreadListResponse, readNativeThreadListVisibility };
