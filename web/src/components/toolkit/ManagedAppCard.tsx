import { CloudSyncOutlined, EditOutlined, ExportOutlined } from '@ant-design/icons';
import { Space, Tag, Tooltip } from 'antd';
import Button from '@/components/ui/AppButton';
import type { ManagedAppItem } from '@/types';
import InstallLifecycleAction from './InstallLifecycleAction';
import ManagedAppIcon from './ManagedAppIcon';
import { SESSION_SYNC_BOUNDARY, SESSION_SYNC_SCOPE } from '@/components/session-sync-copy';

export const APP_TYPE_LABELS: Record<ManagedAppItem['type'], string> = {
  cli: 'CLI',
  desktop: '桌面客户端',
  ide: 'IDE 扩展'
};

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
  onAction: (app: ManagedAppItem, action: 'install' | 'update' | 'uninstall') => void;
  onOpenApp: (app: ManagedAppItem) => void;
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
  onAction,
  onOpenApp,
  onInstallHooks,
  onEditConfig
}: ManagedAppCardProps) {
  const canInstall = app.type === 'cli' ? Boolean(app.installAvailable) : (app.type === 'desktop' && app.installAvailable);
  const lifecycleManaged = app.type === 'cli' || app.type === 'desktop';
  const existingConfig = hasExistingConfig(app);
  const hookStatusDetail = getHookStatusDetail(app);

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
              <Space size={4} wrap>
                <Tag color="blue">{APP_TYPE_LABELS[app.type]}</Tag>
                <Tag color={app.installed ? 'success' : 'default'}>{app.installed ? '已安装' : '未安装'}</Tag>
                {app.installed && app.hookSupported ? (
                  <Tag color={app.hookInstalled ? 'blue' : 'warning'}>
                    {app.hookInstalled ? '会话同步已验证' : '会话同步待启用'}
                  </Tag>
                ) : null}
              </Space>
            </div>
          </div>
        </div>
        <dl className="toolkit-card-body">
          <div className="toolkit-detail-row">
            <dt className="toolkit-detail-label">版本</dt>
            <dd className="toolkit-detail-value">{app.version || '未探测到'}</dd>
          </div>
          <div className="toolkit-detail-row">
            <dt className="toolkit-detail-label">主模型</dt>
            <dd className="toolkit-detail-value">{app.type === 'cli' ? (app.defaultModel || '未声明') : '由应用自身管理'}</dd>
          </div>
          <div className="toolkit-detail-row">
            <dt className="toolkit-detail-label">程序路径</dt>
            <dd className="toolkit-detail-value">
              <Tooltip title={app.cliPath || '未探测到可执行路径'}>{app.cliPath || '未探测到'}</Tooltip>
            </dd>
          </div>
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
          {app.type === 'desktop' && app.installed ? (
            <Button
              size="small"
              icon={<ExportOutlined />}
              disabled={Boolean(busyAction)}
              onClick={() => onOpenApp(app)}
            >
              打开应用
            </Button>
          ) : null}
          {!app.installed && canInstall ? (
            <InstallLifecycleAction
              action="install"
              size="small"
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
                loading={busyAction === 'update'}
                disabled={Boolean(busyAction) || app.canUpdate === false}
                title={app.canUpdate === false ? (app.updateReason || '没有可用更新计划') : undefined}
                onClick={() => onAction(app, 'update')}
              />
              <InstallLifecycleAction
                action="uninstall"
                size="small"
                loading={busyAction === 'uninstall'}
                disabled={Boolean(busyAction) || app.canUninstall === false}
                title={app.canUninstall === false ? (app.uninstallReason || '没有安全卸载计划') : undefined}
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
            <Button size="small" icon={<EditOutlined />} onClick={() => onEditConfig(app)}>
              编辑配置
            </Button>
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
