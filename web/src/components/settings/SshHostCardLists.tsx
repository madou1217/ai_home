import { useEffect, useState } from 'react';
import { Card, Empty, Popconfirm, Space, Spin } from 'antd';
import { sshHostsAPI } from '@/services/api';
import { DeleteOutlined, EditOutlined, MessageOutlined, ToolOutlined } from '@ant-design/icons';
import { buildAppHref } from '@/services/app-navigation';
import { buildToolkitEnvironmentHref } from '@/pages/toolkit-url-state';
import Button from '@/components/ui/AppButton';
import {
  SSH_AUTH_LABELS as AUTH_LABELS,
  SSH_DELETE_CONNECTION_CONFIRM,
  SSH_DELETE_WORKSPACE_CONFIRM,
  formatSshTarget
} from '@/features/ssh-hosts/ssh-hosts-model';
import type { SshConnection, SshReverseTunnelStatus, SshWorkspace } from '@/features/ssh-hosts/ssh-hosts-model';
import './SshHostCardLists.css';

export type { SshConnection, SshWorkspace } from '@/features/ssh-hosts/ssh-hosts-model';

interface ConnectionListProps {
  connections: SshConnection[];
  loading: boolean;
  testingIds: string[];
  onTest: (connection: SshConnection) => void;
  onViewWorkspaces: (connection: SshConnection) => void;
  onCreateWorkspace: (connection: SshConnection) => void;
  onEdit: (connection: SshConnection) => void;
  onDelete: (id: string) => void;
}

const TUNNEL_STATUS_LABEL: Record<string, string> = { open: '已连通', connecting: '连接中', retrying: '重连中' };

/** 反向隧道状态（顺带让 Server 对齐一次隧道配置）。15s 轮询。 */
function useReverseTunnels(enabled: boolean): SshReverseTunnelStatus[] | null {
  const [tunnels, setTunnels] = useState<SshReverseTunnelStatus[] | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const load = () => { sshHostsAPI.listTunnels().then((list) => { if (alive) setTunnels(list); }).catch(() => {}); };
    load();
    return () => { alive = false; };
  }, [enabled]);
  return tunnels;
}

export function SshConnectionCardList({
  connections,
  loading,
  testingIds,
  onTest,
  onViewWorkspaces,
  onCreateWorkspace,
  onEdit,
  onDelete
}: ConnectionListProps) {
  const tunnels = useReverseTunnels(connections.some((item) => Boolean(item.reverseTunnel?.remotePort)));
  if (loading) return <div className="ssh-card-loading"><Spin /></div>;
  if (connections.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无远程连接" />;

  return (
    <div className="ssh-card-list">
      {connections.map((connection) => (
        <Card key={connection.id} bordered={false} className="ssh-list-card hud-panel hud-panel--sm">
          <div className="ssh-list-card-head">
            <div className="ssh-list-card-title">
              <span className="ssh-list-card-name" title={connection.label}>{connection.label}</span>
              <code className="ssh-list-card-endpoint" title={formatSshTarget(connection)}>
                {formatSshTarget(connection)}
              </code>
            </div>
            <span className={`ssh-auth-pill ssh-auth-pill--${connection.authType}`}>{AUTH_LABELS[connection.authType]}</span>
          </div>
          {connection.reverseTunnel?.remotePort ? (
            <div className="ssh-list-card-egress" title="这台机器的回环端口转到 AIH Server 本机 SSH">
              反向隧道：远端 127.0.0.1:{connection.reverseTunnel.remotePort} → 本机 SSH
              {tunnels ? <span> · {TUNNEL_STATUS_LABEL[tunnels.find((item) => item.connectionId === connection.id)?.status || ''] || '未启动'}</span> : null}
            </div>
          ) : null}
          {connection.egressConnectionId ? (
            <div className="ssh-list-card-egress">
              出网经由：{connections.find((item) => item.id === connection.egressConnectionId)?.label || '已删除的连接'}
            </div>
          ) : null}
          <div className="ssh-list-card-footer">
            <Space size={6} wrap>
              <Button size="small" loading={testingIds.includes(connection.id)} onClick={() => onTest(connection)}>测试连接</Button>
              <Button size="small" onClick={() => onViewWorkspaces(connection)}>查看工作区</Button>
              <Button
                size="small"
                icon={<ToolOutlined />}
                href={buildAppHref(buildToolkitEnvironmentHref(`ssh:${connection.id}`))}
              >
                环境与工具
              </Button>
              <Button size="small" onClick={() => onCreateWorkspace(connection)}>创建工作区</Button>
            </Space>
            <Space size={6} wrap>
              <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(connection)}>编辑</Button>
              <Popconfirm
                title={SSH_DELETE_CONNECTION_CONFIRM}
                onConfirm={() => onDelete(connection.id)}
                okText="确认"
                cancelText="取消"
              >
                <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
              </Popconfirm>
            </Space>
          </div>
        </Card>
      ))}
    </div>
  );
}

interface WorkspaceListProps {
  workspaces: SshWorkspace[];
  connections: SshConnection[];
  loading: boolean;
  onEdit: (workspace: SshWorkspace) => void;
  onDelete: (id: string) => void;
}

export function SshWorkspaceCardList({ workspaces, connections, loading, onEdit, onDelete }: WorkspaceListProps) {
  if (loading) return <div className="ssh-card-loading"><Spin /></div>;
  if (workspaces.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无项目工作空间" />;

  return (
    <div className="ssh-card-list">
      {workspaces.map((workspace) => {
        const connection = connections.find((item) => item.id === workspace.connectionId);
        return (
          <Card key={workspace.id} bordered={false} className="ssh-list-card hud-panel hud-panel--sm">
            <div className="ssh-list-card-head">
              <div className="ssh-list-card-title">
                <span className="ssh-list-card-name" title={workspace.label}>{workspace.label}</span>
                <code className="ssh-list-card-path" title={workspace.remoteRoot}>{workspace.remoteRoot}</code>
              </div>
              <span className={`ssh-connection-pill${connection ? '' : ' ssh-connection-pill--missing'}`}>
                <span className={`hud-led ${connection ? 'hud-led--info' : 'hud-led--err'}`} aria-hidden="true" />
                {connection ? connection.label : '连接已删除'}
              </span>
            </div>
            {connection && (
              <div className="ssh-list-card-meta" title={formatSshTarget(connection)}>
                {formatSshTarget(connection)}
              </div>
            )}
            <div className="ssh-list-card-footer ssh-list-card-footer--end">
              <Space size={6} wrap>
                {workspace.projectPath && connection ? (
                  <Button
                    size="small"
                    type="primary"
                    icon={<MessageOutlined />}
                    href={buildAppHref('/chat', `?projectPath=${encodeURIComponent(workspace.projectPath)}`)}
                    title="作为 Work 项目打开：AI 会话在 WebUI 渲染，文件与命令在这台机器上执行"
                  >
                    在 Work 中打开
                  </Button>
                ) : null}
                <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(workspace)}>编辑</Button>
                <Popconfirm
                  title={SSH_DELETE_WORKSPACE_CONFIRM}
                  onConfirm={() => onDelete(workspace.id)}
                  okText="确认"
                  cancelText="取消"
                >
                  <Button size="small" danger icon={<DeleteOutlined />}>移除</Button>
                </Popconfirm>
              </Space>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
