export type WorkspaceConnectorState = 'online' | 'offline' | 'revoked' | string;

export interface WorkspaceConnectorCapabilities {
  readFile: boolean;
  writeFile: boolean;
  listDirectory: boolean;
  search: boolean;
  runCommand: boolean;
  names?: string[];
}

export interface WorkspaceConnector {
  id: string;
  connectorId: string;
  label: string;
  rootLabel?: string;
  /** Server-side anchor path used by Work/requirements. Not a local copy. */
  shadowPath?: string;
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

export interface WorkspaceApproval {
  id: string;
  command: string;
  cwd: string;
  state: 'pending' | 'approved' | 'denied' | 'used' | 'expired' | string;
  createdAt: number;
  expiresAt: number;
}

export interface WorkspaceApprovalListResponse {
  ok: boolean;
  workspaceId: string;
  mode: string;
  approvals: WorkspaceApproval[];
}

export interface WorkspaceApprovalDecisionResponse {
  ok: boolean;
  approval: WorkspaceApproval;
}

export interface RemoteSessionUsage {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
  updatedAtMs?: number;
}

export interface RemoteExecutionSession {
  id: string;
  workspaceId: string;
  connectorId?: string;
  agent: string;
  account?: string;
  model?: string;
  sessionKey: string;
  termId?: string;
  status: 'running' | 'exited' | 'stopped' | 'unknown' | string;
  toolExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
  stoppedAt?: number;
  events?: { at: number; type: string; detail?: string }[];
  usage?: RemoteSessionUsage;
}

export interface RemoteExecutionSessionListResponse {
  ok: boolean;
  count: number;
  sessions: RemoteExecutionSession[];
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

export interface WorkspaceAcpPermissionOption {
  id: string;
  name: string;
  kind: string;
}

export interface WorkspaceAcpApproval {
  id: string;
  toolCallId: string;
  title: string;
  options: WorkspaceAcpPermissionOption[];
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | string;
}

export interface WorkspaceAcpToolCall {
  id: string;
  title: string;
  name?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface WorkspaceAcpPlanEntry {
  content: string;
  priority?: string;
  status?: string;
}

export interface WorkspaceAcpEvent {
  seq: number;
  type: 'message' | 'thought' | 'tool_call' | 'tool_update' | 'plan' | 'notice' | 'approval' | 'user' | 'status' | 'error' | string;
  text?: string;
  toolCall?: WorkspaceAcpToolCall;
  plan?: WorkspaceAcpPlanEntry[];
  notice?: { title: string; description?: string; severity?: string };
  approval?: WorkspaceAcpApproval;
  status?: string;
  error?: string;
}

export interface WorkspaceAcpSession {
  id: string;
  workspaceId: string;
  status: string;
  createdAt: number;
}

export interface WorkspaceAcpSessionResponse {
  ok: boolean;
  session: WorkspaceAcpSession;
}
