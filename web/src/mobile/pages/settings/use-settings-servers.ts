import { message } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  addControlPlaneProfilesChangeListener,
  isControlPlaneProfileReady,
  listControlPlaneProfiles,
  syncSharedControlPlaneProfiles
} from '@/services/control-plane-profiles';
import {
  addActiveControlPlaneProfileChangeListener,
  getActiveControlPlaneProfileId,
  resolveCurrentControlPlaneProfile,
  resolveStoredActiveControlPlaneProfile,
  selectCurrentControlPlaneProfileSecure,
  syncCurrentControlPlaneProfile,
  syncStoredActiveControlPlaneProfile
} from '@/services/control-plane-selection';
import { buildServerRouteRows } from '@/services/server-route-presentation';
import type { ControlPlaneProfile } from '@/types';

// Go 账号 Preview 不初始化正式 Node Server profile 同步器（与 ControlPlaneProfileSelect 一致）。
export const SERVER_SWITCH_AVAILABLE = process.env.AIH_GO_ACCOUNTS_PREVIEW !== '1';

/** 端点与当前页面同源（localhost / ::1 归一为 127.0.0.1）即视为本机。 */
export function isLocalProfileEndpoint(endpoint?: string) {
  if (typeof window === 'undefined') return false;
  try {
    const target = new URL(String(endpoint || ''));
    const origin = new URL(window.location.origin);
    const norm = (host: string) => (host === 'localhost' || host === '::1' || host === '[::1]' ? '127.0.0.1' : host);
    return norm(target.hostname) === norm(origin.hostname);
  } catch {
    return false;
  }
}

/** 极简名：本机 / 远端 · <hostname 首段>（与桌面 footer 切换器、CurrentServerBadge 一致）。 */
export function getProfileShortName(profile: ControlPlaneProfile | null) {
  if (!profile) return '未连接';
  if (isLocalProfileEndpoint(profile.endpoint)) return '本机';
  let host = String(profile.name || profile.endpoint || profile.id);
  try {
    const parsed = new URL(String(profile.endpoint || ''));
    if (parsed.hostname) host = parsed.hostname.split('.')[0] || parsed.hostname;
  } catch {
    /* 保留 fallback 名 */
  }
  return `远端 · ${host}`;
}

/** Server 状态短文案：ready 之外只区分异常 / 离线（与桌面切换器菜单一致）。 */
export function getProfileStateLabel(profile: ControlPlaneProfile) {
  if (profile.state === 'ready') return 'READY';
  return profile.state === 'degraded' ? '异常' : '离线';
}

export { isControlPlaneProfileReady };

/**
 * 设置页的 Server 数据：
 * - current：本标签页当前连接的 Server（ControlPlaneProfileSelect 同一套 resolve / select 逻辑）；
 * - activeProfile：默认 Server 的逻辑行（保存 Management Key 时轮换的对象，与桌面 Settings 一致）。
 */
export function useSettingsServers() {
  const [profiles, setProfiles] = useState<ControlPlaneProfile[]>(() => listControlPlaneProfiles());
  const [currentProfileId, setCurrentProfileId] = useState(() => (
    resolveCurrentControlPlaneProfile(listControlPlaneProfiles()).profileId
  ));
  const [activeProfileId, setActiveProfileId] = useState(() => (
    resolveStoredActiveControlPlaneProfile(listControlPlaneProfiles(), getActiveControlPlaneProfileId()).profileId
  ));
  const [switchingId, setSwitchingId] = useState('');

  const refresh = useCallback(() => {
    const next = listControlPlaneProfiles();
    setProfiles(next);
    setCurrentProfileId(syncCurrentControlPlaneProfile(next).profileId);
    setActiveProfileId(syncStoredActiveControlPlaneProfile(next).profileId);
  }, []);

  useEffect(() => {
    if (!SERVER_SWITCH_AVAILABLE) return undefined;
    const unsubscribeActive = addActiveControlPlaneProfileChangeListener(() => refresh());
    const unsubscribeProfiles = addControlPlaneProfilesChangeListener(() => refresh());
    window.addEventListener('focus', refresh);
    // 与切换器一致：挂载时从 server 拉齐共享 profile 列表
    syncSharedControlPlaneProfiles().then(() => refresh()).catch(() => {});
    return () => {
      window.removeEventListener('focus', refresh);
      unsubscribeActive();
      unsubscribeProfiles();
    };
  }, [refresh]);

  const selectCurrent = useCallback(async (profileId: string) => {
    setSwitchingId(profileId);
    try {
      const resolution = await selectCurrentControlPlaneProfileSecure(profiles, profileId);
      setCurrentProfileId(resolution.profileId);
      return true;
    } catch (error) {
      const source = error as { code?: unknown; message?: unknown };
      message.error(String(source?.code || source?.message || '切换 Server 失败'));
      return false;
    } finally {
      setSwitchingId('');
    }
  }, [profiles]);

  const currentProfile = useMemo(
    () => profiles.find((profile) => profile.id === currentProfileId) || null,
    [currentProfileId, profiles]
  );
  const activeProfile = useMemo(
    () => buildServerRouteRows(profiles).map((row) => row.profile).find((profile) => profile.id === activeProfileId) || null,
    [activeProfileId, profiles]
  );

  return {
    profiles,
    currentProfile,
    currentProfileId,
    activeProfile,
    canSwitch: profiles.length >= 2,
    switchingId,
    selectCurrent,
    refresh
  };
}
