import { AccountManagementError } from './errors.ts';
import type {
  AccountModelSummaryView,
  AccountModelManualPolicy,
  AccountModelView,
  AccountUsageEntryView,
  AccountUsageSnapshotView,
  AccountUsageView,
  AccountView,
  ManagedProvider,
  OAuthJobStartView,
  OAuthJobStatus,
  OAuthJobView,
  ProviderDefaultView
} from './types.ts';

const ACCOUNT_REF_PATTERN = /^acct_[a-f0-9]{20}$/;
const JOB_ID_PATTERN = /^[a-f0-9]{32}$/;
const SAFE_TOKEN_PATTERN = /^[a-z0-9_]{1,64}$/;
const STABLE_IDENTIFIER_PATTERN = /^[a-z0-9_.:-]{1,128}$/;
const UTC_RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const OAUTH_STATUSES = new Set<OAuthJobStatus>([
  'pending',
  'processing',
  'completed',
  'failed',
  'cancelled',
  'expired'
]);
const MODEL_MANUAL_POLICIES = new Set<AccountModelManualPolicy>([
  'inherit',
  'force_enable',
  'force_disable'
]);
const USAGE_KINDS = new Set(['window', 'credits']);
const USAGE_SCOPES = new Set(['account', 'model_family']);
const USAGE_AVAILABILITIES = new Set([
  'unknown',
  'available',
  'exhausted',
  'unlimited',
  'disabled'
]);
const MAX_USAGE_ENTRIES = 64;
const MAX_USAGE_WINDOW_SECONDS = 316_224_000;

interface AccountPage {
  data: AccountView[];
  page: {
    limit: number;
    hasMore: boolean;
    nextAfterRef: string;
  };
}

// isManagedProvider 限定当前迁移范围，不让未来 Provider 被错误投影为已支持。
export function isManagedProvider(value: unknown): value is ManagedProvider {
  return value === 'codex' || value === 'claude';
}

// assertManagedProvider 为命令入口提供一致的本地校验。
export function assertManagedProvider(value: unknown): asserts value is ManagedProvider {
  if (!isManagedProvider(value)) fail('account_management_provider_invalid');
}

// assertAccountRef 避免未经编码的路径片段进入 Management API。
export function assertAccountRef(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ACCOUNT_REF_PATTERN.test(value)) {
    fail('account_management_account_ref_invalid');
  }
}

// assertOAuthJobId 避免任意路径片段进入 OAuth Job API。
export function assertOAuthJobId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !JOB_ID_PATTERN.test(value)) {
    fail('account_management_oauth_job_id_invalid');
  }
}

// assertAccountModelId 让模型策略写入复用与响应解码相同的安全边界。
export function assertAccountModelId(value: unknown): asserts value is string {
  modelID(value);
}

// assertAccountModelManualPolicy 只允许 Go 合同声明的三种人工策略。
export function assertAccountModelManualPolicy(
  value: unknown
): asserts value is AccountModelManualPolicy {
  if (
    typeof value !== 'string'
    || !MODEL_MANUAL_POLICIES.has(value as AccountModelManualPolicy)
  ) {
    fail('account_management_model_policy_invalid');
  }
}

// decodeAccountPage 严格校验 keyset 数据和游标合同。
export function decodeAccountPage(value: unknown): AccountPage {
  const root = record(value, 'account_management_accounts_response_invalid');
  const rawAccounts = array(root.data, 'account_management_accounts_data_invalid');
  let lastScannedAccountRef = '';
  const data: AccountView[] = [];
  for (const rawAccount of rawAccounts) {
    const raw = record(rawAccount, 'account_management_account_data_invalid');
    const scannedAccountRef = accountRef(raw.account_ref);
    if (lastScannedAccountRef && scannedAccountRef <= lastScannedAccountRef) {
      fail('account_management_accounts_order_invalid');
    }
    lastScannedAccountRef = scannedAccountRef;
    const providerId = providerToken(raw.provider_id);
    // Go 数据库可能同时保存其他 Provider；G1 页面只消费 Codex/Claude，安全 Provider 被忽略。
    if (!isManagedProvider(providerId)) continue;
    data.push(decodeAccountView(raw));
  }
  const page = record(root.page, 'account_management_accounts_page_invalid');
  const limit = integer(page.limit, 1, 255, 'account_management_accounts_limit_invalid');
  const hasMore = boolean(page.has_more, 'account_management_accounts_has_more_invalid');
  const nextAfterRef = text(page.next_after_ref, 25, 'account_management_accounts_cursor_invalid');
  if (hasMore) assertAccountRef(nextAfterRef);
  if (!hasMore && nextAfterRef !== '') fail('account_management_accounts_cursor_invalid');
  if (
    hasMore
    && (
      !lastScannedAccountRef
      || lastScannedAccountRef !== nextAfterRef
    )
  ) {
    fail('account_management_accounts_cursor_invalid');
  }
  return { data, page: { limit, hasMore, nextAfterRef } };
}

