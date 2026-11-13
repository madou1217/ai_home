import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Drawer, Empty, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined } from '@ant-design/icons';
import type { Account, WebUiModelsResponse } from '@/types';
import { getAccountModelProbe } from '@/features/accounts/account-model-catalog';
import { routingAPI } from '@/services/api';
import type { RoutingWeightCandidate, RoutingWeightsResponse } from '@/services/api';

type RoutingWeightsDrawerProps = {
  open: boolean;
  onClose: () => void;
  accounts: Account[];
  modelCatalog: WebUiModelsResponse | null;
  /** 当前 Providers 页签；all 时取第一个有账号的 provider。 */
  defaultProvider?: string;
};

// 原因码 → 展示文案。只翻译已知的稳定码；未知码原样展示，避免悄悄丢信息。
const REASON_LABELS: Record<string, string> = {
  model_not_in_catalog: '模型目录不含',
  model_cooldown: '模型冷却',
  account_cooldown: '账号冷却',
  account_state_unavailable: '状态不可用',
  runtime_cooling_down: '冷却中',
  runtime_auth_invalid: '需重新登录',
  runtime_rate_limited: '限流中',
  runtime_overloaded: '上游过载',
  runtime_transient_network: '网络抖动',
  runtime_service_unavailable: '上游不可用',
  runtime_upstream_error: '上游错误',
  runtime_blocked: '运行态阻塞',
  routing_block_probe_in_flight: '探针占用',
  model_capacity_recovery_in_flight: '容量恢复中',
  quota_exhausted: '额度耗尽',
  usage_gate: '额度门禁',
  excluded_by_request: '本次请求排除'
};

function reasonLabel(reason: string) {
  if (!reason) return '可调度';
  if (REASON_LABELS[reason]) return REASON_LABELS[reason];
  if (reason.startsWith('runtime_')) return '运行态：' + reason.slice('runtime_'.length).replace(/_/g, ' ');
  return reason;
}

function formatPct(value: number | null) {
  return value == null || !Number.isFinite(Number(value)) ? '未知' : `${Math.round(Number(value))}%`;
}

function formatRate(rate: number, windowMs: number) {
  if (!rate) return '0';
  const seconds = Math.max(1, Math.round((Number(windowMs) || 60000) / 1000));
  return `${rate}/${seconds}s`;
}

export default function RoutingWeightsDrawer({
  open,
  onClose,
  accounts,
  modelCatalog,
  defaultProvider = 'all'
}: RoutingWeightsDrawerProps) {
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [data, setData] = useState<RoutingWeightsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // 选择切换很快时丢弃过期响应，避免旧请求覆盖新结果。
  const requestSeq = useRef(0);

  const providers = useMemo(() => {
    const seen = new Set<string>();
    for (const account of accounts) {
      const id = String(account.provider || '').trim();
      if (id) seen.add(id);
    }
    return [...seen].sort();
  }, [accounts]);

  const providerOptions = useMemo(
    () => providers.map((id) => ({ label: id, value: id })),
    [providers]
  );

  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const account of accounts) {
      if (String(account.provider || '') !== provider) continue;
      for (const id of getAccountModelProbe(account, modelCatalog).models) {
        const text = String(id || '').trim();
        if (text) seen.add(text);
      }
    }
    return [...seen].sort();
  }, [accounts, modelCatalog, provider]);
  const modelOptionsKey = modelOptions.join('\u0000');

  // 打开时还原到当前 Provider 页签；模型默认取该 Provider 的第一个已探测模型。
  useEffect(() => {
    if (!open) return;
    const preferred = providers.includes(defaultProvider) ? defaultProvider : (providers[0] || '');
    setProvider(preferred);
  }, [open, defaultProvider, providers]);

  useEffect(() => {
    if (!open) return;
    setModel((current) => (
      current && modelOptions.includes(current) ? current : (modelOptions[0] || '')
    ));
  }, [open, provider, modelOptionsKey]);

  const load = useCallback(async () => {
    if (!provider || !model) {
      setData(null);
      setError('');
      return;
    }
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    setLoading(true);
    try {
      const payload = await routingAPI.weights(provider, model);
      if (requestSeq.current !== seq) return;
      setData(payload);
      setError('');
    } catch (requestError: any) {
      if (requestSeq.current !== seq) return;
      setData(null);
      setError(requestError?.response?.data?.message || requestError?.message || '读取权重失败');
    } finally {
      if (requestSeq.current === seq) setLoading(false);
    }
  }, [provider, model]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, provider, model, load]);

  const columns: ColumnsType<RoutingWeightCandidate> = [
    {
      title: '账号',
      dataIndex: 'email',
      key: 'account',
      render: (_value: string, record) => (
        <div>
          <div>{record.email || record.accountRef}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.cliAccountId == null ? '' : `#${record.cliAccountId} · `}
            {record.accountRef.slice(-6)}
          </Typography.Text>
        </div>
      )
    },
    {
      title: '剩余额度',
      dataIndex: 'remainingPct',
      key: 'remainingPct',
      width: 96,
      render: (value: number | null) => formatPct(value)
    },
    {
      title: '并发 / 速率',
      key: 'pressure',
      width: 128,
      render: (_value, record) => (
        <div>
          <div>{record.inFlight}{record.modelInFlight > 0 ? `（本模型 ${record.modelInFlight}）` : ''}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatRate(record.rate, record.windowMs)}
          </Typography.Text>
        </div>
      )
    },
    {
      title: '权重',
      dataIndex: 'weight',
      key: 'weight',
      width: 88,
      align: 'right',
      render: (value: number, record) => (record.eligible ? Number(value).toFixed(1) : '—')
    },
    {
      title: '下次概率',
      dataIndex: 'probability',
      key: 'probability',
      width: 92,
      align: 'right',
      render: (value: number, record) => (record.eligible ? `${(Number(value) * 100).toFixed(1)}%` : '—')
    },
    {
      title: '状态',
      dataIndex: 'reason',
      key: 'reason',
      width: 128,
      render: (reason: string, record) => (
        record.eligible
          ? <Tag color="green">可调度</Tag>
          : <Tag>{reasonLabel(reason)}</Tag>
      )
    }
  ];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={760}
      title="路由权重"
      destroyOnClose
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space wrap>
          <Select
            value={provider || undefined}
            onChange={(value) => setProvider(value)}
            options={providerOptions}
            style={{ width: 168 }}
            placeholder="Provider"
          />
          <Select
            value={model || undefined}
            onChange={(value) => setModel(value)}
            options={modelOptions.map((id) => ({ label: id, value: id }))}
            style={{ width: 280 }}
            placeholder="模型"
            showSearch
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        </Space>

        {data ? (
          <Typography.Text type="secondary">
            策略 {data.strategy} · 可调度 {data.eligibleCount}/{data.totalCount} · 总权重 {data.totalWeight.toFixed(1)}
            {data.catalog === 'unchecked' ? ' · 模型索引未就绪，未按目录收窄' : ''}
          </Typography.Text>
        ) : null}

        {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}

        {provider && model ? (
          <Table<RoutingWeightCandidate>
            size="small"
            rowKey="accountRef"
            loading={loading}
            columns={columns}
            dataSource={data?.candidates || []}
            pagination={false}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有候选账号" /> }}
          />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择 Provider 和模型后查看" />
        )}

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          权重 = 剩余额度 / (1 + 并发压力)²；概率只表示下一次 random 策略请求的起点分布。
          会话亲和、默认账号偏好和固定账号会覆盖这个分布；round-robin 策略下权重不生效。
        </Typography.Text>
      </Space>
    </Drawer>
  );
}
