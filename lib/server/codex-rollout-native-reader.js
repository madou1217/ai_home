'use strict';

// Native read-only history boundary. No sqlite/config/credential mutation and
// no fallback to unbounded Node file decoding. A rejected fast read is handled
// by the original official app-server, never by a fabricated empty response.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveGoServerBinary } = require('../cli/services/server/go-core-supervisor');
const { withHiddenWindowsConsole } = require('../runtime/hidden-child-process-options');

let selected = null;
function selectBinary(env = process.env) {
  const standard = resolveGoServerBinary({ binaryPath: env.AIH_GO_CORE_BINARY });
  const companion = path.join(path.dirname(standard), process.platform === 'win32' ? 'aih-codex-rollout-read.exe' : 'aih-codex-rollout-read');
  if (selected) {
    try {
      const stat = fs.statSync(selected.path);
      if (selected.standard === standard && stat.size === selected.size && stat.mtimeMs === selected.mtimeMs && stat.ctimeMs === selected.ctimeMs) return selected.path;
    } catch (_error) {}
    selected = null;
  }
  for (const binary of env.AIH_GO_CORE_BINARY ? [standard] : [standard, companion]) {
    let stat;
    try { stat = fs.statSync(binary); } catch (_error) { continue; }
    const result = spawnSync(binary, ['__codex-rollout-read', '--capabilities'], withHiddenWindowsConsole({env,encoding:'utf8',timeout:5000,maxBuffer:16384}));
    if (result.status === 0 && result.stdout.trim() === 'aih-codex-rollout-read-v1') {
      selected = {path:binary,standard,size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs};
      return binary;
    }
  }
  return '';
}

function runNativeRead(request) {
  const binary = selectBinary();
  if (!binary) return null;
  const result = spawnSync(binary, ['__codex-rollout-read'], withHiddenWindowsConsole({input:JSON.stringify(request),encoding:'utf8',timeout:20000,maxBuffer:32*1024*1024}));
  if (result.status !== 0 || result.error) return null;
  try { return JSON.parse(result.stdout); } catch (_error) { return null; }
}

function readRecentRolloutTurnsNative(file, size, options = {}) {
  const result = runNativeRead({operation:'turns',path:file,size,options:{
    threadId:options.threadId,cwd:options.cwd,turnLimit:options.turnLimit,
    initialBytes:options.initialBytes,maxBytes:options.maxBytes,
    maxCommandOutputChars:options.maxCommandOutputChars,nowMs:options.nowMs,
    staleInProgressAfterMs:options.staleInProgressAfterMs
  }});
  return result && result.eligible === true && Array.isArray(result.turns) ? result.turns : null;
}

function readTurnModelsNative(file, turnIds) {
  const ids = Array.from(new Set(turnIds.map((id) => String(id || '').trim()).filter(Boolean)));
  if (!ids.length) return new Map();
  const result = runNativeRead({operation:'models',path:file,turnIds:ids});
  return result && result.models && typeof result.models === 'object' ? new Map(Object.entries(result.models)) : null;
}

const MODEL_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
let selectedModelResponse = null;

function resolveModelResponseBinary() {
  const env = process.env;
  const standard = resolveGoServerBinary({ binaryPath: env.AIH_GO_CORE_BINARY });
  const cacheKey = `${standard}\0${env.AIH_GO_CORE_BINARY ? 'explicit' : 'default'}`;
  if (selectedModelResponse && selectedModelResponse.cacheKey === cacheKey) {
    try {
      const stat = fs.statSync(selectedModelResponse.path);
      if (stat.size === selectedModelResponse.size && stat.mtimeMs === selectedModelResponse.mtimeMs
        && stat.ctimeMs === selectedModelResponse.ctimeMs) return selectedModelResponse.path;
    } catch (_error) {}
    selectedModelResponse = null;
  }
  const companion = path.join(path.dirname(standard), process.platform === 'win32' ? 'aih-codex-rollout-read.exe' : 'aih-codex-rollout-read');
  for (const binary of env.AIH_GO_CORE_BINARY ? [standard] : [standard, companion]) {
    let stat;
    try { stat = fs.statSync(binary); } catch (_error) { continue; }
    const probe = spawnSync(binary, ['__codex-rollout-read', '--model-response', '--capabilities'], withHiddenWindowsConsole({
      env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 16384
    }));
    if (!probe.error && probe.status === 0 && String(probe.stdout || '').trim() === 'aih-codex-model-response-v1') {
      selectedModelResponse = { cacheKey, path: binary, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
      return binary;
    }
  }
  return '';
}

// Framing only. No native result means preserve the official frame, not a
// second Node mapper or a synthesized empty thread.
function readTurnModelResponseNative(originalLine, context = {}) {
  // A missing tracked request is no task, not a reason to start a helper.
  if (!context || typeof context !== 'object' || !context.rolloutPath) return originalLine;
  if (typeof originalLine !== 'string' || Buffer.byteLength(originalLine) + 1 > MODEL_RESPONSE_MAX_BYTES) return originalLine;
  let parsed;
  let canonical;
  try {
    parsed = JSON.parse(originalLine);
    canonical = JSON.stringify(parsed, (_key, value) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('codex_model_response_protocol_invalid');
      return value;
    });
  } catch (_error) { return originalLine; }
  let input;
  try {
    input = JSON.stringify({ version: 1, context: { threadId: context && context.threadId, rolloutPath: context && context.rolloutPath }, line: canonical });
  } catch (_error) { return originalLine; }
  if (Buffer.byteLength(input) > MODEL_RESPONSE_MAX_BYTES) return originalLine;
  const binary = resolveModelResponseBinary();
  if (!binary) return originalLine;
  const response = spawnSync(binary, ['__codex-rollout-read', '--model-response'], withHiddenWindowsConsole({
    input, encoding: 'utf8', timeout: 16000, killSignal: 'SIGKILL', maxBuffer: MODEL_RESPONSE_MAX_BYTES
  }));
  if (response.error || response.status !== 0) return originalLine;
  let value;
  try { value = JSON.parse(response.stdout); } catch (_error) { return originalLine; }
  if (!value || typeof value.unchanged !== 'boolean'
    || Object.keys(value).length !== (value.unchanged ? 1 : 2)
    || (!value.unchanged && typeof value.line !== 'string')) return originalLine;
  if (value.unchanged) return originalLine;
  if (Buffer.byteLength(value.line) + 1 > MODEL_RESPONSE_MAX_BYTES) return originalLine;
  let output;
  try { output = JSON.parse(value.line); } catch (_error) { return originalLine; }
  const has = (obj, key) => obj && Object.prototype.hasOwnProperty.call(obj, key);
  if (!output || typeof output !== 'object' || Array.isArray(output)
    || has(parsed, 'id') !== has(output, 'id')
    || (has(parsed, 'id') && JSON.stringify(parsed.id) !== JSON.stringify(output.id))) return originalLine;
  return value.line;
}

module.exports = { readRecentRolloutTurnsNative, readTurnModelsNative, readTurnModelResponseNative };
