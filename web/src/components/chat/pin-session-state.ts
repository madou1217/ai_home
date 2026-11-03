const PINNED_STORAGE_KEY = 'aih_pinned_sessions';

export function getPinnedSessionIds(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(PINNED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function persistPinnedSessionIds(ids: Set<string>): Set<string> {
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch {}
  return new Set(ids);
}

// 幂等设置置顶状态：本地置顶操作与跨 Tab SESSION_PINNED 事件的应用端共用同一写入路径。
export function setPinnedSessionId(sessionId: string, pinned: boolean): Set<string> {
  const current = getPinnedSessionIds();
  if (pinned) {
    current.add(sessionId);
  } else {
    current.delete(sessionId);
  }
  return persistPinnedSessionIds(current);
}

export function togglePinnedSessionId(sessionId: string): Set<string> {
  return setPinnedSessionId(sessionId, !getPinnedSessionIds().has(sessionId));
}
