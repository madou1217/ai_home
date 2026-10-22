import { CloudSyncOutlined, EditOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { Badge, Popconfirm, Space, Tag, Tooltip } from 'antd';
import Button from '@/components/ui/AppButton';
import type { Account, ManagedAppItem } from '@/types';
import InstallLifecycleAction from './InstallLifecycleAction';
import ManagedAppIcon from './ManagedAppIcon';
import ManagedAppAccountActions from './ManagedAppAccountActions';
import ManagedResourceCard from './ManagedResourceCard';
import type { ManagedAppUpgradeView } from './provider-cli-upgrade-presentation';
import { SESSION_SYNC_SUMMARY } from '@/components/session-sync-copy';
import {
  getAppAdvancedEntryLabel,
  getAppCurrentVersion,
  getAppHookStatusDetail as getHookStatusDetail,
  hasExistingAppConfig as hasExistingConfig
} from './managed-app-presentation';

/**
 * 有新版时更新图标右上角的小黄点。用主题的 warning 色而不是 antd 默认红点：
 * 红点是「出错了」，有新版是正常且值得做的事，不该被读成故障。
 */
const UPGRADE_DOT_COLOR = 'var(--color-warning)';

/** 自动升级状态标签的色板：与纯展示映射的 tone 一一对应，不再另设语义。 */
const UPGRADE_TAG_COLORS: Record<ManagedAppUpgradeView['statusTone'], string> = {
  success: 'success',
  warning: 'warning',
  error: 'error',
  active: 'processing',
  neutral: 'default'
};

export interface ManagedAppCardProps {
  app: ManagedAppItem;
  busyAction?: 'install' | 'update' | 'uninstall';
  installingHooks: boolean;
  checkingUpdate?: boolean;
  accounts: Account[];
  runningAccountPids: Record<string, number[]>;
  runningCliAccountPids: Record<string, number[]>;
  /** 该 provider 的自动升级账本结论；账本里没有就传 null（卡片不显示任何升级结论）。 */
  upgrade?: ManagedAppUpgradeView | null;
  clearingUpgrade?: boolean;
  onAction: (app: ManagedAppItem, action: 'install' | 'update' | 'uninstall') => void;
  onCheckUpdate: (app: ManagedAppItem) => void;
  onOpenApp: (app: ManagedAppItem, accountRef?: string, unscoped?: boolean) => void;
  onCloseApp: (app: ManagedAppItem, accountRef: string) => void;
  onInstallHooks: (provider: string) => void;
  onClearUpgradeBroken?: (provider: string) => void;
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
  upgrade,
  clearingUpgrade,
  onAction,
  onCheckUpdate,
  onOpenApp,
  onCloseApp,
  onInstallHooks,
  onClearUpgradeBroken,
  onEditConfig
}: ManagedAppCardProps) {
  const canInstall = Boolean(app.installAvailable);
  const existingConfig = hasExistingConfig(app);
  const configFileCount = Math.max(0, Number(app.configFileCount) || 0);
  const canOpenAdvanced = app.type === 'cli' || configFileCount > 0;
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
    ...(configFileCount > 0 ? [{
      label: '配置文件',
      value: `${configFileCount} 个可管理`
    }] : existingConfig ? [{
      label: '配置',
      value: `${app.configName} 已存在`
    }] : []),
    // 自动升级的账本结论挂回这条 provider 卡片：同一个 provider 只在一个地方给版本结论。
    ...(upgrade ? [{
      label: '自动升级',
      value: upgrade.statusLabel,
      tooltip: `${upgrade.channelLabel} · 最近检查 ${upgrade.lastCheckText}`,
      muted: upgrade.statusTone === 'neutral'
    }] : []),
    // 不再单列「升级结论」：它在常态下只是把左边那行状态换个说法（「已是最新」→「已是最新版」），
    // 只有需要人介入时，reasonText 才带着状态标签给不出的原因（熔断原因、回滚后仍失败等）。
    ...(upgrade?.attention && upgrade.reasonText ? [{
      label: '原因',
      value: upgrade.reasonText
    }] : []),
    ...(upgrade?.knownGoodVersion ? [{
      label: '回退锚点',
      value: upgrade.knownGoodVersion
    }] : []),
    ...(upgrade?.blockedVersions.length ? [{
      label: '已拉黑版本',
      value: upgrade.blockedVersions.join('、'),
      tooltip: '验证失败过的版本，不会再被安装'
    }] : [])
  ];

  // 有新版只交给更新图标上的黄点，不再额外贴标签：同一件事说两遍反而像在催。
  const upgradeBadge = upgrade?.attention ? (
    <Tag color={UPGRADE_TAG_COLORS[upgrade.statusTone]}>{upgrade.statusLabel}</Tag>
  ) : null;
  // 「已启用」是常态，每张卡都挂一个一切正常的标签只是噪音；只有待启用时
  // 才需要提示——那是一个还没做、且点一下就能做好的动作。
  const hookBadge = app.installed && app.hookSupported && !app.hookInstalled ? (
    <Tag color="warning">即时刷新待启用</Tag>
  ) : null;

  return (
    <ManagedResourceCard
      resourceId={app.id}
      name={app.name}
      installed={app.installed}
      icon={<ManagedAppIcon app={app} />}
      badges={<>
        {hookBadge}
        {upgradeBadge}
      </>}
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
              <Badge dot={Boolean(upgrade?.hasUpdate)} color={UPGRADE_DOT_COLOR} offset={[-2, 2]}>
                <InstallLifecycleAction
                  action="update"
                  size="small"
                  iconOnly
                  tooltip={upgrade?.hasUpdate ? `更新 ${app.name}：有新版 ${upgrade.versionText}` : `更新 ${app.name}`}
                  aria-label={`更新 ${app.name}`}
                  loading={checkingUpdate || busyAction === 'update'}
                  disabled={Boolean(busyAction) || checkingUpdate || app.canUpdate === false}
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
      footer={hookStatusDetail ? (
        <div className="toolkit-sync-summary">
          <span className="toolkit-sync-detail">{hookStatusDetail}</span>
        </div>
      ) : null}
    />
  );
}
