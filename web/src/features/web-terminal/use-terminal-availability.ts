import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveActiveServer } from '@/services/webui-auth-transport';
import { useTerminalDirectory } from './use-terminal-directory';
import type { WebTerminalTab } from './web-terminal-context';

function activeServerId() {
  try { return String(resolveActiveServer().serverId || 'local').trim() || 'local'; }
  catch { return 'local'; }
}

// Discovery is read-only. A saved identity is never an instruction to attach,
// create a viewer PTY, or forget the original task when discovery is uncertain.
export function useTerminalAvailability(serverId: string, tabs: WebTerminalTab[], overviewVisible: boolean) {
  const directory = useTerminalDirectory(serverId, overviewVisible || tabs.some((tab) => tab.sessionKey.startsWith('native:')));
  const [observation, setObservation] = useState(() => ({
    lifecycle: directory.lifecycle,
    admitted: new Set<string>()
  }));

  useEffect(() => {
    if (!directory.enabled || directory.loading || directory.error || activeServerId() !== serverId) return;
    const live = directory.sessions.filter((item) => item.source === 'native' && item.status === 'running');
    // Empty or partial discovery cannot prove task death. Only positive evidence
    // admits a restored viewer; an already admitted viewer stays mounted even if
    // a later directory snapshot omits it. Switching scopes requires fresh facts.
    if (!live.length) return;
    setObservation((current) => {
      const admitted = new Set(current.lifecycle === directory.lifecycle ? current.admitted : []);
      for (const item of live) admitted.add(item.sessionKey);
      if (current.lifecycle === directory.lifecycle && admitted.size === current.admitted.size) return current;
      return { lifecycle: directory.lifecycle, admitted };
    });
  }, [directory.enabled, directory.error, directory.lifecycle, directory.loading, directory.sessions, serverId]);

  const admitted = observation.lifecycle === directory.lifecycle ? observation.admitted : undefined;
  const unavailableKeys = useMemo(() => new Set(tabs.filter((tab) => tab.serverId === serverId
    && tab.sessionKey.startsWith('native:') && !admitted?.has(tab.sessionKey)).map((tab) => tab.sessionKey)),
  [admitted, serverId, tabs]);
  const unavailableRef = useRef(unavailableKeys);
  unavailableRef.current = unavailableKeys;
  const interactiveTabs = useMemo(() => tabs.filter((tab) => !unavailableKeys.has(tab.sessionKey)), [tabs, unavailableKeys]);
  const unavailableTabs = useMemo(() => tabs.filter((tab) => unavailableKeys.has(tab.sessionKey)), [tabs, unavailableKeys]);
  const isUnavailable = useCallback((key: string) => unavailableRef.current.has(key), []);
  return { directory, interactiveTabs, unavailableTabs, isUnavailable };
}
