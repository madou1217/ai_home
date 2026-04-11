export type Provider = 'codex' | 'gemini' | 'claude';

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
}

export type AccountUsageSnapshot =
  | {
      kind: 'codex_oauth_status';
      capturedAt: number;
      entries: CodexUsageEntry[];
    }
  | {
      kind: 'gemini_oauth_stats';
      capturedAt: number;
      models: GeminiUsageModel[];
    };

export interface Account {
  provider: Provider;
  accountId: string;
  displayName: string;
  configured: boolean;
  apiKeyMode: boolean;
  exhausted: boolean;
  remainingPct: number;
  updatedAt: number;
  planType: string; // free/plus/team/business/api-key/oauth
  email: string;
  configDir: string;
  profileDir: string;
  runtimeStatus?: string;
  runtimeUntil?: number;
  runtimeReason?: string;
  usageSnapshot?: AccountUsageSnapshot | null;
}

export interface AccountConfig {
  apiKey?: string;
  baseUrl?: string;
}

export type AccountAuthMode = 'api-key' | 'oauth-browser' | 'oauth-device';

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

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  images?: string[];
  pending?: boolean;
  statusText?: string;
  timestamp?: string | number;
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

export interface ChatStreamEvent {
  type: 'ready' | 'session-created' | 'delta' | 'thinking' | 'result' | 'done' | 'error' | 'terminal-output';
  delta?: string;
  thinking?: string;
  content?: string;
  text?: string;
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
    message?: string;
  }>;
}

export interface ManagementAccount {
  id: string;
  provider: Provider;
  email?: string;
  accountId?: string;
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
