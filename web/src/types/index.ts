export type Provider = 'codex' | 'gemini' | 'claude' | 'agy' | 'opencode';

export interface CodexUsageEntry {
  bucket: string;
  windowMinutes: number;
  window: string;
  remainingPct: number | null;
  resetIn: string;
  resetAtMs: number;
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

export type AccountUsageSnapshot =
  | {
      kind: 'codex_oauth_status';
      capturedAt: number;
      entries: CodexUsageEntry[];
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
  accountId: string;
  accountRef?: string;
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
  email: string;
  baseUrl?: string;
  configDir: string;
  profileDir: string;
  quotaStatus?: string;
  quotaReason?: string;
  schedulableStatus?: string;
  schedulableReason?: string;
  runtimeStatus?: string;
  runtimeUntil?: number;
  runtimeReason?: string;
  usageSnapshot?: AccountUsageSnapshot | null;
}

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
  accountId: string;
  reason?: string;
  removedAt?: number;
}

export interface AccountRefreshJob {
  id: string;
  provider: Provider;
  accountId: string;
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

export interface WebUiModelsResponse {
  ok: boolean;
  cached: boolean;
  updatedAt: number;
  source: string;
  sources: number;
  scannedAccounts: number;
  firstError: string;
  models: Record<string, string[]>;
  byAccount?: Record<string, string[]>;
  byAccountRef?: Record<string, string[]>;
  selectableByAccountRef?: Record<string, string[]>;
  defaultByAccountRef?: Record<string, string>;
  errorsByAccount?: Record<string, string>;
  errorsByAccountRef?: Record<string, string>;
  /** provider -> modelId -> 上游 displayName(id 与显示名可能完全错位) */
  labels?: Record<string, Record<string, string>>;
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
  accounts?: WebUiOpenAIModelAccount[];
  byProvider: Record<string, string[]>;
  byAccount?: Record<string, string[]>;
  byAccountRef?: Record<string, string[]>;
  errorsByAccount?: Record<string, string>;
  errorsByAccountRef?: Record<string, string>;
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
}

export type AccountAuthMode = 'api-key' | 'auth-token' | 'oauth-browser' | 'oauth-device';

export interface AddAccountRequest {
  provider: Provider;
  authMode: AccountAuthMode;
  config?: AccountConfig;
  replaceExisting?: boolean;
}

export interface AddAccountResponse {
  ok: boolean;
  provider: Provider;
  accountId: string;
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
    accountId: string;
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
  accountId: string;
  authMode: AccountAuthMode;
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
    clientKeyConfigured: boolean;
  };
  capabilities: {
    nodeRpc: string[];
    management: string[];
    remoteManagement: boolean;
    remoteInvite: boolean;
    devicePairing: boolean;
    transports: string[];
  };
}

export interface ControlPlaneDescriptorResponse {
  ok: boolean;
  rpc: 'control_plane.descriptor.read';
  result: ControlPlaneDescriptor;
}

