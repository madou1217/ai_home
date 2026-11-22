export type WorkspaceConnectorState = 'online' | 'offline' | 'revoked' | string;

export interface WorkspaceConnectorCapabilities {
  readFile: boolean;
  writeFile: boolean;
  listDirectory: boolean;
  search: boolean;
  names?: string[];
}

export interface WorkspaceConnector {
  id: string;
  connectorId: string;
  label: string;
  rootLabel?: string;
  platform?: string;
  capabilities: WorkspaceConnectorCapabilities;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
  transport: string;
  state: WorkspaceConnectorState;
  online: boolean;
  sessionId?: string;
  connectedAt?: number;
  liveLastSeenAt?: number;
}

export interface WorkspaceConnectorListResponse {
  ok: boolean;
  serverId?: string;
  count: number;
  workspaces: WorkspaceConnector[];
}

export interface WorkspaceConnectorEnrollment {
  id: string;
  code?: string;
  label: string;
  expiresAt: number;
  capabilities: WorkspaceConnectorCapabilities;
}

export interface WorkspaceConnectorEnrollmentResponse {
  ok: boolean;
  enrollment: WorkspaceConnectorEnrollment;
}

export interface WorkspaceDirectoryEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other' | string;
  size?: number;
  modTime?: number;
}

export interface WorkspaceDirectoryResult {
  path: string;
  entries: WorkspaceDirectoryEntry[];
  truncated?: boolean;
}

export interface WorkspaceDirectoryResponse {
  ok: boolean;
  workspaceId: string;
  directory: WorkspaceDirectoryResult;
}

export interface WorkspaceAgentTerminalResponse {
  ok: boolean;
  sessionKey: string;
  termId?: string;
  reused?: boolean;
  durable?: boolean;
  workspaceId: string;
  agent: string;
  label: string;
  rootLabel?: string;
  toolExpiresAt?: number;
}

export function connectorStateLabel(state: WorkspaceConnectorState): string {
  switch (state) {
    case 'online': return '在线';
    case 'offline': return '离线';
    case 'revoked': return '已撤销';
    default: return state || '未知';
  }
}

export function connectorLocation(workspace: WorkspaceConnector): string {
  return [workspace.rootLabel, workspace.platform].filter(Boolean).join(' · ') || '未上报目录';
}

export function joinWorkspacePath(current: string, name: string): string {
  const base = String(current || '').trim().replace(/^\.\/?/, '').replace(/\/+$/, '');
  if (!base) return name;
  return `${base}/${name}`;
}

export function parentWorkspacePath(current: string): string {
  const base = String(current || '').trim().replace(/^\.\/?/, '').replace(/\/+$/, '');
  const index = base.lastIndexOf('/');
  return index <= 0 ? '' : base.slice(0, index);
}
