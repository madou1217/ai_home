'use strict';

const CODEX_INTERACTIVE_SOURCE_KINDS = Object.freeze(['cli', 'vscode']);
const CODEX_INTERACTIVE_SOURCE_KIND_SET = new Set(CODEX_INTERACTIVE_SOURCE_KINDS);

function normalizeSourceKind(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isCodexInteractiveSessionSource(value) {
  const sourceKind = normalizeSourceKind(value);
  // Older rollout metadata may not include source. Preserve those sessions;
  // current state DB rows always carry a concrete source kind.
  return !sourceKind || CODEX_INTERACTIVE_SOURCE_KIND_SET.has(sourceKind);
}

function parseCodexThreadSource(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const text = String(value || '').trim();
  if (!text.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function isCodexSubagentThread(metadata, spawnedChildIds = null) {
  if (!metadata || typeof metadata !== 'object') return false;

  const sessionId = String(metadata.id || metadata.threadId || '').trim();
  if (sessionId && spawnedChildIds && spawnedChildIds.has(sessionId)) return true;
  const threadSource = String(metadata.thread_source || metadata.threadSource || '').trim().toLowerCase();
  if (threadSource === 'subagent') return true;
  if (String(metadata.parent_thread_id || metadata.parentThreadId || '').trim()) return true;

  const source = parseCodexThreadSource(metadata.source);
  return Boolean(
    source
    && Object.prototype.hasOwnProperty.call(source, 'subagent')
    && source.subagent != null
  );
}

function isCodexWorktreeProjectPath(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .toLowerCase()
    .includes('/.codex/worktrees/');
}

function isCodexTopLevelInteractiveThread(metadata, spawnedChildIds = null) {
  return !isCodexSubagentThread(metadata, spawnedChildIds)
    && !isCodexWorktreeProjectPath(metadata && metadata.cwd)
    && isCodexInteractiveSessionSource(metadata && metadata.source);
}

function resolveCodexThreadListSourceKinds(sourceKinds) {
  const explicit = Array.from(new Set(
    (Array.isArray(sourceKinds) ? sourceKinds : [])
      .map(normalizeSourceKind)
      .filter(Boolean)
  ));
  return explicit.length > 0 ? explicit : CODEX_INTERACTIVE_SOURCE_KINDS.slice();
}

module.exports = {
  CODEX_INTERACTIVE_SOURCE_KINDS,
  isCodexInteractiveSessionSource,
  isCodexSubagentThread,
  isCodexTopLevelInteractiveThread,
  isCodexWorktreeProjectPath,
  parseCodexThreadSource,
  resolveCodexThreadListSourceKinds
};
