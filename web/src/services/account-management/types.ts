import type { ServerJsonValue } from '../server-transport/contract.ts';

// ManagedProvider 是当前 Go 账号管理链明确支持的 Provider 集合。
export type ManagedProvider = 'codex' | 'claude';

// StaticCredentialInput 使用互斥联合类型防止调用方混填两种静态凭据。
export type StaticCredentialInput =
  | {
      kind: 'api_key';
      apiKey: string;
      baseUrl?: string;
    }
  | {
      kind: 'auth_token';
      authToken: string;
      baseUrl?: string;
    };

// AccountView 对应 Go Management API 的无敏感账号投影。
export interface AccountView {
  accountRef: string;
  providerId: ManagedProvider;
  cliAccountId: number;
  enabled: boolean;
  hasCredential: boolean;
  authKind: string;
  authMode: string;
  hasProfile: boolean;
  displayName: string;
  email: string;
  subscriptionKind: string;
  subscriptionRaw: string;
  profileUpdatedAt?: string;
  modelSummary: AccountModelSummaryView | null;
  usageSnapshot: AccountUsageSnapshotView | null;
  createdAt: string;
  updatedAt: string;
}

// AccountModelSummaryView 区分无持久化模型证据与已知零个有效模型。
export interface AccountModelSummaryView {
  storedCount: number;
  effectiveCount: number;
  updatedAt: string;
}

// AccountUsageSnapshotView 是账号列表直接携带的 last-known-good 额度快照。
export interface AccountUsageSnapshotView {
  source: string;
  capturedAt: string;
  entries: AccountUsageEntryView[];
}

// ProviderDefaultView 表示 Provider 与默认启动账号之间的唯一关系。
export interface ProviderDefaultView {
  providerId: ManagedProvider;
  accountRef: string;
  updatedAt: string;
}

// OAuthJobStatus 是 Go OAuth Job 暴露的完整状态机。
export type OAuthJobStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

// OAuthJobView 不包含授权码、Token、PKCE 或 state。
export interface OAuthJobView {
  jobId: string;
  providerId: ManagedProvider;
  purpose: 'register' | 'reauth';
  targetAccountRef?: string;
  status: OAuthJobStatus;
  createdAt: string;
  expiresAt: string;
  finishedAt?: string;
  accountRef?: string;
  cliAccountId?: number;
  failureCode?: string;
}

// OAuthJobStartView 只在创建响应中增加一次性官方授权地址。
export interface OAuthJobStartView extends OAuthJobView {
  authorizationUrl: string;
}

// AccountUsageEntryView 保留 Provider 额度维度以及显式未知值。
export interface AccountUsageEntryView {
  limitId: string;
  limitName: string;
  bucket: string;
  kind: string;
  scope: string;
  scopeKey: string;
  remainingBasisPoints: number | null;
  availability: string;
  windowSeconds: number | null;
  resetAt: string | null;
}

// AccountUsageView 是一次已持久化的额度快照。
export interface AccountUsageView {
  accountRef: string;
  providerId: ManagedProvider;
  source: string;
  capturedAt: string;
  stale: boolean;
  entries: AccountUsageEntryView[];
}

export type AccountModelManualPolicy = 'inherit' | 'force_enable' | 'force_disable';

// AccountModelView 是账号模型正排中一条完整、非敏感的有效性关系。
export interface AccountModelView {
  modelId: string;
  upstreamAvailable: boolean;
  manualPolicy: AccountModelManualPolicy;
  effective: boolean;
  updatedAt: string;
}

// NativeAccountImportInput 只接收 Codex/Claude 官方 artifact JSON。
export interface NativeAccountImportInput {
  providerId: ManagedProvider;
  artifacts: ServerJsonValue;
}

// AccountImportResultView 用 HTTP 创建语义区分首次注册和既有身份原地更新。
export interface AccountImportResultView {
  account: AccountView;
  created: boolean;
}

// AccountProjectionOptions 只传入列表调用方已拥有的关系，避免 usage/default N+1 请求。
export interface AccountProjectionOptions {
  defaultAccountRefs?: ReadonlySet<string>;
}
