/* global crypto, TextEncoder */
const INDEX_KEY = 'aihTranslationCacheIndexV1';
const PAGE_KEY = 'aihTranslationPagesV1';
const PREFIX = 'aihTranslationResultV1:';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 100;

export async function translationHash(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Text and reading state stay in storage.local. The index contains only hashes,
// sizes and timestamps; source paragraphs and URLs are never stored verbatim.
export function createTranslationCache(storage, now = () => Date.now()) {
  let queue = Promise.resolve();
  const serial = (operation) => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  async function load() {
    const data = await storage.get({ [INDEX_KEY]: [], [PAGE_KEY]: {} });
    return {
      entries: (Array.isArray(data[INDEX_KEY]) ? data[INDEX_KEY] : []).filter((item) => item && /^[a-f0-9]{64}$/.test(item.key) && Number.isFinite(item.at) && Number.isFinite(item.bytes)),
      pages: data[PAGE_KEY] && typeof data[PAGE_KEY] === 'object' && !Array.isArray(data[PAGE_KEY]) ? data[PAGE_KEY] : {}
    };
  }
  const fresh = (entry) => entry && Number.isFinite(entry.at) && entry.at <= now() && now() - entry.at < TTL_MS;
  async function prune(state) {
    const removed = state.entries.filter((item) => !fresh(item));
    state.entries = state.entries.filter(fresh).sort((a, b) => a.at - b.at);
    let bytes = state.entries.reduce((sum, entry) => sum + entry.bytes, 0);
    while (state.entries.length > MAX_ENTRIES || bytes > MAX_BYTES) {
      const entry = state.entries.shift(); bytes -= entry.bytes; removed.push(entry);
    }
    state.pages = Object.fromEntries(Object.entries(state.pages).filter(([, value]) => fresh(value)).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_PAGES));
    if (removed.length) await storage.remove(removed.map((item) => PREFIX + item.key));
    return state;
  }
  const saveIndex = (state) => storage.set({ [INDEX_KEY]: state.entries, [PAGE_KEY]: state.pages });
  return {
    read: (key) => serial(async () => {
      const state = await load();
      if (!fresh(state.entries.find((entry) => entry.key === key))) return null;
      const data = await storage.get(PREFIX + key);
      const value = data[PREFIX + key];
      return value && typeof value.text === 'string' && value.text.trim() ? value : null;
    }),
    write: (key, value, isCurrent = () => true) => serial(async () => {
      const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
      if (!value?.text?.trim() || bytes > 256 * 1024) return false;
      const state = await load();
      if (!isCurrent()) return false;
      state.entries = state.entries.filter((entry) => entry.key !== key);
      state.entries.push({ key, at: now(), bytes });
      await storage.set({ [PREFIX + key]: value });
      if (!isCurrent()) { await storage.remove(PREFIX + key); return false; }
      try { await saveIndex(await prune(state)); }
      catch (error) { await storage.remove(PREFIX + key); throw error; }
      return true;
    }),
    getPage: (urlKey, profile) => serial(async () => {
      const state = await load();
      const page = state.pages[urlKey];
      return fresh(page) && (!profile || page.profile === profile) && state.entries.some(fresh)
        ? { target: page.target, mode: page.mode, profile: page.profile } : null;
    }),
    setPage: (urlKey, page, isCurrent = () => true) => serial(async () => {
      const state = await load();
      if (!isCurrent()) return false;
      state.pages[urlKey] = { target: page.target, mode: page.mode, profile: page.profile, at: now() };
      await saveIndex(await prune(state));
      return true;
    }),
    clearPage: (urlKey) => serial(async () => {
      const state = await load(); delete state.pages[urlKey]; await saveIndex(state);
    }),
    status: () => serial(async () => {
      const state = await prune(await load()); await saveIndex(state);
      return { entries: state.entries.length, bytes: state.entries.reduce((sum, entry) => sum + entry.bytes, 0), pages: Object.keys(state.pages).length, ttlDays: TTL_MS / 86400000 };
    }),
    clear: () => serial(async () => {
      const state = await load();
      await storage.remove([INDEX_KEY, PAGE_KEY, ...state.entries.map((entry) => PREFIX + entry.key)]);
    })
  };
}
