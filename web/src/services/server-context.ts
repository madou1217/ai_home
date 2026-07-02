import { useEffect, useState } from 'react';
import type { ControlPlaneProfile } from '@/types';
import {
  addControlPlaneProfilesChangeListener,
  isControlPlaneProfileReady,
  listControlPlaneProfiles
} from './control-plane-profiles';
import {
  addActiveControlPlaneProfileChangeListener,
  resolveStoredActiveControlPlaneProfile
} from './control-plane-selection';

/* ── Server 上下文（R1）：当前激活的 server 是哪个，数据该从哪取 ──
 * 单一真相：激活 profile → { profile, endpoint, deviceToken, isLocal }。
 * - isLocal: profile.endpoint 与当前页面同源（回环等价）→ 走本地 /v0/webui/*（完整 UI）。
 * - 远端：直连 profile.endpoint + 其 deviceToken（/v0/node-rpc/device-*），不走本地代理。
 * 页面订阅切换事件即可让数据全跟随当前 server。 */

export interface ServerContext {
  profile: ControlPlaneProfile | null;
  profileId: string;
  displayName: string;
  endpoint: string;
  deviceToken: string;
  isLocal: boolean;
  ready: boolean;
}

function normalizeHost(host: string) {
  const value = String(host || '').toLowerCase();
  return value === 'localhost' || value === '[::1]' || value === '::1' ? '127.0.0.1' : value;
}

function isSameOriginEndpoint(endpoint: string) {
  try {
    if (typeof window === 'undefined') return false;
    const origin = new URL(window.location.origin);
    const target = new URL(String(endpoint || ''));
    return normalizeHost(target.hostname) === normalizeHost(origin.hostname)
      && String(target.port || '80') === String(origin.port || '80');
  } catch (_error) {
    return false;
  }
}

export function resolveServerContext(): ServerContext {
  const profiles = listControlPlaneProfiles();
  const active = resolveStoredActiveControlPlaneProfile(profiles);
  const profile = active.profile;
  const endpoint = String(profile?.endpoint || '');
  const isLocal = isSameOriginEndpoint(endpoint);
  return {
    profile: profile || null,
    profileId: active.profileId || '',
    // 本机不显示 127.0.0.1，显示「本机」（可读性）。
    displayName: profile ? (isLocal ? '本机' : String(profile.name || endpoint || profile.id)) : '本机',
    endpoint,
    deviceToken: String(profile?.deviceToken || ''),
    isLocal,
    ready: Boolean(profile && isControlPlaneProfileReady(profile))
  };
}

/** 订阅当前 server 上下文（切换 server / profile 变更 / 窗口聚焦时刷新）。 */
export function useActiveServerContext(): ServerContext {
  const [context, setContext] = useState<ServerContext>(() => resolveServerContext());
  useEffect(() => {
    const refresh = () => setContext(resolveServerContext());
    const offActive = addActiveControlPlaneProfileChangeListener(refresh);
    const offProfiles = addControlPlaneProfilesChangeListener(refresh);
    const onFocus = () => refresh();
    if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
    refresh();
    return () => {
      offActive();
      offProfiles();
      if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
    };
  }, []);
  return context;
}
