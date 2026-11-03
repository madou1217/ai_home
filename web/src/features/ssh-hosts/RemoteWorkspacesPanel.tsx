import { useCallback, useEffect, useState } from 'react';
import { Dropdown } from 'antd';
import { CloudServerOutlined, CodeOutlined, DownOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons';
import { sshHostsAPI } from '@/services/api';
import { buildAppHref } from '@/services/app-navigation';
import { useOpenRemoteWorkspaceTerminal } from '@/features/web-terminal/use-open-remote-workspace-terminal';
import type { SshConnection, SshWorkspace } from './ssh-hosts-model';
import './remote-workspaces-panel.css';
import Reveal from '@/components/ui/Reveal';

const COLLAPSE_KEY = 'aih:remote-workspaces-collapsed:v1';

function readCollapsed(): boolean {
  try { return window.localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
}

/**
 * Work 侧栏「远程工作区」：列出 SSH 开发机上登记的工作区目录。
 *
 * 点工作区 = 作为 Work 项目打开（与本机项目同样由 WebUI 渲染会话；harness 在 Server，
 * 文件 / 命令经 SSH 落到远端，远端无需安装 aih / AI CLI）。右侧终端按钮在全局 Web Terminal
 * 浮窗里打开该目录的远端 shell。
 */
export default function RemoteWorkspacesPanel({ onOpenInWork }: {
  onOpenInWork?: (workspace: SshWorkspace) => void | Promise<void>;
} = {}) {
  const [workspaces, setWorkspaces] = useState<SshWorkspace[]>([]);
  const [connections, setConnections] = useState<SshConnection[]>([]);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [opening, setOpening] = useState('');
  // 远端会话是否仍在运行（Server 端状态）：换设备 / 刷新 / Server 重启后都能看到并一键接回。
  const [alive, setAlive] = useState<Record<string, boolean>>({});
  const openTerminal = useOpenRemoteWorkspaceTerminal();

  const load = useCallback(async () => {
    try {
      const [ws, conns] = await Promise.all([sshHostsAPI.listWorkspaces(), sshHostsAPI.listConnections()]);
      setWorkspaces(Array.isArray(ws) ? ws : []);
      setConnections(Array.isArray(conns) ? conns : []);
    } catch {
      setWorkspaces([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const refreshSessions = useCallback(async () => {
    try {
      const sessions = await sshHostsAPI.listWorkspaceSessions();
      setAlive(Object.fromEntries(sessions.map((item) => [item.workspaceId, item.alive])));
    } catch {
      // 状态拿不到不影响打开终端。
    }
  }, []);
  useEffect(() => {
    void refreshSessions();
    const timer = window.setInterval(() => { void refreshSessions(); }, 15000);
    return () => window.clearInterval(timer);
  }, [refreshSessions]);

  const toggle = () => {
    setCollapsed((value) => {
      try { window.localStorage.setItem(COLLAPSE_KEY, value ? '0' : '1'); } catch { /* ignore */ }
      return !value;
    });
  };

  const openShell = async (workspace: SshWorkspace, agent?: 'claude' | 'codex', native = false) => {
    setOpening(workspace.id);
    try { await openTerminal(workspace, { ...(agent ? { agent } : {}), native }); } finally { setOpening(''); void refreshSessions(); }
  };
  const open = async (workspace: SshWorkspace) => {
    if (!onOpenInWork || !workspace.projectPath) { await openShell(workspace); return; }
    setOpening(workspace.id);
    try { await onOpenInWork(workspace); } finally { setOpening(''); }
  };

  const hostOf = (workspace: SshWorkspace) => {
    const conn = connections.find((item) => item.id === workspace.connectionId);
    return conn ? (conn.user ? `${conn.user}@${conn.host}` : conn.host) : '连接已删除';
  };

  return (
    <section className="remote-ws" data-collapsed={collapsed || undefined} aria-label="远程工作区">
      <div className="remote-ws-head">
        <button type="button" className="remote-ws-toggle" aria-expanded={!collapsed} onClick={toggle}>
          {collapsed ? <RightOutlined /> : <DownOutlined />}
          <span>远程工作区</span>
          <span className="remote-ws-count">{workspaces.length}</span>
        </button>
        <a
          className="remote-ws-add"
          href={buildAppHref('/ssh-hosts')}
          title="在 SSH 开发机里添加工作区"
          aria-label="添加远程工作区"
        >
          <PlusOutlined />
        </a>
      </div>
      <Reveal open={!collapsed} exitMs={240}>
        {workspaces.length === 0 ? (
        <p className="remote-ws-empty">
          还没有远程工作区。到「Server → SSH 开发机」添加一台机器并创建工作区，就能像本机项目一样在 Work 里让 AI 直接改远端代码。
        </p>
      ) : (
        <ul className="remote-ws-list">
          {workspaces.map((workspace) => (
            <li key={workspace.id}>
              <button
                type="button"
                className="remote-ws-item"
                disabled={opening === workspace.id}
                title={`${hostOf(workspace)}:${workspace.remoteRoot}`}
                onClick={() => void open(workspace)}
              >
                <CloudServerOutlined className="remote-ws-icon" />
                <span className="remote-ws-text">
                  <span className="remote-ws-label">
                    {workspace.label}
                    {alive[workspace.id] ? <span className="remote-ws-live" title="远端会话仍在运行，点击接回">运行中</span> : null}
                  </span>
                  <span className="remote-ws-meta">{hostOf(workspace)} · {workspace.remoteRoot}</span>
                </span>
              </button>
              {onOpenInWork && workspace.projectPath ? (
                <Dropdown
                  trigger={['click']}
                  menu={{
                    items: [
                      { key: 'shell', label: '远端 shell' },
                      { key: 'native', label: '在本机终端窗口打开（Server 本机）' },
                      { key: 'claude', label: 'Claude 终端（AI 改远端代码）' },
                      { key: 'codex', label: 'Codex 终端（AI 改远端代码）' },
                    ],
                    onClick: ({ key }) => {
                      void openShell(workspace, key === 'claude' || key === 'codex' ? key : undefined, key === 'native');
                    },
                  }}
                >
                  <button
                    type="button"
                    className="remote-ws-shell"
                    title="在 Web Terminal 打开：远端 shell 或 AI 终端"
                    aria-label={`在终端打开 ${workspace.label}`}
                  >
                    <CodeOutlined />
                  </button>
                </Dropdown>
              ) : null}
            </li>
          ))}
        </ul>
        )}
      </Reveal>
    </section>
  );
}
