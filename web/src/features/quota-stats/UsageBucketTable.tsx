import { useMemo } from 'react';
import type { ProColumns } from '@ant-design/pro-components';

import ListTable from '@/components/ui/ListTable';
import { formatCost, formatTokens } from '@/features/model-usage/model-usage-presentation';
import type { QuotaStatsGranularity, QuotaUsageBucket } from '@/types';
import { formatUsageBucketRange, getUsageBucketPeriodLabel } from './quota-stats-model';

interface UsageBucketTableProps {
  buckets: QuotaUsageBucket[];
  granularity: QuotaStatsGranularity;
  loading: boolean;
}

export default function UsageBucketTable({ buckets, granularity, loading }: UsageBucketTableProps) {
  const columns = useMemo<ProColumns<QuotaUsageBucket>[]>(() => [
    {
      title: getUsageBucketPeriodLabel(granularity),
      width: 180,
      render: (_value, row) => formatUsageBucketRange(row, granularity)
    },
    {
      title: 'Tokens',
      width: 130,
      render: (_value, row) => formatTokens(row.tokens)
    },
    {
      title: '成本',
      width: 120,
      render: (_value, row) => (row.costKnown ? formatCost(row.costUsd ?? 0) : '—')
    },
    {
      title: '请求',
      width: 90,
      render: (_value, row) => row.requestCount
    }
  ], [granularity]);

  // 最新在前：日/周明细通常先看最近一段。
  const rows = useMemo(() => buckets.slice().reverse(), [buckets]);

  return (
    <ListTable<QuotaUsageBucket>
      loading={loading && rows.length === 0}
      rowKey={(row) => String(row.index)}
      columns={columns}
      dataSource={rows}
      scroll={{ x: 520 }}
    />
  );
}
