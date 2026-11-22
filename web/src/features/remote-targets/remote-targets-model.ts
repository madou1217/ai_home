export type RemoteTargetStageStatus = 'ok' | 'blocked' | 'unsupported' | 'unknown';
export type RemoteTargetOverallStatus = RemoteTargetStageStatus;

export interface RemoteWorkspaceFact {
  id: string;
  connectionId: string;
  connectionLabel?: string;
  host?: string;
  label: string;
  remoteRoot: string;
}

export interface RemoteRunnerFact {
  id: string;
  provider?: string;
  kind: string;
  status: string;
  supportsHeadless: boolean;
  supportsRemoteTools: boolean;
  supportsApproval: boolean;
  capabilities?: string[];
  reason?: string;
}

export interface RemoteAccountFact {
  accountRef: string;
  provider: string;
  enabled: boolean;
  credentialKnown: boolean;
  modelCount: number;
  effectiveModels: number;
  modelCatalogKnown: boolean;
}

export interface RemoteModelFact {
  accountRef: string;
  provider: string;
  catalogModelId: string;
  cliModelName?: string;
  effective: boolean;
  catalogAvailable: boolean;
  nativeLaunchAvailable: boolean;
}

export interface RemotePreflightStage {
  name: string;
  status: RemoteTargetStageStatus;
  code?: string;
  detail?: string;
}

export interface RemotePreflightReport {
  ready: boolean;
  stages: RemotePreflightStage[];
}

export interface RemoteTargetCandidate {
  id: string;
  serverId: string;
  workspace: RemoteWorkspaceFact;
  runner: RemoteRunnerFact;
  account: RemoteAccountFact;
  model: RemoteModelFact;
  preflight: RemotePreflightReport;
}

export interface RemoteExecutionTarget {
  id: string;
  serverId: string;
  serverProfileId?: string;
  workspaceId: string;
  connectionId: string;
  workspaceRoot: string;
  harness: string;
  provider: string;
  accountRef: string;
  catalogModelId: string;
  cliModelName?: string;
  transport: string;
  permissionMode?: string;
}

export interface RemoteTargetResolution {
  target: RemoteExecutionTarget;
  preflight: RemotePreflightReport;
}

export interface RemoteTargetInventory {
  workspaceCount: number;
  runnerCount: number;
  accountCount: number;
  modelCount: number;
  workspaces: RemoteWorkspaceFact[];
  runners: RemoteRunnerFact[];
  accounts: RemoteAccountFact[];
  models: RemoteModelFact[];
}

export interface RemoteTargetListResponse {
  ok: boolean;
  serverId: string;
  inventory: RemoteTargetInventory;
  candidates: RemoteTargetCandidate[];
  warnings?: string[];
}

export interface RemoteTargetResolutionResponse {
  ok: boolean;
  resolution: RemoteTargetResolution;
}

export interface RemoteTargetSelector {
  serverProfileId?: string;
  serverId?: string;
  workspaceId?: string;
  connectionId?: string;
  harness?: string;
  provider?: string;
  accountRef?: string;
  model?: string;
}

export interface RemoteTargetQuery extends RemoteTargetSelector {
  signal?: AbortSignal;
}

export function modelLabel(model: Pick<RemoteModelFact, 'catalogModelId' | 'cliModelName'>): string {
  const catalog = String(model.catalogModelId || '').trim();
  const cli = String(model.cliModelName || '').trim();
  return cli && cli !== catalog ? `${catalog} · CLI ${cli}` : catalog;
}

export function preflightStatus(report?: RemotePreflightReport): RemoteTargetOverallStatus {
  if (!report) return 'unknown';
  if (report.ready) return 'ok';
  if (report.stages.some((stage) => stage.status === 'unsupported')) return 'unsupported';
  return report.stages.some((stage) => stage.status === 'blocked') ? 'blocked' : 'unknown';
}

export function statusLabel(status: RemoteTargetOverallStatus): string {
  switch (status) {
    case 'ok': return '就绪';
    case 'blocked': return '被阻断';
    case 'unsupported': return '未支持';
    default: return '未知';
  }
}

export function stageLabel(name: string): string {
  const labels: Record<string, string> = {
    server: 'Server',
    workspace: 'Workspace',
    runner: 'Harness',
    provider: 'Provider',
    account: 'Account',
    model: 'Model',
    tools: '远程工具',
    launch: '启动能力'
  };
  return labels[name] || name;
}

export function stageStatusLabel(status: RemoteTargetStageStatus): string {
  switch (status) {
    case 'ok': return '通过';
    case 'blocked': return '阻断';
    case 'unsupported': return '未支持';
    default: return '未知';
  }
}
