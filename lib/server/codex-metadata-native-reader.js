'use strict';

// Optional response metadata is read in native code, never through a helper
// that may repair vendor history. Failures are not authoritative empty values.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveGoServerBinary } = require('../cli/services/server/go-core-supervisor');
const { withHiddenWindowsConsole } = require('../runtime/hidden-child-process-options');

let selected;
function error(code) { return Object.assign(new Error(code), { code }); }
function resolve(options) {
  const env = options.env || (options.processObj && options.processObj.env) || process.env;
  const override = options.goServerBinary || env.AIH_GO_CORE_BINARY;
  const standard = resolveGoServerBinary({ binaryPath: override });
  if (selected && selected.standard === standard) {
    try {
      const stat = fs.statSync(selected.file);
      if (stat.size === selected.size && stat.mtimeMs === selected.mtimeMs && stat.ctimeMs === selected.ctimeMs) return { file: selected.file, env };
    } catch (_error) {}
    selected = null;
  }
  const helper = path.join(path.dirname(standard), process.platform === 'win32' ? 'aih-codex-metadata.exe' : 'aih-codex-metadata');
  for (const file of override ? [standard] : [standard, helper]) {
    let stat;
    try { stat = fs.statSync(file); } catch (_error) { continue; }
    const probe = spawnSync(file, ['__codex-metadata', '--capabilities'], withHiddenWindowsConsole({ env, encoding: 'utf8', timeout: 5000, maxBuffer: 16384 }));
    if (probe.status === 0 && probe.stdout.trim() === 'aih-codex-metadata-v1') {
      selected = { standard, file, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
      return { file, env };
    }
  }
  throw error('codex_metadata_native_unavailable');
}

function read(request, options) {
  const { file, env } = resolve(options);
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 256 * 1024) throw error('codex_metadata_input_limit');
  const result = spawnSync(file, ['__codex-metadata'], withHiddenWindowsConsole({ env, input, encoding: 'utf8', timeout: 11000, maxBuffer: 8 * 1024 * 1024 }));
  if (result.error || result.status !== 0) throw error('codex_metadata_read_unavailable');
  try { return JSON.parse(result.stdout); } catch (_error) { throw error('codex_metadata_protocol_invalid'); }
}

function readNativeThreadTitles(codexHome, ids, options = {}) {
  const threadIds = Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
  if (!threadIds.length) return new Map();
  if (threadIds.length > 1024) throw error('codex_metadata_input_limit');
  const result = read({ operation: 'titles', codexHome, threadIds }, options);
  if (!result || !result.titles || typeof result.titles !== 'object' || Array.isArray(result.titles)) throw error('codex_metadata_protocol_invalid');
  return new Map(Object.entries(result.titles).filter(([, title]) => typeof title === 'string'));
}

function readNativeThreadGoal(codexHome, threadId, options = {}) {
  const result = read({ operation: 'goal', codexHome, threadId }, options);
  if (!result || !['found', 'absent', 'unsupported', 'unavailable'].includes(result.state)) throw error('codex_metadata_protocol_invalid');
  if (result.state === 'found' && (!result.goal || result.goal.threadId !== threadId)) throw error('codex_metadata_identity_mismatch');
  return result;
}

