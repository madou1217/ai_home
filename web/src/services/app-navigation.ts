import { isNativeDesktopRuntime } from './native-server-profile-repository';

export function buildAppHref(pathname: string, search = '') {
  const path = String(pathname || '').startsWith('/') ? pathname : `/${pathname}`;
  const query = search && !String(search).startsWith('?') ? `?${search}` : search;
  return isNativeDesktopRuntime()
    ? `#${path}${query || ''}`
    : `/ui${path}${query || ''}`;
}
