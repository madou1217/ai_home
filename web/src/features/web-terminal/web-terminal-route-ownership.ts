import { useSyncExternalStore } from 'react';
import { history } from '@umijs/max';
import { resolveAppRoutePathname } from '@/services/app-navigation';

export function isOfficeTerminalRoute(): boolean {
  if (typeof window === 'undefined') return false;
  const { pathname, hash } = window.location;
  const route = resolveAppRoutePathname(hash.startsWith('#/') ? hash.slice(1) : pathname);
  return route === '/terminals';
}

function getOfficeRouteOwnership(): boolean {
  return isOfficeTerminalRoute();
}

function subscribeOfficeRouteOwnership(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const unlisten = history?.listen(listener);
  window.addEventListener('popstate', listener);
  window.addEventListener('hashchange', listener);
  return () => {
    unlisten?.();
    window.removeEventListener('popstate', listener);
    window.removeEventListener('hashchange', listener);
  };
}

function getServerOfficeRouteOwnership(): boolean {
  return false;
}

// The global host is outside Router context and can render before the lazy
// office page. Route ownership must precede its layout-effect handoff so a
// saved shell cannot be recreated by the generic terminal during that gap.
export function useOfficeTerminalRouteOwnership(): boolean {
  return useSyncExternalStore(
    subscribeOfficeRouteOwnership,
    getOfficeRouteOwnership,
    getServerOfficeRouteOwnership,
  );
}
