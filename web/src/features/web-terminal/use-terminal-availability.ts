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
export function useTerminalAvailability(
  serverId: string,
  tabs: WebTerminalTab[],
  directoryEnabled: boolean,
  serverGeneration = 0,
) {
  const directory = useTerminalDirectory(serverId, directoryEnabled);
  const scopeSeqRef = useRef(0);
  const scopeKey = `${serverId}:${serverGeneration}`;
  const lastScopeKeyRef = useRef(scopeKey);
  if (lastScopeKeyRef.current !== scopeKey) {
    lastScopeKeyRef.current = scopeKey;
    scopeSeqRef.current += 1;
  }
  const serverScopeSeq = scopeSeqRef.current;

  const [observation, setObservation] = useState(() => ({
    serverScopeSeq,
    admitted: new Set<string>()
  }));

  useEffect(() => {
    if (!directory.enabled || directory.loading || directory.error || activeServerId() !== serverId) return;
    const live = directory.sessions.filter((item) => item.source === 'native' && item.status === 'running');
    // Empty or partial discovery cannot prove task death. Only positive evidence
    // admits a restored viewer; an already admitted viewer stays mounted even if
    // a later directory snapshot omits it. Switching server scopes requires fresh facts.
    if (!live.length) return;
    setObservation((current) => {
      const admitted = new Set(current.serverScopeSeq === serverScopeSeq ? current.admitted : []);
      for (const item of live) admitted.add(item.sessionKey);
      if (current.serverScopeSeq === serverScopeSeq && admitted.size === current.admitted.size) return current;
      return { serverScopeSeq, admitted };
    });
  }, [directory.enabled, directory.error, directory.loading, directory.sessions, serverId, serverScopeSeq]);

  const admitted = observation.serverScopeSeq === serverScopeSeq ? observation.admitted : undefined;
  const unavailableKeys = useMemo(() => new Set(tabs.filter((tab) => tab.serverId === serverId
    && tab.sessionKey.startsWith('native:') && !admitted?.has(tab.sessionKey)).map((tab) => tab.sessionKey)),
  [admitted, serverId, tabs]);
  const unavailableRef = useRef(unavailableKeys);
  unavailableRef.current = unavailableKeys;
  const interactiveTabs = useMemo(() => tabs.filter((tab) => !unavailableKeys.has(tab.sessionKey)), [tabs, unavailableKeys]);
  const unavailableTabs = useMemo(() => tabs.filter((tab) => unavailableKeys.has(tab.sessionKey)), [tabs, unavailableKeys]);
  const isUnavailable = useCallback((key: string) => unavailableRef.current.has(key), []);

  // 项目 shell（非 native 身份）没有「任务」可保：目录成功返回且连续两次快照都查不到它，
  // 就说明服务端该会话确实不存在，保留它只会留下无法接入的幽灵工位。
  const settledDirectory = directory.enabled && !directory.loading && !directory.error;
  const directoryKeys = useMemo(
    () => new Set(directory.sessions.map((item) => item.sessionKey)),
    [directory.sessions],
  );
  const missingStrikesRef = useRef(new Map<string, number>());
  const goneShellKeys = useMemo(() => {
    const gone = new Set<string>();
    if (!settledDirectory) {
      missingStrikesRef.current.clear();
      return gone;
    }
    const shellTabs = tabs.filter(
      (tab) => tab.serverId === serverId && !tab.sessionKey.startsWith('native:'),
    );
    const present = new Set<string>();
    for (const tab of shellTabs) {
      if (directoryKeys.has(tab.sessionKey)) {
        present.add(tab.sessionKey);
        missingStrikesRef.current.delete(tab.sessionKey);
        continue;
      }
      const strikes = (missingStrikesRef.current.get(tab.sessionKey) || 0) + 1;
      missingStrikesRef.current.set(tab.sessionKey, strikes);
      if (strikes >= 2) gone.add(tab.sessionKey);
    }
    for (const key of Array.from(missingStrikesRef.current.keys())) {
      if (!shellTabs.some((tab) => tab.sessionKey === key)) missingStrikesRef.current.delete(key);
    }
    return gone;
  }, [directoryKeys, serverId, settledDirectory, tabs]);

  return { directory, interactiveTabs, unavailableTabs, isUnavailable, goneShellKeys };
}
