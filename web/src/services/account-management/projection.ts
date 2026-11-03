import type { Account, AccountUsageSnapshot, CodexUsageEntry } from '../../types/index.ts';
import type { AccountProjectionOptions, AccountView } from './types.ts';

// projectAccountView 把 Go 基础事实投影为现有页面模型，不臆造运行态或额度。
export function projectAccountView(
  source: AccountView,
  options: AccountProjectionOptions = {}
): Account {
  const apiKeyMode = source.authKind !== '' && source.authKind !== 'oauth';
  const credentialType = toWebAuthMode(source.authKind);
  const planType = source.subscriptionKind || credentialType || 'unknown';
  const displayName = source.displayName
    || source.email
    || `${source.providerId === 'codex' ? 'Codex' : 'Claude'} #${source.cliAccountId}`;

  const usageSnapshot = apiKeyMode ? null : projectUsageSnapshot(source);
  const remainingPct = minimumKnownRemainingPct(usageSnapshot);
  const usageCapturedAt = source.usageSnapshot
    ? Date.parse(source.usageSnapshot.capturedAt)
    : Number.NaN;

  return {
    provider: source.providerId,
    accountRef: source.accountRef,
    status: source.enabled ? 'up' : 'down',
    displayName,
    configured: source.hasCredential,
    apiKeyMode,
    ...(credentialType ? {
      authMode: credentialType,
      authType: credentialType,
      credentialType
    } : {}),
    isDefault: options.defaultAccountRefs?.has(source.accountRef) || false,
    isMobile: false,
    remainingPct,
    updatedAt: Number.isFinite(usageCapturedAt)
      ? usageCapturedAt
      : Date.parse(source.updatedAt),
    planType,
    ...(source.subscriptionRaw && source.subscriptionRaw !== planType
      ? { planName: source.subscriptionRaw }
      : {}),
    email: source.email,
    quotaStatus: 'unknown',
    schedulableStatus: 'unknown',
    runtimeStatus: 'unknown',
    usageSnapshot,
    tokenUsage: null,
    ...(source.modelSummary ? {
      modelSummary: {
        storedCount: source.modelSummary.storedCount,
        effectiveCount: source.modelSummary.effectiveCount,
        updatedAt: Date.parse(source.modelSummary.updatedAt)
      }
    } : {})
  };
}

// projectAccountViews 保留 Go keyset 列表的稳定顺序。
export function projectAccountViews(
  sources: readonly AccountView[],
  options: AccountProjectionOptions = {}
): Account[] {
  return sources.map((source) => projectAccountView(source, options));
}

function toWebAuthMode(authKind: string): string {
  if (authKind === 'api_key') return 'api-key';
  if (authKind === 'auth_token') return 'auth-token';
  return authKind;
}

// projectUsageSnapshot 把 Go 规范额度事实映射为页面现有的双 Provider 展示合同。
function projectUsageSnapshot(source: AccountView): AccountUsageSnapshot | null {
  const snapshot = source.usageSnapshot;
  if (!snapshot) return null;
  const capturedAt = Date.parse(snapshot.capturedAt);
  const entries: CodexUsageEntry[] = snapshot.entries.map((entry) => ({
    bucket: entry.limitName || entry.bucket,
    windowMinutes: entry.windowSeconds == null ? 0 : entry.windowSeconds / 60,
    window: entry.limitName || entry.bucket,
    remainingPct: entry.remainingBasisPoints == null
      ? null
      : entry.remainingBasisPoints / 100,
    resetIn: '',
    resetAtMs: entry.resetAt == null ? 0 : Date.parse(entry.resetAt)
  }));
  if (source.providerId === 'codex') {
    return { kind: 'codex_oauth_status', capturedAt, entries };
  }
  return { kind: 'claude_oauth_usage', capturedAt, entries };
}

// minimumKnownRemainingPct 只汇总 Provider 明确给出的比例，未知仍保持 null。
function minimumKnownRemainingPct(snapshot: AccountUsageSnapshot | null): number | null {
  if (!snapshot || !('entries' in snapshot)) return null;
  const values = snapshot.entries
    .map((entry) => entry.remainingPct)
    .filter((value): value is number => value != null && Number.isFinite(value));
  return values.length === 0 ? null : Math.min(...values);
}
