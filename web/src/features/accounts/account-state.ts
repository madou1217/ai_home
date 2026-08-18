import type { Account, AccountAuthMode } from '@/types';
import { formatAccountIssueReason } from '@/utils/account-reasons';

// 账号显示状态推导 —— 纯函数模块。
// 从 Accounts.tsx 抽取：账号状态、用量、认证方式的所有推导逻辑集中于此，
// 组件/hook 只做展示与交互，禁止在组件内联重复推导。

export function isClaudeAuthTokenMode(value?: string) {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  return normalized === 'auth-token' || normalized === 'claude-code-token';
}

export function getClaudeCredentialMode(record?: Pick<Account, 'authMode' | 'authType' | 'credentialType'> | null): AccountAuthMode {
  return isClaudeAuthTokenMode(record?.credentialType || record?.authType || record?.authMode)
    ? 'auth-token'
    : 'api-key';
}

export function canCopyAccountEmail(record: Pick<Account, 'apiKeyMode' | 'email' | 'baseUrl'>) {
  if (record.apiKeyMode) {
    return true; // API Key 账号始终展示复制按钮
  }
  return Boolean(String(record.email || '').trim());
}

export function hasBlockingRuntimeStatus(record: Pick<Account, 'runtimeStatus'>) {
  const status = String(record.runtimeStatus || '').trim();
  return Boolean(status && status !== 'healthy');
}

export function isAccountEnabled(record: Pick<Account, 'status'>) {
  return String(record.status || 'up').trim().toLowerCase() !== 'down';
}

export type AccountDisplayStateKind =
  | 'healthy'
  | 'exhausted'
  | 'policy_blocked'
  | 'usage_attention'
  | 'runtime_blocked'
  | 'disabled'
  | 'unconfigured';

export function canRefreshUsageAccount(record: Pick<Account, 'configured' | 'apiKeyMode' | 'runtimeStatus' | 'quotaStatus' | 'schedulableStatus'>) {
  // OAuth 已配置账号始终允许手动刷新用量,不再依赖已有额度状态。
  if (String(record.quotaStatus || '').trim() === 'not_applicable') return false;
  return Boolean(record.configured) && !record.apiKeyMode;
}

export function canReauthAccount(record: Pick<Account, 'apiKeyMode'>) {
  return !record.apiKeyMode;
}

export function getReauthActionLabel(record: Pick<Account, 'configured' | 'authPending' | 'authPendingStale'>) {
  if (record.authPending && !record.authPendingStale) return '继续授权';
  if (!record.configured) return '重新授权';
  return '重新登录';
}

export function canEditAccountConfig(record: Pick<Account, 'apiKeyMode'>) {
  return Boolean(record.apiKeyMode);
}

export function hasKnownUsage(record: Pick<Account, 'apiKeyMode' | 'remainingPct' | 'provider' | 'usageSnapshot'>) {
  if (record.apiKeyMode) return false;
  return getEffectiveRemainingPct(record) != null;
}

export function getUsageSnapshotRemainingPct(record: Pick<Account, 'provider' | 'usageSnapshot'>) {
  const snapshot = record.usageSnapshot;
  if (!snapshot) return null;
  let values: number[] = [];
  if (
    (record.provider === 'codex' && snapshot.kind === 'codex_oauth_status')
    || (record.provider === 'claude' && snapshot.kind === 'claude_oauth_usage')
    || (record.provider === 'kimi' && snapshot.kind === 'kimi_oauth_usage')
  ) {
    values = (snapshot.entries || [])
      .map((entry) => Number(entry.remainingPct))
      .filter((value) => Number.isFinite(value));
  } else if (
    (record.provider === 'gemini' && snapshot.kind === 'gemini_oauth_stats')
    || (record.provider === 'agy' && snapshot.kind === 'agy_code_assist_quota')
  ) {
    values = (snapshot.models || [])
      .map((model) => Number(model.remainingPct))
      .filter((value) => Number.isFinite(value));
  }
  if (values.length === 0) return null;
  return Math.max(0, Math.min(100, Math.min(...values)));
}

export function getEffectiveRemainingPct(record: Pick<Account, 'provider' | 'remainingPct' | 'usageSnapshot'>) {
  const snapshotRemaining = getUsageSnapshotRemainingPct(record);
  if (snapshotRemaining != null) return snapshotRemaining;
  if (record.remainingPct == null) return null;
  const numeric = Number(record.remainingPct);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, numeric));
}

export function getUsageSortValue(record: Pick<Account, 'provider' | 'remainingPct' | 'usageSnapshot'>) {
  return getEffectiveRemainingPct(record) ?? -1;
}

export function formatQuotaReason(reason?: string) {
  return formatAccountIssueReason(reason);
}

export function formatSchedulableReason(reason?: string) {
  const text = String(reason || '').trim();
  if (!text) return '';
  if (text === 'codex_free_plan_below_server_min_remaining') {
    return 'Free 账号剩余额度已低于当前账号切换阈值（按配置计算），已从 aih server 账号池排除，避免接近上限时继续使用导致会话中断。';
  }
  if (text === 'codex_free_plan_missing_rate_limits') {
    return '当前账号已被判定为 Free，但 Codex 没返回可计算额度窗口；server 暂不把它放进账号池，建议重新登录确认。';
  }
  if (text === 'codex_team_plan_missing_rate_limits') {
    return '当前账号 token claim 仍是 Team，但 Codex 没返回可计算额度窗口；server 暂不把它放进账号池，建议重新登录确认。';
  }
  if (text === 'agy_access_token_required') {
    return 'Antigravity OAuth token 在系统 keyring 中，aih server 不能安全读取；需要在账号环境中显式配置 AGY_ACCESS_TOKEN 后才会进入聊天/转发池。';
  }
  return formatAccountIssueReason(text);
}

export function getAccountDisplayState(record: Pick<Account, 'status' | 'configured' | 'apiKeyMode' | 'runtimeStatus' | 'quotaStatus' | 'schedulableStatus' | 'remainingPct' | 'provider' | 'usageSnapshot'>): AccountDisplayStateKind {
  if (!isAccountEnabled(record)) return 'disabled';
  if (!record.configured) return 'unconfigured';
  if (hasBlockingRuntimeStatus(record)) return 'runtime_blocked';
  const effectiveRemainingPct = getEffectiveRemainingPct(record);
  if (!record.apiKeyMode && effectiveRemainingPct != null && effectiveRemainingPct <= 0) return 'exhausted';
  if (String(record.quotaStatus || '').trim() === 'exhausted') return 'exhausted';
  if (String(record.schedulableStatus || '').trim() === 'blocked_by_policy') return 'policy_blocked';
  if (
    String(record.quotaStatus || '').trim()
    && !['available', 'not_applicable', 'exhausted'].includes(String(record.quotaStatus || '').trim())
  ) {
    return 'usage_attention';
  }
  if (String(record.quotaStatus || '').trim() === 'not_applicable') return 'healthy';
  if (!record.apiKeyMode && !hasKnownUsage(record)) return 'usage_attention';
  return 'healthy';
}