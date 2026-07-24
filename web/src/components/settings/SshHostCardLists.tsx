import { Card, Empty, Popconfirm, Space, Spin } from 'antd';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import './SshHostCardLists.css';

export interface SshConnection {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  authType: 'key' | 'key-file' | 'password' | 'agent';
  identityFile?: string;
  privateKey?: string;
  password?: string;
  createdAt: number;
}

export interface SshWorkspace {
  id: string;
  connectionId: string;
  label: string;
  remoteRoot: string;
  createdAt: number;
}

const AUTH_LABELS: Record<SshConnection['authType'], string> = {
  agent: 'SSH Agent',
  'key-file': '私钥文件',
  key: '粘贴私钥',
  password: '密码'
};

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
  if (loading) return <div className="ssh-card-loading"><Spin /></div>;
  if (connections.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无远程连接" />;

  return (
    <div className="ssh-card-list">
      {connections.map((connection) => (
        <Card key={connection.id} bordered={false} className="ssh-list-card">
          <div className="ssh-list-card-head">
            <div className="ssh-list-card-title">
              <span className="ssh-list-card-name" title={connection.label}>{connection.label}</span>
              <code className="ssh-list-card-endpoint" title={`${connection.user}@${connection.host}:${connection.port}`}>
                {connection.user}@{connection.host}:{connection.port}
              </code>
            </div>
            <span className={`ssh-auth-pill ssh-auth-pill--${connection.authType}`}>{AUTH_LABELS[connection.authType]}</span>
          </div>
          <div className="ssh-list-card-footer">
            <Space size={6} wrap>
              <Button size="small" loading={testingIds.includes(connection.id)} onClick={() => onTest(connection)}>测试连接</Button>
              <Button size="small" onClick={() => onViewWorkspaces(connection)}>查看工作区</Button>
              <Button size="small" onClick={() => onCreateWorkspace(connection)}>创建工作区</Button>
            </Space>
            <Space size={6} wrap>
              <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(connection)}>编辑</Button>
              <Popconfirm
                title="将同步删除关联该连接的所有工作空间！确认删除？"
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
          <Card key={workspace.id} bordered={false} className="ssh-list-card">
            <div className="ssh-list-card-head">
              <div className="ssh-list-card-title">
                <span className="ssh-list-card-name" title={workspace.label}>{workspace.label}</span>
                <code className="ssh-list-card-path" title={workspace.remoteRoot}>{workspace.remoteRoot}</code>
              </div>
              <span className={`ssh-connection-pill${connection ? '' : ' ssh-connection-pill--missing'}`}>
                {connection ? connection.label : '连接已删除'}
              </span>
            </div>
            {connection && (
              <div className="ssh-list-card-meta" title={`${connection.user}@${connection.host}:${connection.port}`}>
                {connection.user}@{connection.host}:{connection.port}
              </div>
            )}
            <div className="ssh-list-card-footer ssh-list-card-footer--end">
              <Space size={6} wrap>
                <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(workspace)}>编辑</Button>
                <Popconfirm
                  title="仅在数据库中删除此空间，不会影响远程服务器的物理文件。确认移除？"
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
