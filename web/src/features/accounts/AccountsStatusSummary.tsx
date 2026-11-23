import { StatisticCard } from '@ant-design/pro-components';
import AnimatedValue from '@/components/ui/AnimatedValue';
import type { ProviderStats } from './account-view-model';

export interface AccountsStatusSummaryProps {
  hydratingDetails: boolean;
  stats: ProviderStats;
  pendingIssueCount: number;
  unavailableCount: number;
}

/**
 * 账号页首屏状态摘要：保留真实计数，但不让装饰性健康图占据列表上方的首屏。
 * 具体账号状态仍以列表/卡片中的显式标签为准。
 */
export default function AccountsStatusSummary({
  hydratingDetails,
  stats,
  pendingIssueCount,
  unavailableCount
}: AccountsStatusSummaryProps) {
  return (
    <StatisticCard.Group className="accounts-stat-group hos-kpi-strip" direction="row" style={{ marginBottom: 16 }}>
      <StatisticCard
        className={hydratingDetails ? 'accounts-stat--accent' : 'accounts-stat--success'}
        statistic={{
          title: '账号状态',
          value: hydratingDetails ? '详情补全中' : '就绪',
          status: hydratingDetails ? 'processing' : 'success'
        }}
      />
      <StatisticCard
        className={stats.healthy > 0 ? 'accounts-stat--success' : 'accounts-stat--accent'}
        statistic={{
          title: '正常可用',
          value: `${stats.healthy} / ${stats.total}`,
          valueRender: (node) => <AnimatedValue changeKey={`${stats.healthy}/${stats.total}`}>{node}</AnimatedValue>
        }}
      />
      <StatisticCard
        className={pendingIssueCount > 0 ? 'accounts-stat--warning' : 'accounts-stat--accent'}
        statistic={{
          title: '待处理问题',
          value: pendingIssueCount,
          valueRender: (node) => <AnimatedValue changeKey={pendingIssueCount}>{node}</AnimatedValue>,
          description: `需登录 ${stats.reauthRequired} · 阻塞 ${stats.runtimeBlocked}`,
          valueStyle: {
            color: pendingIssueCount > 0 ? 'var(--color-warning)' : undefined
          }
        }}
      />
      <StatisticCard
        className={unavailableCount > 0 ? 'accounts-stat--danger' : 'accounts-stat--accent'}
        statistic={{
          title: '耗尽/停用',
          value: unavailableCount,
          valueRender: (node) => <AnimatedValue changeKey={unavailableCount}>{node}</AnimatedValue>,
          description: `耗尽 ${stats.exhausted} · 停池 ${stats.policyBlocked}`,
          valueStyle: {
            color: unavailableCount > 0 ? 'var(--color-danger)' : undefined
          }
        }}
      />
    </StatisticCard.Group>
  );
}