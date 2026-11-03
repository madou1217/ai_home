'use strict';

// Codex thread identity policy for persistent tmux sessions. A cwd is only a
// project grouping; it is never a stable conversation identity. Reboot restore
// must therefore use an exact UUID learned from an explicit resume command or
// bound from the running provider session.

const CODEX_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeCodexThreadId(value) {
  const threadId = String(value || '').trim();
  return CODEX_THREAD_ID_PATTERN.test(threadId) ? threadId : '';
}

function extractCodexResumeThreadId(args) {
  const values = Array.isArray(args) ? args.map((value) => String(value)) : [];
  const resumeIndex = values.findIndex((value) => {
    const token = value.trim();
    return token === 'resume' || token === '/resume';
  });
  if (resumeIndex < 0) return '';
  for (let index = resumeIndex + 1; index < values.length; index += 1) {
    const threadId = normalizeCodexThreadId(values[index]);
    if (threadId) return threadId;
  }
  return '';
}

function resolveCodexPersistentThreadId(entry = {}) {
  return normalizeCodexThreadId(entry.nativeSessionId)
    || extractCodexResumeThreadId(entry.forwardArgs);
}

function compareCodexPersistentOwners(left = {}, right = {}) {
  const updatedAtDifference = (Number(left.updatedAt) || 0) - (Number(right.updatedAt) || 0);
  if (updatedAtDifference !== 0) return updatedAtDifference;
  const createdAtDifference = (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0);
  if (createdAtDifference !== 0) return createdAtDifference;
  return String(left.session || '').localeCompare(String(right.session || ''));
}

function selectPreferredCodexPersistentOwner(entries) {
  let preferred = null;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!preferred || compareCodexPersistentOwners(entry, preferred) > 0) preferred = entry;
  }
  return preferred;
}

module.exports = {
  CODEX_THREAD_ID_PATTERN,
  compareCodexPersistentOwners,
  extractCodexResumeThreadId,
  normalizeCodexThreadId,
  resolveCodexPersistentThreadId,
  selectPreferredCodexPersistentOwner
};