// decodeAccountEnvelope 解析创建、启停和凭据轮换的共享响应。
export function decodeAccountEnvelope(value: unknown): AccountView {
  return decodeAccountView(record(value, 'account_management_account_response_invalid').data);
}

// decodeProviderDefaultEnvelope 解析默认账号关系。
export function decodeProviderDefaultEnvelope(value: unknown): ProviderDefaultView {
  const data = record(
    record(value, 'account_management_default_response_invalid').data,
    'account_management_default_data_invalid'
  );
  const providerId = managedProvider(data.provider_id);
  const defaultAccountRef = accountRef(data.account_ref);
  return {
    providerId,
    accountRef: defaultAccountRef,
    updatedAt: timestamp(data.updated_at, 'account_management_default_updated_at_invalid')
  };
}

// decodeOAuthJobEnvelope 解析查询、取消和回调共享响应。
export function decodeOAuthJobEnvelope(value: unknown): OAuthJobView {
  return decodeOAuthJob(
    record(value, 'account_management_oauth_response_invalid').data,
    false
  );
}

// decodeOAuthJobStartEnvelope 解析只出现一次的官方授权地址。
export function decodeOAuthJobStartEnvelope(value: unknown): OAuthJobStartView {
  return decodeOAuthJob(
    record(value, 'account_management_oauth_start_response_invalid').data,
    true
  ) as OAuthJobStartView;
}

// decodeAccountUsageEnvelope 解析显式刷新返回的单账号额度快照。
export function decodeAccountUsageEnvelope(value: unknown): AccountUsageView {
  const data = record(
    record(value, 'account_management_usage_response_invalid').data,
    'account_management_usage_data_invalid'
  );
  return {
    accountRef: accountRef(data.account_ref),
    providerId: managedProvider(data.provider_id),
    source: text(data.source, 128, 'account_management_usage_source_invalid'),
    capturedAt: timestamp(data.captured_at, 'account_management_usage_captured_at_invalid'),
    stale: boolean(data.stale, 'account_management_usage_stale_invalid'),
    entries: decodeUsageEntries(data.entries)
  };
}

// decodeAccountModelsEnvelope 严格解析同步列表、策略维护与目录刷新共享的模型快照。
export function decodeAccountModelsEnvelope(value: unknown): AccountModelView[] {
  const root = record(value, 'account_management_models_response_invalid');
  const seen = new Set<string>();
  return array(root.data, 'account_management_models_data_invalid').map((entry) => {
    const data = record(entry, 'account_management_model_invalid');
    const modelId = modelID(data.model_id);
    if (seen.has(modelId)) fail('account_management_model_duplicate');
    seen.add(modelId);
    const manualPolicy = data.manual_policy;
    assertAccountModelManualPolicy(manualPolicy);
    return {
      modelId,
      upstreamAvailable: boolean(
        data.upstream_available,
        'account_management_model_availability_invalid'
      ),
      manualPolicy: manualPolicy as AccountModelManualPolicy,
      effective: boolean(data.effective, 'account_management_model_effective_invalid'),
      updatedAt: timestamp(data.updated_at, 'account_management_model_updated_at_invalid')
    };
  });
}

function decodeAccountView(value: unknown): AccountView {
  const data = record(value, 'account_management_account_data_invalid');
  const hasCredential = boolean(
    data.has_credential,
    'account_management_account_credential_invalid'
  );
  const authKind = text(data.auth_kind, 32, 'account_management_account_auth_kind_invalid');
  const authMode = text(data.auth_mode, 32, 'account_management_account_auth_mode_invalid');
  if ((hasCredential && !authKind) || (!hasCredential && (authKind || authMode))) {
    fail('account_management_account_credential_invalid');
  }
  if ((authKind && !SAFE_TOKEN_PATTERN.test(authKind)) || (authMode && !SAFE_TOKEN_PATTERN.test(authMode))) {
    fail('account_management_account_auth_kind_invalid');
  }
  const profileUpdatedAt = optionalTimestamp(
    data.profile_updated_at,
    'account_management_account_profile_updated_at_invalid'
  );
  const modelSummary = decodeAccountModelSummary(data.model_summary);
  const usageSnapshot = decodeAccountUsageSnapshot(data.usage_snapshot);
  return {
    accountRef: accountRef(data.account_ref),
    providerId: managedProvider(data.provider_id),
    cliAccountId: integer(
      data.cli_account_id,
      1,
      Number.MAX_SAFE_INTEGER,
      'account_management_account_cli_id_invalid'
    ),
    enabled: boolean(data.enabled, 'account_management_account_enabled_invalid'),
    hasCredential,
    authKind,
    authMode,
    hasProfile: boolean(data.has_profile, 'account_management_account_profile_invalid'),
    displayName: text(data.display_name, 256, 'account_management_account_display_name_invalid'),
    email: text(data.email, 320, 'account_management_account_email_invalid'),
    subscriptionKind: text(
      data.subscription_kind,
      64,
      'account_management_account_subscription_invalid'
    ),
    subscriptionRaw: text(
      data.subscription_raw,
      128,
      'account_management_account_subscription_invalid'
    ),
    ...(profileUpdatedAt ? { profileUpdatedAt } : {}),
    modelSummary,
    usageSnapshot,
    createdAt: timestamp(data.created_at, 'account_management_account_created_at_invalid'),
    updatedAt: timestamp(data.updated_at, 'account_management_account_updated_at_invalid')
  };
}

