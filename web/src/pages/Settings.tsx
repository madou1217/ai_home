import '@/components/settings/settings-shared.css';
import '@/components/ui/kpi-strip.css';
import './Settings.css';
import { useEffect, useState, type ReactNode } from 'react';
import { Tabs } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { isControlPlaneProfileRefreshable } from '@/services/control-plane-profiles';
import type { ControlPlaneProfile } from '@/types';
import PageScaffold from '@/components/ui/PageScaffold';
import PageHeaderActions from '@/components/ui/PageHeaderActions';
import BasicSettingsSection from '@/features/settings/BasicSettingsSection';
import ServiceSettingsSection from '@/features/settings/ServiceSettingsSection';
import ControlPlaneSettingsSection from '@/features/settings/ControlPlaneSettingsSection';
import CaptureSettingsCard from '@/features/capture/CaptureSettingsCard';
import { useManagementRestart } from '@/features/settings/use-management-restart';
import {
  useControlPlaneProfilesState,
  useServiceConfigState
} from '@/features/settings/use-settings-data';
import ModelAliases from './ModelAliases';
import UpstreamErrorMappings from './UpstreamErrorMappings';
import SshHostsPanel from './SshHostsPanel';
import FailureSemantics from './FailureSemantics';
import ClientKeysPanel from './ClientKeys';
import ConcurrencyLimitsPanel from './ConcurrencyLimits';
import SwapSettingsCard from '@/features/settings/SwapSettingsCard';

export type SettingsSectionKey =
  | 'basic'
  | 'capture'
  | 'service'
  | 'aliases'
  | 'upstream-errors'
  | 'failure-semantics'
  | 'api-keys'
  | 'concurrency'
  | 'control-planes'
  | 'ssh-hosts';

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
    code: 'CONFIG',
    title: '设置',
    description: '管理当前 Server、外观、录制与运行参数。'
  },
  basic: {
    code: 'CONFIG',
    title: '基础设置',
    description: '管理当前 Server、粘贴阈值与本机外观。'
  },
  capture: {
    code: 'CAPTURE',
    title: '截图与录制',
    description: '管理预览导出格式、录制方式与水印。'
  },
  service: {
    code: 'SERVICE',
    title: '服务与调度',
    description: '管理账号调度、429 重试与本地服务监听参数。'
  },
  aliases: {
    code: 'CONFIG',
    title: '模型别名',
    description: '管理模型展示名称与路由别名。'
  },
  'upstream-errors': {
    code: 'ROUTE',
    title: '上游异常映射',
    description: '将 Provider 错误响应映射为标准运行状态。'
  },
  'failure-semantics': {
    code: 'ROUTE',
    title: '失败语义',
    description: '查看状态码到失败语义与冷却策略的映射。'
  },
  'api-keys': {
    code: 'AUTH',
    title: 'API Keys',
    description: '管理客户端 API Key 与调用统计。'
  },
  concurrency: {
    code: 'LIMITS',
    title: '限流与并发',
    description: '管理全局并发、Provider 默认与账号覆盖。'
  },
  'control-planes': {
    code: 'SERVER',
    title: 'Server 管理',
    description: '管理已保存的 AIH Server 与默认连接目标。'
  },
  'ssh-hosts': {
    code: 'SSH',
    title: 'SSH 开发机',
    description: '管理 SSH 连接与远端开发工作区。'
  }
} as const;

const URL_TAB_KEYS: ReadonlyArray<SettingsSectionKey> = [
  'capture',
  'service',
  'aliases',
  'upstream-errors',
  'failure-semantics',
  'api-keys',
  'concurrency',
  'control-planes',
  'ssh-hosts'
];

function getInitialSettingsTab(): SettingsSectionKey {
  if (typeof window === 'undefined') return 'basic';
  const params = new URLSearchParams(window.location.search);
  const tab = String(params.get('tab') || '').trim() as SettingsSectionKey;
  return URL_TAB_KEYS.includes(tab) ? tab : 'basic';
}

