import { useEffect, useState } from 'react';
import { message } from 'antd';
import {
  isControlPlaneManagementKeyConfigured,
  isControlPlaneProfileReady,
  listControlPlaneProfiles,
  refreshControlPlaneDeviceState,
  removeControlPlaneProfileSecure,
  saveControlPlaneProfileSecure,
  syncSharedControlPlaneProfiles
} from '@/services/control-plane-profiles';
import {
  getActiveControlPlaneProfileId,
  resolveStoredActiveControlPlaneProfile,
  selectActiveControlPlaneProfile,
  selectActiveControlPlaneProfileSecure,
  syncStoredActiveControlPlaneProfile
} from '@/services/control-plane-selection';
import { connectControlPlaneProfile } from '@/services/control-plane-profile-connection';
import type { ControlPlaneProfile } from '@/types';

export type ServerSetupFormValues = {
  endpoint?: string;
  name?: string;
  managementKey?: string;
};

export function normalizeServerSetupError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || '操作失败');
}

/** 已保存 Server 的状态灯 / 文案（与首启页一致：ready / degraded / offline）。 */
export function getServerSetupProfileStatus(profile: ControlPlaneProfile) {
  if (isControlPlaneProfileReady(profile)) return { color: 'green', tone: 'ok' as const, label: 'ready' };
  if (profile.state === 'degraded') return { color: 'orange', tone: 'warn' as const, label: 'degraded' };
  return { color: 'default', tone: 'muted' as const, label: 'offline' };
}

export function formatServerSetupProfileDetail(profile: ControlPlaneProfile) {
  const chunks = [
    `${profile.schedulableAccountCount} 可调度账号`,
    `${profile.sessionCount} 会话`
  ];
  return chunks.join(' · ');
}

function getInitialProfiles() {
  const profiles = listControlPlaneProfiles();
  const active = resolveStoredActiveControlPlaneProfile(profiles, getActiveControlPlaneProfileId());
  return { profiles, activeProfileId: active.profileId };
}

/**
 * 首启 / 切换 Server 页（/server-setup）的数据与操作：本地已保存 Server 列表、当前 Server，
 * 以及连接（探测 + 同步 + 设为当前）、同步、移除、设为当前。桌面 FabricServerSetup 与移动端
 * MobileServerSetup 共用；弹窗 / 表单等视图状态由页面持有。
 */
export function useServerSetupProfiles() {
  const [initialState] = useState(getInitialProfiles);
  const [profiles, setProfiles] = useState<ControlPlaneProfile[]>(initialState.profiles);
  const [activeProfileId, setActiveProfileId] = useState(initialState.activeProfileId);
  const [checkingId, setCheckingId] = useState('');
  const [saving, setSaving] = useState(false);

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) || null;
  const readyProfiles = profiles.filter(isControlPlaneProfileReady);
  const hasReadyServer = readyProfiles.length > 0;

  const syncProfiles = (preferredProfileId = '') => {
    const nextProfiles = listControlPlaneProfiles();
    const resolution = preferredProfileId
      ? selectActiveControlPlaneProfile(nextProfiles, preferredProfileId)
      : syncStoredActiveControlPlaneProfile(nextProfiles);
    setProfiles(nextProfiles);
    setActiveProfileId(resolution.profileId);
    return resolution;
  };

  useEffect(() => {
    let cancelled = false;
    syncSharedControlPlaneProfiles()
      .then((result) => {
        if (cancelled) return;
        const nextProfiles = result.profiles.length > 0 ? result.profiles : listControlPlaneProfiles();
        const preferredProfileId = result.activeProfileId || activeProfileId;
        const resolution = preferredProfileId
          ? selectActiveControlPlaneProfile(nextProfiles, preferredProfileId)
          : syncStoredActiveControlPlaneProfile(nextProfiles);
        setProfiles(nextProfiles);
        setActiveProfileId(resolution.profileId);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // 只在挂载时与共享 Server 列表对齐一次（与桌面首启页一致）
  }, []);

  /**
   * 连接 Server：探测 + 刷新设备状态 + 设为当前。
   * 刷新失败时把 Server 记为 degraded 并仍设为当前，然后提示错误。成功返回 true。
   */
  const saveServer = async (profileId: string, values: ServerSetupFormValues): Promise<boolean> => {
    setSaving(true);
    try {
      const profile = await connectControlPlaneProfile({
        profiles,
        profileId,
        endpoint: values.endpoint,
        name: values.name,
        managementKey: values.managementKey
      });
      try {
        await refreshControlPlaneDeviceState(profile);
      } catch (error) {
        await saveControlPlaneProfileSecure({
          name: profile.name,
          stableServerId: profile.stableServerId,
          endpoint: profile.endpoint,
          routes: profile.routes,
          activeRouteId: profile.activeRouteId,
          descriptor: profile.descriptor,
          state: 'degraded',
          managementKey: profile.managementKey,
          credentialRef: profile.credentialRef,
          managementKeyConfigured: profile.managementKeyConfigured,
          lastError: normalizeServerSetupError(error)
        });
        await selectActiveControlPlaneProfileSecure(listControlPlaneProfiles(), profile.id);
        syncProfiles();
        throw error;
      }
      await selectActiveControlPlaneProfileSecure(listControlPlaneProfiles(), profile.id);
      syncProfiles();
      message.success('Server 已保存并设为当前');
      return true;
    } catch (error) {
      message.error(normalizeServerSetupError(error));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const refreshProfile = async (profile: ControlPlaneProfile) => {
    setCheckingId(profile.id);
    try {
      if (!isControlPlaneManagementKeyConfigured(profile)) throw new Error('missing_management_key');
      await refreshControlPlaneDeviceState(profile);
      message.success('Server 已同步');
      syncProfiles();
    } catch (error) {
      await saveControlPlaneProfileSecure({
        name: profile.name,
        endpoint: profile.endpoint,
        descriptor: profile.descriptor,
        state: isControlPlaneManagementKeyConfigured(profile) ? 'degraded' : 'offline',
        managementKey: profile.managementKey,
        credentialRef: profile.credentialRef,
        managementKeyConfigured: profile.managementKeyConfigured,
        lastError: normalizeServerSetupError(error)
      });
      syncProfiles();
      message.error(normalizeServerSetupError(error));
    } finally {
      setCheckingId('');
    }
  };

  const removeProfile = async (profileId: string) => {
    try {
      await removeControlPlaneProfileSecure(profileId);
      syncProfiles();
    } catch (error) {
      message.error(normalizeServerSetupError(error));
    }
  };

  const selectProfile = async (profileId: string) => {
    try {
      const resolution = await selectActiveControlPlaneProfileSecure(profiles, profileId);
      setActiveProfileId(resolution.profileId);
    } catch (error) {
      message.error(normalizeServerSetupError(error));
    }
  };

  return {
    profiles,
    activeProfileId,
    activeProfile,
    readyProfiles,
    hasReadyServer,
    checkingId,
    saving,
    saveServer,
    refreshProfile,
    removeProfile,
    selectProfile
  };
}