export interface ControlPlaneDevice {
  id: string;
  name: string;
  platform: string;
  publicKeyFingerprint: string;
  scopes: string[];
  state: 'paired' | 'revoked';
  pairedAt: number;
  revokedAt: number;
  lastSeenAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface ControlPlaneDeviceInvite {
  id: string;
  name: string;
  controlEndpoint: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
  consumedAt: number;
  deviceId: string;
}

export interface ControlPlaneDeviceInviteCreatePayload {
  id?: string;
  name?: string;
  controlEndpoint?: string;
  scopes?: string[];
  expiresInMs?: number;
}

export interface ControlPlaneDeviceInviteCreateResponse {
  ok: boolean;
  invite: ControlPlaneDeviceInvite;
  code: string;
  pairUrl: string;
  webPairUrl?: string;
  warnings?: string[];
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

export interface ControlPlaneDevicePairResponse {
  ok: boolean;
  rpc: 'control_plane.device.pair';
  device: ControlPlaneDevice;
  token: string;
}

export interface ControlPlaneDeviceProfileResponse {
  ok: boolean;
  rpc: 'control_plane.device.profile';
  result: {
    device: ControlPlaneDevice;
    controlPlane: ControlPlaneDescriptor;
  };
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

export type ControlPlaneAuthState = 'unpaired' | 'paired' | 'unknown';

export type ControlPlaneProfileState =
  | 'draft'
  | 'discovered'
  | 'pairing'
  | 'paired'
  | 'degraded'
  | 'revoked'
  | 'recovery';

export type ControlPlaneProfileConnectionMode = 'direct' | 'broker-proxy';

export interface ControlPlaneProfileBroker {
  brokerEndpoint: string;
  serverId: string;
  proxyEndpoint: string;
}

export interface ControlPlaneProfile {
  id: string;
  name: string;
  endpoint: string;
  connectionMode: ControlPlaneProfileConnectionMode;
  broker: ControlPlaneProfileBroker | null;
  state: ControlPlaneProfileState;
  authState: ControlPlaneAuthState;
  deviceToken: string;
  nodes: ControlPlaneNodeSummary[];
  nodeCount: number;
  accountCount: number;
  activeAccountCount: number;
  schedulableAccountCount: number;
  sessionCount: number;
  lastDeviceSyncAt: number;
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

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  images?: string[];
  pending?: boolean;
  statusText?: string;
  timestamp?: string | number;
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
}

export interface SessionEventItem {
  type: 'user_message' | 'assistant_text' | 'assistant_reasoning' | 'assistant_tool_call' | 'assistant_tool_result';
  timestamp?: string;
  content?: string;
  text?: string;
  images?: string[];
  callId?: string;
}

export interface SessionEventsResponse {
  ok: boolean;
  events: SessionEventItem[];
  cursor: number;
  requiresSnapshot?: boolean;
}

export interface ChatRequest {
  messages: ChatMessage[];
  provider: Provider;
  accountId: string;
  model?: string;
  stream?: boolean;
  prompt?: string;
  createSession?: boolean;
  sessionId?: string;
  projectDirName?: string;
  projectPath?: string;
  images?: string[];
}

export interface ChatResponse {
  ok: boolean;
  accountId?: string;
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
  type: 'ready' | 'session-created' | 'delta' | 'thinking' | 'result' | 'done' | 'error' | 'terminal-output' | 'interactive-prompt' | 'interactive-prompt-cleared';
  delta?: string;
  thinking?: string;
  content?: string;
  text?: string;
  prompt?: InteractivePrompt;
  promptId?: string;
  reason?: string;
  message?: string;
  code?: string;
  ts?: string;
  elapsedMs?: number;
  firstTokenElapsedMs?: number | null;
  totalElapsedMs?: number;
  runId?: string;
  provider?: Provider;
  accountId?: string;
  sessionId?: string;
  mode?: 'native-session' | 'api-proxy';
  interactionMode?: 'default' | 'terminal';
  slashCommand?: string;
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
  lastErrors: Array<{
    at?: string;
    provider?: string;
    accountRef?: string;
    accountId?: string;
    attemptedAccountIds?: string[];
    route?: string;
    message?: string;
    error?: string;
    detail?: string;
    reason?: string;
  }>;
}

export interface ManagementAccount {
  id: string;
  provider: Provider;
  accountRef?: string;
  email?: string;
  accountId?: string;
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

export interface ModelUsageModelRow {
  provider: Provider;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface ModelUsageSessionRow {
  provider: Provider;
  sessionId: string;
  project: string;
  cwd: string;
  gitBranch: string;
  startedAtMs: number;
  updatedAtMs: number;
  promptCount: number;
  calls: number;
  totalTokens: number;
  costUsd: number;
}

export interface ModelUsageSessionDetailRow extends ModelUsageModelRow {
  sessionId: string;
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

export interface ModelUsageSessionDetailResponse {
  ok: boolean;
  range: ModelUsageDateRange;
  session: ModelUsageSessionDetailRow[];
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
  projectDirName?: string; // Claude 专用：项目目录名
  projectPath?: string;
  draft?: boolean;
  status?: string;
}

export interface ProviderInfo {
  provider: Provider;
  accountId: string;
}

export interface AggregatedProject {
  id: string;
  name: string;
  path: string;
  providers: Provider[]; // 简化为 provider 数组
  sessions: Session[]; // 聚合所有会话
  manual?: boolean;
  addedAt?: number;
}

export interface ArchivedSession {
  id: string;
  title: string;
  provider: Provider;
  projectDirName?: string;
  archivedAt: number;
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
