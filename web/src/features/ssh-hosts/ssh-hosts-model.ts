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
  createdAt: number;
}

export interface SshWorkspace {
  id: string;
  connectionId: string;
  label: string;
  remoteRoot: string;
  createdAt: number;
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
    privateKey: connection.privateKey || (connection.authType === 'key' ? SSH_PASSWORD_MASK : '')
  };
}

/** 新建连接的默认值 */
export const SSH_CONNECTION_FORM_DEFAULTS = { port: 22, authType: 'agent' as SshAuthType };

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
