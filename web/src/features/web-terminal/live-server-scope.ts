import { resolveActiveServer } from '@/services/webui-auth-transport';

/** 当前 API 作用域对应的 serverId（无可用作用域时回落 local）。 */
export function resolveLiveActiveServerId(): string {
  try {
    return String(resolveActiveServer().serverId || 'local').trim() || 'local';
  } catch {
    return 'local';
  }
}