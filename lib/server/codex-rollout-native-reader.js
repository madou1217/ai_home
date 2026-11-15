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

module.exports = { readRecentRolloutTurnsNative, readTurnModelsNative };
