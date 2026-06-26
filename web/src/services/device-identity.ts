type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

type NavigatorLike = {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
};

type DeviceIdentityDeps = {
  navigatorObj?: NavigatorLike | null;
  storage?: StorageLike | null;
  randomBytes?: (length: number) => Uint8Array;
};

const DEVICE_SUFFIX_STORAGE_KEY = 'aih.device.identity.suffix';
const DEVICE_ID_STORAGE_KEY = 'aih.device.identity.id';

function normalizeText(value: unknown, maxLength = 120) {
  const text = String(value ?? '').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function readNavigator(deps: DeviceIdentityDeps): NavigatorLike | null {
  if (deps.navigatorObj !== undefined) return deps.navigatorObj;
  if (typeof navigator === 'undefined') return null;
  return navigator;
}

function readStorage(deps: DeviceIdentityDeps): StorageLike | null {
  if (deps.storage !== undefined) return deps.storage;
  if (typeof window === 'undefined') return null;
  return window.localStorage || null;
}

function createRandomSuffix(randomBytes?: (length: number) => Uint8Array) {
  return createRandomHex(2, randomBytes).slice(0, 4);
}

function createRandomHex(byteLength: number, randomBytes?: (length: number) => Uint8Array) {
  const bytes = typeof randomBytes === 'function'
    ? randomBytes(byteLength)
    : createBrowserRandomBytes(byteLength);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function createBrowserRandomBytes(length: number) {
  const bytes = new Uint8Array(length);
  const cryptoObj = typeof crypto !== 'undefined' ? crypto : null;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
    return bytes;
  }
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

function resolveDeviceSuffix(storage: StorageLike | null, randomBytes?: (length: number) => Uint8Array) {
  try {
    const existing = normalizeText(storage?.getItem(DEVICE_SUFFIX_STORAGE_KEY), 16).toLowerCase();
    if (/^[a-f0-9]{4}$/.test(existing)) return existing;
  } catch (_error) {}

  const next = createRandomSuffix(randomBytes);
  try {
    storage?.setItem(DEVICE_SUFFIX_STORAGE_KEY, next);
  } catch (_error) {}
  return next;
}

function normalizeDeviceIdSegment(value: string) {
  return normalizeText(value, 32)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'web';
}

function resolveDeviceId(storage: StorageLike | null, platform: string, randomBytes?: (length: number) => Uint8Array) {
  try {
    const existing = normalizeText(storage?.getItem(DEVICE_ID_STORAGE_KEY), 96).toLowerCase();
    if (/^[a-z0-9][a-z0-9_.-]{1,63}$/.test(existing)) return existing;
  } catch (_error) {}

  const next = `device-${normalizeDeviceIdSegment(platform)}-${createRandomHex(8, randomBytes)}`.slice(0, 64);
  try {
    storage?.setItem(DEVICE_ID_STORAGE_KEY, next);
  } catch (_error) {}
  return next;
}

export function inferCurrentDevicePlatform(deps: DeviceIdentityDeps = {}) {
  const nav = readNavigator(deps);
  const userAgent = normalizeText(nav?.userAgent, 512).toLowerCase();
  const platform = normalizeText(nav?.platform, 120).toLowerCase();
  const touchPoints = Number(nav?.maxTouchPoints || 0) || 0;

  if (/iphone|ipod|ipad/.test(userAgent) || (platform.includes('mac') && touchPoints > 1)) return 'ios';
  if (userAgent.includes('android')) return 'android';
  if (userAgent.includes('windows') || platform.includes('win')) return 'windows';
  if (userAgent.includes('mac os') || platform.includes('mac')) return 'macos';
  if (userAgent.includes('linux') || platform.includes('linux')) return 'linux';
  return 'web';
}

export function getCurrentDeviceLabel(deps: DeviceIdentityDeps = {}) {
  const nav = readNavigator(deps);
  const userAgent = normalizeText(nav?.userAgent, 512).toLowerCase();
  const platform = normalizeText(nav?.platform, 120).toLowerCase();
  const touchPoints = Number(nav?.maxTouchPoints || 0) || 0;

  if (userAgent.includes('ipad') || (platform.includes('mac') && touchPoints > 1)) return 'iPad';
  if (userAgent.includes('iphone') || userAgent.includes('ipod')) return 'iPhone';
  if (userAgent.includes('android')) return 'Android';
  if (userAgent.includes('windows') || platform.includes('win')) return 'Windows';
  if (userAgent.includes('mac os') || platform.includes('mac')) return 'Mac';
  if (userAgent.includes('linux') || platform.includes('linux')) return 'Linux';
  return 'Web';
}

export function resolveCurrentDeviceIdentity(deps: DeviceIdentityDeps = {}) {
  const storage = readStorage(deps);
  const suffix = resolveDeviceSuffix(storage, deps.randomBytes);
  const platform = inferCurrentDevicePlatform(deps);
  return {
    id: resolveDeviceId(storage, platform, deps.randomBytes),
    name: `${getCurrentDeviceLabel(deps)} ${suffix}`,
    platform
  };
}
