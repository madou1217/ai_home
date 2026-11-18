'use strict';
// Response patching domain, maintained here after the one-time
// codex-app-server-stdio-proxy-split extraction.

const { matchesSessionCwd } = require('../runtime/session-project-scope');
const { readNativeThreadTitles, readNativeThreadGoal } = require('./codex-metadata-native-reader');
const { resolveCodexThreadListScope } = require('./codex-session-list-scope');
const {
  CODEX_INTERACTIVE_SOURCE_KINDS,
  isCodexSubagentThread,
  isCodexWorktreeProjectPath,
  resolveCodexThreadListSourceKinds
} = require('../sessions/codex-visible-session-policy');
const {
  CODEX_DESKTOP_AUTH_TYPES,
  buildCodexDesktopRuntimeAuth,
  resolveAiHomeDir,
  resolveCodexDesktopAccountIdentity,
  resolveCodexDesktopChatGptAccount,
  resolveCodexDesktopChatGptIdentity
} = require('./codex-desktop-account');
const { tryParseJson, readCurrentCodexRuntimeConfig, isAihManagedProvider, readCodexHiddenThreadIds, resolveCodexStateHome, normalizeStateThreadSortKey, encodeStateThreadCursor, compareStateThreadRows, readStateThreadListPage } = require('./codex-app-server-stdio-proxy-utils');

function patchThreadListVisibilityResponse(line, context = {}, options = {}) {
  try { return applyThreadListVisibilityResponse(line, context, options); }
  catch (error) {
    const response = tryParseJson(line);
    const errorLine = !response || !Object.prototype.hasOwnProperty.call(response, 'id')
      ? line
      : JSON.stringify({ id: response.id, error: { code: -32000, message: error.code || 'codex_state_read_unavailable' } });
    if (Buffer.byteLength(errorLine) + 1 > 32 * 1024 * 1024) {
      throw Object.assign(new Error('codex_state_read_budget_exceeded'), { code: 'codex_state_read_budget_exceeded' });
    }
    return errorLine;
  }
}

function applyThreadListVisibilityResponse(line, context = {}, options = {}) {
  if (!context || typeof context !== 'object') return line;
  const parsed = tryParseJson(line);
  if (!parsed || !parsed.result || typeof parsed.result !== 'object' || Array.isArray(parsed.result)) return line;
  const codexHome = String(options.codexHome || resolveCodexStateHome(options)).trim();
  return require('./codex-state-native-reader').readNativeThreadListVisibility(
    codexHome, line, parsed, context, options
  );
}


function mergeThreadListData(existingData, nextData) {
  const seen = new Set();
  const merged = [];
  for (const item of Array.isArray(existingData) ? existingData : []) {
    const key = item && item.id ? String(item.id) : '';
    if (key) seen.add(key);
    merged.push(item);
  }
  for (const item of Array.isArray(nextData) ? nextData : []) {
    const key = item && item.id ? String(item.id) : '';
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(item);
  }
  return merged;
}


function patchThreadConfigResponse(line, context) {
  if (!context) return line;
  try {
    return require('./codex-metadata-native-reader').readNativeConfigResponse(line, context);
  } catch (_error) {
    // Optional config decoration is unavailable, not a Node mapper fallback.
    return line;
  }
}


function patchAccountReadResponse(line, options = {}) {
  const parsed = tryParseJson(line);
  if (!parsed || parsed.error || !parsed.result || typeof parsed.result !== 'object') return line;

  const result = parsed.result;
  if (result.account != null || result.requiresOpenaiAuth !== false) return line;

  const fs = options.fs || require('node:fs');
  const currentConfig = readCurrentCodexRuntimeConfig(fs, resolveCodexStateHome(options), options);
  if (!isAihManagedProvider(currentConfig.modelProvider)) return line;

  const account = resolveCodexDesktopChatGptAccount(fs, options);
  if (!account) return line;

  return JSON.stringify({
    ...parsed,
    result: {
      ...result,
      account,
      requiresOpenaiAuth: false
    }
  });
}


function patchAuthStatusResponse(line, context = {}, options = {}) {
  const parsed = tryParseJson(line);
  if (!parsed || parsed.error || !parsed.result || typeof parsed.result !== 'object' || Array.isArray(parsed.result)) return line;

  // Native auth state belongs to upstream, not to the previously selected
  // AIH account. Only the legacy gateway response shape with an explicit
  // requiresOpenaiAuth=false may use the managed identity fallback. A native
  // ChatGPT response stays authoritative even when its token is omitted.
  const result = parsed.result;
  const gatewayAuth = result.authMethod === 'apikey'
    || (result.authMethod == null && result.authToken == null);
  if (result.requiresOpenaiAuth !== false || !gatewayAuth) return line;

  const fs = options.fs || require('node:fs');
  const currentConfig = readCurrentCodexRuntimeConfig(fs, resolveCodexStateHome(options), options);
  if (!isAihManagedProvider(currentConfig.modelProvider)) return line;

  const includeToken = context.includeToken !== false;
  const identity = resolveCodexDesktopChatGptIdentity(fs, {
    ...options,
    requireAccessToken: true
  });
  if (!identity || !identity.accessToken) return line;

  return JSON.stringify({
    ...parsed,
    result: {
      ...parsed.result,
      authMethod: 'chatgpt',
      authToken: includeToken ? identity.accessToken : null,
      requiresOpenaiAuth: false
    }
  });
}


