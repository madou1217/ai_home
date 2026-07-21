import {
  isNativeDesktopRuntime,
  listNativeServerProfiles,
  refreshNativeLanRoutes
} from '../native-server-profile-repository';

const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
let refreshTimer: number | null = null;

export async function refreshAuthorizedNativeLanRoutes(timeoutMs = 1_500) {
  if (!isNativeDesktopRuntime()) return null;
  const native = await listNativeServerProfiles();
  const profileIds = native.profiles
    .filter((profile) => profile.managementKeyConfigured)
    .map((profile) => profile.id);
  if (profileIds.length === 0) return null;
  return refreshNativeLanRoutes(profileIds, timeoutMs);
}

/**
 * Keep short-lived LAN route proofs fresh without delaying Desktop startup.
 * Native re-discovers endpoints and reads saved Keys from Keychain; the
 * renderer supplies profile IDs only.
 */
export function startNativeLanRouteRefresh(options: {
  intervalMs?: number;
  timeoutMs?: number;
} = {}) {
  if (!isNativeDesktopRuntime() || typeof window === 'undefined') return;
  const timeoutMs = Math.max(250, Math.min(10_000, Math.floor(options.timeoutMs || 1_500)));
  const intervalMs = Math.max(
    30_000,
    Math.min(300_000, Math.floor(options.intervalMs || DEFAULT_REFRESH_INTERVAL_MS))
  );
  void refreshAuthorizedNativeLanRoutes(timeoutMs).catch(() => {});
  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => {
    void refreshAuthorizedNativeLanRoutes(timeoutMs).catch(() => {});
  }, intervalMs);
}