const Settings = ({ section }: SettingsProps) => {
  const [controlPlaneAddModalOpen, setControlPlaneAddModalOpen] = useState(false);
  const [authorizingControlPlaneId, setAuthorizingControlPlaneId] = useState('');
  const [extraActions, setExtraActions] = useState<ReactNode>(null);

  const controlPlanes = useControlPlaneProfilesState();
  const serviceConfig = useServiceConfigState(
    controlPlanes.activeProfile,
    controlPlanes.syncSavedProfiles
  );
  const {
    restarting,
    restartEvent,
    restartNote: restartAlert,
    restartServer: handleRestartServer
  } = useManagementRestart();

  useEffect(() => {
    if (restartEvent?.status === 'started') {
      serviceConfig.markRestarted();
    }
  }, [restartEvent?.status, serviceConfig.markRestarted]);

  useEffect(() => {
    void serviceConfig.loadConfig();
    void controlPlanes.loadEndpointHints();
    controlPlanes.syncSavedProfiles();
  }, [section]);

  const openAddControlPlaneModal = () => {
    setAuthorizingControlPlaneId('');
    setControlPlaneAddModalOpen(true);
  };

  const openAuthorizeControlPlaneModal = (profile: ControlPlaneProfile) => {
    setAuthorizingControlPlaneId(profile.id);
    setControlPlaneAddModalOpen(true);
  };

  const closeControlPlaneModal = () => {
    setControlPlaneAddModalOpen(false);
    setAuthorizingControlPlaneId('');
  };

  const refreshableCount = controlPlanes.logicalProfiles.filter(isControlPlaneProfileRefreshable).length;

  const controlPlanesActions = (
    <PageHeaderActions
      actions={[
        {
          key: 'refresh-all',
          label: '同步全部',
          icon: <ReloadOutlined />,
          disabled: refreshableCount === 0,
          loading: controlPlanes.refreshingAll,
          onClick: () => { void controlPlanes.refreshAllProfiles(); }
        },
        {
          key: 'add',
          label: '添加 Server',
          icon: <PlusOutlined />,
          primary: true,
          onClick: openAddControlPlaneModal
        }
      ]}
    />
  );

  const sectionItems: SettingsSectionItem[] = [
    {
      key: 'basic',
      label: '基础设置',
      forceRender: true,
      children: <BasicSettingsSection />
    },
    {
      key: 'capture',
      label: '截图与录制',
      children: (
        <div className="settings-grid settings-grid--single">
          <CaptureSettingsCard />
        </div>
      )
    },
    {
      key: 'service',
      label: '服务与调度',
      children: (
        <ServiceSettingsSection
          loading={serviceConfig.loading}
          loadError={serviceConfig.loadError}
          savedUsage={serviceConfig.savedUsage}
          savedServer={serviceConfig.savedServer}
          usageSaving={serviceConfig.usageSaving}
          serverSaving={serviceConfig.serverSaving}
          usageFeedback={serviceConfig.usageFeedback}
          serverFeedback={serviceConfig.serverFeedback}
          restartRequired={serviceConfig.restartRequired}
          restarting={restarting}
          restartAlert={restartAlert}
          onReload={() => { void serviceConfig.loadConfig(); }}
          onSaveUsage={serviceConfig.saveUsage}
          onSaveServer={serviceConfig.saveServer}
          onClearUsageFeedback={() => serviceConfig.setUsageFeedback(null)}
          onClearServerFeedback={() => serviceConfig.setServerFeedback(null)}
          onRestartServer={() => { void handleRestartServer(); }}
        />
      )
    },
    {
      key: 'aliases',
      label: '模型别名',
      children: <ModelAliases setActions={setExtraActions} />,
      actions: extraActions
    },
    {
      key: 'upstream-errors',
      label: '上游异常映射',
      children: <UpstreamErrorMappings setActions={setExtraActions} />,
      actions: extraActions
    },
    {
      key: 'failure-semantics',
      label: '失败语义',
      children: <FailureSemantics />
    },
    {
      key: 'api-keys',
      label: 'API Keys',
      children: <ClientKeysPanel />
    },
    {
      key: 'concurrency',
      label: '限流与并发',
      children: <ConcurrencyLimitsPanel />
    },
    {
      key: 'control-planes',
      label: 'Server',
      forceRender: true,
      children: (
        <>
        <ControlPlaneSettingsSection
          profiles={controlPlanes.profiles}
          logicalProfiles={controlPlanes.logicalProfiles}
          serverRouteRows={controlPlanes.serverRouteRows}
          activeControlPlaneId={controlPlanes.activeId}
          activeControlPlaneProfile={controlPlanes.activeProfile}
          endpointHints={controlPlanes.endpointHints}
          endpointWarnings={controlPlanes.endpointWarnings}
          saving={controlPlanes.saving}
          checkingId={controlPlanes.checkingId}
          addModalOpen={controlPlaneAddModalOpen}
          authorizingId={authorizingControlPlaneId}
          onOpenAddModal={openAddControlPlaneModal}
          onOpenAuthorizeModal={openAuthorizeControlPlaneModal}
          onCloseModal={closeControlPlaneModal}
          onSaveProfile={(values) => controlPlanes.saveProfile(values, authorizingControlPlaneId)}
          onRefreshProfile={controlPlanes.refreshProfile}
          onRemoveProfile={controlPlanes.removeProfile}
          onSelectProfile={controlPlanes.selectProfile}
        />
      
        <SwapSettingsCard />
        </>
        ),
      actions: controlPlanesActions
    },
    {
      key: 'ssh-hosts',
      label: 'SSH 开发机',
      children: <SshHostsPanel setActions={setExtraActions} />,
      actions: extraActions
    }
  ];

  const standaloneSection = section ? sectionItems.find((item) => item.key === section) : null;

  if (standaloneSection) {
    const meta = SETTINGS_PAGE_META[standaloneSection.key];
    return (
      <PageScaffold
        code={meta.code}
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
      code={SETTINGS_PAGE_META.settings.code}
      title={SETTINGS_PAGE_META.settings.title}
      subTitle={SETTINGS_PAGE_META.settings.description}
      extra={extraActions}
      ghost
      className="animate__animated animate__fadeIn animate__faster"
    >
      {/* 移动端（< 768px）由 web/src/mobile/pages/MobileSettings 独立渲染，桌面页不挂载。 */}
      <Tabs
        className="settings-tabs"
        defaultActiveKey={getInitialSettingsTab()}
        animated={{ inkBar: true, tabPane: true }}
        items={sectionItems.filter((item) => item.key !== 'control-planes' && item.key !== 'ssh-hosts')}
      />
    </PageScaffold>
  );
};

export default Settings;
