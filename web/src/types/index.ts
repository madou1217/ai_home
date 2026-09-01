import type { ProviderId } from '@/providers/catalog';
export * from './proxy-pool';

// Provider 类型由 Go 核心生成，新增 Provider 不再手工修改 TypeScript 联合类型。
export type Provider = ProviderId;

export interface CodexUsageEntry {
  bucket: string;
  windowMinutes: number;
  window: string;
  remainingPct: number | null;
  resetIn: string;
  resetAtMs: number;
  // zcode_plan_balance 携带的绝对额度（unitType 为 'token' 时即 token 数）；
  // 其余 provider 的 entries 不带这些字段。
  totalUnits?: number | null;
  usedUnits?: number | null;
  remainingUnits?: number | null;
  unitType?: string;
}

export interface GeminiUsageModel {
  model: string;
  remainingPct: number | null;
  resetIn: string;
  resetAtMs: number;
  displayName?: string;
  supportsThinking?: boolean;
  supportsImages?: boolean;
  maxTokens?: number | null;
  maxOutputTokens?: number | null;
}

export interface AccountTokenUsageModel {
  model: string;
  day: number;
  week: number;
  month: number;
  total: number;
  dayCostUsd: number | null;
  weekCostUsd: number | null;
  monthCostUsd: number | null;
  totalCostUsd: number | null;
}

export interface AccountTokenUsage {
  day: number;
  week: number;
  month: number;
  total: number;
  models: AccountTokenUsageModel[];
}

export interface AccountModelSummary {
  storedCount: number;
  effectiveCount: number;
  updatedAt: number;
}

export type AccountRegion = 'china' | 'overseas';

export type AccountUsageSnapshot =
  | {
      kind: 'codex_oauth_status';
      capturedAt: number;
      entries: CodexUsageEntry[];
      resetCreditsAvailableCount?: number;
    }
  | {
      kind: 'claude_oauth_usage';
      capturedAt: number;
      account?: {
        email: string;
        fullName: string;
        planType: string;
      } | null;
      entries: CodexUsageEntry[];
    }
  | {
      kind: 'kimi_oauth_usage';
      capturedAt: number;
      account?: {
        displayName: string;
        userId: string;
        phone: string;
        planType: string;
        planName?: string; // 订阅页品牌档：Andante/Moderato/Allegretto/Allegro
      } | null;
      entries: CodexUsageEntry[];
    }
  | {
      kind: 'zcode_plan_balance';
      capturedAt: number;
      account?: {
        planType: string; // 套餐名，如 ZCode Start Plan
      } | null;
      entries: CodexUsageEntry[]; // bucket = 模型 ID（billing/balance 的 capabilities model:*）
    }
  | {
      kind: 'gemini_oauth_stats';
      capturedAt: number;
      models: GeminiUsageModel[];
    }
  | {
      kind: 'agy_code_assist_quota';
      capturedAt: number;
      account?: {
        planType: string;
        email: string;
        subscriptionTier: string;
        project: string;
      } | null;
      models: GeminiUsageModel[];
      modelForwardingRules?: Record<string, string>;
    };

export interface Account {
  provider: Provider;
  accountRef: string;
  gateway?: false;
  status: 'up' | 'down';
  displayName: string;
  configured: boolean;
  apiKeyMode: boolean;
  authMode?: string;
  authType?: string;
  credentialType?: string;
  authPending?: boolean;
  authPendingStale?: boolean;
  authPendingAgeMs?: number;
  isDefault?: boolean;
  isMobile?: boolean;
  remainingPct: number | null;
  updatedAt: number;
  lastUsedAt?: number | null;
  planType: string; // free/pro/ultra/plus/team/business/api-key/oauth
  planName?: string; // 订阅品牌档（如 kimi 的 Allegretto），展示优先于 planType
  region?: AccountRegion; // 当前账号客户端实际生效区域
  email: string;
  baseUrl?: string;
  quotaStatus?: string;
  quotaReason?: string;
  schedulableStatus?: string;
  schedulableReason?: string;
  runtimeStatus?: string;
  runtimeUntil?: number;
  runtimeReason?: string;
  usageSnapshot?: AccountUsageSnapshot | null;
  modelSummary?: AccountModelSummary;
  tokenUsage?: AccountTokenUsage | null;
}

export type GatewayAccount = Omit<Account, 'accountRef' | 'gateway'> & {
  gateway: true;
  accountRef?: never;
};

export type ChatAccount = Account | GatewayAccount;

export interface ProviderNativeCapability {
  provider: Provider;
  config: {
    envHomeKeys: string[];
    userSettings: string[];
    projectSettings: string[];
    cliFlags: string[];
  };
  sessions: {
    flags: string[];
    nativeStore: string;
  };
  mcp: {
    commands: string[];
    configFiles: string[];
  };
  hooks: {
    files: string[];
    stopRequiresJsonStdout: boolean;
  };
  permissions: {
    flags: string[];
    modes: string[];
  };
}

export type ProviderNativeCapabilityMap = Partial<Record<Provider, ProviderNativeCapability>>;

export interface AccountsListResponse {
  accounts: Account[];
  hydrating: boolean;
  providerNativeCapabilities: ProviderNativeCapabilityMap;
}

export interface AccountsSnapshotRequestResponse {
  ok: boolean;
  accepted: boolean;
  alreadyRunning: boolean;
  requestedAt: number;
}

export interface AccountRemovedEvent {
  provider: Provider;
  accountRef: string;
  reason?: string;
  removedAt?: number;
}

export interface AccountRefreshJob {
  id: string;
  provider: Provider;
  accountRef: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  createdAt: number;
  updatedAt: number;
  finishedAt?: number | null;
  error?: string;
}

export interface AccountRefreshUsageResponse {
  ok: boolean;
  accepted: boolean;
  alreadyRunning: boolean;
  job: AccountRefreshJob;
}

export type CodexResetCreditStatus =
  | 'available'
  | 'consuming'
  | 'consumed'
  | 'expired'
  | 'missing'
  | 'unknown';

export interface CodexResetCredit {
  accountRef: string;
  creditId: string;
  status: CodexResetCreditStatus;
  grantedAt: number | null;
  expiresAt: number | null;
  firstSeenAt: number;
  lastSeenAt: number;
  consumedAt: number | null;
  consumedOperationId: string;
  statusSource: string;
}

export type CodexResetOperationStatus =
  | 'consuming'
  | 'succeeded'
  | 'no_effect'
  | 'unknown';

export type CodexResetOperationOutcome =
  | 'reset'
  | 'nothingToReset'
  | 'noCredit'
  | 'alreadyRedeemed'
  | '';

export interface CodexResetOperation {
  operationId: string;
  accountRef: string;
  creditId: string;
  inventoryVersion: string;
  status: CodexResetOperationStatus;
  outcome: CodexResetOperationOutcome;
  requestedAt: number;
  updatedAt: number;
  completedAt: number | null;
  beforeCount: number;
  afterCount: number | null;
  errorCode: string;
}

export interface CodexResetCreditsResponse {
  ok: boolean;
  accountRef: string;
  supported: boolean;
  availableCount: number;
  selectableCount: number;
  detailsComplete: boolean;
  inventoryVersion: string;
  capturedAt: number;
  nextCreditId: string;
  credits: CodexResetCredit[];
  activeOperation: CodexResetOperation | null;
}

export interface CodexResetOperationResponse {
  ok: boolean;
  operation: CodexResetOperation;
  reconciliationRequired: boolean;
}

export interface WebUiModelsResponse {
  ok: boolean;
  cached: boolean;
  updatedAt: number;
  source: string;
  sources: number;
  scannedAccounts: number;
  firstError: string;
  models: Record<string, string[]>;
  byAccountRef: Record<string, string[]>;
  selectableByAccountRef?: Record<string, string[]>;
  defaultByAccountRef?: Record<string, string>;
  errorsByAccountRef: Record<string, string>;
  /** provider -> modelId -> 上游 displayName(id 与显示名可能完全错位) */
  labels?: Record<string, Record<string, string>>;
  metadata?: Record<string, ModelMetadata>;
}

export interface OpenAIModelItem {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface ModelMetadata {
  id: string;
  providerId?: string;
  baseModel?: string;
  source?: {
    type: 'models.dev';
    repository: string;
    path: string;
  };
  name?: string;
  family?: string;
  status?: string;
  experimental?: boolean;
  dates?: {
    release?: string;
    lastUpdated?: string;
    knowledge?: string;
  };
  capabilities?: {
    attachment?: boolean;
    reasoning?: boolean;
    reasoningOptions?: Array<{
      type: string;
      values?: string[];
      min?: number;
      max?: number;
    }>;
    toolCall?: boolean;
    structuredOutput?: boolean;
    temperature?: boolean;
    openWeights?: boolean;
  };
  limits?: {
    context?: number;
    input?: number;
    output?: number;
  };
  modalities?: {
    input?: string[];
    output?: string[];
  };
  cost?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cacheRead?: number;
    cacheWrite?: number;
    inputAudio?: number;
    outputAudio?: number;
    tiers?: unknown[];
    contextOver200k?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
  };
  interleaved?: {
    field?: string;
  };
}

