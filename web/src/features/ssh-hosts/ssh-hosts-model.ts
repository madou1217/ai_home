/**
 * SSH 开发机的数据模型与纯展示映射（桌面 SshHostsPanel 与移动端 MobileSshHosts 共用）。
 * 字段与 /webui/ssh-connections、/webui/ssh-workspaces 返回结构一致。
 */

export type SshAuthType = 'key' | 'key-file' | 'password' | 'agent';

export interface SshConnection {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  authType: SshAuthType;
  identityFile?: string;
  privateKey?: string;
  password?: string;
  /** 出网代理：借这条连接的网络出去（安装工具等需要外网的任务）；空为直连。 */
  egressConnectionId?: string;
  /** 反向隧道：这台远端的 127.0.0.1:remotePort 转到 AIH Server 本机的 sshd（让远端能 SSH 回本机）。 */
  reverseTunnel?: { enabled?: boolean; remotePort?: number; localPort?: number } | null;
  /** 将这条 SSH 连接作为托管代理出口；独立于 egressConnectionId。 */
  proxyEnabled?: boolean;
  createdAt: number;
}

export interface SshReverseTunnelStatus {
  connectionId: string;
  remotePort: number;
  localPort: number;
  state?: 'connecting' | 'open' | 'error';
  /** 兼容旧版 Node 状态。 */
  status?: 'connecting' | 'open' | 'retrying';
  error?: string;
  attempt?: number;
  stats?: { connections: number; failed: number; rebounds: number };
  /** 兼容旧版 Node 的平铺计数。 */
  connections?: number;
  openedAt?: number;
  lastProbeAt?: number;
}

/** 新版开关优先；旧记录只有固定端口时保持可读。 */
export function isSshReverseTunnelEnabled(connection: Pick<SshConnection, 'reverseTunnel'>): boolean {
  const tunnel = connection.reverseTunnel;
  return tunnel?.enabled ?? Boolean(tunnel?.remotePort);
}

/** 桌面开关序列化为自动模式；保留旧表单数字端口的兼容入口。 */
export function sshConnectionPayload(values: Record<string, unknown>): Record<string, unknown> {
  const { reverseTunnelEnabled, reverseTunnelPort, ...rest } = values;
  if (typeof reverseTunnelEnabled === 'boolean') {
    return { ...rest, reverseTunnel: reverseTunnelEnabled ? { enabled: true } : null };
  }
  const port = Number(reverseTunnelPort) || 0;
  return { ...rest, reverseTunnel: port ? { remotePort: port } : null };
}

export interface SshWorkspace {
  id: string;
  connectionId: string;
  label: string;
  remoteRoot: string;
  createdAt: number;
  /** 作为 Work 项目时的项目路径（Server 本机影子目录）。 */
  projectPath?: string;
}

export interface RemoteDirItem {
  name: string;
  path: string;
}

/** 编辑已有连接时，密码 / 私钥以掩码回填（服务端识别该掩码为「保持不变」）。 */
export const SSH_PASSWORD_MASK = '******';

/** 卡片 / 行上的认证方式短标签 */
export const SSH_AUTH_LABELS: Record<SshAuthType, string> = {
  agent: 'SSH Agent',
  'key-file': '私钥文件',
  key: '粘贴私钥',
  password: '密码'
};

/** 表单里认证方式单选的选项文案（与桌面 Radio.Button 一致） */
export const SSH_AUTH_OPTIONS: Array<{ value: SshAuthType; label: string }> = [
  { value: 'agent', label: 'SSH Agent 免密' },
  { value: 'key-file', label: '私钥文件' },
  { value: 'key', label: '粘贴私钥' },
  { value: 'password', label: '账户密码' }
];

export const formatSshTarget = (connection: Pick<SshConnection, 'user' | 'host' | 'port'>) => (
  `${connection.user}@${connection.host}:${connection.port}`
);

/** 编辑表单回填值（与桌面 showConnModal 完全一致） */
export function buildSshConnectionFormValues(connection: SshConnection) {
  return {
    label: connection.label,
    host: connection.host,
    port: connection.port,
    user: connection.user,
    authType: connection.authType,
    identityFile: connection.identityFile || '',
    password: connection.password || (connection.authType === 'password' ? SSH_PASSWORD_MASK : ''),
    privateKey: connection.privateKey || (connection.authType === 'key' ? SSH_PASSWORD_MASK : ''),
    egressConnectionId: connection.egressConnectionId || '',
    reverseTunnelEnabled: isSshReverseTunnelEnabled(connection),
    proxyEnabled: connection.proxyEnabled === true,
    reverseTunnelPort: connection.reverseTunnel?.remotePort || undefined
  };
}

/** 新建连接的默认值 */
export const SSH_CONNECTION_FORM_DEFAULTS = { port: 22, authType: 'agent' as SshAuthType, egressConnectionId: '', reverseTunnelEnabled: false, proxyEnabled: false };

/** 目录浏览器面包屑：把绝对路径拆成可点击的逐级路径。 */
export function buildRemotePathCrumbs(currentPath: string) {
  const parts = currentPath.split('/').filter(Boolean);
  let accumulator = '';
  return parts.map((part, index) => {
    accumulator += `/${part}`;
    return { name: part, path: accumulator, last: index === parts.length - 1 };
  });
}

export const SSH_DELETE_CONNECTION_CONFIRM = '将同步删除关联该连接的所有工作空间！确认删除？';
export const SSH_DELETE_WORKSPACE_CONFIRM = '仅在数据库中删除此空间，不会影响远程服务器的物理文件。确认移除？';

export type SshConnectionRuntimeStatus =
  | 'saved_unprobed'
  | 'probing'
  | 'reachable'
  | 'auth_failed'
  | 'unreachable';

export interface SshConnectionStatusMeta {
  state: SshConnectionRuntimeStatus;
  tagStatus: 'unset' | 'saving' | 'applied' | 'dirty' | 'error';
  label: string;
}

export function resolveSshConnectionStatus(input: {
  testing?: boolean;
  probeStatus?: 'reachable' | 'auth-required' | 'unreachable';
  tunnelState?: string;
  proxyAvailable?: boolean;
}): SshConnectionStatusMeta {
  if (input.testing) {
    return { state: 'probing', tagStatus: 'saving', label: '探测中' };
  }
  if (input.probeStatus === 'reachable') {
    return { state: 'reachable', tagStatus: 'applied', label: '已连通' };
  }
  if (input.probeStatus === 'auth-required') {
    return { state: 'auth_failed', tagStatus: 'dirty', label: '认证失败' };
  }
  if (input.probeStatus === 'unreachable') {
    return { state: 'unreachable', tagStatus: 'error', label: '不可达' };
  }
  if (input.tunnelState === 'open' || input.proxyAvailable) {
    return { state: 'reachable', tagStatus: 'applied', label: '运行可用' };
  }
  return { state: 'saved_unprobed', tagStatus: 'unset', label: '已保存·未探测' };
}

export function formatSshProbeTime(timestamp?: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '尚未探测';
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}
