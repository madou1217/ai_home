import { useCallback, useEffect, useState } from 'react';
import { message } from 'antd';
import { configAPI, serverProfilesAPI } from '@/services/api';
import type { ControlPlaneEndpointHint, ControlPlaneProfile, ServerConfig } from '@/types';
import {
  addControlPlaneProfilesChangeListener,
  isControlPlaneManagementKeyConfigured,
  listControlPlaneProfiles,
  refreshControlPlaneDeviceState,
  refreshControlPlaneProfileStates,
  removeControlPlaneProfile,
  saveControlPlaneProfile
} from '@/services/control-plane-profiles';
import { normalizeEndpointHintWarnings } from '@/services/control-plane-endpoints';
import { connectControlPlaneProfile } from '@/services/control-plane-profile-connection';
import {
  getActiveControlPlaneProfileId,
  resolveStoredActiveControlPlaneProfile,
  selectActiveControlPlaneProfile,
  syncStoredActiveControlPlaneProfile
} from '@/services/control-plane-selection';
import { buildServerRouteRows } from '@/services/server-route-presentation';
import {
  SERVER_FORM_DEFAULTS,
  USAGE_FORM_DEFAULTS,
  toUsageConfig,
  toUsageFormValues,
  type UsageFormValues
} from './settings-config';
import { saveServerConfig } from './save-server-config';
import { rotateManagementKey } from '@/services/management-key-rotation';

export interface FormSaveFeedback {
  tone: 'success' | 'error';
  text: string;
}

const getInitialControlPlaneProfiles = () => listControlPlaneProfiles();

const getInitialActiveControlPlaneId = () => (
  resolveStoredActiveControlPlaneProfile(
    listControlPlaneProfiles(),
    getActiveControlPlaneProfileId()
  ).profileId
);

/**
 * 统一规范 ServerConfig 快照，用于与表单草稿精确对比。
 */
export function normalizeServerSnapshot(config: Partial<ServerConfig> | null | undefined): ServerConfig {
  const openNetwork = Boolean(config?.openNetwork);
  return {
    host: openNetwork ? '0.0.0.0' : String(config?.host || SERVER_FORM_DEFAULTS.host).trim(),
    port: Number(config?.port ?? SERVER_FORM_DEFAULTS.port),
    openNetwork,
    apiKey: '',
    managementKey: '',
    proxyUrl: String(config?.proxyUrl || '').trim()
  };
}

export function isUsageFormDirty(
  draft: Partial<UsageFormValues> | null | undefined,
  saved: UsageFormValues | null
): boolean {
  if (!saved || !draft) return false;
  return (
    Number(draft.threshold_pct) !== saved.threshold_pct
    || Number(draft.active_refresh_interval) !== saved.active_refresh_interval
    || Number(draft.background_refresh_interval) !== saved.background_refresh_interval
  );
}

export function isServerFormDirty(
  draft: Partial<ServerConfig> | null | undefined,
  saved: ServerConfig | null,
  secretBaseline?: { apiKey?: string; managementKey?: string } | null
): boolean {
  if (!saved || !draft) return false;
  const openNetwork = Boolean(draft.openNetwork);
  const host = openNetwork ? '0.0.0.0' : String(draft.host || '').trim();
  const port = Number(draft.port);
  const proxyUrl = String(draft.proxyUrl || '').trim();
  // 密钥输入框预填当前值：只有与已保存明文不同且非空才算改动，留空表示保持原值。
  const apiKey = String(draft.apiKey || '').trim();
  const managementKey = String(draft.managementKey || '').trim();
  const hasNewApiKey = apiKey !== '' && apiKey !== String(secretBaseline?.apiKey || '').trim();
  const hasNewManagementKey = managementKey !== '' && managementKey !== String(secretBaseline?.managementKey || '').trim();
  return (
    openNetwork !== saved.openNetwork
    || host !== saved.host
    || port !== saved.port
    || proxyUrl !== String(saved.proxyUrl || '').trim()
    || hasNewApiKey
    || hasNewManagementKey
  );
}

export function hasListenerChanges(
  values: Partial<ServerConfig>,
  previous: ServerConfig | null
): boolean {
  if (!previous) return false;
  const openNetwork = Boolean(values.openNetwork);
  const host = openNetwork ? '0.0.0.0' : String(values.host || '127.0.0.1').trim();
  const port = Number(values.port || SERVER_FORM_DEFAULTS.port);
  return (
    openNetwork !== previous.openNetwork
    || host !== previous.host
    || port !== previous.port
  );
}

