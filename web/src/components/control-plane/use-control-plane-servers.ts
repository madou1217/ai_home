import { useEffect, useState } from 'react';
import { message } from 'antd';
import { serverProfilesAPI } from '@/services/api';
import {
  addControlPlaneProfilesChangeListener,
  isControlPlaneManagementKeyConfigured,
  isControlPlaneProfileRefreshable,
  listControlPlaneProfiles,
  refreshControlPlaneDeviceState,
  refreshControlPlaneProfileStates,
  removeControlPlaneProfileSecure,
  saveControlPlaneProfileSecure,
  summarizeControlPlaneProfiles
} from '@/services/control-plane-profiles';
import {
  normalizeEndpointHintWarnings,
  resolveDefaultControlEndpoint
} from '@/services/control-plane-endpoints';
import { connectControlPlaneProfile } from '@/services/control-plane-profile-connection';
import {
  getActiveControlPlaneProfileId,
  resolveStoredActiveControlPlaneProfile,
  selectActiveControlPlaneProfile,
  selectActiveControlPlaneProfileSecure,
  syncStoredActiveControlPlaneProfile
} from '@/services/control-plane-selection';
import {
  discoverNativeServers,
  isNativeDesktopRuntime,
  refreshNativeLanRoutes
} from '@/services/native-server-profile-repository';
import { discoverServersOnLan } from '@/services/server-routes/server-route-service';
import {
  buildLanDiscoveryProfileInputs,
  buildServerRouteRows
} from '@/services/server-route-presentation';
import type { ControlPlaneEndpointHint, ControlPlaneProfile } from '@/types';

export type ControlPlaneServerFormValues = { endpoint?: string; name?: string; managementKey?: string };

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : '');

/**
 * Server 管理（/fabric/servers）的数据与操作，语义与桌面 Settings「Server 管理」分区一致：
 * 本地已保存 Server（按 stableServerId 聚合为逻辑 Server 行）、默认 Server、端点提示，
 * 以及 探测并保存 / 授权、同步、同步全部、移除、设为默认、局域网发现（仅原生桌面运行时）。
 */
