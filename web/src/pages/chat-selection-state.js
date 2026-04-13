const CHAT_SELECTION_STORAGE_KEY = 'web-chat-selection-v1';
const getWindowLike = () => (typeof globalThis !== 'undefined' ? globalThis.window : undefined);
const getUrlSearchParamsCtor = () => (typeof globalThis !== 'undefined' ? globalThis.URLSearchParams : undefined);

function normalizeSelection(selection) {
  const next = selection && typeof selection === 'object' ? selection : {};
  return {
    projectPath: next.projectPath || undefined,
    sessionId: next.sessionId || undefined,
    provider: next.provider || undefined,
    projectDirName: next.projectDirName || undefined
  };
}

export function readSelectionFromSearch(search) {
  const UrlSearchParams = getUrlSearchParamsCtor();
  if (typeof UrlSearchParams !== 'function') return {};
  const params = new UrlSearchParams(String(search || ''));
  return normalizeSelection({
    projectPath: params.get('projectPath') || undefined,
    sessionId: params.get('sessionId') || undefined,
    provider: params.get('provider') || undefined,
    projectDirName: params.get('projectDirName') || undefined
  });
}

export function readPersistedSelection(options = {}) {
  const storageKey = options.storageKey || CHAT_SELECTION_STORAGE_KEY;
  const search = options.search != null
    ? options.search
    : (getWindowLike() ? getWindowLike().location.search : '');
  const localStorageLike = options.localStorage
    || (getWindowLike() ? getWindowLike().localStorage : null);
  const fromUrl = readSelectionFromSearch(search);
  if (fromUrl.projectPath || fromUrl.sessionId) return fromUrl;
  if (!localStorageLike || typeof localStorageLike.getItem !== 'function') return {};
  try {
    const raw = localStorageLike.getItem(storageKey);
    if (!raw) return {};
    return normalizeSelection(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function writePersistedSelection(selection, options = {}) {
  const storageKey = options.storageKey || CHAT_SELECTION_STORAGE_KEY;
  const next = normalizeSelection(selection);
  const windowLike = getWindowLike();
  const locationLike = options.location
    || (windowLike ? windowLike.location : null);
  const historyLike = options.history
    || (windowLike ? windowLike.history : null);
  const localStorageLike = options.localStorage
    || (windowLike ? windowLike.localStorage : null);

  if (locationLike && historyLike && typeof historyLike.replaceState === 'function') {
    const UrlSearchParams = getUrlSearchParamsCtor();
    if (typeof UrlSearchParams !== 'function') return next;
    const params = new UrlSearchParams(String(locationLike.search || ''));
    if (next.projectPath) params.set('projectPath', next.projectPath);
    else params.delete('projectPath');
    if (next.sessionId) params.set('sessionId', next.sessionId);
    else params.delete('sessionId');
    if (next.provider) params.set('provider', next.provider);
    else params.delete('provider');
    if (next.projectDirName) params.set('projectDirName', next.projectDirName);
    else params.delete('projectDirName');
    const query = params.toString();
    const pathname = String(locationLike.pathname || '');
    const hash = String(locationLike.hash || '');
    const nextUrl = `${pathname}${query ? `?${query}` : ''}${hash}`;
    historyLike.replaceState(null, '', nextUrl);
  }

  if (!localStorageLike) return next;
  try {
    if (next.projectPath || next.sessionId) {
      localStorageLike.setItem(storageKey, JSON.stringify(next));
    } else {
      localStorageLike.removeItem(storageKey);
    }
  } catch {
    // Best effort only: storage may be unavailable in private mode or tests.
  }
  return next;
}

export {
  CHAT_SELECTION_STORAGE_KEY
};
