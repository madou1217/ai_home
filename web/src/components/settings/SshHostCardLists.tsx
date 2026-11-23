import { useEffect, useState } from 'react';
import { Card, Dropdown, Empty, Popconfirm, Space, Spin } from 'antd';
import { fetchAuthorizedWebUiResource, sshHostsAPI, watchSshReverseTunnels } from '@/services/api';
import {
  ApiOutlined,
  DeleteOutlined,
  EditOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  MessageOutlined,
  MoreOutlined,
  ToolOutlined
} from '@ant-design/icons';
import { buildAppHref } from '@/services/app-navigation';
import { buildToolkitEnvironmentHref } from '@/pages/toolkit-url-state';
import Button from '@/components/ui/AppButton';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import {
  SSH_AUTH_LABELS as AUTH_LABELS,
  SSH_DELETE_CONNECTION_CONFIRM,
  SSH_DELETE_WORKSPACE_CONFIRM,
  formatSshProbeTime,
  formatSshTarget,
  isSshReverseTunnelEnabled,
  resolveSshConnectionStatus
} from '@/features/ssh-hosts/ssh-hosts-model';
import type { SshConnection, SshReverseTunnelStatus, SshWorkspace } from '@/features/ssh-hosts/ssh-hosts-model';
import type { SshTestState } from '@/features/ssh-hosts/use-ssh-hosts';
import './SshHostCardLists.css';

export type { SshConnection, SshWorkspace } from '@/features/ssh-hosts/ssh-hosts-model';

interface ConnectionListProps {
  connections: SshConnection[];
  loading: boolean;
  testingIds: string[];
  testStates?: Record<string, SshTestState>;
  workspaceCounts?: Record<string, number>;
  onTest: (connection: SshConnection) => void;
  onViewWorkspaces: (connection: SshConnection) => void;
  onCreateWorkspace: (connection: SshConnection) => void;
  onEdit: (connection: SshConnection) => void;
  onDelete: (id: string) => void;
}

const TUNNEL_STATUS_LABEL: Record<string, string> = {
  open: '已连通',
  connecting: '连接中',
  retrying: '重连中',
  error: '重连中'
};

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

interface SshProxyCandidate {
  id: string;
  available: boolean;
  error?: string;
}

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
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [enabled]);
  return candidates;
}

function resolveProxyRoleText(
  connection: SshConnection,
  candidates: SshProxyCandidate[] | null
): { label: string; detail?: string; tone: 'applied' | 'error' | 'saving' | 'unset' } | null {
  if (!connection.proxyEnabled) return null;
  const proxy = candidates?.find((item) => item.id === `ssh:${connection.id}`);
  if (proxy?.available) return { label: '代理出口·可用', tone: 'applied' };
  if (proxy?.error) return { label: '代理出口·不可用', detail: proxy.error, tone: 'error' };
  if (candidates) return { label: '代理出口·连接中', tone: 'saving' };
  return { label: '代理出口·待刷新', tone: 'unset' };
}

function resolveTunnelText(
  connection: SshConnection,
  tunnels: SshReverseTunnelStatus[] | null
): string | null {
  if (!isSshReverseTunnelEnabled(connection)) return null;
  const tunnel = tunnels?.find((item) => item.connectionId === connection.id);
  const state = tunnel?.state || tunnel?.status || '';
  const boundPort = state === 'open' ? tunnel?.remotePort : undefined;
  const route = boundPort
    ? `远端 :${boundPort} → 本机 :${tunnel?.localPort || 22}`
    : '等待分配端口';
  const statusText = TUNNEL_STATUS_LABEL[state] || (tunnels ? '未启动' : '待刷新');
  return `${route}（${statusText}${tunnel?.error ? ` · ${tunnel.error}` : ''}）`;
}