function getThreadObjectId(thread) {
  if (!thread || typeof thread !== 'object' || Array.isArray(thread)) return '';
  return String(thread.id || thread.sessionId || thread.threadId || '').trim();
}


function resolveThreadTitleForPatch(thread, options = {}) {
  const existing = String(
    thread && (thread.title || thread.name || thread.preview || thread.first_user_message) || ''
  ).trim();
  if (existing) return existing;
  const threadId = getThreadObjectId(thread);
  if (!threadId) return '';
  if (options.threadTitleSnapshot instanceof Map) return options.threadTitleSnapshot.get(threadId) || '';
  const codexHome = String(options.codexHome || resolveCodexStateHome(options)).trim();
  if (!codexHome) return '';
  try { return readNativeThreadTitles(codexHome, [threadId], options).get(threadId) || ''; }
  catch (_error) { return ''; } // Optional title decoration never masks a real upstream result.
}


function patchThreadObjectTitleFields(thread, options = {}) {
  if (!thread || typeof thread !== 'object' || Array.isArray(thread)) return { thread, changed: false };
  const title = resolveThreadTitleForPatch(thread, options);
  if (!title) return { thread, changed: false };
  let changed = false;
  const next = { ...thread };
  if (!String(next.title || '').trim()) {
    next.title = title;
    changed = true;
  }
  if (!String(next.name || '').trim()) {
    next.name = title;
    changed = true;
  }
  if (!String(next.preview || '').trim()) {
    next.preview = title;
    changed = true;
  }
  return changed ? { thread: next, changed: true } : { thread, changed: false };
}


function patchThreadTitleFieldsResponse(line, options = {}) {
  if (Buffer.byteLength(line) + 1 > 32 * 1024 * 1024) {
    throw Object.assign(new Error('codex_metadata_input_limit'), { code: 'codex_metadata_input_limit' });
  }
  const parsed = tryParseJson(line);
  if (!parsed || parsed.error || !parsed.result || typeof parsed.result !== 'object' || Array.isArray(parsed.result)) {
    return line;
  }
  const codexHome = String(options.codexHome || resolveCodexStateHome(options)).trim();
  try {
    return require('./codex-metadata-native-reader').readNativeTitleResponse(codexHome, line, parsed, options);
  } catch (error) {
    const budget = error.code === 'codex_metadata_input_limit';
    // Optional decoration failure preserves the real upstream response. It
    // never re-enters the old Node mapper or turns missing metadata into null.
    if (!budget) {
      const processObj = options.processObj || process;
      try { processObj.stderr.write('[aih] codex title decoration unavailable; upstream response preserved\n'); } catch (_error) {}
      return line;
    }
    if (!Object.prototype.hasOwnProperty.call(parsed, 'id')) throw error;
    const errorLine = JSON.stringify({ id: parsed.id, error: { code: -32000, message: 'codex_metadata_input_limit' } });
    if (Buffer.byteLength(errorLine) + 1 > 32 * 1024 * 1024) throw error;
    return errorLine;
  }
}


function normalizeThreadGoalStatus(status) {
  const normalized = String(status || '').trim();
  if (normalized === 'budget_limited') return 'budgetLimited';
  if (normalized === 'budgetLimited') return 'budgetLimited';
  if (normalized === 'usage_limited' || normalized === 'usageLimited') return 'usageLimited';
  if (normalized === 'active' || normalized === 'paused' || normalized === 'blocked' || normalized === 'complete') return normalized;
  return '';
}


function timestampMsToSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric / 1000);
}


function normalizeNullableInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}


function readThreadGoalFromGoalDb(threadId, deps = {}) {
  const id = String(threadId || '').trim();
  const codexHome = String(deps.codexHome || resolveCodexStateHome(deps)).trim();
  if (!id || !codexHome) return null;
  const result = readNativeThreadGoal(codexHome, id, deps);
  return result.state === 'found' ? result.goal : null;
}

function patchThreadGoalGetResponse(line, context = {}, options = {}) {
  if (!context || !context.threadId) return line;
  const parsed = tryParseJson(line);
  // A local compatibility read is allowed only for a genuinely unsupported
  // method. Invalid IDs, missing threads, permissions and provider failures are
  // upstream facts, not successful {goal:null} responses.
  if (!parsed || !parsed.error || parsed.error.code !== -32601) return line;
  const id = String(context.threadId || '').trim();
  const codexHome = String(options.codexHome || resolveCodexStateHome(options)).trim();
  if (!id || !codexHome) return line;
  let result;
  try { result = readNativeThreadGoal(codexHome, id, options); } catch (_error) { return line; }
  // A missing local record cannot prove the remote thread exists. Preserve the
  // original error unless a supported persisted goal was actually found.
  if (result.state !== 'found') return line;
  const { error: _unsupported, ...response } = parsed;
  return JSON.stringify({ ...response, result: { goal: result.goal } });
}


module.exports = { patchThreadListVisibilityResponse, mergeThreadListData, patchThreadConfigResponse, patchAccountReadResponse, patchAuthStatusResponse, getThreadObjectId, resolveThreadTitleForPatch, patchThreadObjectTitleFields, patchThreadTitleFieldsResponse, normalizeThreadGoalStatus, timestampMsToSeconds, normalizeNullableInteger, readThreadGoalFromGoalDb, patchThreadGoalGetResponse };
