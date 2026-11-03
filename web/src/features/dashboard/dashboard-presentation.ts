import { providerIds, providerNames } from '@/components/chat/provider-registry';
import type { ManagementAccount, ManagementMetrics, ManagementQueueSnapshot, ManagementStatus, Provider } from '@/types';
import { formatAccountIssueReason } from '@/utils/account-reasons';

/**
 * 网关仪表盘的纯展示 / 派生工具：桌面 Dashboard 与移动端 MobileDashboard 共用，
 * 口径、阈值与文案保持单一来源（从 pages/Dashboard.tsx 原样抽出）。
 */

export const DASHBOARD_PROVIDERS: readonly Provider[] = providerIds;

export type DashboardRecentError = ManagementMetrics['lastErrors'][number];

export type SuccessTone = 'healthy' | 'warning' | 'error' | 'neutral';

export type OverallHealth = 'loading' | 'healthy' | 'degraded' | 'critical';

export type ProviderRow = {
  key: Provider;
  provider: Provider;
  total: number;
  active: number;
  statuses: Record<string, number>;
  queue: ManagementQueueSnapshot | undefined;
  requests: number;
  success: number;
  failures: number;
};

export type RouteRow = { key: string; route: string; count: number };

export const formatPercent = (value?: number) => `${(Number(value || 0) * 100).toFixed(1)}%`;

export function normalizeQueueCount(value: unknown, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.floor(numeric));
}

