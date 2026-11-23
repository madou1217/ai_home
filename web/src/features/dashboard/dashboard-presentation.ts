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

export type ProviderHealthBucket = 'attention' | 'healthy' | 'inactive';

export interface ProviderRowGroups {
  attention: ProviderRow[];
  healthy: ProviderRow[];
  inactive: ProviderRow[];
}

export interface DashboardNextAction {
  kind: 'accounts' | 'clear_cooldown' | 'none';
  summary: string;
  actionLabel?: string;
}

export function classifyProviderRow(row: ProviderRow): ProviderHealthBucket {
  if (row.total <= 0) return 'inactive';
  if (row.active < row.total || row.failures > 0) return 'attention';
  return 'healthy';
}

export function groupProviderRows(rows: ProviderRow[]): ProviderRowGroups {
  const groups: ProviderRowGroups = { attention: [], healthy: [], inactive: [] };
  for (const row of rows) {
    groups[classifyProviderRow(row)].push(row);
  }
  groups.attention.sort((a, b) => {
    const aDegraded = Math.max(0, a.total - a.active);
    const bDegraded = Math.max(0, b.total - b.active);
    if (bDegraded !== aDegraded) return bDegraded - aDegraded;
    return b.failures - a.failures;
  });
  groups.healthy.sort((a, b) => b.requests - a.requests || b.total - a.total);
  return groups;
}

export function resolveDashboardNextAction(input: {
  overallHealth: OverallHealth;
  totalAccounts: number;
  degradedCount: number;
  cooldownAccounts: number;
  attentionProviders: ProviderRow[];
}): DashboardNextAction {
  if (input.overallHealth === 'loading') {
    return { kind: 'none', summary: '正在拉取网关与账号运行态。' };
  }
  if (input.totalAccounts === 0) {
    return {
      kind: 'accounts',
      summary: '尚未接入可用账号，先添加账号即可开始调度。',
      actionLabel: '去添加账号'
    };
  }
  if (input.cooldownAccounts > 0) {
    return {
      kind: 'clear_cooldown',
      summary: `${input.cooldownAccounts} 个账号在冷却中被临时摘除，可尝试清空冷却恢复。`,
      actionLabel: '清空冷却'
    };
  }
  if (input.degradedCount > 0) {
    const names = input.attentionProviders
      .slice(0, 3)
      .map((row) => getProviderDisplayName(row.provider))
      .join('、');
    return {
      kind: 'accounts',
      summary: names
        ? `${names} 存在异常账号，建议检查授权与配额。`
        : `${input.degradedCount} 个账号处于降级态，建议检查账号状态。`,
      actionLabel: '查看账号'
    };
  }
  return { kind: 'none', summary: '网关与已接入 Provider 运行正常，无需干预。' };
}

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