export function useControlPlaneProfilesState() {
  const [profiles, setProfiles] = useState<ControlPlaneProfile[]>(getInitialControlPlaneProfiles);
  const [activeId, setActiveId] = useState(getInitialActiveControlPlaneId);
  const [endpointHints, setEndpointHints] = useState<ControlPlaneEndpointHint[]>([]);
  const [endpointWarnings, setEndpointWarnings] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [checkingId, setCheckingId] = useState('');
  const [refreshingAll, setRefreshingAll] = useState(false);

  const syncProfiles = useCallback((nextProfiles: ControlPlaneProfile[], preferredProfileId = '') => {
    const resolution = preferredProfileId
      ? selectActiveControlPlaneProfile(nextProfiles, preferredProfileId)
      : syncStoredActiveControlPlaneProfile(nextProfiles);
    setProfiles(nextProfiles);
    setActiveId(resolution.profileId);
    return resolution;
  }, []);

  const syncSavedProfiles = useCallback((preferredProfileId = '') => (
    syncProfiles(listControlPlaneProfiles(), preferredProfileId)
  ), [syncProfiles]);

  const loadEndpointHints = useCallback(async () => {
    const payload = await serverProfilesAPI.listEndpointHints()
      .catch(() => ({ ok: false, endpoints: [], warnings: [] }));
    const hints = payload.endpoints || [];
    setEndpointHints(hints);
    setEndpointWarnings(normalizeEndpointHintWarnings(hints, payload.warnings));
    return hints;
  }, []);

  useEffect(() => addControlPlaneProfilesChangeListener(() => {
    syncSavedProfiles(activeId);
  }), [activeId, syncSavedProfiles]);

  const saveProfile = useCallback(async (
    values: { endpoint?: string; name?: string; managementKey?: string },
    authorizingId: string
  ) => {
    setSaving(true);
    try {
      const profile = await connectControlPlaneProfile({
        profiles,
        profileId: authorizingId,
        endpoint: values.endpoint,
        name: values.name,
        managementKey: values.managementKey
      });
      try {
        await refreshControlPlaneDeviceState(profile);
      } catch (error) {
        await saveControlPlaneProfile({
          name: profile.name,
          endpoint: profile.endpoint,
          descriptor: profile.descriptor,
          state: 'degraded',
          managementKey: profile.managementKey,
          managementKeyConfigured: profile.managementKeyConfigured,
          lastError: error instanceof Error ? error.message : 'server_refresh_failed'
        });
        await selectActiveControlPlaneProfile(listControlPlaneProfiles(), profile.id);
        syncSavedProfiles();
        throw error;
      }
      await selectActiveControlPlaneProfile(listControlPlaneProfiles(), profile.id);
      syncSavedProfiles();
      message.success('Server 已保存');
      return profile;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Server 探测失败';
      message.error(msg);
      throw error;
    } finally {
      setSaving(false);
    }
  }, [profiles, syncSavedProfiles]);

  const refreshProfile = useCallback(async (profile: ControlPlaneProfile) => {
    setCheckingId(profile.id);
    try {
      if (!isControlPlaneManagementKeyConfigured(profile)) throw new Error('missing_management_key');
      await refreshControlPlaneDeviceState(profile);
      syncSavedProfiles();
      message.success('Server 已同步');
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'descriptor_failed';
      await saveControlPlaneProfile({
        name: profile.name,
        endpoint: profile.endpoint,
        descriptor: profile.descriptor,
        state: isControlPlaneManagementKeyConfigured(profile) ? 'degraded' : 'offline',
        managementKey: profile.managementKey,
        managementKeyConfigured: profile.managementKeyConfigured,
        lastError: msg
      });
      syncSavedProfiles();
      message.error(msg || 'Server 探测失败');
    } finally {
      setCheckingId('');
    }
  }, [syncSavedProfiles]);

  const refreshAllProfiles = useCallback(async () => {
    setRefreshingAll(true);
    try {
      const result = await refreshControlPlaneProfileStates(profiles);
      syncProfiles(result.profiles, activeId);
      if (result.refreshed === 0 && result.failed === 0) {
        message.info('没有可同步的 Server');
      } else if (result.failed > 0) {
        message.warning(`已同步 ${result.refreshed} 个 Server，${result.failed} 个失败`);
      } else {
        message.success(`已同步 ${result.refreshed} 个 Server`);
      }
    } catch (error: unknown) {
      message.error(error instanceof Error ? error.message : '同步 Server 失败');
    } finally {
      setRefreshingAll(false);
    }
  }, [profiles, activeId, syncProfiles]);

  const removeProfile = useCallback(async (profileId: string) => {
    try {
      syncProfiles(await removeControlPlaneProfile(profileId));
      message.success('已移除 Server');
    } catch (error: unknown) {
      message.error(error instanceof Error ? error.message : '移除 Server 失败');
    }
  }, [syncProfiles]);

  const selectProfile = useCallback(async (profileId: string) => {
    try {
      const resolution = await selectActiveControlPlaneProfile(profiles, profileId);
      setActiveId(resolution.profileId);
      message.success('已切换默认 Server');
    } catch (error: unknown) {
      message.error(error instanceof Error ? error.message : '切换 Server 失败');
    }
  }, [profiles]);

  const serverRouteRows = buildServerRouteRows(profiles);
  const logicalProfiles = serverRouteRows.map((row) => row.profile);
  const activeProfile = logicalProfiles.find((profile) => profile.id === activeId) || null;

  return {
    profiles,
    logicalProfiles,
    serverRouteRows,
    activeId,
    activeProfile,
    endpointHints,
    endpointWarnings,
    saving,
    checkingId,
    refreshingAll,
    syncSavedProfiles,
    loadEndpointHints,
    saveProfile,
    refreshProfile,
    refreshAllProfiles,
    removeProfile,
    selectProfile
  };
}