export interface ManagedOpenAIModelItem extends OpenAIModelItem {
  provider: Provider;
  accountRef: string;
  enabled: boolean;
  manual: boolean;
  defaultModel?: boolean;
  source: string;
  providers: Provider[];
  description: string;
  updatedAt: number;
  metadata?: ModelMetadata;
}

export interface WebUiOpenAIModelAccount {
  provider: Provider;
  accountRef: string;
  displayName: string;
  email?: string;
  apiKeyMode?: boolean;
  authType?: string;
}

export interface WebUiOpenAIModelsResponse {
  ok: boolean;
  endpoint: string;
  cached: boolean;
  updatedAt: number;
  source: string;
  sources: number;
  scannedAccounts: number;
  firstError: string;
  accountScope?: {
    accountRef?: string;
  } | null;
  data: OpenAIModelItem[];
  managedData?: ManagedOpenAIModelItem[];
  metadata?: Record<string, ModelMetadata>;
  labels?: Record<string, Record<string, string>>;
  accounts?: WebUiOpenAIModelAccount[];
  byProvider: Record<string, string[]>;
  byAccountRef: Record<string, string[]>;
  errorsByAccountRef: Record<string, string>;
  settingsUpdatedAt?: number;
}

export type WebUiOpenAIModelsJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface WebUiOpenAIModelsJob {
  id: string;
  status: WebUiOpenAIModelsJobStatus;
  accountScope?: WebUiOpenAIModelsResponse['accountScope'];
  startedAt: number;
  finishedAt: number;
  catalog: WebUiOpenAIModelsResponse | null;
  error: string;
}

export interface WebUiOpenAIModelsRefreshResponse {
  ok: boolean;
  accepted: boolean;
  alreadyRunning: boolean;
  scheduled?: boolean;
  job: WebUiOpenAIModelsJob | null;
}

export interface AccountConfig {
  apiKey?: string;
  baseUrl?: string;
  credentialType?: AccountAuthMode;
  projectId?: string;
  location?: string;
}

export type AccountAuthMode = 'api-key' | 'auth-token' | 'oauth-browser' | 'oauth-device' | 'vertex-ai';

export interface AddAccountRequest {
  provider: Provider;
  authMode: AccountAuthMode;
  config?: AccountConfig;
  replaceExisting?: boolean;
}

export interface AddAccountResponse {
  ok: boolean;
  provider: Provider;
  accountRef: string;
  authMode: AccountAuthMode;
  status: 'configured' | 'pending';
  jobId?: string;
  expiresAt?: number | null;
  pollIntervalMs?: number | null;
  authorizationUrl?: string;
  redirectUri?: string;
  callbackCaptureStatus?: string;
  callbackListeningUrl?: string;
  callbackCaptureError?: string;
  authProgressState?: string;
  setupPhase?: string;
  installRequired?: boolean;
}

export interface AccountImportSummary {
  imported: number;
  created: number;
  updated: number;
  skipped: number;
  invalid: number;
  failed: number;
  total: number;
  providers: Provider[];
  accounts: Array<{
    provider: Provider;
    accountRef: string;
    status: 'created' | 'updated';
  }>;
}

export interface AccountImportResponse {
  ok: boolean;
  imported: number;
  status?: 'queued' | 'running' | 'succeeded' | 'failed';
  jobId?: string;
  job?: AccountImportJob;
  summary?: AccountImportSummary;
  result?: unknown;
}

export interface AccountImportJob {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  mode: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number | null;
  summary?: AccountImportSummary;
  result?: unknown;
  error?: string;
  logs?: string;
  progress?: {
    current: number;
    total: number;
    percent: number;
    label?: string;
  } | null;
}

export interface AccountAddJob {
  id: string;
  provider: Provider;
  accountRef: string;
  authMode: AccountAuthMode;
  reauth?: boolean;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
  createdAt: number;
  updatedAt: number;
  lastOutputAt?: number;
  expiresAt?: number | null;
  pollIntervalMs?: number | null;
  pid?: number | null;
  exitCode: number | null;
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
  authorizationUrl?: string;
  redirectUri?: string;
  oauthState?: string;
  browserCallbackForwardedAt?: number;
  callbackCaptureStatus?: string;
  callbackListeningUrl?: string;
  callbackCaptureError?: string;
  authProgressState?: string;
  setupPhase?: string;
  installRequired?: boolean;
  installAttempts?: Array<{ id: string; label: string; ok: boolean; error?: string }>;
  email?: string;
  displayName?: string;
  planType?: string;
  logs: string;
  error?: string;
}

export interface UsageConfig {
  active_refresh_interval: string;
  background_refresh_interval: string;
  threshold_pct: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  apiKey: string;
  managementKey: string;
  apiKeyConfigured?: boolean;
  managementKeyConfigured?: boolean;
  openNetwork: boolean;
}

export interface ControlPlaneDescriptor {
  ok: boolean;
  service: 'aih-control-plane';
  protocolVersion: number;
  endpoint: string;
  host: string;
  port: number;
  serverTime: string;
  uptimeSec: number;
  auth: {
    managementKeyConfigured: boolean;
  };
  capabilities: {
    nodeRpc: string[];
    management: string[];
    remoteManagement: boolean;
    remoteInvite: boolean;
    transports: string[];
  };
}

export interface ControlPlaneDescriptorResponse {
  ok: boolean;
  rpc: 'control_plane.descriptor.read';
  result: ControlPlaneDescriptor;
}

export interface ControlPlaneEndpointHint {
  endpoint: string;
  source: 'request' | 'lan' | 'configured';
  label: string;
  warning?: string;
  recommended?: boolean;
}

export interface ControlPlaneEndpointHintsResponse {
  ok: boolean;
  endpoints: ControlPlaneEndpointHint[];
  warnings: string[];
}

export interface ControlPlaneDeviceStatus {
  ok: boolean;
  service: 'aih-control-plane';
  serverTime: string;
  uptimeSec: number;
  backend: string;
  providerMode: string;
  strategy: string;
  totalAccounts: number;
  activeAccounts: number;
  cooldownAccounts: number;
  statusTotals: Record<string, number>;
  providers: Record<string, {
    total: number;
    active: number;
    statuses: Record<string, number>;
  }>;
  queue: Record<string, {
    name: string;
    running: number;
    queued: number;
    maxConcurrency: number;
    queueLimit: number;
    totalScheduled: number;
    totalRejected: number;
  }>;
  queueTotals: {
    running: number;
    queued: number;
    totalScheduled: number;
    totalRejected: number;
  };
  modelsCached: number;
  modelsUpdatedAt: number;
  modelRegistryUpdatedAt: number;
  successRate: number;
  timeoutRate: number;
  totalRequests: number;
}

export interface ControlPlaneDeviceStatusResponse {
  ok: boolean;
  rpc: 'control_plane.device.status';
  result: {
    status: ControlPlaneDeviceStatus;
  };
}

export interface ControlPlaneDeviceAccountSummary {
  total: number;
  active: number;
  byProvider: Record<string, number>;
  byRuntimeStatus: Record<string, number>;
  bySchedulableStatus: Record<string, number>;
}

export interface ControlPlaneDeviceAccount {
  accountRef: string;
  provider: Provider;
  label: string;
  status: 'up' | 'down';
  authMode: 'oauth' | 'api-key';
  planType: string;
  runtimeStatus: string;
  quotaStatus: string;
  schedulableStatus: string;
  remainingPct: number | null;
  modelCooldownCount: number;
  lastRefresh: number;
  successCount: number;
  failCount: number;
}

export interface ControlPlaneDeviceAccountsResponse {
  ok: boolean;
  rpc: 'control_plane.device.accounts';
  result: {
    accounts: ControlPlaneDeviceAccount[];
    summary: ControlPlaneDeviceAccountSummary;
  };
}

export interface ControlPlaneDeviceSessionSummary {
  total: number;
  returned: number;
  byProvider: Record<string, number>;
  byStatus: Record<string, number>;
  byProject: Record<string, number>;
  recentlyUpdatedAt: number;
}

export interface ControlPlaneDeviceSession {
  sessionRef: string;
  projectRef: string;
  provider: Provider;
  title: string;
  projectName: string;
  status: 'idle' | 'running' | 'draft' | 'failed';
  updatedAt: number;
  startedAt: number;
}

export interface ControlPlaneDeviceSessionMessagesSummary {
  total: number;
  returned: number;
  truncated: boolean;
  cursor: number;
}

