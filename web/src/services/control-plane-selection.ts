import type { ControlPlaneProfile } from '@/types';
import { resolveWebUiManagementKey } from './webui-auth-transport';
import {
  isNativeDesktopRuntime,
  setActiveNativeServerProfile
} from './native-server-profile-repository';

const ACTIVE_CONTROL_PLANE_STORAGE_KEY = 'aih:active-control-plane-profile:v1';
export const ACTIVE_CONTROL_PLANE_CHANGED_EVENT = 'aih:active-control-plane-profile-changed';
const SHARED_PROFILE_ACTIVE_API_PATH = '/v0/webui/control-plane/profiles/active';

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface ActiveControlPlaneChangeDetail {
  profileId: string;
  previousProfileId: string;
}

export interface ActiveControlPlaneResolution {
  profile: ControlPlaneProfile | null;
  profileId: string;
  source: 'stored' | 'ready' | 'first' | 'none';
}

function getStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage || null;
}

function getEventTarget(): EventTarget | null {
  if (typeof window === 'undefined') return null;
  if (typeof window.addEventListener !== 'function' || typeof window.dispatchEvent !== 'function') return null;
  return window;
}

function getSharedProfileFetch(): typeof fetch | null {
  if (typeof window === 'undefined' || isNativeDesktopRuntime()) return null;
  const fetcher = (window as Window & { fetch?: typeof fetch }).fetch;
  return typeof fetcher === 'function' ? fetcher.bind(window) : null;
}

function normalizeProfileId(value: unknown) {
  return String(value ?? '').trim().slice(0, 96);
}

function createActiveControlPlaneChangeEvent(detail: ActiveControlPlaneChangeDetail) {
  if (typeof CustomEvent === 'function') {
    return new CustomEvent<ActiveControlPlaneChangeDetail>(ACTIVE_CONTROL_PLANE_CHANGED_EVENT, { detail });
  }
  const event = new Event(ACTIVE_CONTROL_PLANE_CHANGED_EVENT);
  Object.defineProperty(event, 'detail', {
    value: detail,
    enumerable: true
  });
  return event as CustomEvent<ActiveControlPlaneChangeDetail>;
}

function emitActiveControlPlaneProfileChange(
  detail: ActiveControlPlaneChangeDetail,
  eventTarget = getEventTarget()
) {
  if (!eventTarget || typeof eventTarget.dispatchEvent !== 'function'
    || detail.profileId === detail.previousProfileId) return;
  eventTarget.dispatchEvent(createActiveControlPlaneChangeEvent(detail));
}

function persistSharedActiveControlPlaneProfileId(profileId: string) {
  const fetcher = getSharedProfileFetch();
  const id = normalizeProfileId(profileId);
  const managementKey = resolveWebUiManagementKey();
  if (!fetcher) return;
  fetcher(SHARED_PROFILE_ACTIVE_API_PATH, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(managementKey ? { authorization: `Bearer ${managementKey}` } : {})
    },
    credentials: 'same-origin',
    body: JSON.stringify({ profileId: id })
  }).catch(() => {});
}

export function getActiveControlPlaneProfileId(storage = getStorage()) {
  if (!storage) return '';
  return normalizeProfileId(storage.getItem(ACTIVE_CONTROL_PLANE_STORAGE_KEY));
}

export function setActiveControlPlaneProfileId(
  profileId: string,
  storage = getStorage(),
  eventTarget = getEventTarget()
) {
  const id = normalizeProfileId(profileId);
  const previousProfileId = getActiveControlPlaneProfileId(storage);
  if (!storage) return id;
  if (!id) {
    storage.removeItem(ACTIVE_CONTROL_PLANE_STORAGE_KEY);
    emitActiveControlPlaneProfileChange({ profileId: '', previousProfileId }, eventTarget);
    persistSharedActiveControlPlaneProfileId('');
    return '';
  }
  storage.setItem(ACTIVE_CONTROL_PLANE_STORAGE_KEY, id);
  emitActiveControlPlaneProfileChange({ profileId: id, previousProfileId }, eventTarget);
  persistSharedActiveControlPlaneProfileId(id);
  return id;
}

export async function setActiveControlPlaneProfileIdSecure(
  profileId: string,
  storage = getStorage(),
  eventTarget = getEventTarget()
) {
  const id = normalizeProfileId(profileId);
  if (isNativeDesktopRuntime()) {
    await setActiveNativeServerProfile(id);
  }
  return setActiveControlPlaneProfileId(id, storage, eventTarget);
}