// A distinct response capability must not reuse a cached legacy read port.
let selectedTitleResponse;
function resolveTitleResponse(options) {
  const env = options.env || (options.processObj && options.processObj.env) || process.env;
  const override = options.goServerBinary || env.AIH_GO_CORE_BINARY;
  const standard = resolveGoServerBinary({ binaryPath: override });
  const cacheKey = `${standard}\0${override ? 'explicit' : 'default'}`;
  if (selectedTitleResponse && selectedTitleResponse.cacheKey === cacheKey) {
    try {
      const stat = fs.statSync(selectedTitleResponse.file);
      if (stat.size === selectedTitleResponse.size && stat.mtimeMs === selectedTitleResponse.mtimeMs
        && stat.ctimeMs === selectedTitleResponse.ctimeMs) return { file: selectedTitleResponse.file, env };
    } catch (_error) {}
    selectedTitleResponse = null;
  }
  const helper = path.join(path.dirname(standard), process.platform === 'win32' ? 'aih-codex-metadata.exe' : 'aih-codex-metadata');
  for (const file of override ? [standard] : [standard, helper]) {
    let stat;
    try { stat = fs.statSync(file); } catch (_error) { continue; }
    const probe = spawnSync(file, ['__codex-metadata', '--title-response', '--capabilities'], withHiddenWindowsConsole({
      env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 16384
    }));
    if (!probe.error && probe.status === 0 && probe.stdout.trim() === 'aih-codex-title-response-v1') {
      selectedTitleResponse = { cacheKey, file, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
      return { file, env };
    }
  }
  throw error('codex_metadata_native_unavailable');
}

// Framing only: optional metadata and all patch decisions have a Go owner.
function readNativeTitleResponse(codexHome, originalLine, parsed, options = {}) {
  if (Buffer.byteLength(originalLine) + 1 > 32 * 1024 * 1024) throw error('codex_metadata_input_limit');
  const canonical = JSON.stringify(parsed, (_key, value) => {
    // JSON.parse accepts numeric overflow, but stringify would silently turn
    // Infinity into null. Preserve the upstream frame as unavailable instead.
    if (typeof value === 'number' && !Number.isFinite(value)) throw error('codex_metadata_protocol_invalid');
    return value;
  });
  const input = JSON.stringify({ version: 1, codexHome, line: canonical });
  if (Buffer.byteLength(input) > 32 * 1024 * 1024) throw error('codex_metadata_input_limit');
  const { file, env } = resolveTitleResponse(options);
  const result = spawnSync(file, ['__codex-metadata', '--title-response'], withHiddenWindowsConsole({
    env, input, encoding: 'utf8', timeout: 16000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024
  }));
  if (result.error || result.status !== 0) {
    const budget = (result.error && result.error.code === 'ENOBUFS')
      || String(result.stderr || '').includes('codex_state_read_budget_exceeded');
    throw error(budget ? 'codex_metadata_input_limit' : 'codex_metadata_read_unavailable');
  }
  let value;
  try { value = JSON.parse(result.stdout); } catch (_error) { throw error('codex_metadata_protocol_invalid'); }
  if (!value || typeof value.unchanged !== 'boolean'
    || Object.keys(value).length !== (value.unchanged ? 1 : 2)
    || (!value.unchanged && typeof value.line !== 'string')) throw error('codex_metadata_protocol_invalid');
  if (value.unchanged) return originalLine;
  if (Buffer.byteLength(value.line) + 1 > 32 * 1024 * 1024) throw error('codex_metadata_input_limit');
  let output;
  try { output = JSON.parse(value.line); } catch (_error) { throw error('codex_metadata_protocol_invalid'); }
  const has = (obj, key) => obj && Object.prototype.hasOwnProperty.call(obj, key);
  if (!output || typeof output !== 'object' || Array.isArray(output)
    || has(parsed, 'id') !== has(output, 'id')
    || (has(parsed, 'id') && JSON.stringify(parsed.id) !== JSON.stringify(output.id))) throw error('codex_metadata_protocol_invalid');
  return value.line;
}

// Config response mapping has an independent capability and cache; title/read
// readiness cannot accidentally admit an older native binary for this policy.
let selectedConfigResponse;
function resolveConfigResponse(options) {
  const env = options.env || (options.processObj && options.processObj.env) || process.env;
  const override = options.goServerBinary || env.AIH_GO_CORE_BINARY;
  const standard = resolveGoServerBinary({ binaryPath: override });
  const cacheKey = `${standard}\0${override ? 'explicit' : 'default'}`;
  if (selectedConfigResponse && selectedConfigResponse.cacheKey === cacheKey) {
    try {
      const stat = fs.statSync(selectedConfigResponse.file);
      if (stat.size === selectedConfigResponse.size && stat.mtimeMs === selectedConfigResponse.mtimeMs
        && stat.ctimeMs === selectedConfigResponse.ctimeMs) return { file: selectedConfigResponse.file, env };
    } catch (_error) {}
    selectedConfigResponse = null;
  }
  const helper = path.join(path.dirname(standard), process.platform === 'win32' ? 'aih-codex-metadata.exe' : 'aih-codex-metadata');
  for (const file of override ? [standard] : [standard, helper]) {
    let stat;
    try { stat = fs.statSync(file); } catch (_error) { continue; }
    const probe = spawnSync(file, ['__codex-metadata', '--config-response', '--capabilities'], withHiddenWindowsConsole({
      env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 16384
    }));
    if (!probe.error && probe.status === 0 && probe.stdout.trim() === 'aih-codex-config-response-v1') {
      selectedConfigResponse = { cacheKey, file, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
      return { file, env };
    }
  }
  throw error('codex_metadata_native_unavailable');
}

function readNativeConfigResponse(originalLine, context, options = {}) {
  if (!context) return originalLine;
  if (Buffer.byteLength(originalLine) + 1 > 32 * 1024 * 1024) throw error('codex_metadata_input_limit');
  let parsed;
  try { parsed = JSON.parse(originalLine); } catch (_error) { return originalLine; }
  const finite = (_key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw error('codex_metadata_protocol_invalid');
    return value;
  };
  const input = JSON.stringify({ version: 1, line: JSON.stringify(parsed, finite), context }, finite);
  if (Buffer.byteLength(input) > 32 * 1024 * 1024) throw error('codex_metadata_input_limit');
  const { file, env } = resolveConfigResponse(options);
  const result = spawnSync(file, ['__codex-metadata', '--config-response'], withHiddenWindowsConsole({
    env, input, encoding: 'utf8', timeout: 16000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024
  }));
  if (result.error || result.status !== 0) {
    const budget = (result.error && result.error.code === 'ENOBUFS')
      || String(result.stderr || '').includes('codex_state_read_budget_exceeded');
    throw error(budget ? 'codex_metadata_input_limit' : 'codex_metadata_read_unavailable');
  }
  let value;
  try { value = JSON.parse(result.stdout); } catch (_error) { throw error('codex_metadata_protocol_invalid'); }
  if (!value || typeof value.unchanged !== 'boolean'
    || Object.keys(value).length !== (value.unchanged ? 1 : 2)
    || (!value.unchanged && typeof value.line !== 'string')) throw error('codex_metadata_protocol_invalid');
  if (value.unchanged) return originalLine;
  if (Buffer.byteLength(value.line) + 1 > 32 * 1024 * 1024) throw error('codex_metadata_input_limit');
  let output;
  try { output = JSON.parse(value.line); } catch (_error) { throw error('codex_metadata_protocol_invalid'); }
  const has = (obj, key) => obj && Object.prototype.hasOwnProperty.call(obj, key);
  if (!output || typeof output !== 'object' || Array.isArray(output)
    || has(parsed, 'id') !== has(output, 'id')
    || (has(parsed, 'id') && JSON.stringify(parsed.id) !== JSON.stringify(output.id))) throw error('codex_metadata_protocol_invalid');
  return value.line;
}

module.exports = { readNativeThreadTitles, readNativeThreadGoal, readNativeTitleResponse, readNativeConfigResponse };