export interface ControlPlaneDeviceSessionMessagesResponse {
  ok: boolean;
  rpc: 'control_plane.device.session_messages';
  result: {
    session: ControlPlaneDeviceSession;
    messages: ChatMessage[];
    summary: ControlPlaneDeviceSessionMessagesSummary;
  };
}

export interface ControlPlaneDeviceNodeSessionMessagesResponse {
  ok: boolean;
  rpc: 'control_plane.device.node_session_messages';
  nodeId: string;
  result: ControlPlaneDeviceSessionMessagesResponse['result'];
}

export interface ControlPlaneDeviceNodeSessionsResponse {
  ok: boolean;
  rpc: 'control_plane.device.node_sessions';
  nodeId: string;
  result: ControlPlaneDeviceSessionsResponse['result'];
}

export interface ControlPlaneDeviceNodeSessionInputResponse {
  ok: boolean;
  rpc: 'control_plane.device.node_session_input';
  nodeId: string;
  result: {
    session: ControlPlaneDeviceSession;
    accepted: boolean;
    appendNewline: boolean;
    promptId: string;
  };
}

export type ControlPlaneDeviceSessionEvent =
  | {
      type: 'user_message';
      timestamp: string;
      content: string;
    }
  | {
      type: 'assistant_text' | 'assistant_reasoning';
      timestamp: string;
      text: string;
    };

export interface ControlPlaneDeviceSessionEventsResponse {
  ok: boolean;
  rpc: 'control_plane.device.session_events';
  result: {
    session: ControlPlaneDeviceSession;
    events: ControlPlaneDeviceSessionEvent[];
    cursor: number;
    requiresSnapshot: boolean;
    truncated: boolean;
  };
}

export interface ControlPlaneDeviceSessionStreamFrame {
  ok: boolean;
  rpc: 'control_plane.device.session_stream';
  type: 'events';
  result: ControlPlaneDeviceSessionEventsResponse['result'];
}

export interface ControlPlaneDeviceNodeSessionStreamFrame {
  ok: boolean;
  rpc: 'control_plane.device.node_session_stream';
  type: 'events';
  nodeId: string;
  result: ControlPlaneDeviceSessionEventsResponse['result'];
}

export interface ControlPlaneDeviceSessionsResponse {
  ok: boolean;
  rpc: 'control_plane.device.sessions';
  result: {
    sessions: ControlPlaneDeviceSession[];
    summary: ControlPlaneDeviceSessionSummary;
  };
}

export interface ControlPlaneNodeTransportSummary {
  id: string;
  nodeId: string;
  kind: RemoteNodeTransportKind;
  status: string;
  score: number;
  latencyMs: number;
  lastError: string;
  disabled: boolean;
  managedBy: string;
  provider: string;
  routeRole: RemoteNodeTransportRouteRole;
  trustLevel: RemoteNodeTransportTrustLevel;
  createdAt: number;
  updatedAt: number;
}

export type RemoteNodeConnectionStatus = 'online' | 'offline' | 'unknown';

export interface RemoteNodeConnection {
  status: RemoteNodeConnectionStatus;
  transportKind: RemoteNodeTransportKind | '';
  transportId: string;
  sessionId: string;
  remoteAddress: string;
  connectedAt: number;
  lastSeenAt: number;
}

export interface ControlPlaneNodeSummary {
  id: string;
  name: string;
  role: string;
  endpointPolicy: string;
  preferredTransports: RemoteNodeTransportKind[];
  capabilities: string[];
  fingerprint: string;
  tags: string[];
  disabled: boolean;
  lastSeenAt: number;
  connection: RemoteNodeConnection;
  createdAt: number;
  updatedAt: number;
  transports: ControlPlaneNodeTransportSummary[];
}

export interface ControlPlaneDeviceNodesResponse {
  ok: boolean;
  rpc: 'control_plane.device.nodes';
  result: {
    nodes: ControlPlaneNodeSummary[];
  };
}

export type ControlPlaneProfileState = 'ready' | 'degraded' | 'offline';

export type ControlPlaneProfileConnectionMode = 'direct' | 'broker-proxy';

export interface ControlPlaneProfileBroker {
  brokerEndpoint: string;
  serverId: string;
  proxyEndpoint: string;
}

export type ServerAuthorizationState = 'authorized' | 'discovered-pending-auth';

export type ServerRouteKind = 'direct' | 'direct-lan' | 'relay-via-server' | 'frp';

export type ServerRouteHealth = 'healthy' | 'degraded' | 'offline' | 'unknown';

/**
 * One reachable path to a logical Server. Credentials belong to the Server
 * profile and must never be copied into a route.
 */
export interface ServerRoute {
  id: string;
  kind: ServerRouteKind;
  endpoint: string;
  viaServerId: string;
  health: ServerRouteHealth;
  rttMs: number;
  failureRate: number;
  consecutiveFailures: number;
  lastCheckedAt: number;
  lastSuccessAt: number;
  lastFailureAt: number;
  updatedAt: number;
}

export interface ControlPlaneProfile {
  id: string;
  /** Stable logical Server identity; unlike endpoint it does not change with the selected route. */
  stableServerId: string;
  name: string;
  endpoint: string;
  routes: ServerRoute[];
  activeRouteId: string;
  authorizationState: ServerAuthorizationState;
  connectionMode: ControlPlaneProfileConnectionMode;
  broker: ControlPlaneProfileBroker | null;
  state: ControlPlaneProfileState;
  /** Browser/PWA only. Native desktop profiles keep this value empty. */
  managementKey: string;
  credentialRef: string;
  managementKeyConfigured: boolean;
  nodes: ControlPlaneNodeSummary[];
  nodeCount: number;
  accountCount: number;
  activeAccountCount: number;
  schedulableAccountCount: number;
  sessionCount: number;
  lastNodeSyncAt: number;
  lastStatusSyncAt: number;
  lastAccountsSyncAt: number;
  lastSessionsSyncAt: number;
  descriptor: ControlPlaneDescriptor | null;
  lastCheckedAt: number;
  lastError: string;
  createdAt: number;
  updatedAt: number;
}



export type RemoteNodeTransportKind =
  | 'direct'
  | 'frp'
  | 'ssh'
  | 'tailscale'
  | 'zerotier'
  | 'wireguard'
  | 'omr'
  | 'mptcp'
  | 'relay';

export type RemoteNodeTransportRouteRole = 'data-plane' | 'bootstrap' | 'underlay';

export type RemoteNodeTransportTrustLevel = 'managed' | 'verified' | 'external' | 'manual';

export type RemoteNodeTransportLane = 'data-plane' | 'bootstrap' | 'underlay';

export type RemoteNodeTransportEndpointMode = 'http' | 'relay' | 'manual' | 'none';

export type RemoteNodeTransportDefaults = Partial<Record<RemoteNodeTransportKind, {
  provider: string;
  routeRole: RemoteNodeTransportRouteRole;
  trustLevel: RemoteNodeTransportTrustLevel;
}>>;

export interface RemoteNodeTransportCatalogEntry {
  kind: RemoteNodeTransportKind;
  label: string;
  provider: string;
  defaultRouteRole: RemoteNodeTransportRouteRole;
  defaultTrustLevel: RemoteNodeTransportTrustLevel;
  lane: RemoteNodeTransportLane;
  endpointMode: RemoteNodeTransportEndpointMode;
  summary: string;
}

export type RemoteNodeTransportCatalog = Partial<Record<RemoteNodeTransportKind, RemoteNodeTransportCatalogEntry>>;

export interface RemoteNodeTransportStrategy {
  id: string;
  title: string;
  priority: number;
  defaultTransport: RemoteNodeTransportKind;
  provider: string;
  lane: RemoteNodeTransportLane | '';
  endpointMode: RemoteNodeTransportEndpointMode | '';
  dataPlaneTransports: RemoteNodeTransportKind[];
  bootstrapTransports: RemoteNodeTransportKind[];
  underlayTransports: RemoteNodeTransportKind[];
  summary: string;
  constraints: string[];
}

