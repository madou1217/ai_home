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

export function togglePinnedSessionId(sessionId: string): Set<string> {
  const current = getPinnedSessionIds();
  if (current.has(sessionId)) {
    current.delete(sessionId);
  } else {
    current.add(sessionId);
  }
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(Array.from(current)));
  } catch {}
  return new Set(current);
}
