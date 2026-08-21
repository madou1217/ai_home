import { CloudSyncOutlined, EditOutlined } from '@ant-design/icons';
import { Space, Tag, Tooltip } from 'antd';
import Button from '@/components/ui/AppButton';
import type { Account, ManagedAppItem } from '@/types';
import InstallLifecycleAction from './InstallLifecycleAction';
import ManagedAppIcon from './ManagedAppIcon';
import ManagedAppAccountActions from './ManagedAppAccountActions';
import { SESSION_SYNC_BOUNDARY, SESSION_SYNC_SCOPE } from '@/components/session-sync-copy';

export const SYNC_MODE_LABELS: Record<ManagedAppItem['syncMode'], string> = {
  hook: '事件驱动',
  polling: '文件轮询',
  unavailable: '未接入'
};

const SYNC_MODE_DESCRIPTIONS: Record<ManagedAppItem['syncMode'], string> = {
  hook: `Provider 官方 Hook 把${SESSION_SYNC_SCOPE}的事件实时通知给 WebUI；${SESSION_SYNC_BOUNDARY}`,
  polling: '没有官方 Hook，WebUI 通过会话文件轮询获取变化，可能有轻微延迟。',
  unavailable: '当前 Provider 没有可用的会话事件或会话文件读取能力。'
};

const HOOK_REASON_LABELS: Record<string, string> = {
  disabled: 'Hook 已禁用',
  missing_events: 'Hook 配置不完整'
};

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

function hasExistingConfig(app: ManagedAppItem) {
  return Boolean(app.configExists && app.configName);
}

function getHookStatusDetail(app: ManagedAppItem) {
  if (!app.hookSupported || app.hookInstalled) return '';
  const reasonKey = String(app.hookReason || '').trim();
  const reason = HOOK_REASON_LABELS[reasonKey] || (reasonKey ? `Hook 状态：${reasonKey}` : 'Hook 尚未通过验证');
  const missingEvents = (app.hookMissingEvents || [])
    .map((event) => String(event || '').trim())
    .filter(Boolean);
  return [
    reason,
    missingEvents.length > 0 ? `缺少事件：${missingEvents.join('、')}` : ''
  ].filter(Boolean).join('；');
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
  const canInstall = app.type === 'cli' ? Boolean(app.installAvailable) : (app.type === 'desktop' && app.installAvailable);
  const lifecycleManaged = app.type === 'cli' || app.type === 'desktop';
  const existingConfig = hasExistingConfig(app);
  const hookStatusDetail = getHookStatusDetail(app);
  const currentVersion = app.installed
    ? (app.version && app.version !== '-' ? app.version : '未探测到')
    : '未安装';

  return (
    <article
      key={app.id}
      className={`toolkit-app-card ${app.installed ? 'installed' : 'uninstalled'}`}
      data-app-id={app.id}
    >
      <div>
        <div className="toolkit-card-header">
          <div className="toolkit-card-title-group">
            <ManagedAppIcon app={app} />
            <div>
              <h3 className="toolkit-card-title">{app.name}</h3>
              {app.installed && app.hookSupported ? (
                <Tag color={app.hookInstalled ? 'blue' : 'warning'}>
                  {app.hookInstalled ? '会话同步已验证' : '会话同步待启用'}
                </Tag>
              ) : null}
            </div>
          </div>
        </div>
        <dl className="toolkit-card-body">
          <div className="toolkit-detail-row">
            <dt className="toolkit-detail-label">当前版本</dt>
            <dd className={`toolkit-detail-value${app.installed ? '' : ' is-uninstalled'}`}>
              {currentVersion}
            </dd>
          </div>
          {app.installed ? (
            <div className="toolkit-detail-row">
              <dt className="toolkit-detail-label">程序路径</dt>
              <dd className="toolkit-detail-value">
                <Tooltip title={app.cliPath || '未探测到可执行路径'}>{app.cliPath || '未探测到'}</Tooltip>
              </dd>
            </div>
          ) : null}
          {existingConfig ? (
            <div className="toolkit-detail-row">
              <dt className="toolkit-detail-label">配置</dt>
              <dd className="toolkit-detail-value">{app.configName} 已存在</dd>
            </div>
          ) : null}
        </dl>
      </div>
      <div className="toolkit-card-actions">
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
          {app.installed && lifecycleManaged ? (
            <>
              <InstallLifecycleAction
                action="update"
                size="small"
                iconOnly
                tooltip={`检查 ${app.name} 更新`}
                aria-label={`检查 ${app.name} 更新`}
                loading={checkingUpdate || busyAction === 'update'}
                disabled={Boolean(busyAction) || checkingUpdate}
                onClick={() => onCheckUpdate(app)}
              />
              <InstallLifecycleAction
                action="uninstall"
                size="small"
                iconOnly
                tooltip={app.canUninstall === false
                  ? `无法卸载 ${app.name}：${app.uninstallReason || '没有安全卸载计划'}`
                  : `卸载 ${app.name}`}
                aria-label={`卸载 ${app.name}`}
                loading={busyAction === 'uninstall'}
                disabled={Boolean(busyAction) || app.canUninstall === false}
                onClick={() => onAction(app, 'uninstall')}
              />
            </>
          ) : null}
          {app.installed && app.hookSupported && !app.hookInstalled ? (
            <Tooltip title={`仅写入 AIH 标记的官方事件 Hook，把${SESSION_SYNC_SCOPE}通知 WebUI；${SESSION_SYNC_BOUNDARY}安装后会重新读取并验证。`}>
              <Button
                size="small"
                icon={<CloudSyncOutlined />}
                loading={installingHooks}
                disabled={Boolean(busyAction)}
                onClick={() => onInstallHooks(app.provider)}
              >
                启用会话同步
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
        <div className="toolkit-sync-summary">
          <Tooltip title={SYNC_MODE_DESCRIPTIONS[app.syncMode]}>
            <span className="toolkit-sync-mode">会话同步：{SYNC_MODE_LABELS[app.syncMode]}</span>
          </Tooltip>
          {hookStatusDetail ? <span className="toolkit-sync-detail">{hookStatusDetail}</span> : null}
        </div>
      </div>
    </article>
  );
}
