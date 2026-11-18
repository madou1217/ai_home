import { useEffect, useState } from 'react';
import { Card, Empty, Popconfirm, Space, Spin } from 'antd';
import { fetchAuthorizedWebUiResource, sshHostsAPI, watchSshReverseTunnels } from '@/services/api';
import { DeleteOutlined, EditOutlined, MessageOutlined, ToolOutlined } from '@ant-design/icons';
import { buildAppHref } from '@/services/app-navigation';
import { buildToolkitEnvironmentHref } from '@/pages/toolkit-url-state';
import Button from '@/components/ui/AppButton';
import {
  SSH_AUTH_LABELS as AUTH_LABELS,
  SSH_DELETE_CONNECTION_CONFIRM,
  SSH_DELETE_WORKSPACE_CONFIRM,
  formatSshTarget,
  isSshReverseTunnelEnabled
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

const TUNNEL_STATUS_LABEL: Record<string, string> = { open: '已连通', connecting: '连接中', retrying: '重连中', error: '重连中' };

/** SSE 即时刷新，15s 轮询兜底；请求失败后不继续展示陈旧端口。 */
function useReverseTunnels(enabled: boolean): SshReverseTunnelStatus[] | null {
  const [tunnels, setTunnels] = useState<SshReverseTunnelStatus[] | null>(null);
  useEffect(() => {
    setTunnels(null);
    if (!enabled) return undefined;
    let alive = true;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const list = await sshHostsAPI.listTunnels();
        if (alive) setTunnels(list);
      } catch {
        if (alive) setTunnels(null);
      } finally {
        pending = false;
      }
    };
    void load();
    const source = watchSshReverseTunnels();
    source.onmessage = () => { void load(); };
    const timer = window.setInterval(() => { void load(); }, 15000);
    return () => { alive = false; source.close(); window.clearInterval(timer); };
  }, [enabled]);
  return tunnels;
}

function ReverseTunnelSummary({ connection, tunnels }: { connection: SshConnection; tunnels: SshReverseTunnelStatus[] | null }) {
  if (!isSshReverseTunnelEnabled(connection)) return null;
  const tunnel = tunnels?.find((item) => item.connectionId === connection.id);
  const state = tunnel?.state || tunnel?.status || '';
  const boundPort = state === 'open' ? tunnel?.remotePort : undefined;
  return (
    <div className="ssh-list-card-egress" role="status" title={tunnel?.error || '远端回环端口转发到 AIH Server 本机 SSH，重连后端口可能变化'}>
      反向隧道：{boundPort ? `远端 127.0.0.1:${boundPort} → 本机 SSH :${tunnel?.localPort || 22}` : '等待分配端口'}
      <span> · {TUNNEL_STATUS_LABEL[state] || (tunnels ? '未启动' : '状态待刷新')}</span>
      {tunnel?.error ? <span> · {tunnel.error}</span> : null}
    </div>
  );
}

interface SshProxyCandidate { id: string; available: boolean; error?: string }

function useSshProxyCandidates(enabled: boolean): SshProxyCandidate[] | null {
  const [candidates, setCandidates] = useState<SshProxyCandidate[] | null>(null);
  useEffect(() => {
    setCandidates(null);
    if (!enabled) return undefined;
    let alive = true;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await fetchAuthorizedWebUiResource('/v0/webui/proxy-candidates');
        if (!response.ok) throw new Error('proxy_status_unavailable');
        const result = await response.json();
        if (alive) setCandidates(Array.isArray(result.candidates) ? result.candidates : []);
      } catch {
        if (alive) setCandidates(null);
      } finally { pending = false; }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [enabled]);
  return candidates;
}

function ProxySummary({ connection, candidates }: { connection: SshConnection; candidates: SshProxyCandidate[] | null }) {
  if (!connection.proxyEnabled) return null;
  const proxy = candidates?.find((item) => item.id === `ssh:${connection.id}`);
  return (
    <div className="ssh-list-card-egress" role="status" title={proxy?.error || '此 SSH 出口已自动加入代理池，安装和更新可使用 --proxy 选择'}>
      代理出口：{proxy?.available ? '可用 · 已加入代理池' : proxy?.error ? `不可用 · ${proxy.error}` : candidates ? '连接中' : '状态待刷新'}
    </div>
  );
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
  const tunnels = useReverseTunnels(connections.some(isSshReverseTunnelEnabled));
  const proxyCandidates = useSshProxyCandidates(connections.some((item) => item.proxyEnabled));
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
            <Space size={6}>
              {connection.proxyEnabled ? <span className="ssh-connection-pill" title="代理出口已启用；可用状态由托管代理运行时提供">代理已启用</span> : null}
              <span className={`ssh-auth-pill ssh-auth-pill--${connection.authType}`}>{AUTH_LABELS[connection.authType]}</span>
            </Space>
          </div>
          <ReverseTunnelSummary connection={connection} tunnels={tunnels} />
          <ProxySummary connection={connection} candidates={proxyCandidates} />
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