export function formatUptime(sec?: number | null) {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return '-';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec % 60}s`;
  return `${sec}s`;
}

export function formatRecentErrorMessage(item: DashboardRecentError) {
  const raw = String(item?.message || item?.error || item?.detail || item?.reason || '').trim();
  if (!raw) return '未提供错误详情';
  const friendly = formatAccountIssueReason(raw);
  return friendly || raw;
}

export function getProtocolDisplayName(protocol?: string, family?: string): string {
  if (protocol) {
    switch (protocol) {
      case 'anthropic_messages': return 'Claude (Messages)';
      case 'openai_responses': return 'Codex (Responses)';
      case 'openai_chat': return 'OpenAI (Chat)';
      case 'gemini_generate_content':
      case 'gemini_stream_generate_content': return 'Gemini (GenerateContent)';
      case 'kimi_chat': return 'Kimi (Chat)';
      default: break;
    }
  }
  if (family) {
    const p = family.toLowerCase();
    return providerNames[p as keyof typeof providerNames] || family.toUpperCase();
  }
  return '';
}

export function getProviderDisplayName(provider?: string): string {
  if (!provider) return '';
  const p = provider.toLowerCase();
  return providerNames[p as keyof typeof providerNames] || provider.toUpperCase();
}

export function getRecentErrorProvider(item: DashboardRecentError) {
  const provider = String(item.effectiveProvider || item.provider || '').trim().toLowerCase();
  return DASHBOARD_PROVIDERS.includes(provider as Provider) ? (provider as Provider) : null;
}

/** 管理快照里的账号可能带 displayName（类型未声明，按真实返回兜底读取）。 */
type ManagementAccountWithName = ManagementAccount & { displayName?: string };

export function resolveFriendlyAccountDisplay(item: DashboardRecentError, account?: ManagementAccountWithName): string {
  if (item.accountLabel && !item.accountLabel.startsWith('acct_')) {
    return item.accountLabel;
  }
  if (account?.displayName) return account.displayName;
  if (account?.email) return account.email;
  const prov = item.effectiveProvider || item.provider || account?.provider || '';
  const provName = prov ? (providerNames[prov as keyof typeof providerNames] || prov.toUpperCase()) : 'AI';
  if (account?.apiKeyMode) {
    return `${provName} 密钥账号`;
  }
  if (item.attemptedCount && item.attemptedCount > 1) {
    return `尝试了 ${item.attemptedCount} 个账号`;
  }
  return `${provName} 账号`;
}

export function extractProjectBasename(projectPath?: string, dirName?: string): string {
  if (dirName && dirName.trim()) return dirName.trim();
  if (!projectPath || !projectPath.trim()) return '';
  const clean = projectPath.trim().replace(/[/\\]+$/, '');
  const parts = clean.split(/[/\\]/);
  return parts[parts.length - 1] || clean;
}

export function formatSessionShortId(sessionId?: string): string {
  if (!sessionId) return '';
  const trimmed = sessionId.trim();
  if (trimmed.length <= 16) return trimmed;
  return `${trimmed.slice(0, 7)}…${trimmed.slice(-5)}`;
}

/** 调用链路与别名映射（Cross-Provider 路由 / 模型别名链）的派生字段。 */
export function describeErrorPipeline(item: DashboardRecentError) {
  const sourceProtocolLabel = getProtocolDisplayName(item.clientProtocol, item.familyProvider);
  const targetProviderLabel = getProviderDisplayName(item.effectiveProvider || item.provider);
  const isCrossRoute = Boolean(
    item.familyProvider &&
    (item.effectiveProvider || item.provider) &&
    item.familyProvider.toLowerCase() !== String(item.effectiveProvider || item.provider).toLowerCase()
  );
  const displayRequestedModel = item.requestedModel || (item.aliasTarget ? item.model : '');
  const displayEffectiveModel = item.effectiveModel || item.aliasTarget || '';
  const isAlias = Boolean(
    item.aliasMatched ||
    (displayRequestedModel && displayEffectiveModel && displayRequestedModel !== displayEffectiveModel)
  );
  return {
    sourceProtocolLabel,
    targetProviderLabel,
    isCrossRoute,
    displayRequestedModel,
    displayEffectiveModel,
    isAlias,
    showPipeline: isCrossRoute || isAlias
  };
}

export function buildProviderRows(status: ManagementStatus | null, metrics: ManagementMetrics | null): ProviderRow[] {
  return DASHBOARD_PROVIDERS.map((provider) => {
    const providerStatus = status?.providers?.[provider];
    const providerQueue = status?.queue?.[provider];
    return {
      key: provider,
      provider,
      total: providerStatus?.total || 0,
      active: providerStatus?.active || 0,
      statuses: providerStatus?.statuses || {},
      queue: providerQueue,
      requests: metrics?.providerCounts?.[provider] || 0,
      success: metrics?.providerSuccess?.[provider] || 0,
      failures: metrics?.providerFailures?.[provider] || 0
    };
  });
}

export function buildRouteRows(metrics: ManagementMetrics | null, limit = 8): RouteRow[] {
  return Object.entries(metrics?.routeCounts || {})
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .slice(0, limit)
    .map(([route, count]) => ({
      key: route,
      route,
      count: Number(count || 0)
    }));
}

/** 成功率阈值：无请求不评健康色；>=95% 健康，>=80% 告警，<80% 异常。 */
export function getSuccessTone(totalRequests: unknown, successRate: unknown): SuccessTone {
  if (Number(totalRequests || 0) === 0) return 'neutral';
  const rate = Number(successRate || 0);
  if (rate >= 0.95) return 'healthy';
  if (rate >= 0.8) return 'warning';
  return 'error';
}

/** 健康口径与账号页一致：分母为全部持久化账号，分子为 display-state=healthy。 */
export function getOverallHealth(options: {
  statusLoaded: boolean;
  accountsLoaded: boolean;
  total: number;
  healthy: number;
}): OverallHealth {
  const { statusLoaded, accountsLoaded, total, healthy } = options;
  if (!statusLoaded || !accountsLoaded) return 'loading';
  const degraded = Math.max(0, total - healthy);
  if (total > 0 && degraded === 0) return 'healthy';
  return healthy === 0 ? 'critical' : 'degraded';
}

export function getOverallHealthMeta(health: OverallHealth, degradedCount: number): { label: string; dot: 'idle' | 'ok' | 'warn' | 'crit' } {
  switch (health) {
    case 'healthy': return { label: '运行正常', dot: 'ok' };
    case 'degraded': return { label: `${degradedCount} 个账号降级`, dot: 'warn' };
    case 'critical': return { label: '无健康账号', dot: 'crit' };
    default: return { label: '连接中…', dot: 'idle' };
  }
}

export function sumRunningQueue(status: ManagementStatus | null) {
  return DASHBOARD_PROVIDERS.reduce((sum, p) => sum + normalizeQueueCount(status?.queue?.[p]?.running), 0);
}

export function buildRuntimeParams(status: ManagementStatus | null, uptimeSec: number | null): Array<[string, string | number]> {
  return [
    ['Backend', status?.backend || '-'],
    ['调度策略', status?.strategy || '-'],
    ['监听地址', status ? `${status.host}:${status.port}` : '-'],
    ['Provider 模式', status?.providerMode || '-'],
    ['API Key', status?.apiKeyConfigured ? '已配置' : '未配置'],
    ['Sticky Session', status?.sessionAffinity?.total || 0],
    ['缓存模型', status?.modelsCached || 0],
    ['运行时长', formatUptime(uptimeSec)]
  ];
}

export function buildChatJumpPath(options: { projectPath?: string; sessionId?: string }) {
  const params = new URLSearchParams();
  if (options.projectPath) params.set('projectPath', options.projectPath);
  if (options.sessionId) params.set('sessionId', options.sessionId);
  const search = params.toString();
  return search ? `/chat?${search}` : '/chat';
}