export function useControlPlaneServers() {
  const [profiles, setProfiles] = useState<ControlPlaneProfile[]>(() => listControlPlaneProfiles());
  const [activeControlPlaneId, setActiveControlPlaneId] = useState(() => (
    resolveStoredActiveControlPlaneProfile(listControlPlaneProfiles(), getActiveControlPlaneProfileId()).profileId
  ));
  const [checkingControlPlaneId, setCheckingControlPlaneId] = useState('');
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [discoveringLanServers, setDiscoveringLanServers] = useState(false);
  const [saving, setSaving] = useState(false);
  const [endpointHints, setEndpointHints] = useState<ControlPlaneEndpointHint[]>([]);
  const [endpointWarnings, setEndpointWarnings] = useState<string[]>([]);

  const syncControlPlaneProfiles = (nextProfiles: ControlPlaneProfile[], preferredProfileId = '') => {
    const resolution = preferredProfileId
      ? selectActiveControlPlaneProfile(nextProfiles, preferredProfileId)
      : syncStoredActiveControlPlaneProfile(nextProfiles);
    setProfiles(nextProfiles);
    setActiveControlPlaneId(resolution.profileId);
    return resolution;
  };

  const syncSavedControlPlaneProfiles = (preferredProfileId = '') => (
    syncControlPlaneProfiles(listControlPlaneProfiles(), preferredProfileId)
  );

  useEffect(() => {
    let cancelled = false;
    serverProfilesAPI.listEndpointHints()
      .catch(() => ({ ok: false, endpoints: [], warnings: [] }))
      .then((payload) => {
        if (cancelled) return;
        const hints = payload.endpoints || [];
        setEndpointHints(hints);
        setEndpointWarnings(normalizeEndpointHintWarnings(hints, payload.warnings));
      });
    syncSavedControlPlaneProfiles();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => addControlPlaneProfilesChangeListener(() => {
    syncSavedControlPlaneProfiles(activeControlPlaneId);
  }), [activeControlPlaneId]);

  /** 探测并保存（authorizingProfileId 为空）或授权已发现的 Server；成功返回 true。 */
  const saveControlPlane = async (authorizingProfileId: string, values: ControlPlaneServerFormValues) => {
    setSaving(true);
    try {
      const profile = await connectControlPlaneProfile({
        profiles,
        profileId: authorizingProfileId,
        endpoint: values.endpoint,
        name: values.name,
        managementKey: values.managementKey
      });
      try {
        await refreshControlPlaneDeviceState(profile);
      } catch (error) {
        await saveControlPlaneProfileSecure({
          name: profile.name,
          endpoint: profile.endpoint,
          descriptor: profile.descriptor,
          state: 'degraded',
          managementKey: profile.managementKey,
          credentialRef: profile.credentialRef,
          managementKeyConfigured: profile.managementKeyConfigured,
          lastError: error instanceof Error ? error.message : 'server_refresh_failed'
        });
        await selectActiveControlPlaneProfileSecure(listControlPlaneProfiles(), profile.id);
        syncSavedControlPlaneProfiles();
        throw error;
      }
      await selectActiveControlPlaneProfileSecure(listControlPlaneProfiles(), profile.id);
      syncSavedControlPlaneProfiles();
      message.success('Server 已保存');
      return true;
    } catch (error) {
      message.error(errorMessage(error) || 'Server 探测失败');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const refreshControlPlane = async (profile: ControlPlaneProfile) => {
    setCheckingControlPlaneId(profile.id);
    try {
      if (!isControlPlaneManagementKeyConfigured(profile)) throw new Error('missing_management_key');
      await refreshControlPlaneDeviceState(profile);
      syncSavedControlPlaneProfiles();
      message.success('Server 已同步');
    } catch (error) {
      await saveControlPlaneProfileSecure({
        name: profile.name,
        endpoint: profile.endpoint,
        descriptor: profile.descriptor,
        state: isControlPlaneManagementKeyConfigured(profile) ? 'degraded' : 'offline',
        managementKey: profile.managementKey,
        credentialRef: profile.credentialRef,
        managementKeyConfigured: profile.managementKeyConfigured,
        lastError: errorMessage(error) || 'descriptor_failed'
      });
      syncSavedControlPlaneProfiles();
      message.error(errorMessage(error) || 'Server 探测失败');
    } finally {
      setCheckingControlPlaneId('');
    }
  };

  const refreshAllControlPlanes = async () => {
    setRefreshingAll(true);
    try {
      const result = await refreshControlPlaneProfileStates(profiles);
      syncControlPlaneProfiles(result.profiles, activeControlPlaneId);
      if (result.refreshed === 0 && result.failed === 0) {
        message.info('没有可同步的 Server');
      } else if (result.failed > 0) {
        message.warning(`已同步 ${result.refreshed} 个 Server，${result.failed} 个失败`);
      } else {
        message.success(`已同步 ${result.refreshed} 个 Server`);
      }
    } catch (error) {
      message.error(errorMessage(error) || '同步 Server 失败');
    } finally {
      setRefreshingAll(false);
    }
  };

  const removeControlPlane = async (profileId: string) => {
    try {
      syncControlPlaneProfiles(await removeControlPlaneProfileSecure(profileId));
      message.success('已移除 Server');
    } catch (error) {
      message.error(errorMessage(error) || '移除 Server 失败');
    }
  };

  const selectControlPlane = async (profileId: string) => {
    try {
      const resolution = await selectActiveControlPlaneProfileSecure(profiles, profileId);
      setActiveControlPlaneId(resolution.profileId);
      message.success('已设置默认 Server');
    } catch (error) {
      message.error(errorMessage(error) || '切换 Server 失败');
    }
  };

  const discoverLanServers = async () => {
    setDiscoveringLanServers(true);
    try {
      const nativeDiscovery = await discoverNativeServers();
      const discovery = await discoverServersOnLan({
        existingServers: profiles,
        discover: async () => nativeDiscovery
      });
      if (discovery.error) throw new Error(discovery.error);
      const discoveredStableServerIds = Array.from(new Set(
        nativeDiscovery.servers.map((server) => server.stableServerId).filter(Boolean)
      ));
      const inputs = buildLanDiscoveryProfileInputs(profiles, discovery.servers, discoveredStableServerIds);
      if (inputs.length === 0) {
        message.info('局域网内未发现 AIH Server');
        return;
      }
      const savedProfiles: ControlPlaneProfile[] = [];
      for (const input of inputs) {
        savedProfiles.push(await saveControlPlaneProfileSecure(input));
      }
      const authorizedProfileIds = savedProfiles
        .filter((profile) => profile.managementKeyConfigured)
        .map((profile) => profile.id);
      if (authorizedProfileIds.length > 0) {
        await refreshNativeLanRoutes(authorizedProfileIds);
      }
      syncSavedControlPlaneProfiles(activeControlPlaneId);
      const pendingCount = savedProfiles.filter((profile) => !profile.managementKeyConfigured).length;
      message.success(
        pendingCount > 0
          ? `发现 ${savedProfiles.length} 个 Server，其中 ${pendingCount} 个待授权`
          : `已合并 ${savedProfiles.length} 个局域网 Server`
      );
    } catch (error) {
      const reason = errorMessage(error);
      message.error(reason && reason !== 'server_discovery_failed' ? reason : '局域网 Server 发现失败');
    } finally {
      setDiscoveringLanServers(false);
    }
  };

  // 复制页面上已展示的 Server URL（与桌面一致）
  const copyEndpoint = async (endpoint: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持剪贴板写入');
      await navigator.clipboard.writeText(endpoint);
      message.success('Server URL 已复制');
    } catch (error) {
      message.error(`复制失败：${errorMessage(error) || '无法写入剪贴板'}`);
    }
  };

  const serverRouteRows = buildServerRouteRows(profiles);
  const logicalProfiles = serverRouteRows.map((row) => row.profile);
  const overview = summarizeControlPlaneProfiles(logicalProfiles);
  const refreshableCount = logicalProfiles.filter(isControlPlaneProfileRefreshable).length;
  const activeProfile = logicalProfiles.find((profile) => profile.id === activeControlPlaneId) || null;

  return {
    profiles,
    serverRouteRows,
    logicalProfiles,
    overview,
    refreshableCount,
    activeControlPlaneId,
    activeProfile,
    checkingControlPlaneId,
    refreshingAll,
    discoveringLanServers,
    canDiscoverLan: isNativeDesktopRuntime(),
    saving,
    endpointHints,
    endpointWarnings,
    defaultEndpoint: resolveDefaultControlEndpoint(endpointHints, ''),
    saveControlPlane,
    refreshControlPlane,
    refreshAllControlPlanes,
    removeControlPlane,
    selectControlPlane,
    discoverLanServers,
    copyEndpoint
  };
}
