import { isNativeDesktopRuntime } from './native-server-profile-repository';

const BROWSER_APP_BASE_PATH = '/ui';

export function resolveAppRoutePathname(pathname: string) {
  const raw = String(pathname || '').trim().split(/[?#]/u, 1)[0];
  const normalized = `${raw.startsWith('/') ? '' : '/'}${raw}`.replace(/\/+$/u, '') || '/';
  if (normalized === BROWSER_APP_BASE_PATH) return '/';
  if (normalized.startsWith(`${BROWSER_APP_BASE_PATH}/`)) {
    return normalized.slice(BROWSER_APP_BASE_PATH.length) || '/';
  }
  return normalized;
}

export function buildAppHref(pathname: string, search = '') {
  const path = String(pathname || '').startsWith('/') ? pathname : `/${pathname}`;
  const query = search && !String(search).startsWith('?') ? `?${search}` : search;
  return isNativeDesktopRuntime()
    ? `#${path}${query || ''}`
    : `${BROWSER_APP_BASE_PATH}${path}${query || ''}`;
}