export interface RemoteNodeTransport {
  id: string;
  nodeId: string;
  kind: RemoteNodeTransportKind;
  endpoint: string;
  status: string;
  score: number;
  latencyMs: number;
  lastError: string;
  disabled: boolean;
  managedBy: string;
  provider: string;
  routeRole: RemoteNodeTransportRouteRole;
  trustLevel: RemoteNodeTransportTrustLevel;
  setupHint?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RemoteNode {
  id: string;
  name: string;
  role: string;
  endpointPolicy: string;
  preferredTransports: RemoteNodeTransportKind[];
  capabilities: string[];
  authRef: string;
  fingerprint: string;
  tags: string[];
  disabled: boolean;
  lastSeenAt: number;
  connection: RemoteNodeConnection;
  createdAt: number;
  updatedAt: number;
  transports: RemoteNodeTransport[];
}

export interface RemoteNodeSavePayload {
  id: string;
  name?: string;
  endpoint?: string;
  transportKind?: RemoteNodeTransportKind;
  provider?: string;
  routeRole?: RemoteNodeTransportRouteRole;
  trustLevel?: RemoteNodeTransportTrustLevel;
  setupHint?: string;
  managementKey?: string;
  preferredTransports?: RemoteNodeTransportKind[];
  capabilities?: string[];
  tags?: string[];
  disabled?: boolean;
}

export interface RemoteNodeDefaults {
  nodeId: string;
  name: string;
  transportKind: RemoteNodeTransportKind;
  provider: string;
  routeRole: RemoteNodeTransportRouteRole;
  trustLevel: RemoteNodeTransportTrustLevel;
  transportDefaults?: RemoteNodeTransportDefaults;
  transportCatalog?: RemoteNodeTransportCatalog;
  transportStrategies?: RemoteNodeTransportStrategy[];
  preferredTransports: RemoteNodeTransportKind[];
  capabilities: string[];
  repoUrl?: string;
  repoSubdir?: string;
  repoDir?: string;
}

export interface RemoteNodeInvite {
  id: string;
  nodeId: string;
  name: string;
  role: string;
  controlEndpoint: string;
  endpointHint: string;
  transportKind: RemoteNodeTransportKind;
  provider: string;
  routeRole: RemoteNodeTransportRouteRole;
  trustLevel: RemoteNodeTransportTrustLevel;
  setupHint: string;
  preferredTransports: RemoteNodeTransportKind[];
  capabilities: string[];
  tags: string[];
  createdAt: number;
  expiresAt: number;
  consumedAt: number;
}

export interface RemoteNodeInviteCreatePayload {
  nodeId?: string;
  name?: string;
  role?: string;
  controlEndpoint?: string;
  endpointHint?: string;
  transportKind?: RemoteNodeTransportKind;
  provider?: string;
  routeRole?: RemoteNodeTransportRouteRole;
  trustLevel?: RemoteNodeTransportTrustLevel;
  setupHint?: string;
  preferredTransports?: RemoteNodeTransportKind[];
  capabilities?: string[];
  tags?: string[];
  expiresInMs?: number;
  bootstrapTarget?: RemoteNodeBootstrapTarget;
  inviteUrl?: string;
  repoUrl?: string;
  repoSubdir?: string;
  repoDir?: string;
  probeSshTargets?: string[] | string;
  probeTcpTargets?: string[] | string;
  concurrency?: number;
  timeoutMs?: number;
  executeConcurrency?: number;
  executeTimeoutMs?: number;
}

export interface RemoteNodeBootstrapApplyPayload extends RemoteNodeInviteCreatePayload {
  execute: true;
  confirm: 'execute';
}

export type RemoteNodeBootstrapTarget = 'linux' | 'darwin' | 'win32';
export type RemoteNodeBootstrapScriptType = 'sh' | 'powershell';

export interface RemoteNodeBootstrapScript {
  type: RemoteNodeBootstrapScriptType;
  command: string;
  content: string;
}

export interface RemoteNodeProbeBootstrapScript extends RemoteNodeBootstrapScript {
  target: RemoteNodeBootstrapTarget;
  requiredInputs: string[];
  warnings: string[];
}

export interface RemoteNodeBootstrapStep {
  id: string;
  title: string;
  command: string;
}

export interface RemoteNodeBootstrapReadinessCheck {
  id: string;
  required: boolean;
  status: 'provided' | 'target-derived' | 'checked-by-script' | 'placeholder' | 'planned' | 'disabled' | string;
  message: string;
}

export interface RemoteNodeBootstrapPlan {
  ok: boolean;
  target: RemoteNodeBootstrapTarget;
  channel: string;
  transportKind: RemoteNodeTransportKind;
  requiredInputs: string[];
  prerequisites: string[];
  readinessChecks?: RemoteNodeBootstrapReadinessCheck[];
  transportGuidance: string[];
  warnings: string[];
  steps: RemoteNodeBootstrapStep[];
  script: RemoteNodeBootstrapScript;
  security: {
    containsSecrets: boolean;
    notes: string[];
  };
}

export interface RemoteNodeBootstrapCreateResult {
  plan: RemoteNodeBootstrapPlan;
  script: RemoteNodeBootstrapScript;
}

export interface RemoteNodeBootstrapPlanResponse extends RemoteNodeBootstrapCreateResult {
  ok: boolean;
}

export interface RemoteNodeInviteCreateResponse {
  ok: boolean;
  invite: RemoteNodeInvite;
  code: string;
  joinUrl: string;
  warnings?: string[];
  joinCommand?: string;
  probeCommand?: string;
  bootstrap?: RemoteNodeBootstrapCreateResult;
}

export interface RemoteNodeBootstrapManualCommand {
  key: string;
  label: string;
  command: string;
  note?: string;
}

export interface RemoteNodeBootstrapProbeAction {
  channel: string;
  generateScriptCommand: string;
  remoteRunCommand?: string;
  targetAction: string;
  targetCommand: string;
  manualCommands?: RemoteNodeBootstrapManualCommand[];
  note: string;
}

export interface RemoteNodeBootstrapProbePort {
  port: number;
  open: boolean;
  error: string;
}

export interface RemoteNodeBootstrapProbeSshResult {
  kind: 'ssh';
  target: string;
  host: string;
  user: string;
  port: number;
  status: 'reachable' | 'auth-required' | 'unreachable';
  platform: string;
  arch: string;
  commands: Record<'node' | 'npm' | 'git' | 'aih', boolean>;
  repo: {
    checked: boolean;
    present: boolean | null;
    path: string;
  };
  stderr: string;
  timedOut: boolean;
  recommendation: string;
  bootstrapTarget: RemoteNodeBootstrapTarget | '';
  bootstrapCommand: string;
  bootstrapAction: RemoteNodeBootstrapProbeAction;
  bootstrapScript?: RemoteNodeProbeBootstrapScript | null;
}

export interface RemoteNodeBootstrapProbeTcpResult {
  kind: 'tcp';
  target: string;
  host: string;
  ports: RemoteNodeBootstrapProbePort[];
  openPorts: number[];
  accessMode: 'ssh' | 'winrm' | 'local-manual' | 'unreachable';
  recommendation: string;
  bootstrapTarget: RemoteNodeBootstrapTarget | '';
  bootstrapCommand: string;
  bootstrapAction: RemoteNodeBootstrapProbeAction;
  bootstrapScript?: RemoteNodeProbeBootstrapScript | null;
}

export type RemoteNodeBootstrapProbeResult = RemoteNodeBootstrapProbeSshResult | RemoteNodeBootstrapProbeTcpResult;

export interface RemoteNodeBootstrapProbeExecutionStep {
  order: number;
  priority: number;
  status: 'ready' | 'manual' | 'needs-input' | 'blocked';
  resultKey: string;
  kind: 'ssh' | 'tcp' | '';
  target: string;
  channel: string;
  title: string;
  summary: string;
  command: string;
  manualCommands?: RemoteNodeBootstrapManualCommand[];
  note: string;
}

export interface RemoteNodeBootstrapProbeReport {
  ok: boolean;
  concurrency: number;
  timeoutMs: number;
  repoDir: string;
  results: RemoteNodeBootstrapProbeResult[];
  executionPlan?: RemoteNodeBootstrapProbeExecutionStep[];
  summary: {
    total: number;
    reachableSsh: number;
    authRequiredSsh?: number;
    sshPort: number;
    winrm: number;
    localManual: number;
    unreachable: number;
  };
  warnings: string[];
}

export interface RemoteNodeBootstrapApplyAction {
  order: number;
  resultKey: string;
  target: string;
  title: string;
  channel: string;
  probeStatus: 'ready' | 'manual' | 'needs-input' | 'blocked' | string;
  summary: string;
  note: string;
  command: string;
  manualCommands?: RemoteNodeBootstrapManualCommand[];
  executable: boolean;
  executionState: 'dry-run' | 'manual' | 'needs-input' | 'blocked' | 'pending' | 'executed' | 'failed' | string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RemoteNodeBootstrapApplyResult {
  ok: boolean;
  mode: 'dry-run' | 'execute';
  executeTimeoutMs: number;
  executeConcurrency: number;
  plan: {
    ok: boolean;
    error?: string;
    message?: string;
    actions: RemoteNodeBootstrapApplyAction[];
    summary: {
      total: number;
      executable: number;
      dryRun: number;
      executed: number;
      failed: number;
      manual: number;
      needsInput: number;
      blocked: number;
    };
    warnings: string[];
  };
}

export type RemoteNodeBootstrapApplyPreview = RemoteNodeBootstrapApplyResult;

export interface RemoteNodeBootstrapProbeResponse {
  ok: boolean;
  command: string;
  applyCommand?: string;
  applyExecuteCommand?: string;
  apply?: RemoteNodeBootstrapApplyPreview;
  report: RemoteNodeBootstrapProbeReport;
}

export interface RemoteNodeBootstrapApplyResponse {
  ok: boolean;
  command: string;
  apply: RemoteNodeBootstrapApplyResult;
  report: RemoteNodeBootstrapProbeReport;
}

export interface RemoteNodeManagementResult<TPayload = unknown> {
  nodeId: string;
  transport: Pick<RemoteNodeTransport, 'id' | 'kind' | 'endpoint'>;
  status: number;
  ok: boolean;
  payload?: TPayload;
}

export interface RemoteNodeManagementResponse<TPayload = unknown> {
  ok: boolean;
  result?: RemoteNodeManagementResult<TPayload>;
  error?: string;
  message?: string;
}

export type RemoteNodeTestResponse = RemoteNodeManagementResponse;

export type ManagementRestartStatus = 'queued' | 'starting' | 'started' | 'failed';

export interface ManagementRestartEvent {
  type: 'restart';
  jobId: string;
  status: ManagementRestartStatus;
  createdAt: number;
  updatedAt: number;
  pid?: number;
  appliedConfig?: Partial<ServerConfig>;
  error?: string;
  message?: string;
}

export interface ManagementRestartResponse {
  ok: boolean;
  accepted: boolean;
  restarting: boolean;
  job: ManagementRestartEvent;
}

export interface ChatMessageMetrics {
  durationMs?: number;
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  tokensPerSec?: number;
}

// Toolkit Types
export interface ManagedAppItem {
  id: string;
  name: string;
  provider: string;
  /** 宿主客户端身份；IDE 场景与 Provider 身份分开，便于一个宿主承载多个 Provider。 */
  clientId?: string;
  clientName?: string;
  /** 当前宿主实际承载的 Provider 标识，顺序与卡片角标展示一致。 */
  integrationProviders?: string[];
  type: 'cli' | 'desktop' | 'ide';
  categories: string[];
  binaryName: string;
  cliPath: string;
  configName: string;
  configFormat: string;
  configExists: boolean;
  installed: boolean;
  version: string;
  versionSource?: {
    type: 'npm' | 'homebrew_cask' | 'winget' | string;
    packageName?: string;
    cask?: string;
    id?: string;
  } | null;
  latestVersion?: string | null;
  updateAvailable?: boolean;
  updateStatus?: 'unavailable' | 'unknown' | 'current' | 'available' | string;
  pkg: string;
  defaultModel: string;
  supportedModels: string[];
  hookSupported: boolean;
  hookInstalled: boolean;
  hookReason?: string;
  hookMissingEvents?: string[];
  syncMode: 'hook' | 'polling' | 'unavailable';
  installAvailable?: boolean;
  canUpdate?: boolean;
  canUninstall?: boolean;
}

export interface ManagedAppsResponse {
  ok: boolean;
  total: number;
  installedCount: number;
  apps: ManagedAppItem[];
}

export interface ManagedAppUpdateResponse {
  ok: boolean;
  appId: string;
  provider: string;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  status: 'unavailable' | 'unknown' | 'current' | 'available' | string;
  error?: string;
  message?: string;
}

export interface AccountAppLaunchResponse {
  ok: boolean;
  provider?: string;
  accountRef?: string;
  kind?: 'cli' | 'desktop' | string;
  status?: string;
  pid?: number | null;
  pids?: number[];
  terminalId?: string;
  executable?: string;
  installRequired?: boolean;
  installAvailable?: boolean;
  error?: string;
  message?: string;
  egressWarning?: string;
}

export type AccountEgressMode = 'system' | 'tun' | 'url' | 'node' | 'group';

export interface AccountEgressBinding {
  mode: AccountEgressMode;
  proxyUrl: string;
  nodeId: string;
  groupId: string;
  updatedAt: number;
}

export interface AccountEgressBindingInput {
  mode: AccountEgressMode;
  proxyUrl?: string;
  nodeId?: string;
  groupId?: string;
}

export interface AccountEgressApplyResult {
  ok: boolean;
  applied: boolean;
  status?: 'pending_launch' | 'selected' | 'started' | 'restarted' | 'unchanged' | 'applied';
  rotated?: boolean;
  restarted?: boolean;
  pid?: number | null;
  previousPids?: number[];
  proxyServer?: string;
  source?: string;
  previousNodeId?: string | null;
  selectedNodeId?: string | null;
  groupId?: string | null;
  attemptedNodeCount?: number;
  rolledBack?: boolean;
  error?: string;
  reason?: string;
}

export interface AccountEgressHealthStatus {
  monitoring: boolean;
  intervalMs?: number;
  failureThreshold?: number;
  consecutiveFailures?: number;
  lastCheckedAt?: number | null;
  lastHealthyAt?: number | null;
  lastSwitchAt?: number | null;
  lastError?: string | null;
  checking?: boolean;
}

export interface AccountEgressRuntimeStatus {
  running: boolean;
  dataPlaneReady: boolean;
  proxyServer: string | null;
  source: string | null;
  selectedNodeId: string | null;
  groupId: string | null;
  ownerPid?: number | null;
  zcodePid: number | null;
  canRotate: boolean;
  sidecar: {
    engine: string;
    installed: boolean;
    running: boolean;
    dataPlaneReady: boolean;
    pid: number | null;
    lastError: string | null;
  };
  health: AccountEgressHealthStatus;
}

export interface AccountEgressResponse {
  ok: boolean;
  binding: AccountEgressBinding | null;
  apply?: AccountEgressApplyResult;
  runtime?: AccountEgressRuntimeStatus | null;
  runtimeError?: string;
}

export interface AccountEgressRotateResponse extends AccountEgressApplyResult {
  binding?: AccountEgressBinding | null;
  runtime?: AccountEgressRuntimeStatus | null;
  runtimeError?: string;
}

// 兼容已发布的组件/API 类型名；新代码统一使用 AccountEgress*。
export type ZcodeEgressMode = AccountEgressMode;
export type ZcodeEgressBinding = AccountEgressBinding;
export type ZcodeEgressBindingInput = AccountEgressBindingInput;
export type ZcodeEgressApplyResult = AccountEgressApplyResult;
export type ZcodeEgressHealthStatus = AccountEgressHealthStatus;
export type ZcodeEgressRuntimeStatus = AccountEgressRuntimeStatus;
export type ZcodeEgressResponse = AccountEgressResponse;
export type ZcodeEgressRotateResponse = AccountEgressRotateResponse;

export interface AppInstallJob {
  id: string;
  source?: 'app-install' | 'terminal' | 'environment' | 'managed-tool' | string;
  taskName?: string;
  appId: string;
  provider: string;
  kind: 'cli' | 'desktop' | 'terminal' | string;
  action?: 'install' | 'update' | 'uninstall' | string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | string;
  phase: string;
  progress: { percent: number; label: string };
  attempts: Array<{ id: string; label: string; ok: boolean; error?: string }>;
  result?: { installed: boolean; cliPath?: string; executablePath?: string } | null;
  error?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number | null;
}

export interface WebUiTask extends AppInstallJob {
  source: 'app-install' | 'terminal' | 'environment' | 'managed-tool' | string;
  taskName: string;
}

export type ToolkitLifecycleAction = 'install' | 'update' | 'uninstall';

export type ClientPlatform = 'macos' | 'windows' | 'linux';

export interface ClientTerminalItem {
  id: string;
  name: string;
  description: string;
  sourceUrl: string;
  platform: ClientPlatform;
  installed: boolean;
  default: boolean;
  executablePath: string;
  canInstall: boolean;
  canUpdate: boolean;
  canUninstall: boolean;
  canLaunch: boolean;
  packageManager: string;
  plans: Array<{ action: string; label: string; command: string }>;
}

export interface ClientTerminalsResponse {
  ok: boolean;
  platform: ClientPlatform;
  homeDir?: string;
  terminals: ClientTerminalItem[];
}

export interface ToolkitAppConfigResponse {
  ok: boolean;
  appId: string;
  configName: string;
  configFormat: string;
  exists: boolean;
  content: string;
  revision: string;
  writable: boolean;
  requiresElevation: boolean;
  elevated?: boolean;
  size?: number;
}

export type ToolkitToolCategoryId = 'session-runtimes' | 'network-access';

export interface ToolkitToolCategory {
  id: ToolkitToolCategoryId;
  label: string;
  description: string;
}

export interface ManagedToolItem {
  id: string;
  category: ToolkitToolCategoryId;
  name: string;
  role: string;
  supported: boolean;
  installed: boolean;
  executablePath: string;
  binaryName: string;
  version: string;
  serviceManager: string;
  capabilities: string[];
  runtimeInspectable: boolean;
  running: boolean;
  runningCount: number;
  startupManaged: boolean;
  startupSources: string[];
  configName: string;
  configFormat: string;
  configSource: string;
  configCount: number;
  configAmbiguous: boolean;
  configState: 'none' | 'single' | 'multiple' | 'unresolved' | 'token-managed';
  configExists: boolean;
  configWritable: boolean;
  requiresElevation: boolean;
  configEditable: boolean;
  managedPath?: string;
  managedBy: 'aih' | 'homebrew' | '' | string;
  canInstall: boolean;
  canUpdate: boolean;
  canUninstall: boolean;
  lifecycle: Record<ToolkitLifecycleAction, boolean>;
}

export interface ManagedToolsResponse {
  ok: boolean;
  platform: string;
  categories: ToolkitToolCategory[];
  total: number;
  installedCount: number;
  tools: ManagedToolItem[];
}

export interface ToolkitToolConfigResponse extends ToolkitAppConfigResponse {
  toolId: string;
  targetRevision: string;
}

export type ManagedToolLifecycleAction = ToolkitLifecycleAction;

export interface ManagedToolPlan {
  id: string;
  toolId: string;
  action: ManagedToolLifecycleAction;
  label: string;
  method: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  effect: string;
  timeoutMs: number;
  requiresConfirmation: boolean;
  preview: string;
}

export interface ManagedToolActionResponse {
  ok: boolean;
  platform?: ClientPlatform;
  action?: ManagedToolLifecycleAction;
  label?: string;
  tool?: Pick<ManagedToolItem, 'id' | 'name' | 'category'>;
  plans?: ManagedToolPlan[];
  job?: WebUiTask;
  accepted?: boolean;
  alreadyRunning?: boolean;
  error?: string;
  message?: string;
}

export interface EnvironmentCheatsheetCommand {
  desc?: string;
  label?: string;
  cmd: string;
  platform?: string;
  method?: string;
}

export interface EnvironmentToolCheatsheet {
  id: string;
  name: string;
  statusCmd?: string;
  installGuide?: string;
  recommended?: boolean;
  platforms?: string[];
  commands?: EnvironmentCheatsheetCommand[];
  installCommands?: Array<{ platform?: string; method?: string; cmd: string }>;
  uninstallCommands?: Array<{ method?: string; cmd: string }>;
  commonCommands?: EnvironmentCheatsheetCommand[];
}

export interface EnvironmentInfo {
  name: string;
  scope?: string;
  source?: string;
  probeStatus?: 'available' | 'unavailable' | 'unset' | 'error';
  currentVersion: string;
  activePath: string;
  packageManagers?: {
    npm?: string | null;
    pnpm?: string | null;
    yarn?: string | null;
    bun?: string | null;
  };
  pip?: string | null;
  tools?: {
    uv?: string | null;
    poetry?: string | null;
  };
  versionManagers?: Array<{
    name: string;
    displayName?: string;
    installed: boolean;
    version?: string;
    path?: string;
    versions?: string[];
  }>;
  installedVersions?: string[];
  cheatsheet?: {
    versionManagers?: EnvironmentToolCheatsheet[];
    packageManagers?: EnvironmentToolCheatsheet[];
    virtualEnvironments?: EnvironmentToolCheatsheet[];
  };
}

export interface EnvironmentActionInput {
  manager: 'nvm' | 'fnm' | 'pyenv' | 'conda' | 'venv';
  action: 'install' | 'uninstall' | 'default' | 'global' | 'create' | 'remove';
  version?: string;
  pythonVersion?: string;
  name?: string;
  path?: string;
  confirmed?: boolean;
}

export interface EnvironmentActionPlan {
  manager: EnvironmentActionInput['manager'];
  action: EnvironmentActionInput['action'];
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  scope: string;
  effect: string;
  requiresConfirmation: boolean;
  changesCallerShell: boolean;
}

export interface EnvironmentActionResponse {
  ok: boolean;
  error?: string | null;
  message?: string;
  plan?: EnvironmentActionPlan;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  outputTruncated?: boolean;
}

export type EnvironmentLifecycleAction = ToolkitLifecycleAction;

export interface EnvironmentRuntimeSummary {
  name: string;
  scope: string;
  source: string;
  probeStatus: 'available' | 'unavailable' | 'unset' | 'error' | string;
  currentVersion: string;
  activePath: string;
  packageManagerVersion?: string;
}

export interface EnvironmentResourceItem {
  id: string;
  name: string;
  runtime: 'node' | 'python';
  category: string;
  description: string;
  platform: ClientPlatform;
  installed: boolean;
  version: string;
  executablePath: string;
  managedVersions: string[];
  canInstall: boolean;
  canUpdate: boolean;
  canUninstall: boolean;
  lifecycle: Record<EnvironmentLifecycleAction, boolean>;
}

export interface EnvironmentToolPlan {
  id: string;
  toolId: string;
  action: EnvironmentLifecycleAction;
  label: string;
  method: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  effect: string;
  timeoutMs: number;
  requiresConfirmation: boolean;
  preview: string;
}

export interface EnvironmentToolActionResponse {
  ok: boolean;
  platform?: ClientPlatform;
  action?: EnvironmentLifecycleAction;
  label?: string;
  tool?: Pick<EnvironmentResourceItem, 'id' | 'name' | 'runtime' | 'category'>;
  plans?: EnvironmentToolPlan[];
  job?: WebUiTask;
  accepted?: boolean;
  alreadyRunning?: boolean;
  error?: string;
  message?: string;
}

export interface EnvironmentGuideTask {
  id: string;
  toolId: string;
  label: string;
  category: 'install' | 'update' | 'uninstall' | 'configure' | 'use' | 'inspect';
  template: string;
  parameters: Array<{ key: string; label: string; placeholder: string }>;
  method?: string;
  source: 'lifecycle' | 'task';
}

export interface EnvironmentGuideTool {
  id: string;
  name: string;
  runtime: 'node' | 'python';
  category: string;
  description: string;
  tasks: EnvironmentGuideTask[];
}

export interface EnvironmentGuideResponse {
  ok: boolean;
  platform: ClientPlatform;
  currentPlatform: ClientPlatform;
  platforms: Array<{ id: ClientPlatform; label: string }>;
  tools: EnvironmentGuideTool[];
}

export interface EnvironmentsResponse {
  ok: boolean;
  platform: ClientPlatform;
  runtimes: {
    node: EnvironmentRuntimeSummary;
    python: EnvironmentRuntimeSummary;
  };
  resources: EnvironmentResourceItem[];
  installedCount: number;
  total: number;
  environments: {
    node: EnvironmentInfo;
    python: EnvironmentInfo;
  };
}

export interface MirrorPreset {
  id: string;
  name: string;
  url: string;
  official: boolean;
  active?: boolean;
  speed?: string;
  desc?: string;
  guides?: MirrorGuide;
}

export interface MirrorGuide {
  title: string;
  sourceUrl?: string;
  sourceHost?: string;
  commands: Array<{
    platform: string;
    label: string;
    cmd: string;
  }>;
}

export interface MirrorsResponse {
  ok: boolean;
  npm: {
    current: string;
    presets: MirrorPreset[];
    guides?: MirrorGuide;
  };
  pip: {
    current: string;
    presets: MirrorPreset[];
    guides?: MirrorGuide;
  };
}

export interface SystemProxyInfo {
  platform: string;
  scope?: string;
  source?: string;
  probeStatus?: 'available' | 'unset' | 'error' | 'unsupported';
  enabled: boolean;
  httpProxy: string;
  httpsProxy: string;
  socksProxy: string;
  bypassList?: string[];
}

export interface ProxyStatusResponse {
  ok: boolean;
  env: {
    scope?: string;
    source?: string;
    probeStatus?: 'available' | 'unset';
    httpProxy: string;
    httpsProxy: string;
    allProxy: string;
    noProxy: string;
  };
  system?: SystemProxyInfo;
  tools: {
    git: {
      scope?: string;
      source?: string;
      probeStatus?: 'available' | 'unset' | 'error';
      httpProxy: string;
      httpsProxy: string;
      scopedProxies?: Array<{ key: string; value: string }>;
    };
    npm: {
      scope?: string;
      source?: string;
      probeStatus?: 'available' | 'unset' | 'error';
      httpProxy: string;
      httpsProxy: string;
    };
  };
}

export interface ConnectivityTargetResult {
  id: string;
  name: string;
  url: string;
  host: string;
  reachable: boolean;
  latencyMs: number;
  statusCode?: number | null;
  route?: 'direct' | 'proxy';
  proxyUsed?: string | null;
  error?: string | null;
}

export interface ConnectivityResponse {
  ok: boolean;
  testedAt: number;
  route: 'direct' | 'proxy';
  proxyUsed: string | null;
  networkLayer?: NetworkLayerStatus;
  error?: string;
  results: ConnectivityTargetResult[];
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  images?: string[];
  pending?: boolean;
  statusText?: string;
  timestamp?: string | number;
  model?: string;
  source?: 'codex-mobile';
  metrics?: ChatMessageMetrics;
}

export interface QueuedChatMessage {
  id: string;
  content: string;
  images?: string[];
  createdAt: number;
  mode?: 'after_turn' | 'after_tool_call';
}

export interface SessionMessageBundle {
  messages: ChatMessage[];
  cursor: number;
  start: number;
  total: number;
  hasMore: boolean;
}

export interface SessionEventItem {
  type: 'user_message' | 'assistant_text' | 'assistant_reasoning' | 'assistant_tool_call' | 'assistant_tool_result';
  timestamp?: string;
  content?: string;
  text?: string;
  images?: string[];
  model?: string;
  callId?: string;
  source?: string;
}

export interface SessionEventsResponse {
  ok: boolean;
  events: SessionEventItem[];
  cursor: number;
  requiresSnapshot?: boolean;
  hasAssistantToolCall?: boolean;
}

export type ChatRequest = {
  messages: ChatMessage[];
  provider: Provider;
  model?: string;
  stream?: boolean;
  prompt?: string;
  createSession?: boolean;
  sessionId?: string;
  projectDirName?: string;
  projectPath?: string;
  images?: string[];
  // 会话级审批模式(P3):bypass(默认)/confirm(权限请求转 webUI 审批)/plan(计划模式+确认)。
  approvalMode?: 'bypass' | 'confirm' | 'plan';
} & (
  | { accountRef: string; gateway?: false }
  | { gateway: true; accountRef?: never }
);

export interface ChatResponse {
  ok: boolean;
  accountRef?: string;
  gateway?: boolean;
  provider?: Provider;
  sessionId?: string;
  runId?: string;
  mode?: 'native-session' | 'api-proxy';
  model?: string;
  content?: string;
  error?: string;
}

export interface InteractivePromptOption {
  value: string;
  title: string;
  description?: string;
}

export interface InteractivePrompt {
  kind: 'plan-choice';
  promptId: string;
  question: string;
  options: InteractivePromptOption[];
  provider?: Provider | string;
  runId?: string;
}

export interface ChatStreamEvent {
  type: 'ready' | 'session-created' | 'delta' | 'thinking' | 'result' | 'done' | 'error' | 'terminal-output' | 'interactive-prompt' | 'interactive-prompt-cleared' | 'assistant_tool_call' | 'assistant_tool_result' | 'retry-status' | 'cli-install-confirmation' | 'cli-install-progress';
  delta?: string;
  thinking?: string;
  content?: string;
  text?: string;
  prompt?: InteractivePrompt;
  promptId?: string;
  reason?: string;
  phase?: 'scheduled' | 'reconnecting' | 'recovered';
  source?: 'upstream-api' | 'provider-runtime' | 'transport';
  attempt?: number;
  maxAttempts?: number;
  retryAfterMs?: number;
  retryAt?: number;
  status?: number;
  message?: string;
  code?: string;
  ts?: string;
  elapsedMs?: number;
  firstTokenElapsedMs?: number | null;
  totalElapsedMs?: number;
  runId?: string;
  provider?: Provider;
  model?: string;
  accountRef?: string;
  gateway?: boolean;
  sessionId?: string;
  mode?: 'native-session' | 'api-proxy';
  interactionMode?: 'default' | 'terminal';
  slashCommand?: string;
  installPhase?: 'installing' | 'plan-succeeded' | 'plan-failed' | 'installed' | 'failed' | 'cancelled';
  confirmationId?: string;
  countdownMs?: number;
  expiresAt?: number;
  planId?: string;
  planLabel?: string;
}

export interface NativeSlashCommand {
  command: string;
  description: string;
  argumentHint?: string;
  aliases: string[];
  source?: string;
}

export interface ManagementQueueSnapshot {
  name: string;
  running: number;
  queued: number;
  maxConcurrency: number;
  queueLimit: number;
  totalScheduled: number;
  totalRejected: number;
}

export interface ManagementProviderStatus {
  total: number;
  active: number;
  statuses: Record<string, number>;
}

export interface ManagementStatus {
  ok: boolean;
  backend: string;
  host: string;
  port: number;
  apiKeyConfigured: boolean;
  providerMode: string;
  strategy: string;
  totalAccounts: number;
  activeAccounts: number;
  cooldownAccounts: number;
  statusTotals: Record<string, number>;
  providers: Record<string, ManagementProviderStatus>;
  sessionAffinity: Record<string, number>;
  queue: Record<string, ManagementQueueSnapshot>;
  modelsCached: number;
  modelsUpdatedAt: number;
  modelRegistryUpdatedAt: number;
  successRate: number;
  timeoutRate: number;
  totalRequests: number;
  uptimeSec: number;
}

export interface ManagementAccountActivity {
  provider: string;
  accountRef: string;
  /** 网关 attempt 的 in-flight，外加一个「原生会话回合正在跑」的折算位。 */
  inFlight: number;
  /** 原生 CLI 会话（不经网关）当前是否有回合在跑。 */
  sessionTurnActive?: boolean;
  rate: number;
  activeModels?: string[];
  lastActivityAt: number;
  updatedAt: number;
}

export interface ManagementMetrics {
  ok: boolean;
  totalRequests: number;
  totalSuccess: number;
  totalFailures: number;
  totalTimeouts: number;
  successRate: number;
  timeoutRate: number;
  routeCounts: Record<string, number>;
  providerCounts: Record<string, number>;
  providerSuccess: Record<string, number>;
  providerFailures: Record<string, number>;
  queue: Record<string, ManagementQueueSnapshot>;
  accountActivity?: Record<string, ManagementAccountActivity>;
  lastErrors: Array<{
    at?: string;
    provider?: string;
    accountLabel?: string;
    attemptedCount?: number;
    accountRef?: string;
    attemptedAccountRefs?: string[];
    model?: string;
    requestedModel?: string;
    effectiveModel?: string;
    clientProtocol?: string;
    familyProvider?: string;
    effectiveProvider?: string;
    aliasTarget?: string;
    aliasMatched?: boolean;
    sessionId?: string;
    sessionKey?: string;
    projectPath?: string;
    projectDirName?: string;
    route?: string;
    message?: string;
    error?: string;
    detail?: string;
    reason?: string;
  }>;
}

export interface ManagementAccount {
  provider: Provider;
  accountRef: string;
  email?: string;
  baseUrl?: string;
  planType?: string;
  remainingPct: number | null;
  configured?: boolean;
  apiKeyMode?: boolean;
  usageSnapshot?: AccountUsageSnapshot | null;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  cooldownUntil: number;
  lastRefresh: number;
  consecutiveFailures: number;
  successCount: number;
  failCount: number;
  lastError: string;
  runtimeStatus?: string;
  runtimeUntil?: number;
  runtimeReason?: string;
}

export interface ManagementAccountsResponse {
  ok: boolean;
  accounts: ManagementAccount[];
}

export interface ModelUsageDateRange {
  from: string;
  to: string;
}

export interface ModelUsageQuery {
  from?: string;
  to?: string;
  provider?: Provider | '';
  model?: string;
  sessionId?: string;
  limit?: number;
  scan?: boolean;
}

export interface ModelUsageStats {
  totalCalls: number;
  totalSessions: number;
  totalPrompts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
}

export interface ModelUsageMetricTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUsd: number;
  cacheHitRate: number | null;
}

export interface ModelUsageModelRow extends ModelUsageMetricTotals {
  provider: Provider;
  model: string;
  accountCount: number;
  unattributedCalls: number;
}

export interface ModelUsageSessionRow extends ModelUsageMetricTotals {
  provider: Provider;
  sessionId: string;
  project: string;
  cwd: string;
  gitBranch: string;
  startedAtMs: number;
  updatedAtMs: number;
  promptCount: number;
  accountCount: number;
  unattributedCalls: number;
}

export interface ModelUsageSessionDetailRow extends ModelUsageModelRow {
  sessionId: string;
}

export interface ModelUsageTrendPoint extends ModelUsageMetricTotals {
  bucketStartMs: number;
}

export interface ModelUsageTrend {
  fromMs: number;
  toMs: number;
  bucketMs: number;
  points: ModelUsageTrendPoint[];
}

export interface ModelUsageAccountModelRow extends ModelUsageMetricTotals {
  provider: Provider;
  model: string;
}

export interface ModelUsageAccountRow extends ModelUsageMetricTotals {
  accountRef: string;
  accountProvider: Provider | '';
  modelCount: number;
  models: ModelUsageAccountModelRow[];
}

export interface ModelUsageBreakdownSummary extends ModelUsageMetricTotals {
  accountCount: number;
  unattributedCalls: number;
}

export interface ModelUsageStatsResponse {
  ok: boolean;
  range: ModelUsageDateRange;
  stats: ModelUsageStats;
}

export interface ModelUsageModelsResponse {
  ok: boolean;
  range: ModelUsageDateRange;
  models: ModelUsageModelRow[];
}

export interface ModelUsageSessionsResponse {
  ok: boolean;
  range: ModelUsageDateRange;
  sessions: ModelUsageSessionRow[];
}

export interface ModelUsageDashboardData {
  stats: ModelUsageStats;
  models: ModelUsageModelRow[];
  sessions: ModelUsageSessionRow[];
  modelOptions: ModelUsageModelRow[];
  trend: ModelUsageTrend;
}

export interface ModelUsageDashboardResponse extends ModelUsageDashboardData {
  ok: boolean;
  range: ModelUsageDateRange;
}

export type ModelUsageDashboardQueryStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface ModelUsageDashboardQueryJob {
  id: string;
  status: ModelUsageDashboardQueryStatus;
  query: ModelUsageQuery;
  startedAt: number;
  finishedAt: number;
  completedShards: number;
  totalShards: number;
  dashboard: ModelUsageDashboardData | null;
  error: string;
}

export interface ModelUsageDashboardQueryResponse {
  ok: boolean;
  accepted: boolean;
  job: ModelUsageDashboardQueryJob;
}

export interface ModelUsageDashboardQueryCancelResponse {
  ok: boolean;
  cancelled: boolean;
  job: ModelUsageDashboardQueryJob;
}

export interface ModelUsageSessionDetailResponse {
  ok: boolean;
  range: ModelUsageDateRange;
  session: ModelUsageSessionDetailRow[];
}

export interface ModelUsageRequestRow {
  requestId: string;
  provider: Provider | '';
  model: string;
  reasoningEffort: string;
  endpoint: string;
  clientIp: string;
  requestType: 'stream' | 'sync' | '';
  billingMode: 'token' | '';
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  timestampMs: number;
  statusCode: number;
  errorCode: string;
  errorMessage: string;
}

export interface ModelUsageRequestDetailsResponse {
  ok: boolean;
  range: ModelUsageDateRange;
  usage: ModelUsageRequestRow[];
  errors: ModelUsageRequestRow[];
}

export interface ModelUsageBreakdownResponse {
  ok: boolean;
  range: ModelUsageDateRange;
  summary: ModelUsageBreakdownSummary;
  models: ModelUsageModelRow[];
  accounts: ModelUsageAccountRow[];
}

export interface ModelUsageScanProviderResult {
  files: number;
  records: number;
  prompts: number;
  skipped: number;
  reason?: string;
}

export interface ModelUsageScanResult {
  files: number;
  records: number;
  prompts: number;
  skipped: number;
  providers: Partial<Record<Provider, ModelUsageScanProviderResult>>;
}

export interface ModelUsageScanResponse {
  ok: boolean;
  accepted?: boolean;
  alreadyRunning?: boolean;
  job?: ModelUsageScanJob;
  result?: ModelUsageScanResult;
}

export type ModelUsageScanJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface ModelUsageScanJob {
  id: string;
  status: ModelUsageScanJobStatus;
  provider: Provider | '';
  startedAt: number;
  finishedAt: number;
  result: ModelUsageScanResult | null;
  error: string;
}

export interface SlashCommandsResponse {
  ok: boolean;
  provider: string;
  commands: NativeSlashCommand[];
}

export interface Session {
  id: string;
  title: string;
  updatedAt: number;
  provider: Provider;
  accountRef?: string;
  projectDirName?: string; // Claude 专用：项目目录名
  projectPath?: string;
  draft?: boolean;
  status?: string;
  model?: string;   // 会话最近使用的模型（快照可选带上，用于列表展示）
  preview?: string; // 最后一条消息的简短预览（快照可选带上）
}

export interface ProviderInfo {
  provider: Provider;
  accountRef: string;
}

export interface AggregatedProject {
  id: string;
  name: string;
  path: string;
  providers: Provider[]; // 简化为 provider 数组
  sessions: Session[]; // 聚合会话（后端只下发最近 N 条，见 sessionTotal）
  sessionTotal?: number; // 该项目会话总数（可能 > sessions.length，超出部分未下发）
  manual?: boolean;
  addedAt?: number;
}

export interface ArchivedSession {
  id: string;
  title: string;
  provider: Provider;
  projectPath?: string;
  projectDirName?: string;
  origin: 'native' | 'legacy';
  canUnarchive: boolean;
  updatedAt: number;
  archivedAt?: number;
}

export interface SessionLifecycleOperationCapability {
  support: 'native' | 'unsupported';
  available: boolean;
  reason?: string;
}

export interface ProviderSessionLifecycleCapability {
  provider?: Provider;
  workflowAvailable: boolean;
  reason?: string;
  operations: {
    archive: SessionLifecycleOperationCapability;
    listArchived: SessionLifecycleOperationCapability;
    unarchive: SessionLifecycleOperationCapability;
  };
}

export interface ArchivedSessionListError {
  provider: string;
  code: string;
  message: string;
}

export interface ArchivedSessionsResponse {
  archived: ArchivedSession[];
  errors: ArchivedSessionListError[];
}

export interface SshHost {
  id: string;
  label: string;
  sshTarget: string;
  remoteRoot: string;
  createdAt: number;
}

export interface SshHostTestResult {
  status: 'reachable' | 'auth-required' | 'unreachable';
  target: string;
  stderr?: string;
  accessMode?: string;
  platform?: string;
  arch?: string;
  commands?: {
    node?: boolean;
    npm?: boolean;
    git?: boolean;
    aih?: boolean;
  };
  repo?: {
    present?: boolean;
  };
  recommendation?: string;
}

export interface ImageStudioModelCapabilities {
  generation: boolean;
  edit: boolean;
  mask: boolean;
  multiple: boolean;
  size: boolean;
  quality: boolean;
  responseFormat: boolean;
  maxInputImages: number;
  background: boolean;
  outputFormat: boolean;
  outputCompression: boolean;
  moderation: boolean;
}

export interface ImageStudioModel {
  key: string;
  id: string;
  label: string;
  provider: string;
  providerLabel: string;
  priority: number;
  source: string;
  capabilities: ImageStudioModelCapabilities;
  qualityOptions?: string[];
  accountCount: number;
  availableAccountCount: number;
  unavailableReasons?: Array<{
    reason: string;
    count: number;
  }>;
}

export type ImageStudioRevisionStatus = 'running' | 'succeeded' | 'failed';
export type ImageStudioRevisionMode = 'generation' | 'edit';

export interface ImageStudioRevisionError {
  code: string;
  message: string;
  statusCode: number;
}

export interface ImageStudioRevision {
  id: string;
  parentRevisionId: string;
  mode: ImageStudioRevisionMode;
  prompt: string;
  provider: string;
  model: string;
  modelKey: string;
  parameters: {
    n: number;
    size: string;
    quality: string;
    background: string;
    outputFormat: string;
    outputCompression: number | null;
    moderation: string;
  };
  sourceAssetIds: string[];
  maskAssetId: string;
  outputAssetIds: string[];
  status: ImageStudioRevisionStatus;
  createdAt: number;
  completedAt: number;
  accountRef: string;
  error: ImageStudioRevisionError | null;
}

export interface ImageStudioAsset {
  id: string;
  revisionId: string;
  role: 'source' | 'mask' | 'output';
  mimeType: string;
  byteLength: number;
  createdAt: number;
  revisedPrompt?: string;
  url: string;
}

export interface ImageStudioSession {
  version: number;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  activeRevisionId: string;
  revisions: ImageStudioRevision[];
  assets: ImageStudioAsset[];
}

export interface ImageStudioSessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  revisionCount: number;
  assetCount: number;
  activeRevisionId: string;
  latestStatus: ImageStudioRevisionStatus | '';
  latestModel: string;
  latestProvider: string;
  previewAssetId: string;
  previewMimeType: string;
  previewUrl: string;
}

export interface ImageStudioModelsResponse {
  ok: boolean;
  models: ImageStudioModel[];
  defaultModelKey: string;
}

export interface ImageStudioSessionsResponse {
  ok: boolean;
  sessions: ImageStudioSessionSummary[];
}

export interface ImageStudioSessionResponse {
  ok: boolean;
  session: ImageStudioSession;
}

export interface ImageStudioDeleteSessionResponse {
  ok: boolean;
  deletedSessionId: string;
}

export interface ImageStudioRunInput {
  mode: ImageStudioRevisionMode;
  modelKey: string;
  prompt: string;
  parentRevisionId?: string;
  sources?: Array<{
    assetId?: string;
    image?: string;
  }>;
  maskAssetId?: string;
  mask?: string;
  n?: number;
  size?: string;
  quality?: string;
  background?: string;
  output_format?: string;
  output_compression?: number;
  moderation?: string;
}

export interface ImageStudioRunResponse extends ImageStudioSessionResponse {
  revisionId: string;
}
