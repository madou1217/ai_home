import { Drawer, Empty, Space, Spin, Tabs, Tooltip, Typography, message } from 'antd';
import type { ProColumns } from '@ant-design/pro-components';
import { CopyOutlined, QuestionCircleOutlined } from '@ant-design/icons';

import ProviderIcon, { providerNames } from '@/components/chat/ProviderIcon';
import ListTable from '@/components/ui/ListTable';
import Button from '@/components/ui/AppButton';
import type {
  Account,
  ModelUsageAccountRow,
  ModelUsageBreakdownResponse,
  ModelUsageModelRow,
  ModelUsageSessionRow,
  Provider
} from '@/types';
import {
  formatAccountScope,
  formatCacheRate,
  formatCost,
  formatTokens,
  getCacheTokens
} from './model-usage-presentation';

const { Text } = Typography;

export type UsageBreakdownTarget =
  | { kind: 'model'; row: ModelUsageModelRow }
  | { kind: 'session'; row: ModelUsageSessionRow };

interface UsageBreakdownDrawerProps {
  target: UsageBreakdownTarget | null;
  data: ModelUsageBreakdownResponse | null;
  loading: boolean;
  isMobile: boolean;
  accountsByRef: Map<string, Account>;
  onClose: () => void;
}

function shortAccountRef(accountRef: string) {
  return accountRef.length > 13 ? `${accountRef.slice(0, 9)}…${accountRef.slice(-4)}` : accountRef;
}

function renderProvider(provider: Provider | '') {
  if (!provider) return null;
  return <ProviderIcon provider={provider} size={16} />;
}

