import { CloudSyncOutlined, EditOutlined } from '@ant-design/icons';
import { Space, Tag, Tooltip } from 'antd';
import Button from '@/components/ui/AppButton';
import type { Account, ManagedAppItem } from '@/types';
import InstallLifecycleAction from './InstallLifecycleAction';
import ManagedAppIcon from './ManagedAppIcon';
import ManagedAppAccountActions from './ManagedAppAccountActions';
import ManagedResourceCard from './ManagedResourceCard';
import { SESSION_SYNC_SUMMARY } from '@/components/session-sync-copy';
import {
  getAppCurrentVersion,
  getAppHookStatusDetail as getHookStatusDetail,
  hasExistingAppConfig as hasExistingConfig,
  SYNC_MODE_DESCRIPTIONS,
  SYNC_MODE_LABELS
} from './managed-app-presentation';

export { SYNC_MODE_LABELS } from './managed-app-presentation';

export interface ManagedAppCardProps {
  app: ManagedAppItem;
  busyAction?: 'install' | 'update' | 'uninstall';
  installingHooks: boolean;
  checkingUpdate?: boolean;
  accounts: Account[];
  runningAccountPids: Record<string, number[]>;
  runningCliAccountPids: Record<string, number[]>;
  onAction: (app: ManagedAppItem, action: 'install' | 'update' | 'uninstall') => void;
  onCheckUpdate: (app: ManagedAppItem) => void;
  onOpenApp: (app: ManagedAppItem, accountRef?: string, unscoped?: boolean) => void;
  onCloseApp: (app: ManagedAppItem, accountRef: string) => void;
  onInstallHooks: (provider: string) => void;
  onEditConfig: (app: ManagedAppItem) => void;
}

export default function ManagedAppCard({
  app,
  busyAction,
  installingHooks,
  checkingUpdate,
  accounts,
  runningAccountPids,
  runningCliAccountPids,
  onAction,
  onCheckUpdate,
  onOpenApp,
  onCloseApp,
  onInstallHooks,
  onEditConfig
}: ManagedAppCardProps) {
  const canInstall = Boolean(app.installAvailable);
  const existingConfig = hasExistingConfig(app);
  const hookStatusDetail = getHookStatusDetail(app);
  const currentVersion = getAppCurrentVersion(app);
  const details = [
    {
      label: '当前版本',
      value: currentVersion,
      muted: !app.installed
    },
    ...(app.installed ? [{
      label: '程序路径',
      value: app.cliPath || '未探测到',
      tooltip: app.cliPath || '未探测到可执行路径'
    }] : []),
    ...(existingConfig ? [{
      label: '配置',
      value: `${app.configName} 已存在`
    }] : [])
  ];

  return (
    <ManagedResourceCard
      resourceId={app.id}
      name={app.name}
      installed={app.installed}
      icon={<ManagedAppIcon app={app} />}
      badges={app.installed && app.hookSupported ? (
        <Tag color={app.hookInstalled ? 'blue' : 'warning'}>
          {app.hookInstalled ? '即时刷新已启用' : '即时刷新待启用'}
        </Tag>
      ) : null}
      details={details}
      actions={(
        <Space size={6} wrap>
          {app.installed && (app.type === 'cli' || app.type === 'desktop') ? (
            <ManagedAppAccountActions
              app={app}
              accounts={accounts}
              runningAccountPids={runningAccountPids}
              runningCliAccountPids={runningCliAccountPids}
              disabled={Boolean(busyAction)}
              onOpen={onOpenApp}
              onClose={onCloseApp}
            />
          ) : null}
          {!app.installed && canInstall ? (
            <InstallLifecycleAction
              action="install"
              size="small"
              iconOnly
              tooltip={`安装 ${app.name}`}
              aria-label={`安装 ${app.name}`}
              loading={busyAction === 'install'}
              disabled={Boolean(busyAction)}
              onClick={() => onAction(app, 'install')}
            />
          ) : null}
          {app.installed ? (
            <>
              <InstallLifecycleAction
                action="update"
                size="small"
                iconOnly
                tooltip={`更新 ${app.name}`}
                aria-label={`更新 ${app.name}`}
                loading={checkingUpdate || busyAction === 'update'}
                disabled={Boolean(busyAction) || checkingUpdate || app.canUpdate === false}
                onClick={() => onCheckUpdate(app)}
              />
              <InstallLifecycleAction
                action="uninstall"
                size="small"
                iconOnly
                tooltip={`卸载 ${app.name}`}
                aria-label={`卸载 ${app.name}`}
                loading={busyAction === 'uninstall'}
                disabled={Boolean(busyAction) || app.canUninstall === false}
                onClick={() => onAction(app, 'uninstall')}
              />
            </>
          ) : null}
          {app.installed && app.hookSupported && !app.hookInstalled ? (
            <Tooltip title={`${SESSION_SYNC_SUMMARY} 启用后会重新读取配置并验证。`}>
              <Button
                size="small"
                icon={<CloudSyncOutlined />}
                loading={installingHooks}
                disabled={Boolean(busyAction)}
                onClick={() => onInstallHooks(app.provider)}
              >
                启用即时刷新
              </Button>
            </Tooltip>
          ) : null}
          {existingConfig ? (
            <Tooltip title={`编辑 ${app.name} 配置`}>
              <Button
                size="small"
                shape="circle"
                icon={<EditOutlined />}
                aria-label={`编辑 ${app.name} 配置`}
                onClick={() => onEditConfig(app)}
              />
            </Tooltip>
          ) : null}
        </Space>
      )}
      footer={app.type === 'cli' ? (
        <div className="toolkit-sync-summary">
          <Tooltip title={SYNC_MODE_DESCRIPTIONS[app.syncMode]}>
            <span className="toolkit-sync-mode">网页会话刷新：{SYNC_MODE_LABELS[app.syncMode]}</span>
          </Tooltip>
          {hookStatusDetail ? <span className="toolkit-sync-detail">{hookStatusDetail}</span> : null}
        </div>
      ) : null}
    />
  );
}
