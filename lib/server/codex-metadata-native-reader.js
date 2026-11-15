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

module.exports = { readNativeThreadTitles, readNativeThreadGoal };
