export type WebTerminalTabOrigin = 'explicit' | 'adopted';

export interface WebTerminalTabIdentity {
  sessionKey: string;
  origin?: WebTerminalTabOrigin;
}

/**
 * Normalizes tab provenance across persisted v1 records.
 *
 * Legacy v1 tabs without an explicit `origin` field were historically populated
 * by office directory adoption (`adoptSessions`), so they default to `'adopted'`
 * rather than re-waking the global floating overlay. Existing session identities
 * remain intact in manager state for `/terminals` and are
 * promoted to `'explicit'` whenever the user actively opens or selects them
 * outside the office routes.
 */
export function normalizeTabOrigin(rawOrigin: unknown): WebTerminalTabOrigin {
  return rawOrigin === 'explicit' ? 'explicit' : 'adopted';
}

export function promoteTabOrigin(
  existing: WebTerminalTabOrigin | undefined,
  requested: WebTerminalTabOrigin,
): WebTerminalTabOrigin {
  if (existing === 'explicit' || requested === 'explicit') return 'explicit';
  return 'adopted';
}

export function isFloatingHostTab(tab: Pick<WebTerminalTabIdentity, 'origin'>): boolean {
  return tab.origin === 'explicit';
}

export function shouldPollTerminalDirectory(options: {
  overviewVisible: boolean;
  officeRouteOwned: boolean;
  floatingOpen: boolean;
  tabs: ReadonlyArray<WebTerminalTabIdentity>;
}): boolean {
  if (options.overviewVisible || options.officeRouteOwned) return true;
  if (!options.floatingOpen) return false;
  return options.tabs.some((tab) => isFloatingHostTab(tab) && tab.sessionKey.startsWith('native:'));
}

export function isFloatingViewerVisible(options: {
  floatingOpen: boolean;
  floatingServerId: string;
  floatingServerGeneration: number;
  currentServerId: string;
  currentServerGeneration: number;
  overviewVisible: boolean;
  officeRouteOwned: boolean;
  hasFloatingTabs: boolean;
}): boolean {
  return Boolean(
    options.floatingOpen
    && options.floatingServerId
    && options.floatingServerId === options.currentServerId
    && options.floatingServerGeneration > 0
    && options.floatingServerGeneration === options.currentServerGeneration
    && !options.overviewVisible
    && !options.officeRouteOwned
    && options.hasFloatingTabs,
  );
}
