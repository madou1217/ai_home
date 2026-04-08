export type Provider = 'codex' | 'gemini' | 'claude';

export interface Account {
  provider: Provider;
  accountId: string;
  displayName: string;
  configured: boolean;
  apiKeyMode: boolean;
  exhausted: boolean;
  remainingPct: number;
  updatedAt: number;
  configDir: string;
  profileDir: string;
}

export interface AccountConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface UsageConfig {
  active_refresh_interval: string;
  background_refresh_interval: string;
  threshold_pct: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  provider: Provider;
  accountId: string;
  stream?: boolean;
}

export interface ChatResponse {
  ok: boolean;
  accountId?: string;
  provider?: Provider;
  model?: string;
  content?: string;
  error?: string;
}

export interface ServerStatus {
  ok: boolean;
  service: string;
  uptime?: number;
  version?: string;
}

export interface ServerMetrics {
  requests_total: number;
  errors_total: number;
  avg_duration_ms: number;
}

export interface Session {
  id: string;
  title: string;
  updatedAt: number;
  provider: Provider;
  projectDirName?: string; // Claude 专用：项目目录名
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
}
