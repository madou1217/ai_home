import { EditOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { Badge, Popconfirm, Space, Tooltip } from 'antd';
import Button from '@/components/ui/AppButton';
import type { Account, ManagedAppItem } from '@/types';
import InstallLifecycleAction from './InstallLifecycleAction';
import ManagedAppIcon from './ManagedAppIcon';
import ManagedAppAccountActions, { type ManagedAppLaunchTarget } from './ManagedAppAccountActions';
import ManagedResourceCard from './ManagedResourceCard';
import type { ManagedAppUpgradeView } from './provider-cli-upgrade-presentation';
import {
  getAppAdvancedEntryLabel,
  getAppCurrentVersion,
  getManagedAppWarning,
  hasExistingAppConfig as hasExistingConfig
} from './managed-app-presentation';

/**
 * 有新版时更新图标右上角的小黄点。用主题的 warning 色而不是 antd 默认红点：
 * 红点是「出错了」，有新版是正常且值得做的事，不该被读成故障。
 */
const UPGRADE_DOT_COLOR = 'var(--color-warning)';

export interface ManagedAppCardProps {
  app: ManagedAppItem;
  busyAction?: 'install' | 'update' | 'uninstall';
  checkingUpdate?: boolean;
  accounts: Account[];
  runningAccountPids: Record<string, number[]>;
  runningCliAccountPids: Record<string, number[]>;
  /** 该 provider 的自动升级账本结论；账本里没有就传 null（卡片不显示任何升级结论）。 */
  upgrade?: ManagedAppUpgradeView | null;
  clearingUpgrade?: boolean;
  onAction: (app: ManagedAppItem, action: 'install' | 'update' | 'uninstall') => void;
  onCheckUpdate: (app: ManagedAppItem) => void;
  onOpenApp: (app: ManagedAppLaunchTarget, accountRef?: string, unscoped?: boolean) => void;
  onCloseApp: (app: ManagedAppLaunchTarget, accountRef: string) => void;
  onClearUpgradeBroken?: (provider: string) => void;
  onEditConfig: (app: ManagedAppItem) => void;
}

export default function ManagedAppCard({
  app,
  busyAction,
  checkingUpdate,
  accounts,
  runningAccountPids,
  runningCliAccountPids,
  upgrade,
  clearingUpgrade,
  onAction,
  onCheckUpdate,
  onOpenApp,
  onCloseApp,
  onClearUpgradeBroken,
  onEditConfig
}: ManagedAppCardProps) {
  const canInstall = Boolean(app.installAvailable);
  const existingConfig = hasExistingConfig(app);
  const configFileCount = Math.max(0, Number(app.configFileCount) || 0);
  const canOpenAdvanced = app.type === 'cli' || configFileCount > 0;
  const warning = getManagedAppWarning(app, upgrade);
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
      tooltip: app.cliPath || '未探测到可执行路径',
      ellipsis: true
    }] : []),
    ...(configFileCount > 0 ? [{
      label: '配置文件',
      value: `${configFileCount} 个可管理`
    }] : existingConfig ? [{
      label: '配置',
      value: `${app.configName} 已存在`
    }] : []),
  ];

  return (
    <ManagedResourceCard
      resourceId={app.id}
      name={app.name}
      installed={app.installed}
      icon={<ManagedAppIcon app={app} />}
      warning={warning}
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
              {/* 自动升级在装这个 provider 时，转圈就是进度本身；有新版则挂黄点。 */}
              <Badge
                dot={Boolean(upgrade?.hasUpdate) && !upgrade?.applying}
                color={UPGRADE_DOT_COLOR}
                offset={[-2, 2]}
              >
                <InstallLifecycleAction
                  action="update"
                  size="small"
                  iconOnly
                  tooltip={upgrade?.applying
                    ? `正在升级 ${app.name}…`
                    : upgrade?.hasUpdate ? `更新 ${app.name}：有新版 ${upgrade.versionText}` : `更新 ${app.name}`}
                  aria-label={`更新 ${app.name}`}
                  loading={Boolean(upgrade?.applying) || checkingUpdate || busyAction === 'update'}
                  disabled={Boolean(busyAction) || checkingUpdate || Boolean(upgrade?.applying) || app.canUpdate === false}
                  onClick={() => onCheckUpdate(app)}
                />
              </Badge>
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
          {/* 熔断只能人工解除，且服务端会先用升级同一套判据验证当前 CLI，所以入口放在 providers 卡片上。 */}
          {upgrade?.canClearBroken && onClearUpgradeBroken ? (
            <Popconfirm
              title={`验证并解除 ${app.name} 的熔断？`}
              description="会用升级同一套验证检查当前安装的版本（可能需要十几秒），通过才解除并恢复自动升级；不会安装任何东西。"
              okText="验证并解除"
              cancelText="取消"
              onConfirm={() => onClearUpgradeBroken(app.provider)}
            >
              <Tooltip title={`自动升级已熔断：${upgrade.reasonText || '需要人工确认'}`}>
                <Button
                  size="small"
                  icon={<SafetyCertificateOutlined />}
                  loading={Boolean(clearingUpgrade)}
                  disabled={Boolean(busyAction) || Boolean(clearingUpgrade)}
                >
                  验证并解除
                </Button>
              </Tooltip>
            </Popconfirm>
          ) : null}
          {canOpenAdvanced ? (
            <Tooltip title={`${app.name} 高级设置：${getAppAdvancedEntryLabel(app, configFileCount)}`}>
              <Button
                size="small"
                shape="circle"
                icon={<EditOutlined />}
                aria-label={`${app.name} 高级设置`}
                onClick={() => onEditConfig(app)}
              />
            </Tooltip>
          ) : null}
        </Space>
      )}
    />
  );
}