export function SshConnectionCardList({
  connections,
  loading,
  testingIds,
  testStates = {},
  workspaceCounts = {},
  onTest,
  onViewWorkspaces,
  onCreateWorkspace,
  onEdit,
  onDelete
}: ConnectionListProps) {
  const tunnels = useReverseTunnels(connections.some(isSshReverseTunnelEnabled));
  const proxyCandidates = useSshProxyCandidates(connections.some((item) => item.proxyEnabled));

  if (loading) return <div className="ssh-card-loading"><Spin /></div>;
  if (connections.length === 0) {
    return (
      <div className="ssh-empty-panel hud-panel hud-panel--sm">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="尚未保存远程 SSH 连接。点击右上角「添加连接」配置开发机。"
        />
      </div>
    );
  }

  return (
    <div className="ssh-card-list">
      {connections.map((connection) => {
        const testState = testStates[connection.id];
        const tunnel = tunnels?.find((item) => item.connectionId === connection.id);
        const tunnelState = tunnel?.state || tunnel?.status || '';
        const proxy = proxyCandidates?.find((item) => item.id === `ssh:${connection.id}`);
        const testing = testingIds.includes(connection.id) || Boolean(testState?.loading);
        const connStatus = resolveSshConnectionStatus({
          testing,
          probeStatus: testState?.result?.status,
          tunnelState,
          proxyAvailable: proxy?.available
        });
        const proxyRole = resolveProxyRoleText(connection, proxyCandidates);
        const tunnelText = resolveTunnelText(connection, tunnels);
        const egressHost = connection.egressConnectionId
          ? connections.find((item) => item.id === connection.egressConnectionId)?.label || '已删除的连接'
          : '';
        const wsCount = workspaceCounts[connection.id] || 0;
        const probeTimestamp = testState?.testedAt || tunnel?.lastProbeAt;
        const probeFailureDetail = testState?.result?.status && testState.result.status !== 'reachable'
          ? (testState.result.stderr || (testState.result.status === 'auth-required' ? 'SSH 认证未通过' : '网络不可达'))
          : '';

        return (
          <Card key={connection.id} bordered={false} className="ssh-list-card hud-panel hud-panel--sm">
            <div className="ssh-list-card-head">
              <div className="ssh-list-card-title">
                <div className="ssh-list-card-name-row">
                  <SettingStatusTag
                    status={connStatus.tagStatus}
                    label={connStatus.label}
                    detail={probeFailureDetail || undefined}
                    compact
                  />
                  <span className="ssh-list-card-name" title={connection.label}>{connection.label}</span>
                </div>
                <code className="ssh-list-card-endpoint" title={formatSshTarget(connection)}>
                  {formatSshTarget(connection)}
                </code>
              </div>

              <div className="ssh-list-card-badges">
                {proxyRole ? (
                  <SettingStatusTag
                    status={proxyRole.tone}
                    label={proxyRole.label}
                    detail={proxyRole.detail}
                    compact
                    live="off"
                  />
                ) : null}
                <span className={`ssh-auth-pill ssh-auth-pill--${connection.authType}`}>
                  {AUTH_LABELS[connection.authType]}
                </span>
              </div>
            </div>

            <div className="ssh-list-card-facts">
              <span className="ssh-fact-item">
                <em>最近探测</em>
                <strong>{testing ? '探测中…' : formatSshProbeTime(probeTimestamp)}</strong>
              </span>
              <span className="ssh-fact-item">
                <em>出网角色</em>
                <strong>
                  {connection.proxyEnabled ? '托管代理出口' : '普通开发机'}
                  {egressHost ? ` · 经由 ${egressHost}` : ' · 直连'}
                </strong>
              </span>
              <span className="ssh-fact-item">
                <em>工作空间</em>
                <strong>{wsCount} 个</strong>
              </span>
              {tunnelText ? (
                <span className="ssh-fact-item ssh-fact-item--wide" title={tunnel?.error || undefined}>
                  <em>反向隧道</em>
                  <strong>{tunnelText}</strong>
                </span>
              ) : null}
              {probeFailureDetail ? (
                <span className="ssh-fact-item ssh-fact-item--error ssh-fact-item--wide">
                  <em>探测异常</em>
                  <strong>{probeFailureDetail}</strong>
                </span>
              ) : null}
            </div>

            <div className="ssh-list-card-footer">
              <Space size={6} wrap>
                <Button
                  size="small"
                  icon={<ApiOutlined />}
                  loading={testing}
                  onClick={() => onTest(connection)}
                >
                  探测连接
                </Button>
                <Button
                  size="small"
                  icon={<FolderOpenOutlined />}
                  onClick={() => onViewWorkspaces(connection)}
                >
                  工作区 ({wsCount})
                </Button>
                <Button
                  size="small"
                  icon={<ToolOutlined />}
                  href={buildAppHref(buildToolkitEnvironmentHref(`ssh:${connection.id}`))}
                >
                  环境与工具
                </Button>
              </Space>

              <Space size={6} wrap>
                <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(connection)}>
                  编辑
                </Button>
                <Dropdown
                  trigger={['click']}
                  menu={{
                    items: [
                      {
                        key: 'create-ws',
                        label: '创建工作区',
                        icon: <FolderAddOutlined />
                      }
                    ],
                    onClick: ({ key }) => {
                      if (key === 'create-ws') onCreateWorkspace(connection);
                    }
                  }}
                >
                  <Button size="small" icon={<MoreOutlined />} aria-label="更多操作" />
                </Dropdown>
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
        );
      })}
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
  if (workspaces.length === 0) {
    return (
      <div className="ssh-empty-panel hud-panel hud-panel--sm">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暂无远程项目工作空间。先添加连接，再创建工作空间。"
        />
      </div>
    );
  }

  return (
    <div className="ssh-card-list">
      {workspaces.map((workspace) => {
        const connection = connections.find((item) => item.id === workspace.connectionId);
        return (
          <Card key={workspace.id} bordered={false} className="ssh-list-card hud-panel hud-panel--sm">
            <div className="ssh-list-card-head">
              <div className="ssh-list-card-title">
                <div className="ssh-list-card-name-row">
                  <SettingStatusTag
                    status={connection ? 'saved' : 'error'}
                    label={connection ? `连接：${connection.label}` : '关联连接已删除'}
                    compact
                    live="off"
                  />
                  <span className="ssh-list-card-name" title={workspace.label}>{workspace.label}</span>
                </div>
                <code className="ssh-list-card-path" title={workspace.remoteRoot}>{workspace.remoteRoot}</code>
              </div>
            </div>

            {connection ? (
              <div className="ssh-list-card-meta" title={formatSshTarget(connection)}>
                {formatSshTarget(connection)}
              </div>
            ) : null}

            <div className="ssh-list-card-footer ssh-list-card-footer--end">
              <Space size={6} wrap>
                {workspace.projectPath && connection ? (
                  <Button
                    size="small"
                    type="primary"
                    icon={<MessageOutlined />}
                    href={buildAppHref('/chat', `?projectPath=${encodeURIComponent(workspace.projectPath)}`)}
                    title="作为 Work 项目打开：文件与命令在远端执行"
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
