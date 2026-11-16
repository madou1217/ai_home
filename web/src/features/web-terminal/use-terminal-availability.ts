import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { terminalAPI } from '@/services/api';
import { resolveActiveServer } from '@/services/webui-auth-transport';
import { useTerminalDirectory } from './use-terminal-directory';
import type { WebTerminalTab } from './web-terminal-context';

function activeServerId() {
  try { return String(resolveActiveServer().serverId || 'local').trim() || 'local'; }
  catch { return 'local'; }
}

// Availability is a current observation, never a persisted deletion of a task.
export function useTerminalAvailability(serverId: string, tabs: WebTerminalTab[], overviewVisible: boolean) {
  const directory = useTerminalDirectory(serverId, overviewVisible || tabs.some((tab) => tab.sessionKey.startsWith('native:')));
  const scope = useRef({ serverId, epoch: 0 });
  if (scope.current.serverId !== serverId) scope.current = { serverId, epoch: scope.current.epoch + 1 };
  const scopeKey = `${serverId}:${scope.current.epoch}`;
  const activeScope = useRef(scopeKey);
  activeScope.current = scopeKey;
  const [checkedScope, setCheckedScope] = useState('');
  const [unavailableByServer, setUnavailableByServer] = useState<Record<string, string[]>>({});
  const [checkingByScope, setCheckingByScope] = useState<Record<string, string[]>>({});
  const unavailableRef = useRef(unavailableByServer);
  unavailableRef.current = unavailableByServer;
  const latest = useRef<{ scopeKey: string; keys: Set<string> } | null>(null);
  const revisions = useRef(new Map<string, number>());
  const continuity = useRef(0);
  const probes = useRef(new Map<string, Promise<void>>());
  const admitted = useRef(new Set<string>());

  useEffect(() => {
    activeScope.current = scopeKey;
    return () => { activeScope.current = ''; latest.current = null; };
  }, [scopeKey]);

  useEffect(() => {
    if (directory.loading) return;
    const live = new Set(directory.sessions.filter((item) => item.source === 'native'
      && item.status === 'running').map((item) => item.sessionKey));
    // Empty/unsupported and failed discovery invalidate in-flight evidence;
    // neither proves task death. Do not strand a previous scope's checking.
    if (directory.error || !live.size) {
      continuity.current += 1;
      latest.current = null;
      setCheckingByScope((current) => ({ ...current, [scopeKey]: [] }));
      for (const tab of tabs) admitted.current.add(`${scopeKey}:${tab.sessionKey}`);
      setCheckedScope(scopeKey);
      return;
    }
    latest.current = { scopeKey, keys: live };
    for (const key of live) {
      const address = `${scopeKey}:${key}`;
      revisions.current.set(address, (revisions.current.get(address) || 0) + 1);
      admitted.current.add(address);
    }
    setUnavailableByServer((current) => {
      const previous = current[serverId] || [];
      const next = previous.filter((key) => !live.has(key));
      return next.length === previous.length ? current : { ...current, [serverId]: next };
    });
    const known = new Set(unavailableRef.current[serverId] || []);
    const candidates = tabs.filter((tab) => tab.serverId === serverId && tab.sessionKey.startsWith('native:')
      && !live.has(tab.sessionKey) && !known.has(tab.sessionKey));
    // Only an unverified first attachment waits for a probe. Background checks
    // must never unmount an already-admitted viewer every polling interval.
    setCheckingByScope((current) => ({ ...current, [scopeKey]: candidates
      .filter((tab) => !admitted.current.has(`${scopeKey}:${tab.sessionKey}`)).map((tab) => tab.sessionKey) }));
    setCheckedScope(scopeKey);
    const epoch = continuity.current;
    const probeMux = `directory-check-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    for (const tab of candidates) {
      const address = `${scopeKey}:${tab.sessionKey}`;
      const revision = revisions.current.get(address) || 0;
      const probeKey = `${address}:${epoch}:${revision}`;
      if (probes.current.has(probeKey)) continue;
      const isCurrent = () => activeScope.current === scopeKey && activeServerId() === serverId
        && continuity.current === epoch && (revisions.current.get(address) || 0) === revision
        && latest.current?.scopeKey === scopeKey && !latest.current.keys.has(tab.sessionKey);
      const probe = (async () => {
        try {
          // No mux watcher: a live key cannot create a viewer PTY here.
          const result = await terminalAPI.attach(tab.sessionKey, probeMux);
          if (isCurrent() && result.error === 'terminal_not_found') {
            setUnavailableByServer((current) => ({
              ...current, [serverId]: [...new Set([...(current[serverId] || []), tab.sessionKey])],
            }));
          }
        } catch { /* Authorization/transport failures are not task death. */ }
        finally {
          probes.current.delete(probeKey);
          if (isCurrent()) {
            admitted.current.add(address);
            setCheckingByScope((current) => ({
              ...current, [scopeKey]: (current[scopeKey] || []).filter((key) => key !== tab.sessionKey),
            }));
          }
        }
      })();
      probes.current.set(probeKey, probe);
    }
  }, [directory.error, directory.loading, directory.sessions, scopeKey, serverId, tabs]);

  const unavailableKeys = useMemo(() => new Set(unavailableByServer[serverId] || []), [serverId, unavailableByServer]);
  const interactiveTabs = useMemo(() => tabs.filter((tab) => !unavailableKeys.has(tab.sessionKey)
    && (!tab.sessionKey.startsWith('native:') || (checkedScope === scopeKey
      && !checkingByScope[scopeKey]?.includes(tab.sessionKey)))),
  [checkedScope, checkingByScope, scopeKey, tabs, unavailableKeys]);
  const unavailableTabs = useMemo(() => tabs.filter((tab) => unavailableKeys.has(tab.sessionKey)), [tabs, unavailableKeys]);
  const isUnavailable = useCallback((key: string) => unavailableRef.current[serverId]?.includes(key) || false, [serverId]);
  return { directory, interactiveTabs, unavailableTabs, isUnavailable };
}