export default function UsageBreakdownDrawer({
  target,
  data,
  loading,
  isMobile,
  accountsByRef,
  onClose
}: UsageBreakdownDrawerProps) {
  const summary = data?.summary;
  const title = target?.kind === 'model'
    ? `模型分量 · ${providerNames[target.row.provider] || target.row.provider} · ${target.row.model || '未知模型'}`
    : target?.kind === 'session'
      ? `会话分量 · ${target.row.project || target.row.sessionId}`
      : '用量分量';

  const copySessionId = async () => {
    if (!target || target.kind !== 'session') return;
    try {
      await navigator.clipboard.writeText(target.row.sessionId);
      message.success('会话 ID 已复制');
    } catch {
      message.error('复制失败');
    }
  };

  const accountColumns: ProColumns<ModelUsageAccountRow>[] = [
    {
      title: '账号',
      key: 'account',
      width: 250,
      render: (_, row) => {
        if (!row.accountRef) {
          return (
            <Space size={7}>
              <QuestionCircleOutlined />
              <span>未归属</span>
              <Tooltip title="历史或非 AIH 管理会话缺少可审计账号证据，因此不做猜测。">
                <Text type="secondary">为什么？</Text>
              </Tooltip>
            </Space>
          );
        }
        const account = accountsByRef.get(row.accountRef);
        const provider = account?.provider || row.accountProvider;
        const label = account?.displayName || account?.email || `账号 ${shortAccountRef(row.accountRef)}`;
        return (
          <div className="usage-account-identity">
            <span className="usage-account-provider">{renderProvider(provider)}</span>
            <span>
              <strong>{label}</strong>
              <small>{shortAccountRef(row.accountRef)}</small>
            </span>
          </div>
        );
      }
    },
    {
      title: '模型',
      key: 'models',
      width: 180,
      ellipsis: true,
      render: (_, row) => row.models.map((model) => model.model).filter(Boolean).join(' · ') || '-'
    },
    { title: '调用', dataIndex: 'calls', width: 78, align: 'right' },
    {
      title: 'Input',
      dataIndex: 'inputTokens',
      width: 96,
      align: 'right',
      render: (value) => formatTokens(Number(value))
    },
    {
      title: 'Output',
      dataIndex: 'outputTokens',
      width: 96,
      align: 'right',
      render: (value) => formatTokens(Number(value))
    },
    {
      title: 'Cache',
      key: 'cache',
      width: 96,
      align: 'right',
      render: (_, row) => (
        <Tooltip title={`读取 ${formatTokens(row.cacheReadInputTokens)} · 写入 ${formatTokens(row.cacheCreationInputTokens)}`}>
          <span>{formatTokens(getCacheTokens(row))}</span>
        </Tooltip>
      )
    },
    {
      title: '缓存率',
      dataIndex: 'cacheHitRate',
      width: 92,
      align: 'right',
      render: (value) => formatCacheRate(value as number | null)
    },
    {
      title: 'Tokens',
      dataIndex: 'totalTokens',
      width: 100,
      align: 'right',
      render: (value) => formatTokens(Number(value))
    },
    {
      title: '成本',
      dataIndex: 'costUsd',
      width: 100,
      align: 'right',
      render: (value) => formatCost(Number(value))
    }
  ];

  const modelColumns: ProColumns<ModelUsageModelRow>[] = [
    {
      title: 'Provider',
      dataIndex: 'provider',
      width: 130,
      render: (value) => {
        const provider = value as Provider;
        return (
          <Space size={6}>
            <ProviderIcon provider={provider} size={14} />
            <span>{providerNames[provider] || provider}</span>
          </Space>
        );
      }
    },
    { title: '模型', dataIndex: 'model', ellipsis: true, render: (value) => value || '-' },
    { title: '调用', dataIndex: 'calls', width: 78, align: 'right' },
    {
      title: 'Input',
      dataIndex: 'inputTokens',
      width: 96,
      align: 'right',
      render: (value) => formatTokens(Number(value))
    },
    {
      title: 'Output',
      dataIndex: 'outputTokens',
      width: 96,
      align: 'right',
      render: (value) => formatTokens(Number(value))
    },
    {
      title: 'Cache',
      key: 'cache',
      width: 96,
      align: 'right',
      render: (_, row) => formatTokens(getCacheTokens(row))
    },
    {
      title: '缓存率',
      dataIndex: 'cacheHitRate',
      width: 92,
      align: 'right',
      render: (value) => formatCacheRate(value as number | null)
    },
    {
      title: 'Tokens',
      dataIndex: 'totalTokens',
      width: 100,
      align: 'right',
      render: (value) => formatTokens(Number(value))
    },
    {
      title: '成本',
      dataIndex: 'costUsd',
      width: 100,
      align: 'right',
      render: (value) => formatCost(Number(value))
    }
  ];

  return (
    <Drawer
      title={title}
      open={Boolean(target)}
      onClose={onClose}
      width={isMobile ? '100%' : 1040}
      destroyOnClose
    >
      {target?.kind === 'session' ? (
        <div className="usage-breakdown-context">
          <Text code>{target.row.sessionId}</Text>
          <Button type="text" size="small" icon={<CopyOutlined />} onClick={copySessionId}>
            复制
          </Button>
          {target.row.cwd ? <Text type="secondary">{target.row.cwd}</Text> : null}
        </div>
      ) : null}

      {loading ? (
        <div className="usage-breakdown-loading"><Spin /></div>
      ) : data && summary ? (
        <>
          <div className="usage-breakdown-summary">
            <div><span>账号范围</span><strong>{formatAccountScope(summary.accountCount, summary.unattributedCalls)}</strong></div>
            <div><span>总 Tokens</span><strong>{formatTokens(summary.totalTokens)}</strong></div>
            <div><span>Input</span><strong>{formatTokens(summary.inputTokens)}</strong></div>
            <div><span>Output</span><strong>{formatTokens(summary.outputTokens)}</strong></div>
            <div><span>Cache</span><strong>{formatTokens(getCacheTokens(summary))}</strong></div>
            <div><span>缓存率</span><strong>{formatCacheRate(summary.cacheHitRate)}</strong></div>
            <div><span>成本</span><strong>{formatCost(summary.costUsd)}</strong></div>
          </div>
          <Tabs
            items={[
              {
                key: 'accounts',
                label: `账号分量 (${data.accounts.length})`,
                children: data.accounts.length > 0 ? (
                  <ListTable<ModelUsageAccountRow>
                    rowKey={(row) => row.accountRef || '__unattributed__'}
                    columns={accountColumns}
                    dataSource={data.accounts}
                    scroll={{ x: 1090 }}
                  />
                ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无账号分量" />
              },
              {
                key: 'models',
                label: `模型分量 (${data.models.length})`,
                children: data.models.length > 0 ? (
                  <ListTable<ModelUsageModelRow>
                    rowKey={(row) => `${row.provider}:${row.model}`}
                    columns={modelColumns}
                    dataSource={data.models}
                    scroll={{ x: 960 }}
                  />
                ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无模型分量" />
              }
            ]}
          />
        </>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无分量数据" />
      )}
    </Drawer>
  );
}