export function useServiceConfigState(
  activeProfile: ControlPlaneProfile | null,
  onRotatedProfile: (profileId: string) => void
) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedUsage, setSavedUsage] = useState<UsageFormValues>(USAGE_FORM_DEFAULTS);
  const [savedServer, setSavedServer] = useState<ServerConfig>(SERVER_FORM_DEFAULTS);
  const [usageSaving, setUsageSaving] = useState(false);
  const [serverSaving, setServerSaving] = useState(false);
  const [usageFeedback, setUsageFeedback] = useState<FormSaveFeedback | null>(null);
  const [serverFeedback, setServerFeedback] = useState<FormSaveFeedback | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [config, serverConfig] = await Promise.all([
        configAPI.get(),
        configAPI.getServer()
      ]);
      const nextUsage = toUsageFormValues(config);
      const nextServer = normalizeServerSnapshot(serverConfig);
      setSavedUsage(nextUsage);
      setSavedServer(nextServer);
      return { usage: nextUsage, server: nextServer };
    } catch (_error) {
      const errText = '读取服务端配置失败';
      setLoadError(errText);
      message.error(errText);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const saveUsage = useCallback(async (values: UsageFormValues) => {
    setUsageSaving(true);
    setUsageFeedback(null);
    try {
      await configAPI.update(toUsageConfig(values));
      setSavedUsage(values);
      setUsageFeedback({
        tone: 'success',
        text: `已应用：阈值 ${values.threshold_pct}%，活跃 ${values.active_refresh_interval}s，后台 ${values.background_refresh_interval}s`
      });
      return values;
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : '保存额度配置失败';
      setUsageFeedback({ tone: 'error', text: errMsg });
      message.error(errMsg);
      throw error;
    } finally {
      setUsageSaving(false);
    }
  }, []);

  const saveServer = useCallback(async (values: ServerConfig) => {
    setServerSaving(true);
    setServerFeedback(null);
    // API Key 在进程启动时载入鉴权器，保存后需要重启才对客户端生效。
    const needsRestart = hasListenerChanges(values, savedServer) || Boolean(String(values.apiKey || '').trim());
    try {
      const { saved, rotatedProfileId } = await saveServerConfig(values, activeProfile);
      if (rotatedProfileId) {
        onRotatedProfile(rotatedProfileId);
      }
      const nextSnapshot = normalizeServerSnapshot(saved);
      setSavedServer(nextSnapshot);
      if (needsRestart) {
        setRestartRequired(true);
      }
      setServerFeedback({
        tone: 'success',
        text: needsRestart
          ? `已保存监听 ${nextSnapshot.host}:${nextSnapshot.port}，需重启服务后生效`
          : '服务配置已保存并生效'
      });
      return nextSnapshot;
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : '保存服务配置失败';
      setServerFeedback({ tone: 'error', text: errMsg });
      message.error(errMsg);
      throw error;
    } finally {
      setServerSaving(false);
    }
  }, [activeProfile, onRotatedProfile, savedServer]);

  // 一键轮换：只写这一把密钥，不提交表单里其它未保存草稿。
  // apiKey 走 server-config 补丁；managementKey 走专用轮换并同步默认 Server 凭据。
  const applyServerSecret = useCallback(async (field: 'apiKey' | 'managementKey', value: string) => {
    setServerSaving(true);
    setServerFeedback(null);
    try {
      if (field === 'apiKey') {
        await configAPI.updateServer({ apiKey: value });
        setRestartRequired(true);
        setServerFeedback({ tone: 'success', text: 'API Key 已轮换；重启服务后对外生效' });
      } else {
        if (!activeProfile) throw new Error('请先选择要轮换的 Server');
        await rotateManagementKey(activeProfile, value);
        onRotatedProfile(activeProfile.id);
        setServerFeedback({ tone: 'success', text: 'Management Key 已轮换，并同步更新当前默认 Server 凭据' });
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : '轮换密钥失败';
      setServerFeedback({ tone: 'error', text: errMsg });
      throw error;
    } finally {
      setServerSaving(false);
    }
  }, [activeProfile, onRotatedProfile]);

  const markRestarted = useCallback(() => {
    setRestartRequired(false);
  }, []);

  return {
    loading,
    loadError,
    savedUsage,
    savedServer,
    usageSaving,
    serverSaving,
    usageFeedback,
    serverFeedback,
    restartRequired,
    setUsageFeedback,
    setServerFeedback,
    loadConfig,
    saveUsage,
    saveServer,
    applyServerSecret,
    markRestarted
  };
}
