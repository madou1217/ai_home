import type { ReactNode } from 'react';
import type { ProColumns } from '@ant-design/pro-components';
import { Tabs, Tag, Tooltip, Typography } from 'antd';
import dayjs from 'dayjs';
import { ReloadOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import ListTable from '@/components/ui/ListTable';
import SectionCard from '@/components/ui/SectionCard';
import type { ModelUsageRequestRow } from '@/types';
import {
  REQUEST_DETAIL_COLUMN_CONTRACTS,
  buildRequestTokenParts,
  formatBillingMode,
  formatReasoningEffort,
  formatRequestCost,
  formatRequestDuration,
  formatRequestType,
  formatTokens,
  type RequestDetailColumnKey
} from './request-details-presentation';
import './RequestDetailsSection.css';

const { Text } = Typography;

export interface RequestDetailsSectionProps {
  usage: ModelUsageRequestRow[];
  errors: ModelUsageRequestRow[];
  requested: boolean;
  loading: boolean;
  error: string;
  limit?: number;
  onRequest: () => void;
}

type RequestColumnConfig = Omit<ProColumns<ModelUsageRequestRow>, 'key' | 'title'>;

function renderEllipsisText(value: string, maxWidth: number, monospace = false): ReactNode {
  const label = String(value || '').trim() || '-';
  return (
    <Tooltip title={label === '-' ? undefined : label}>
      <Text
        className={monospace ? 'request-detail-mono' : undefined}
        ellipsis
        style={{ display: 'block', maxWidth }}
      >
        {label}
      </Text>
    </Tooltip>
  );
}

function renderTokenParts(row: ModelUsageRequestRow) {
  return (
    <div className="request-detail-token-cell">
      {buildRequestTokenParts(row).map((part) => (
        <span className="request-detail-token-part" key={part.key}>
          <span>{part.label}</span>
          <strong>{formatTokens(part.value)}</strong>
        </span>
      ))}
    </div>
  );
}

function renderErrorMessage(row: ModelUsageRequestRow) {
  const message = String(row.errorMessage || '').trim() || '-';
  return (
    <div className="request-detail-error-cell">
      <Tooltip title={message === '-' ? undefined : message}>
        <Text ellipsis className="request-detail-error-message">{message}</Text>
      </Tooltip>
      {row.errorCode ? <Text type="secondary">{row.errorCode}</Text> : null}
    </div>
  );
}

const REQUEST_COLUMN_CONFIG: Record<RequestDetailColumnKey, RequestColumnConfig> = {
  model: {
    dataIndex: 'model',
    width: 180,
    render: (_, row) => renderEllipsisText(row.model, 180)
  },
  reasoningEffort: {
    dataIndex: 'reasoningEffort',
    width: 100,
    render: (_, row) => formatReasoningEffort(row.reasoningEffort)
  },
  endpoint: {
    dataIndex: 'endpoint',
    width: 220,
    render: (_, row) => renderEllipsisText(row.endpoint, 220, true)
  },
  clientIp: {
    dataIndex: 'clientIp',
    width: 140,
    render: (_, row) => renderEllipsisText(row.clientIp, 140, true)
  },
  requestType: {
    dataIndex: 'requestType',
    width: 80,
    render: (_, row) => (
      <Tag color={row.requestType === 'stream' ? 'blue' : undefined}>
        {formatRequestType(row.requestType)}
      </Tag>
    )
  },
  billingMode: {
    dataIndex: 'billingMode',
    width: 100,
    render: (_, row) => <Tag color="geekblue">{formatBillingMode(row.billingMode)}</Tag>
  },
  tokens: {
    dataIndex: 'totalTokens',
    width: 260,
    render: (_, row) => renderTokenParts(row)
  },
  costUsd: {
    dataIndex: 'costUsd',
    width: 110,
    align: 'right',
    render: (_, row) => <Text className="request-detail-cost">{formatRequestCost(row.costUsd)}</Text>
  },
  durationMs: {
    dataIndex: 'durationMs',
    width: 100,
    align: 'right',
    render: (_, row) => formatRequestDuration(row.durationMs)
  },
  timestampMs: {
    dataIndex: 'timestampMs',
    width: 170,
    render: (_, row) => row.timestampMs ? dayjs(row.timestampMs).format('YYYY-MM-DD HH:mm:ss') : '-'
  },
  statusCode: {
    dataIndex: 'statusCode',
    width: 90,
    render: (_, row) => <Tag color="error">{row.statusCode || '-'}</Tag>
  },
  errorMessage: {
    dataIndex: 'errorMessage',
    width: 340,
    render: (_, row) => renderErrorMessage(row)
  }
};

function buildColumns(kind: keyof typeof REQUEST_DETAIL_COLUMN_CONTRACTS) {
  const contract = kind === 'usage'
    ? REQUEST_DETAIL_COLUMN_CONTRACTS.usage
    : REQUEST_DETAIL_COLUMN_CONTRACTS.errors;
  return contract.map(({ key, title }) => ({
    ...REQUEST_COLUMN_CONFIG[key],
    key,
    title
  }));
}

const usageColumns = buildColumns('usage');
const errorColumns = buildColumns('errors');

export default function RequestDetailsSection({
  usage,
  errors,
  requested,
  loading,
  error,
  limit = 80,
  onRequest
}: RequestDetailsSectionProps) {
  if (!requested) {
    return (
      <SectionCard
        className="request-details-section"
        title="请求明细"
        extra={(
          <Button icon={<ReloadOutlined />} onClick={onRequest}>
            加载最近 {limit} 条
          </Button>
        )}
      >
        <Text type="secondary">
          成功与错误请求仅在需要时读取，避免日志解析占用趋势与分量统计的首屏资源。
        </Text>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      className="request-details-section"
      title="请求明细"
      extra={(
        <Button icon={<ReloadOutlined />} loading={loading} onClick={onRequest}>
          刷新明细
        </Button>
      )}
    >
      {error ? (
        <Text className="request-detail-load-error" type="danger" role="status">
          请求明细加载失败：{error}
        </Text>
      ) : null}
      <Tabs
        items={[
          {
            key: 'usage',
            label: `用量明细 ${usage.length}`,
            children: (
              <ListTable<ModelUsageRequestRow>
                loading={loading && usage.length === 0}
                rowKey="requestId"
                columns={usageColumns}
                dataSource={usage}
                scroll={{ x: 1460 }}
              />
            )
          },
          {
            key: 'errors',
            label: `错误请求 ${errors.length}`,
            children: (
              <ListTable<ModelUsageRequestRow>
                loading={loading && errors.length === 0}
                rowKey="requestId"
                columns={errorColumns}
                dataSource={errors}
                scroll={{ x: 1370 }}
              />
            )
          }
        ]}
      />
    </SectionCard>
  );
}
