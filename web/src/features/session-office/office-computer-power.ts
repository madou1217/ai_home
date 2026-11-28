import { resolveActiveServer } from '@/services/webui-auth-transport';
import type { OfficeSessionItem } from './session-office-types';

/** 当前 API 作用域对应的 serverId（无可用作用域时回落 local）。 */
export function resolveLiveActiveServerId(): string {
  try {
    return String(resolveActiveServer().serverId || 'local').trim() || 'local';
  } catch {
    return 'local';
  }
}

/**
 * Validates that `serverId`, `session.serverId`, live active API server scope,
 * and (when present) `session.tab` identity/server scope all strictly agree.
 */
export function isSessionServerScopeAdmitted(
  serverId: string,
  session: Pick<OfficeSessionItem, 'serverId' | 'sessionKey' | 'tab'> | null | undefined,
): boolean {
  const sid = String(serverId || '').trim();
  const skey = String(session?.sessionKey || '').trim();
  const sessionSid = String(session?.serverId || '').trim();
  if (!sid || !skey || !sessionSid) return false;
  if (sessionSid !== sid) return false;
  if (resolveLiveActiveServerId() !== sid) return false;
  if (session?.tab) {
    const tabKey = String(session.tab.sessionKey || '').trim();
    const tabSid = String(session.tab.serverId || '').trim();
    if (!tabKey || tabKey !== skey) return false;
    if (!tabSid || tabSid !== sid) return false;
  }
  return true;
}

/**
 * Strict admission required before mounting `ShellTerminalPanel` with controlled
 * `sessionTabs`: the tab identity must match the session and server scope.
 */
export function isTerminalTabScopeAdmitted(
  serverId: string,
  session: Pick<OfficeSessionItem, 'serverId' | 'sessionKey' | 'tab'> | null | undefined,
): boolean {
  if (!isSessionServerScopeAdmitted(serverId, session)) return false;
  const tab = session?.tab;
  if (!tab) return false;
  const tabId = String(tab.id || '').trim();
  const tabKey = String(tab.sessionKey || '').trim();
  const tabSid = String(tab.serverId || '').trim();
  const sid = String(serverId || '').trim();
  const skey = String(session?.sessionKey || '').trim();
  return Boolean(tabId && tabKey === skey && tabSid === sid);
}