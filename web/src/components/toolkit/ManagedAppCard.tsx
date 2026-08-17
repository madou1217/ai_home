import { CloudSyncOutlined, EditOutlined } from '@ant-design/icons';
import { Space, Tag, Tooltip } from 'antd';
import Button from '@/components/ui/AppButton';
import type { ManagedAppItem } from '@/types';
import InstallLifecycleAction from './InstallLifecycleAction';
import ManagedAppIcon from './ManagedAppIcon';

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
  hook: 'Provider 官方 Hook 把会话事件实时通知给 WebUI，不上传凭据或配置文件内容。',
  polling: '没有官方 Hook，WebUI 通过会话文件轮询获取变化，可能有轻微延迟。',
  unavailable: '当前 Provider 没有可用的会话事件或会话文件读取能力。'
};

export interface ManagedAppCardProps {
  app: ManagedAppItem;
  installingApp: boolean;
  installingHooks: boolean;
  onInstall: (app: ManagedAppItem) => void;
  onInstallHooks: (provider: string) => void;
  onEditConfig: (app: ManagedAppItem) => void;
}

function hasExistingConfig(app: ManagedAppItem) {
  return Boolean(app.configExists && app.configName);
}

export default function ManagedAppCard({
  app,
  installingApp,
  installingHooks,
  onInstall,
  onInstallHooks,
  onEditConfig
}: ManagedAppCardProps) {
  const canInstall = app.type === 'cli' || (app.type === 'desktop' && app.installAvailable);
  const existingConfig = hasExistingConfig(app);

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
                {app.hookSupported ? (
                  <Tag color={app.hookInstalled ? 'blue' : 'warning'}>
                    {app.hookInstalled ? '会话 Hook 已启用' : '会话 Hook 待配置'}
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
          {canInstall ? (
            <InstallLifecycleAction
              action={app.installed ? 'update' : 'install'}
              size="small"
              loading={installingApp}
              onClick={() => onInstall(app)}
            />
          ) : null}
          {app.hookSupported && !app.hookInstalled ? (
            <Button
              size="small"
              icon={<CloudSyncOutlined />}
              loading={installingHooks}
              onClick={() => onInstallHooks(app.provider)}
            >
              安装会话 Hook
            </Button>
          ) : null}
          {existingConfig ? (
            <Button size="small" icon={<EditOutlined />} onClick={() => onEditConfig(app)}>
              编辑配置
            </Button>
          ) : null}
        </Space>
        <Tooltip title={SYNC_MODE_DESCRIPTIONS[app.syncMode]}>
          <span className="toolkit-sync-mode">会话同步：{SYNC_MODE_LABELS[app.syncMode]}</span>
        </Tooltip>
      </div>
    </article>
  );
}