function decodeAccountModelSummary(value: unknown): AccountModelSummaryView | null {
  if (value === null) return null;
  const data = record(value, 'account_management_account_model_summary_invalid');
  const storedCount = integer(
    data.stored_count,
    1,
    Number.MAX_SAFE_INTEGER,
    'account_management_account_model_summary_invalid'
  );
  const effectiveCount = integer(
    data.effective_count,
    0,
    storedCount,
    'account_management_account_model_summary_invalid'
  );
  return {
    storedCount,
    effectiveCount,
    updatedAt: timestamp(
      data.updated_at,
      'account_management_account_model_summary_invalid'
    )
  };
}

function decodeAccountUsageSnapshot(value: unknown): AccountUsageSnapshotView | null {
  if (value === null) return null;
  const data = record(value, 'account_management_account_usage_snapshot_invalid');
  const source = stableIdentifier(
    data.source,
    false,
    'account_management_account_usage_snapshot_invalid'
  );
  return {
    source,
    capturedAt: timestamp(
      data.captured_at,
      'account_management_account_usage_snapshot_invalid'
    ),
    entries: decodeUsageEntries(
      data.entries,
      'account_management_account_usage_snapshot_invalid'
    )
  };
}

function decodeOAuthJob(value: unknown, withAuthorizationUrl: boolean): OAuthJobView {
  const data = record(value, 'account_management_oauth_job_invalid');
  const jobId = text(data.job_id, 32, 'account_management_oauth_job_id_invalid');
  assertOAuthJobId(jobId);
  const status = data.status;
  if (typeof status !== 'string' || !OAUTH_STATUSES.has(status as OAuthJobStatus)) {
    fail('account_management_oauth_status_invalid');
  }
  const purpose = data.purpose;
  if (purpose !== 'register' && purpose !== 'reauth') {
    fail('account_management_oauth_purpose_invalid');
  }
  const targetAccountRef = optionalAccountRef(data.target_account_ref);
  if (purpose === 'reauth' && !targetAccountRef) fail('account_management_oauth_target_invalid');
  if (purpose === 'register' && targetAccountRef) fail('account_management_oauth_target_invalid');
  const accountRefValue = optionalAccountRef(data.account_ref);
  const finishedAt = optionalTimestamp(data.finished_at, 'account_management_oauth_finished_at_invalid');
  const cliAccountId = optionalPositiveInteger(
    data.cli_account_id,
    'account_management_oauth_cli_id_invalid'
  );
  const failureCode = optionalSafeToken(
    data.failure_code,
    'account_management_oauth_failure_code_invalid'
  );
  const job: OAuthJobView = {
    jobId,
    providerId: managedProvider(data.provider_id),
    purpose,
    ...(targetAccountRef ? { targetAccountRef } : {}),
    status: status as OAuthJobStatus,
    createdAt: timestamp(data.created_at, 'account_management_oauth_created_at_invalid'),
    expiresAt: timestamp(data.expires_at, 'account_management_oauth_expires_at_invalid'),
    ...(finishedAt ? { finishedAt } : {}),
    ...(accountRefValue ? { accountRef: accountRefValue } : {}),
    ...(cliAccountId ? { cliAccountId } : {}),
    ...(failureCode ? { failureCode } : {})
  };
  if (!withAuthorizationUrl) return job;
  const authorizationUrl = absoluteHttpUrl(data.authorization_url);
  return { ...job, authorizationUrl } as OAuthJobStartView;
}

function decodeUsageEntries(
  value: unknown,
  code = 'account_management_usage_entries_invalid'
): AccountUsageEntryView[] {
  const values = array(value, code);
  if (values.length < 1 || values.length > MAX_USAGE_ENTRIES) fail(code);
  const entries = values.map(decodeUsageEntry);
  let previousKey = '';
  for (const entry of entries) {
    const key = `${entry.limitId}\0${entry.bucket}`;
    if (previousKey && key <= previousKey) fail(code);
    previousKey = key;
  }
  return entries;
}

