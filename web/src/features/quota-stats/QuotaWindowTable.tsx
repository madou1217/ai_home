import { Tag, Tooltip } from 'antd';
import type { ProColumns } from '@ant-design/pro-components';

import ListTable from '@/components/ui/ListTable';
import { formatCost, formatTokens } from '@/features/model-usage/model-usage-presentation';
import type { QuotaStatsWindowRow } from '@/types';
import {
  formatQuotaClock,
  formatQuotaPct,
  formatQuotaWindowRange,
  formatWindowConsumed,
  getResetKindLabel,
  getWindowSourceMeta
} from './quota-stats-model';

interface QuotaWindowTableProps {
  windows: QuotaStatsWindowRow[];
  loading: boolean;
}

const SOURCE_TAG_COLORS: Record<string, string> = {
  live: 'green',
  high: 'cyan',
  medium: 'gold',
  low: 'default'
};

const columns: ProColumns<QuotaStatsWindowRow>[] = [
  {
    title: '#',
    width: 56,
    render: (_value, row) => row.index + 1
  },
  {
    title: '窗口',
    width: 230,
    render: (_value, row) => (
      <span className="quota-window-range">
        {formatQuotaWindowRange(row)}
        {row.truncated ? (
          <Tooltip title={`计划关窗 ${formatQuotaClock(row.scheduledCloseAtMs)}`}>
            <Tag color="orange" className="quota-window-tag">提前重置</Tag>
          </Tooltip>
        ) : null}
      </span>
    )
  },
  {
    title: '消耗',
    width: 100,
    render: (_value, row) => formatWindowConsumed(row)
  },
  {
    title: '峰值',
    width: 90,
    render: (_value, row) => formatQuotaPct(row.peakConsumedPct)
  },
  {
    title: 'Tokens',
    width: 110,
    render: (_value, row) => formatTokens(row.tokens)
  },
  {
    title: '成本',
    width: 110,
    render: (_value, row) => (row.costKnown ? formatCost(row.costUsd ?? 0) : '—')
  },
  {
    title: '请求',
    width: 80,
    render: (_value, row) => row.requestCount
  },
  {
    title: '样本',
    width: 80,
    render: (_value, row) => row.sampleCount
  },
  {
    title: '来源',
    width: 120,
    render: (_value, row) => {
      const meta = getWindowSourceMeta(row);
      return <Tag color={SOURCE_TAG_COLORS[meta.tone] || 'default'}>{meta.label}</Tag>;
    }
  },
  {
    title: '重置',
    width: 120,
    render: (_value, row) => getResetKindLabel(row) || '—'
  }
];

export default function QuotaWindowTable({ windows, loading }: QuotaWindowTableProps) {
  return (
    <ListTable<QuotaStatsWindowRow>
      loading={loading && windows.length === 0}
      rowKey={(row) => String(row.index)}
      columns={columns}
      dataSource={windows}
      scroll={{ x: 1100 }}
    />
  );
}
