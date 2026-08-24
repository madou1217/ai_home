export const EXPLICIT_SERVER_QUERY_KEY = 'server';
export const EXPLICIT_SERVER_SESSION_KEY = 'aih:explicit-control-plane-profile:v1';

interface LocationLike {
  search?: string;
  hash?: string;
  pathname?: string;
}

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function normalizeProfileId(value: unknown) {
  return String(value ?? '').trim().slice(0, 96);
}

function getLocation(): LocationLike | null {
  return typeof window === 'undefined' ? null : window.location;
}

function getSessionStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage || null;
  } catch (_error) {
    return null;
  }
}

function readRouteSearch(location: LocationLike | null) {
  const search = String(location?.search || '');
  if (new URLSearchParams(search).has(EXPLICIT_SERVER_QUERY_KEY)) return search;
  const hash = String(location?.hash || '');
  const hashQueryIndex = hash.indexOf('?');
  if (hashQueryIndex >= 0) return hash.slice(hashQueryIndex);
  return search;
}

function readExplicitQuery(location: LocationLike | null) {
  const params = new URLSearchParams(readRouteSearch(location));
  return {
    present: params.has(EXPLICIT_SERVER_QUERY_KEY),
    profileId: normalizeProfileId(params.get(EXPLICIT_SERVER_QUERY_KEY))
  };
}

function persistExplicitProfileId(profileId: string, storage: StorageLike | null) {
  if (!storage) return;
  try {
    if (profileId) storage.setItem(EXPLICIT_SERVER_SESSION_KEY, profileId);
    else storage.removeItem(EXPLICIT_SERVER_SESSION_KEY);
  } catch (_error) {
    // Storage can be unavailable in hardened browser contexts; the URL remains authoritative.
  }
}

export function getExplicitServerProfileId(
  location: LocationLike | null = getLocation(),
  storage: StorageLike | null = getSessionStorage()
) {
  const query = readExplicitQuery(location);
  if (query.present) {
    persistExplicitProfileId(query.profileId, storage);
    return query.profileId;
  }
  try {
    return normalizeProfileId(storage?.getItem(EXPLICIT_SERVER_SESSION_KEY));
  } catch (_error) {
    return '';
  }
}

export function getEffectiveServerProfileId(
  defaultProfileId: string,
  location: LocationLike | null = getLocation(),
  storage: StorageLike | null = getSessionStorage()
) {
  return getExplicitServerProfileId(location, storage) || normalizeProfileId(defaultProfileId);
}

export function hasExplicitServerSelection(
  location: LocationLike | null = getLocation(),
  storage: StorageLike | null = getSessionStorage()
) {
  return Boolean(getExplicitServerProfileId(location, storage));
}

export function buildServerScopedSearch(search: string, profileId: string) {
  const params = new URLSearchParams(String(search || '').replace(/^\?/u, ''));
  const id = normalizeProfileId(profileId);
  if (id) params.set(EXPLICIT_SERVER_QUERY_KEY, id);
  else params.delete(EXPLICIT_SERVER_QUERY_KEY);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

export function buildServerScopedHref(href: string, profileId: string) {
  const source = String(href || '');
  const hashRoute = source.startsWith('#');
  const fragmentIndex = hashRoute ? -1 : source.indexOf('#');
  const fragment = fragmentIndex >= 0 ? source.slice(fragmentIndex) : '';
  const route = fragmentIndex >= 0 ? source.slice(0, fragmentIndex) : source;
  const queryIndex = route.indexOf('?');
  const pathname = queryIndex >= 0 ? route.slice(0, queryIndex) : route;
  const search = queryIndex >= 0 ? route.slice(queryIndex) : '';
  return `${pathname}${buildServerScopedSearch(search, profileId)}${fragment}`;
}

export function setExplicitServerProfileId(
  profileId: string,
  options: {
    location?: LocationLike | null;
    storage?: StorageLike | null;
    replaceState?: (data: unknown, unused: string, url?: string | URL | null) => void;
  } = {}
) {
  const id = normalizeProfileId(profileId);
  const location = options.location === undefined ? getLocation() : options.location;
  const storage = options.storage === undefined ? getSessionStorage() : options.storage;
  persistExplicitProfileId(id, storage);
  const replaceState = options.replaceState
    || (typeof window !== 'undefined' ? window.history?.replaceState?.bind(window.history) : undefined);
  if (!replaceState || !location) return id;
  const hash = String(location.hash || '');
  const currentHref = hash.startsWith('#/')
    ? hash
    : `${String(location.pathname || '')}${String(location.search || '')}${hash}`;
  replaceState(null, '', buildServerScopedHref(currentHref, id));
  return id;
}