function decodeUsageEntry(value: unknown): AccountUsageEntryView {
  const data = record(value, 'account_management_usage_entry_invalid');
  const limitId = stableIdentifier(
    data.limit_id,
    true,
    'account_management_usage_limit_invalid'
  );
  const bucket = stableIdentifier(
    data.bucket,
    false,
    'account_management_usage_bucket_invalid'
  );
  const kind = enumText(
    data.kind,
    USAGE_KINDS,
    'account_management_usage_kind_invalid'
  );
  const scope = enumText(
    data.scope,
    USAGE_SCOPES,
    'account_management_usage_scope_invalid'
  );
  const scopeKey = stableIdentifier(
    data.scope_key,
    scope === 'account',
    'account_management_usage_scope_invalid'
  );
  if ((scope === 'account' && scopeKey !== '') || (scope === 'model_family' && scopeKey === '')) {
    fail('account_management_usage_scope_invalid');
  }
  const remainingBasisPoints = nullableInteger(
    data.remaining_basis_points,
    0,
    10000,
    'account_management_usage_remaining_invalid'
  );
  const availability = enumText(
    data.availability,
    USAGE_AVAILABILITIES,
    'account_management_usage_availability_invalid'
  );
  if (
    (remainingBasisPoints === 0 && availability !== 'exhausted')
    || (remainingBasisPoints !== null && remainingBasisPoints > 0 && availability !== 'available')
    || (kind === 'window' && (availability === 'unlimited' || availability === 'disabled'))
  ) {
    fail('account_management_usage_availability_invalid');
  }
  return {
    limitId,
    limitName: text(data.limit_name, 256, 'account_management_usage_limit_invalid'),
    bucket,
    kind,
    scope,
    scopeKey,
    remainingBasisPoints,
    availability,
    windowSeconds: nullableInteger(
      data.window_seconds,
      1,
      MAX_USAGE_WINDOW_SECONDS,
      'account_management_usage_window_invalid'
    ),
    resetAt: nullableTimestamp(data.reset_at, 'account_management_usage_reset_at_invalid')
  };
}

function stableIdentifier(value: unknown, allowEmpty: boolean, code: string): string {
  if (allowEmpty && value === '') return '';
  if (typeof value !== 'string' || !STABLE_IDENTIFIER_PATTERN.test(value)) fail(code);
  return value;
}

function enumText(value: unknown, allowed: ReadonlySet<string>, code: string): string {
  if (typeof value !== 'string' || !allowed.has(value)) fail(code);
  return value;
}

function managedProvider(value: unknown): ManagedProvider {
  assertManagedProvider(value);
  return value;
}

function providerToken(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_TOKEN_PATTERN.test(value)) {
    fail('account_management_provider_invalid');
  }
  return value;
}

function accountRef(value: unknown): string {
  assertAccountRef(value);
  return value;
}

function modelID(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || new TextEncoder().encode(value).byteLength > 256
    || /[\p{C}\p{Z}]/u.test(value)
  ) {
    fail('account_management_model_id_invalid');
  }
  return value;
}

function optionalAccountRef(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  return accountRef(value);
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function array(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) fail(code);
  return value;
}

function text(value: unknown, maxLength: number, code: string): string {
  if (typeof value !== 'string' || value.length > maxLength || /[\r\n\0]/.test(value)) fail(code);
  return value;
}

function boolean(value: unknown, code: string): boolean {
  if (typeof value !== 'boolean') fail(code);
  return value;
}

function integer(value: unknown, min: number, max: number, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail(code);
  return Number(value);
}

function nullableInteger(
  value: unknown,
  min: number,
  max: number,
  code: string
): number | null {
  if (value === null) return null;
  return integer(value, min, max, code);
}

function optionalPositiveInteger(value: unknown, code: string): number | undefined {
  if (value === undefined || value === 0) return undefined;
  return integer(value, 1, Number.MAX_SAFE_INTEGER, code);
}

function timestamp(value: unknown, code: string): string {
  if (
    typeof value !== 'string'
    || !UTC_RFC3339_PATTERN.test(value)
    || Number.isNaN(Date.parse(value))
  ) fail(code);
  return value;
}

function optionalTimestamp(value: unknown, code: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  return timestamp(value, code);
}

function nullableTimestamp(value: unknown, code: string): string | null {
  if (value === null) return null;
  return timestamp(value, code);
}

function optionalSafeToken(value: unknown, code: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !SAFE_TOKEN_PATTERN.test(value)) fail(code);
  return value;
}

function absoluteHttpUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value)) {
    fail('account_management_oauth_url_invalid');
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      fail('account_management_oauth_url_invalid');
    }
    return value;
  } catch (_error) {
    return fail('account_management_oauth_url_invalid');
  }
}

function fail(code: string): never {
  throw new AccountManagementError(code);
}
