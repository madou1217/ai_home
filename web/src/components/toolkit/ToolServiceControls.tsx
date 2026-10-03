import { Space, Switch, Tooltip } from 'antd';
import {
  FileAddOutlined,
  FileTextOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  SyncOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import type { ManagedToolItem, ManagedToolService } from '@/types';

interface ToolServiceActionsProps {
  tool: ManagedToolItem;
  service: ManagedToolService;
  busy: string;
  onControl: (action: 'start' | 'stop' | 'restart') => void;
  onCreateConfig: () => void;
  onOpenLogs: () => void;
}

/** 服务操作按钮组：启动 / 停止 / 重启 / 新建配置 / 日志（图标 + 文字，避免与安装生命周期的图标按钮混淆）。 */
export function ToolServiceActions({ tool, service, busy, onControl, onCreateConfig, onOpenLogs }: ToolServiceActionsProps) {
  const disabled = Boolean(busy) || !service.controllable;
  return (
    <>
      {service.canStart ? (
        <Button
          size="small"
          icon={<PlayCircleOutlined />}
          loading={busy === 'start'}
          disabled={disabled}
          aria-label={`启动 ${tool.name}`}
          title={`启动 ${tool.name}`}
          onClick={() => onControl('start')}
        >
          启动
        </Button>
      ) : null}
      {service.canRestart ? (
        <Button
          size="small"
          icon={<SyncOutlined />}
          loading={busy === 'restart'}
          disabled={disabled}
          aria-label={`重启 ${tool.name}`}
          title={`重启 ${tool.name}`}
          onClick={() => onControl('restart')}
        >
          重启
        </Button>
      ) : null}
      {service.canStop ? (
        <Button
          size="small"
          danger
          icon={<PauseCircleOutlined />}
          loading={busy === 'stop'}
          disabled={disabled}
          aria-label={`停止 ${tool.name}`}
          title={`停止 ${tool.name}`}
          onClick={() => onControl('stop')}
        >
          停止
        </Button>
      ) : null}
      {service.canCreateConfig ? (
        <Button
          size="small"
          icon={<FileAddOutlined />}
          loading={busy === 'config'}
          disabled={Boolean(busy)}
          aria-label={`新建 ${tool.name} 配置`}
          title={`新建 ${tool.name} 配置`}
          onClick={onCreateConfig}
        >
          新建配置
        </Button>
      ) : null}
      {service.logAvailable ? (
        <Button
          size="small"
          icon={<FileTextOutlined />}
          aria-label={`查看 ${tool.name} 日志`}
          title={`查看 ${tool.name} 日志`}
          onClick={onOpenLogs}
        >
          日志
        </Button>
      ) : null}
    </>
  );
}

interface ToolServicePolicyProps {
  service: ManagedToolService;
  busy: string;
  onChange: (settings: { autoStart?: boolean; autoRestart?: boolean }) => void;
}

/** 守护策略：AIH 守护可切换；Homebrew 服务只读（由服务定义决定）。 */
export function ToolServicePolicy({ service, busy, onChange }: ToolServicePolicyProps) {
  const editable = Boolean(service.settingsEditable) && !busy;
  const autoStartLabel = service.backend === 'homebrew' ? '开机自启' : '随 AIH 启动';
  return (
    <Tooltip title={service.settingsNote}>
      <Space size={12} wrap className="toolkit-service-policy">
        <label className="toolkit-service-switch">
          <Switch
            size="small"
            checked={Boolean(service.autoRestart)}
            disabled={!editable}
            loading={busy === 'settings'}
            onChange={(checked) => onChange({ autoRestart: checked })}
          />
          <span>自动重启</span>
        </label>
        <label className="toolkit-service-switch">
          <Switch
            size="small"
            checked={Boolean(service.autoStart)}
            disabled={!editable}
            onChange={(checked) => onChange({ autoStart: checked })}
          />
          <span>{autoStartLabel}</span>
        </label>
      </Space>
    </Tooltip>
  );
}