export function clearActiveControlPlaneProfileId(storage = getStorage(), eventTarget = getEventTarget()) {
  setActiveControlPlaneProfileId('', storage, eventTarget);
}

export function addActiveControlPlaneProfileChangeListener(
  listener: (detail: ActiveControlPlaneChangeDetail) => void,
  eventTarget = getEventTarget()
) {
  if (!eventTarget || typeof eventTarget.addEventListener !== 'function'
    || typeof eventTarget.removeEventListener !== 'function') return () => {};
  const notify = (detail: ActiveControlPlaneChangeDetail) => {
    const normalized = {
      profileId: normalizeProfileId(detail && detail.profileId),
      previousProfileId: normalizeProfileId(detail && detail.previousProfileId)
    };
    if (normalized.profileId !== normalized.previousProfileId) listener(normalized);
  };
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<ActiveControlPlaneChangeDetail>).detail;
    notify(detail);
  };
  const storageHandler = (event: Event) => {
    const storageEvent = event as StorageEvent;
    if (storageEvent.key !== ACTIVE_CONTROL_PLANE_STORAGE_KEY) return;
    notify({
      profileId: normalizeProfileId(storageEvent.newValue),
      previousProfileId: normalizeProfileId(storageEvent.oldValue)
    });
  };
  eventTarget.addEventListener(ACTIVE_CONTROL_PLANE_CHANGED_EVENT, handler);
  eventTarget.addEventListener('storage', storageHandler);
  return () => {
    eventTarget.removeEventListener(ACTIVE_CONTROL_PLANE_CHANGED_EVENT, handler);
    eventTarget.removeEventListener('storage', storageHandler);
  };
}

function findStoredProfile(profiles: ControlPlaneProfile[], storedProfileId: string) {
  if (!storedProfileId) return null;
  return profiles.find((item) => item.id === storedProfileId) || null;
}

function findPreferredProfile(profiles: ControlPlaneProfile[]) {
  return profiles.find((profile) => profile.state === 'ready')
    || profiles[0]
    || null;
}

function resolveControlPlaneProfile(
  profiles: ControlPlaneProfile[],
  storedProfileId: string
): ActiveControlPlaneResolution {
  const items = Array.isArray(profiles) ? profiles : [];
  const stored = findStoredProfile(items, normalizeProfileId(storedProfileId));
  if (stored) {
    return {
      profile: stored,
      profileId: stored.id,
      source: 'stored'
    };
  }
  const preferred = findPreferredProfile(items);
  if (!preferred) {
    return {
      profile: null,
      profileId: '',
      source: 'none'
    };
  }
  return {
    profile: preferred,
    profileId: preferred.id,
    source: preferred.state === 'ready' ? 'ready' : 'first'
  };
}

export function resolveActiveControlPlaneProfile(
  profiles: ControlPlaneProfile[],
  storedProfileId = getActiveControlPlaneProfileId()
): ActiveControlPlaneResolution {
  return resolveControlPlaneProfile(profiles, storedProfileId);
}

export function resolveStoredActiveControlPlaneProfile(
  profiles: ControlPlaneProfile[],
  storedProfileId = getActiveControlPlaneProfileId()
): ActiveControlPlaneResolution {
  return resolveControlPlaneProfile(profiles, storedProfileId);
}

export function syncStoredActiveControlPlaneProfile(
  profiles: ControlPlaneProfile[],
  storage = getStorage(),
  eventTarget = getEventTarget()
): ActiveControlPlaneResolution {
  const storedProfileId = getActiveControlPlaneProfileId(storage);
  const resolution = resolveStoredActiveControlPlaneProfile(profiles, storedProfileId);
  if (storage && resolution.profileId !== storedProfileId) {
    setActiveControlPlaneProfileId(resolution.profileId, storage, eventTarget);
  }
  return resolution;
}

export function selectActiveControlPlaneProfile(
  profiles: ControlPlaneProfile[],
  profileId: string,
  storage = getStorage()
): ActiveControlPlaneResolution {
  const id = setActiveControlPlaneProfileId(profileId, storage);
  return resolveActiveControlPlaneProfile(profiles, id);
}

export async function selectActiveControlPlaneProfileSecure(
  profiles: ControlPlaneProfile[],
  profileId: string,
  storage = getStorage()
) {
  const id = await setActiveControlPlaneProfileIdSecure(profileId, storage);
  return resolveActiveControlPlaneProfile(profiles, id);
}
