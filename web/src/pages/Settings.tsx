import { useState, useEffect, useRef } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import './Settings.css';
import { ProCard, StatisticCard } from '@ant-design/pro-components';
import { Form, InputNumber, Input, message, Space, Switch, Alert, Tabs, Select, Tag, Modal, Divider, Typography, Grid } from 'antd';
import MobilePills from '@/components/mobile/MobilePills';
import { DeleteOutlined, LinkOutlined, PlusOutlined, RadarChartOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { configAPI, managementAPI, serverProfilesAPI } from '@/services/api';
import {
  addControlPlaneProfilesChangeListener,
  isControlPlaneManagementKeyConfigured,
  isControlPlaneProfileRefreshable,
  listControlPlaneProfiles,
  removeControlPlaneProfileSecure,
  refreshControlPlaneProfileStates,
  refreshControlPlaneDeviceState,
  saveControlPlaneProfileSecure,
  summarizeControlPlaneProfiles
} from '@/services/control-plane-profiles';
import {
  formatEndpointHintLabel,
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
import type {
  UsageConfig,
  ServerConfig,
  ManagementRestartEvent,
  ControlPlaneEndpointHint,
  ControlPlaneProfile,
  ControlPlaneProfileState
} from '@/types';
import Button from '@/components/ui/AppButton';
import ListTable from '@/components/ui/ListTable';
import PageScaffold from '@/components/ui/PageScaffold';
import ModelAliases from './ModelAliases';
import SshHostsPanel from './SshHostsPanel';
import ControlPlaneProfileSelect from '@/components/control-plane/ControlPlaneProfileSelect';
import RealtimeSyncCard from '@/components/settings/RealtimeSyncCard';
import PublicServerEntryCard from '@/components/settings/PublicServerEntryCard';
import { rotateManagementKey as updateServerManagementKey } from '@/services/management-key-rotation';
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
import type { ServerRouteRow } from '@/services/server-route-presentation';

type NumericAddonInputProps = ComponentProps<typeof InputNumber> & {
  addonAfter: React.ReactNode;
};

const NumericAddonInput = ({ addonAfter, style, ...props }: NumericAddonInputProps) => (
  <InputNumber {...props} addonAfter={addonAfter} style={{ width: '100%', ...style }} />
);

const renderControlEndpointHints = (
  hints: ControlPlaneEndpointHint[],
  warnings: string[],
  onSelect: (endpoint: string) => void
) => {
  if (hints.length === 0) return null;
  return (
    <div className="settings-endpoint-hints">
      <Space size={[6, 6]} wrap>
        {hints.map((hint) => (
          <Button
            key={`${hint.source}:${hint.endpoint}`}
            size="small"
            type={hint.recommended ? 'primary' : 'default'}
            icon={<LinkOutlined />}
            htmlType="button"
            onClick={() => onSelect(hint.endpoint)}
          >
            {formatEndpointHintLabel(hint)}
          </Button>
        ))}
      </Space>
      {warnings.length > 0 && (
        <div className="settings-endpoint-warning">
          {warnings.slice(0, 2).map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
      )}
    </div>
  );
};

const CONTROL_PLANE_PROFILE_STATUS: Record<ControlPlaneProfileState, { color: string; label: string }> = {
  ready: { color: 'green', label: '就绪' },
  degraded: { color: 'orange', label: '连接异常' },
  offline: { color: 'default', label: '离线' }
};

const getControlPlaneProfileStatus = (state: ControlPlaneProfileState) => (
  CONTROL_PLANE_PROFILE_STATUS[state] || CONTROL_PLANE_PROFILE_STATUS.offline
);

export type SettingsSectionKey = 'basic' | 'aliases' | 'control-planes' | 'ssh-hosts';

interface SettingsProps {
  section?: SettingsSectionKey;
}

interface SettingsSectionItem {
  key: SettingsSectionKey;
  label: string;
  forceRender?: boolean;
  children: ReactNode;
  actions?: ReactNode;
}

const SETTINGS_PAGE_META = {
  settings: {
    title: '设置',
    eyebrow: '配置',
    description: '管理 server、额度刷新和模型别名。'
  },
  basic: {
    title: '基础设置',
    eyebrow: '配置',
    description: '管理 server、额度刷新和本地服务参数。'
  },
  aliases: {
    title: '模型别名',
    eyebrow: '配置',
    description: '管理模型展示、路由和别名配置。'
  },
  'control-planes': {
    title: 'Server 管理',
    eyebrow: 'Fabric',
    description: '使用 Server URL 和 Management Key 管理 AIH Server。'
  },
  'ssh-hosts': {
    title: 'SSH 开发机',
    eyebrow: 'Fabric',
    description: '管理 SSH 连接和可用于远端开发的工作区。'
  }
} as const;

const getInitialSettingsTab = () => {
  if (typeof window === 'undefined') return 'basic';
  const params = new URLSearchParams(window.location.search);
  const tab = String(params.get('tab') || '').trim();
  return tab === 'aliases' ? 'aliases' : 'basic';
};

const formatActiveControlPlaneLabel = (profile: ControlPlaneProfile | null) => {
  if (!profile) return '未选择服务器';
  return profile.name || profile.endpoint || profile.id;
};

const formatActiveControlPlaneEndpoint = (profile: ControlPlaneProfile | null) => {
  if (!profile) return '请先添加 Server';
  return profile.endpoint;
};

const getInitialControlPlaneProfiles = () => listControlPlaneProfiles();

const getInitialActiveControlPlaneId = () => (
  resolveStoredActiveControlPlaneProfile(listControlPlaneProfiles(), getActiveControlPlaneProfileId()).profileId
);

const Settings = ({ section }: SettingsProps) => {
  const [usageForm] = Form.useForm();
  const [serverForm] = Form.useForm();
  const [controlPlaneForm] = Form.useForm();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const [settingsTab, setSettingsTab] = useState(getInitialSettingsTab());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverSaving, setServerSaving] = useState(false);
  const [controlPlaneSaving, setControlPlaneSaving] = useState(false);
  const [checkingControlPlaneId, setCheckingControlPlaneId] = useState('');
  const [controlPlaneProfiles, setControlPlaneProfiles] = useState<ControlPlaneProfile[]>(getInitialControlPlaneProfiles);
  const [refreshingControlPlanes, setRefreshingControlPlanes] = useState(false);
  const [discoveringLanServers, setDiscoveringLanServers] = useState(false);
  const [activeControlPlaneId, setActiveControlPlaneId] = useState(getInitialActiveControlPlaneId);
  const [controlPlaneAddModalOpen, setControlPlaneAddModalOpen] = useState(false);
  const [authorizingControlPlaneId, setAuthorizingControlPlaneId] = useState('');
  const [extraActions, setExtraActions] = useState<React.ReactNode>(null);
  const [controlPlaneEndpointHints, setControlPlaneEndpointHints] = useState<ControlPlaneEndpointHint[]>([]);
  const [controlPlaneEndpointWarnings, setControlPlaneEndpointWarnings] = useState<string[]>([]);
  const [restarting, setRestarting] = useState(false);
  const [restartEvent, setRestartEvent] = useState<ManagementRestartEvent | null>(null);
  const restartFallbackTimerRef = useRef<number | null>(null);

  const syncControlPlaneProfiles = (profiles: ControlPlaneProfile[], preferredProfileId = '') => {
    const resolution = preferredProfileId
      ? selectActiveControlPlaneProfile(profiles, preferredProfileId)
      : syncStoredActiveControlPlaneProfile(profiles);
    setControlPlaneProfiles(profiles);
    setActiveControlPlaneId(resolution.profileId);
    return resolution;
  };

  const syncSavedControlPlaneProfiles = (preferredProfileId = '') => (
    syncControlPlaneProfiles(listControlPlaneProfiles(), preferredProfileId)
  );

  const clearRestartFallbackTimer = () => {
    if (restartFallbackTimerRef.current === null) return;
    window.clearTimeout(restartFallbackTimerRef.current);
    restartFallbackTimerRef.current = null;
  };

  const loadConfig = async () => {
    setLoading(true);
    try {
      const [config, serverConfig] = await Promise.all([
        configAPI.get(),
        configAPI.getServer()
      ]);
      const endpointHintsPayload = await serverProfilesAPI.listEndpointHints()
        .catch(() => ({ ok: false, endpoints: [], warnings: [] }));
      const endpointHints = endpointHintsPayload.endpoints || [];
      const defaultControlEndpoint = resolveDefaultControlEndpoint(endpointHints);
      setControlPlaneEndpointHints(endpointHints);
      setControlPlaneEndpointWarnings(normalizeEndpointHintWarnings(endpointHints, endpointHintsPayload.warnings));
      usageForm.setFieldsValue({
        threshold_pct: config.threshold_pct,
        active_refresh_interval: parseInterval(config.active_refresh_interval),
        background_refresh_interval: parseInterval(config.background_refresh_interval)
      });
      serverForm.setFieldsValue(serverConfig);
      if (section === 'control-planes') {
        controlPlaneForm.setFieldsValue({
          endpoint: defaultControlEndpoint,
          name: '当前 Server'
        });
      }
      syncSavedControlPlaneProfiles();
    } catch (_error) {
      syncSavedControlPlaneProfiles();
      message.error('加载配置失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConfig();
  }, []);

  useEffect(() => addControlPlaneProfilesChangeListener(() => {
    syncSavedControlPlaneProfiles(activeControlPlaneId);
  }), [activeControlPlaneId]);

  useEffect(() => {
    const source = managementAPI.watch({
      onRestart: (event) => {
        setRestartEvent(event);
        if (event.status === 'queued' || event.status === 'starting') {
          setRestarting(true);
          return;
        }
        clearRestartFallbackTimer();
        setRestarting(false);
        if (event.status === 'started') {
          message.success('服务重启已启动');
          return;
        }
        if (event.status === 'failed') {
          message.error(event.message || '重启服务失败');
        }
      }
    });
    return () => {
      clearRestartFallbackTimer();
      source.close();
    };
  }, []);

  const parseInterval = (interval: string): number => {
    const match = interval.match(/^(\d+)([smh])$/);
    if (!match) return 60;
    const [, value, unit] = match;
    const num = parseInt(value);
    switch (unit) {
      case 's': return num;
      case 'm': return num * 60;
      case 'h': return num * 3600;
      default: return num;
    }
  };

  const formatInterval = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h`;
  };

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const config: UsageConfig = {
        threshold_pct: values.threshold_pct,
        active_refresh_interval: formatInterval(values.active_refresh_interval),
        background_refresh_interval: formatInterval(values.background_refresh_interval)
      };
      await configAPI.update(config);
      message.success('保存额度配置成功');
    } catch (_error) {
      message.error('保存额度配置失败');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveServer = async (values: ServerConfig) => {
    setServerSaving(true);
    try {
      const apiKey = String(values.apiKey || '').trim();
      const managementKey = String(values.managementKey || '').trim();
      if (managementKey && !activeControlPlaneProfile) throw new Error('请先选择 Server');
      const nextConfig: Partial<ServerConfig> = {
        host: values.openNetwork ? '0.0.0.0' : (values.host || '127.0.0.1'),
        port: Number(values.port || 9527),
        openNetwork: Boolean(values.openNetwork),
        ...(apiKey ? { apiKey } : {})
      };
      const saved = await configAPI.updateServer(nextConfig);
      if (managementKey) {
        const profile = activeControlPlaneProfile;
        if (!profile) throw new Error('请先选择 Server');
        await updateServerManagementKey(profile, managementKey);
        syncSavedControlPlaneProfiles(profile.id);
      }
      serverForm.setFieldsValue({
        ...saved,
        apiKey: '',
        managementKey: ''
      });
      message.success('保存服务配置成功');
    } catch (error: any) {
      message.error(error?.message || '保存服务配置失败');
    } finally {
      setServerSaving(false);
    }
  };

  const handleRestartServer = async () => {
    setRestarting(true);
    try {
      const result = await managementAPI.restart();
      if (result.job) {
        setRestartEvent(result.job);
      }
      clearRestartFallbackTimer();
      restartFallbackTimerRef.current = window.setTimeout(() => {
        setRestarting(false);
      }, 70_000);
    } catch (error: any) {
      clearRestartFallbackTimer();
      message.error(error?.response?.data?.message || error?.message || '重启服务失败');
      setRestarting(false);
    }
  };

  const openAddControlPlaneModal = () => {
    setAuthorizingControlPlaneId('');
    controlPlaneForm.setFieldsValue({
      endpoint: resolveDefaultControlEndpoint(controlPlaneEndpointHints, ''),
      name: 'AIH Server',
      managementKey: ''
    });
    setControlPlaneAddModalOpen(true);
  };

  const openDiscoveredServerAuthorization = (profile: ControlPlaneProfile) => {
    setAuthorizingControlPlaneId(profile.id);
    controlPlaneForm.setFieldsValue({
      endpoint: profile.endpoint,
      name: profile.name,
      managementKey: ''
    });
    setControlPlaneAddModalOpen(true);
  };

  const closeControlPlaneModal = () => {
    setControlPlaneAddModalOpen(false);
    setAuthorizingControlPlaneId('');
  };

  const handleDiscoverLanServers = async () => {
    setDiscoveringLanServers(true);
    try {
      const nativeDiscovery = await discoverNativeServers();
      const discovery = await discoverServersOnLan({
        existingServers: controlPlaneProfiles,
        discover: async () => nativeDiscovery
      });
      if (discovery.error) throw new Error(discovery.error);
      const discoveredStableServerIds = Array.from(new Set(
        nativeDiscovery.servers.map((server) => server.stableServerId).filter(Boolean)
      ));
      const inputs = buildLanDiscoveryProfileInputs(
        controlPlaneProfiles,
        discovery.servers,
        discoveredStableServerIds
      );
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
      const reason = error instanceof Error ? error.message : '';
      message.error(reason && reason !== 'server_discovery_failed' ? reason : '局域网 Server 发现失败');
    } finally {
      setDiscoveringLanServers(false);
    }
  };

  const handleSaveControlPlane = async (values: { endpoint?: string; name?: string; managementKey?: string }) => {
    setControlPlaneSaving(true);
    try {
      const profile = await connectControlPlaneProfile({
        profiles: controlPlaneProfiles,
        profileId: authorizingControlPlaneId,
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
      controlPlaneForm.setFieldsValue({
        endpoint: profile.endpoint,
        name: profile.name,
        managementKey: ''
      });
      closeControlPlaneModal();
      message.success('Server 已保存');
    } catch (error: any) {
      message.error(error?.message || 'Server 探测失败');
    } finally {
      setControlPlaneSaving(false);
    }
  };

  const handleRefreshControlPlane = async (profile: ControlPlaneProfile) => {
    setCheckingControlPlaneId(profile.id);
    try {
      if (!isControlPlaneManagementKeyConfigured(profile)) throw new Error('missing_management_key');
      await refreshControlPlaneDeviceState(profile);
      syncSavedControlPlaneProfiles();
      message.success('Server 已同步');
    } catch (error: any) {
      await saveControlPlaneProfileSecure({
        name: profile.name,
        endpoint: profile.endpoint,
        descriptor: profile.descriptor,
        state: isControlPlaneManagementKeyConfigured(profile) ? 'degraded' : 'offline',
        managementKey: profile.managementKey,
        credentialRef: profile.credentialRef,
        managementKeyConfigured: profile.managementKeyConfigured,
        lastError: error?.message || 'descriptor_failed'
      });
      syncSavedControlPlaneProfiles();
      message.error(error?.message || 'Server 探测失败');
    } finally {
      setCheckingControlPlaneId('');
    }
  };

  const handleRefreshAllControlPlanes = async () => {
    setRefreshingControlPlanes(true);
    try {
      const result = await refreshControlPlaneProfileStates(controlPlaneProfiles);
      syncControlPlaneProfiles(result.profiles, activeControlPlaneId);
      if (result.refreshed === 0 && result.failed === 0) {
        message.info('没有可同步的 Server');
      } else if (result.failed > 0) {
        message.warning(`已同步 ${result.refreshed} 个 Server，${result.failed} 个失败`);
      } else {
        message.success(`已同步 ${result.refreshed} 个 Server`);
      }
    } catch (error: any) {
      message.error(error?.message || '同步 Server 失败');
    } finally {
      setRefreshingControlPlanes(false);
    }
  };

  const handleRemoveControlPlane = async (profileId: string) => {
    try {
      syncControlPlaneProfiles(await removeControlPlaneProfileSecure(profileId));
      message.success('已移除 Server');
    } catch (error: any) {
      message.error(error?.message || '移除 Server 失败');
    }
  };

  const handleSelectControlPlane = async (profileId: string) => {
    try {
      const resolution = await selectActiveControlPlaneProfileSecure(controlPlaneProfiles, profileId);
      setActiveControlPlaneId(resolution.profileId);
      message.success('已切换当前 Server');
    } catch (error: any) {
      message.error(error?.message || '切换 Server 失败');
    }
  };

  const getRestartAlert = () => {
    if (!restartEvent && !restarting) return null;
    const status = restartEvent?.status || 'queued';
    if (status === 'failed') {
      return {
        type: 'error' as const,
        message: restartEvent?.message || '重启服务失败'
      };
    }
    if (status === 'started') {
      return {
        type: 'success' as const,
        message: restartEvent?.pid ? `服务重启已启动，pid ${restartEvent.pid}` : '服务重启已启动'
      };
    }
    return {
      type: 'info' as const,
      message: status === 'starting' ? '服务正在重启' : '服务重启已排队'
    };
  };

  const restartAlert = getRestartAlert();
  const serverRouteRows = buildServerRouteRows(controlPlaneProfiles);
  const logicalControlPlaneProfiles = serverRouteRows.map((row) => row.profile);
  const controlPlaneOverview = summarizeControlPlaneProfiles(logicalControlPlaneProfiles);
  const refreshableControlPlaneCount = logicalControlPlaneProfiles.filter(isControlPlaneProfileRefreshable).length;
  const activeControlPlaneProfile = logicalControlPlaneProfiles.find((profile) => profile.id === activeControlPlaneId) || null;

  const renderControlPlaneSummary = (profile: ControlPlaneProfile, authorizationPending: boolean) => {
    if (authorizationPending) {
      return (
        <Space direction="vertical" size={4}>
          <Tag color="orange" style={{ marginInlineEnd: 0 }}>已发现，待授权</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            输入 Management Key 后即可连接
          </Typography.Text>
        </Space>
      );
    }
    const status = getControlPlaneProfileStatus(profile.state);
    const syncUnavailable = profile.state === 'degraded' || Boolean(profile.lastError);
    const cachedSummary = [
      profile.lastStatusSyncAt > 0 ? `账号 ${profile.accountCount}` : '',
      profile.lastSessionsSyncAt > 0 ? `会话 ${profile.sessionCount}` : ''
    ].filter(Boolean).join(' · ');
    // 只展示对「管理 Server」真正有用的运营指标：可用账号 / 会话。
    // 协议版本、管理能力数、transport 拆分、Key 配置等内部 plumbing 一律剔除（无用数据）。
    const metrics = syncUnavailable ? [
      <Typography.Text key="unavailable" type="secondary" style={{ fontSize: 12 }}>
        数据无法获取
        {cachedSummary && <> · 上次缓存：{cachedSummary}</>}
      </Typography.Text>
    ] : [
      profile.lastStatusSyncAt > 0 && (
        <Typography.Text key="accounts" type="secondary" style={{ fontSize: 12 }}>
          账号 <Typography.Text strong style={{ fontSize: 12 }}>{profile.activeAccountCount}/{profile.accountCount}</Typography.Text>
          {profile.lastAccountsSyncAt > 0 && profile.schedulableAccountCount > 0
            ? `（${profile.schedulableAccountCount} 可调度）`
            : ''}
        </Typography.Text>
      ),
      profile.lastSessionsSyncAt > 0 && (
        <Typography.Text key="sessions" type="secondary" style={{ fontSize: 12 }}>
          会话 <Typography.Text strong style={{ fontSize: 12 }}>{profile.sessionCount}</Typography.Text>
        </Typography.Text>
      )
    ].filter(Boolean);

    return (
      <Space direction="vertical" size={4} style={{ minWidth: 0 }}>
        <Space size={8} wrap>
          <Tag color={status.color} style={{ marginInlineEnd: 0 }}>{status.label}</Tag>
          {isControlPlaneManagementKeyConfigured(profile) && (
            <Typography.Text type="success" style={{ fontSize: 12 }}>Key 已配置</Typography.Text>
          )}
        </Space>
        {metrics.length > 0 && (
          <Space split={<Divider type="vertical" />} size={4} wrap>
            {metrics}
          </Space>
        )}
      </Space>
    );
  };

  const renderServerRoutes = (row: ServerRouteRow) => (
    <div className="settings-server-route-list">
      {row.routes.map((route) => (
        <div
          key={route.id}
          className={`settings-server-route${route.primary ? ' settings-server-route--primary' : ''}`}
        >
          <div className="settings-server-route-head">
            <Tag color={route.primary ? 'blue' : 'default'}>{route.roleLabel}</Tag>
            <strong>{route.kindLabel}</strong>
            <Tag color={route.healthColor}>{route.healthLabel}</Tag>
            <span>{route.rttLabel}</span>
          </div>
          <span className="settings-server-route-endpoint">{route.endpointLabel}</span>
        </div>
      ))}
    </div>
  );

  const basicSettingsContent = (
    <div className="settings-grid">
      <ProCard className="settings-panel" bordered bodyStyle={{ padding: 18 }}>
        <div className="settings-panel-head">
          <div>
            <h2>AIH Server</h2>
            <p>选择或切换当前连接的 AIH Server。</p>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <ControlPlaneProfileSelect className="settings-server-select-trigger" />
        </div>
      </ProCard>

      <ProCard className="settings-panel" bordered bodyStyle={{ padding: 18 }}>
        <RealtimeSyncCard />
      </ProCard>

      <ProCard className="settings-panel" bordered bodyStyle={{ padding: 18 }}>
        <div className="settings-panel-head">
          <div>
            <h2>账号调度</h2>
            <p>控制额度阈值和后台刷新节奏。</p>
          </div>
        </div>
        <Form
          form={usageForm}
          disabled={loading}
          layout="vertical"
          onFinish={handleSave}
          initialValues={{
            threshold_pct: 95,
            active_refresh_interval: 60,
            background_refresh_interval: 3600
          }}
        >
          <Form.Item
            name="threshold_pct"
            label="自动切换阈值 (%)"
            help="当账号剩余额度低于此百分比时，自动切换到下一个可用账号"
            rules={[
              { required: true, message: '请输入阈值' },
              { type: 'number', min: 0, max: 100, message: '阈值必须在 0-100 之间' }
            ]}
          >
            <NumericAddonInput min={0} max={100} addonAfter="%" />
          </Form.Item>

          <Form.Item
            name="active_refresh_interval"
            label="活跃刷新间隔 (秒)"
            help="正在使用的账号额度刷新间隔时间"
            rules={[
              { required: true, message: '请输入刷新间隔' },
              { type: 'number', min: 10, message: '间隔不能小于 10 秒' }
            ]}
          >
            <NumericAddonInput min={10} addonAfter="秒" />
          </Form.Item>

          <Form.Item
            name="background_refresh_interval"
            label="后台刷新间隔 (秒)"
            help="未使用账号的额度刷新间隔时间"
            rules={[
              { required: true, message: '请输入刷新间隔' },
              { type: 'number', min: 60, message: '间隔不能小于 60 秒' }
            ]}
          >
            <NumericAddonInput min={60} addonAfter="秒" />
          </Form.Item>

          <Form.Item>
            <Space className="settings-actions">
              <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving}>
                保存额度设置
              </Button>
              <Button onClick={loadConfig}>重置</Button>
            </Space>
          </Form.Item>
        </Form>
      </ProCard>

      <ProCard className="settings-panel" bordered bodyStyle={{ padding: 18 }}>
        <div className="settings-panel-head">
          <div>
            <h2>服务配置</h2>
            <p>管理监听地址、端口和本地接口密钥。</p>
          </div>
        </div>
        <Form
          form={serverForm}
          disabled={loading}
          layout="vertical"
          onFinish={handleSaveServer}
          initialValues={{
            host: '127.0.0.1',
            port: 9527,
            apiKey: '',
            managementKey: '',
            openNetwork: false
          }}
        >
          <Alert
            type="info"
            showIcon
            className="settings-inline-alert"
            message="开启开放网络后，Server 会监听 0.0.0.0。监听配置保存后，需要点击“一键重启服务”才会生效。"
          />
          {restartAlert && (
            <Alert
              type={restartAlert.type}
              showIcon
              className="settings-inline-alert settings-restart-alert animate__animated animate__fadeIn animate__faster"
              message={restartAlert.message}
            />
          )}

          <Form.Item
            name="openNetwork"
            label="开放网络访问"
            valuePropName="checked"
          >
            <Switch checkedChildren="开放" unCheckedChildren="本机" />
          </Form.Item>

          <Form.Item shouldUpdate noStyle>
            {() => {
              const openNetwork = serverForm.getFieldValue('openNetwork');
              return (
                <Form.Item
                  name="host"
                  label="监听地址"
                  help={openNetwork ? '开放网络时会自动使用 0.0.0.0' : '默认仅监听本机 127.0.0.1'}
                >
                  <Input disabled={openNetwork} placeholder="127.0.0.1" />
                </Form.Item>
              );
            }}
          </Form.Item>

          <Form.Item
            name="port"
            label="端口"
            rules={[
              { required: true, message: '请输入端口' },
              { type: 'number', min: 1, max: 65535, message: '端口必须在 1-65535 之间' }
            ]}
          >
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item
            name="apiKey"
            label="API Key"
            help="用于访问 /v1 接口的客户端密钥。留空保留当前配置。"
          >
            <Input.Password autoComplete="new-password" placeholder="例如 sk-local-xxxx" />
          </Form.Item>

          <Form.Item
            name="managementKey"
            label="Management Key"
            help="用于访问 Server 管理接口的客户端密钥。留空保留当前配置。"
          >
            <Input.Password autoComplete="new-password" placeholder="输入新的 Management Key" />
          </Form.Item>

          <Form.Item>
            <Space className="settings-actions">
              <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={serverSaving}>
                保存服务配置
              </Button>
              <Button icon={<ReloadOutlined />} onClick={handleRestartServer} loading={restarting}>
                一键重启服务
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </ProCard>
    </div>
  );

  const controlPlanesActions = (
    <Space size={8} wrap>
      {isNativeDesktopRuntime() && (
        <Button
          icon={<RadarChartOutlined />}
          loading={discoveringLanServers}
          onClick={handleDiscoverLanServers}
        >
          发现局域网 Server
        </Button>
      )}
      <Button
        icon={<ReloadOutlined />}
        disabled={refreshableControlPlaneCount === 0}
        loading={refreshingControlPlanes}
        onClick={handleRefreshAllControlPlanes}
      >
        同步全部
      </Button>
      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={openAddControlPlaneModal}
      >
        添加 Server
      </Button>
    </Space>
  );

  const controlPlanesContent = (
    <div className="settings-control-plane-page">
      <ProCard className="settings-panel settings-control-plane-shell" bordered bodyStyle={{ padding: 18 }}>
        <div className="settings-control-plane-current">
          <div className="settings-control-plane-current-main">
            <span>当前 Server</span>
            <strong>{formatActiveControlPlaneLabel(activeControlPlaneProfile)}</strong>
            <em>{formatActiveControlPlaneEndpoint(activeControlPlaneProfile)}</em>
          </div>
          <div className="settings-control-plane-current-actions">
            <Select
              value={activeControlPlaneId || undefined}
              placeholder="选择 Server"
              disabled={controlPlaneProfiles.length === 0}
              onChange={handleSelectControlPlane}
              options={serverRouteRows.map((row) => ({
                value: row.profile.id,
                label: row.authorizationPending
                  ? `${row.profile.name || row.profile.endpoint}（待授权）`
                  : row.profile.name || row.profile.endpoint || row.profile.id,
                disabled: row.authorizationPending
              }))}
            />
            <Button
              icon={<ReloadOutlined />}
              disabled={!activeControlPlaneProfile}
              loading={checkingControlPlaneId === activeControlPlaneProfile?.id}
              onClick={() => activeControlPlaneProfile && handleRefreshControlPlane(activeControlPlaneProfile)}
            >
              同步当前
            </Button>
          </div>
        </div>

        {/* 只保留运营指标，不展示内部协议和鉴权细节。 */}
        <StatisticCard.Group direction="row" bordered={false} style={{ marginBottom: 12 }}>
          <StatisticCard statistic={{ title: '服务器', value: controlPlaneOverview.total }} />
          <StatisticCard statistic={{ title: '可调度账号', value: controlPlaneOverview.schedulableAccounts }} />
          <StatisticCard statistic={{ title: '会话', value: controlPlaneOverview.sessions }} />
        </StatisticCard.Group>

        <Tabs
          className="settings-control-plane-manage-tabs"
          items={[
            {
              key: 'profiles',
              label: 'Server',
              children: (
                serverRouteRows.length === 0 ? (
                  <div className="settings-control-plane-empty">
                    <Alert type="info" showIcon message="暂无已保存 Server" />
                    <Button
                      type="primary"
                      icon={<PlusOutlined />}
                      onClick={openAddControlPlaneModal}
                    >
                      添加 Server
                    </Button>
                  </div>
                ) : (
                  <ListTable
                    dataSource={serverRouteRows}
                    rowKey="stableServerId"
                    rowClassName={(row) => activeControlPlaneId === row.profile.id ? 'settings-control-plane-item--active' : ''}
                    columns={[
                      {
                        title: 'Server',
                        key: 'profile',
                        render: (_: unknown, row: ServerRouteRow) => (
                          <div className="settings-node-main">
                            <strong>{row.profile.name || row.profile.endpoint}</strong>
                            <span>{row.stableServerId}</span>
                            {row.profile.lastError && <span className="settings-control-plane-error">{row.profile.lastError}</span>}
                          </div>
                        )
                      },
                      {
                        title: '连接路径',
                        key: 'routes',
                        render: (_: unknown, row: ServerRouteRow) => renderServerRoutes(row)
                      },
                      {
                        title: '状态',
                        key: 'summary',
                        render: (_: unknown, row: ServerRouteRow) => (
                          renderControlPlaneSummary(row.profile, row.authorizationPending)
                        )
                      },
                      {
                        title: '操作',
                        key: 'actions',
                        width: 280,
                        render: (_: unknown, row: ServerRouteRow) => {
                          const profile = row.profile;
                          const active = activeControlPlaneId === profile.id;
                          return (
                            <Space size={6} wrap>
                              {active && <Tag color="green">当前</Tag>}
                              {row.authorizationPending ? (
                                <Button size="small" type="primary" onClick={() => openDiscoveredServerAuthorization(profile)}>
                                  授权
                                </Button>
                              ) : (
                                <>
                                  <Button size="small" disabled={active} onClick={() => handleSelectControlPlane(profile.id)}>
                                    设为当前
                                  </Button>
                                  <Button
                                    size="small"
                                    icon={<ReloadOutlined />}
                                    loading={checkingControlPlaneId === profile.id}
                                    onClick={() => handleRefreshControlPlane(profile)}
                                  >
                                    同步
                                  </Button>
                                </>
                              )}
                              <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleRemoveControlPlane(profile.id)}>
                                移除
                              </Button>
                            </Space>
                          );
                        }
                      }
                    ]}
                  />
                )
              )
            }
          ]}
        />
      </ProCard>

      {isNativeDesktopRuntime() && (
        <PublicServerEntryCard profiles={logicalControlPlaneProfiles} />
      )}

      <Modal
        title={authorizingControlPlaneId ? '授权 Server' : '添加 Server'}
        open={controlPlaneAddModalOpen}
        width={760}
        footer={null}
        forceRender
        onCancel={closeControlPlaneModal}
      >
        <Form
          form={controlPlaneForm}
          layout="vertical"
          onFinish={handleSaveControlPlane}
          initialValues={{
            endpoint: '',
            name: 'AIH Server'
          }}
        >
                  <Form.Item
                    name="endpoint"
                    label="Server URL"
                    help="支持 HTTPS、Tailscale/ZeroTier/WireGuard IP、Cloudflare Tunnel 或局域网地址；原生客户端仅允许回环地址使用 HTTP。"
                    rules={[{ required: true, message: '请输入 Server URL' }]}
                  >
                    <Input placeholder="https://aih.example.com" />
                  </Form.Item>
                  {renderControlEndpointHints(
                    controlPlaneEndpointHints,
                    controlPlaneEndpointWarnings,
                    (endpoint) => controlPlaneForm.setFieldsValue({ endpoint })
                  )}

                  <Form.Item name="name" label="显示名称">
                    <Input placeholder="Home AIH" />
                  </Form.Item>

          <Form.Item
            name="managementKey"
            label="Management Key"
            help="Server 管理密钥，用于读取账号和会话。可通过 aih server config --show-secrets 查看。"
            rules={[{ required: true, message: '请输入 Management Key' }]}
          >
            <Input.Password autoComplete="new-password" placeholder="Management Key" />
          </Form.Item>

                  <Form.Item>
                    <Button type="primary" htmlType="submit" icon={<LinkOutlined />} loading={controlPlaneSaving}>
                      {authorizingControlPlaneId ? '授权并连接' : '探测并保存'}
                    </Button>
                  </Form.Item>
        </Form>
      </Modal>
    </div>
  );

  const sectionItems: SettingsSectionItem[] = [
    {
      key: 'basic',
      label: '基础设置',
      forceRender: true,
      children: basicSettingsContent,
    },
    {
      key: 'aliases',
      label: '模型别名',
      children: <ModelAliases setActions={setExtraActions} />,
      actions: extraActions,
    },
    {
      key: 'control-planes',
      label: 'Server',
      forceRender: true,
      children: controlPlanesContent,
      actions: controlPlanesActions,
    },
    {
      key: 'ssh-hosts',
      label: 'SSH 开发机',
      children: <SshHostsPanel setActions={setExtraActions} />,
      actions: extraActions,
    },
  ];
  const standaloneSection = section ? sectionItems.find((item) => item.key === section) : null;

  if (standaloneSection) {
    const meta = SETTINGS_PAGE_META[standaloneSection.key];
    return (
      <PageScaffold
        title={meta.title}
        subTitle={meta.description}
        extra={standaloneSection.actions}
        ghost
        className="animate__animated animate__fadeIn animate__faster"
      >
        <div className="settings-section-content">
          {standaloneSection.children}
        </div>
      </PageScaffold>
    );
  }

  return (
    <PageScaffold
      title={SETTINGS_PAGE_META.settings.title}
      subTitle={SETTINGS_PAGE_META.settings.description}
      extra={extraActions}
      ghost
      className="animate__animated animate__fadeIn animate__faster"
    >
      {isMobile ? (
        (() => {
          const items = sectionItems.filter((item) => item.key === 'basic' || item.key === 'aliases');
          const active = items.find((it) => it.key === settingsTab) || items[0];
          return (
            <>
              <MobilePills
                items={items.map((it) => ({ key: it.key, label: it.label }))}
                activeKey={active?.key || 'basic'}
                onChange={setSettingsTab}
              />
              {active?.children}
            </>
          );
        })()
      ) : (
        <Tabs
          className="settings-tabs"
          defaultActiveKey={getInitialSettingsTab()}
          items={sectionItems.filter((item) => item.key === 'basic' || item.key === 'aliases')}
        />
      )}
    </PageScaffold>
  );
};

export default Settings;
