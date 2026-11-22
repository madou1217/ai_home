import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, InputNumber, Select, Space, Switch, Table, Tabs, Tag, message } from 'antd';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import type {
  FailureProvenanceEntry,
  FailureSemanticPolicy,
  FailureSemanticSignal
} from '@/types';
import { configAPI, failureSemanticsAPI } from '@/services/api';
import type { FailureSemanticsOverrides } from '@/services/api';

/**
 * 失败语义页：把「状态码/错误码 → 语义 → 动作/阈值/窗口/冷却」与「最近命中」
 * 放在同一处。配置写回 config:server 的 upstreamFailurePolicy，保存后服务端热生效。
 *
 * 页面约束：不使用大面积 Alert 提示块，也不用左侧彩色竖条表达状态；状态用
 * Tag、文本与表格列表达。
 */

type OverridePolicy = {
  threshold?: number;
  failure_window_ms?: number;
  default_cooldown_ms?: number;
};

type OverrideShape = FailureSemanticsOverrides;

const actionLabels: Record<string, string> = {
  model_cooldown: '模型冷却',
  no_state_change: '不改状态',
  credential_block: '凭据阻塞',
  quota_block: '额度阻塞',
  policy_block: '策略阻塞'
};

const scopeLabels: Record<string, string> = {
  account: '账号',
  account_model: '账号+模型'
};

const sourceLabels: Record<string, string> = {
  builtin_contract: '内置契约',
  global_override: '全局覆盖',
  account_rule: '账号规则'
};

function matcherText(signal: FailureSemanticSignal): string {
  const parts: string[] = [];
  if (signal.statuses && signal.statuses.length > 0) parts.push(`HTTP ${signal.statuses.join(',')}`);
  if (signal.status_min !== undefined || signal.status_max !== undefined) {
    parts.push(`HTTP ${signal.status_min ?? '-'}..${signal.status_max ?? '-'}`);
  }
  if (signal.error_type) parts.push(`type=${signal.error_type}`);
  if (signal.error_code) parts.push(`code=${signal.error_code}`);
  if (signal.error_type_or_code && signal.error_type_or_code.length > 0) {
    parts.push(signal.error_type_or_code.join('|'));
  }
  if (signal.retry_after_over_ms !== undefined) {
    parts.push(`Retry-After>${Math.round(signal.retry_after_over_ms / 1000)}s`);
  }
  if (signal.require_conditions && signal.require_conditions.length > 0) {
    parts.push(`条件 ${signal.require_conditions.join(',')}`);
  }
  return parts.join(' · ') || '—';
}

function signalEnabled(signal: FailureSemanticSignal, overrides: OverrideShape): boolean {
  if (signal.enabled === false) return false;
  if (signal.source === 'global_override') return true;
  const disable = overrides.disable || [];
  return !disable.includes(signal.id);
}

function formatTime(value?: number): string {
  if (!value || value <= 0) return '—';
  const date = new Date(value);
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function toServerFailurePolicy(overrides: OverrideShape) {
  return {
    version: 1,
    policies: overrides.policies,
    signals: overrides.signals as unknown as Array<Record<string, unknown>> | undefined,
    disable: overrides.disable
  };
}

const FailureSemantics: React.FC = () => {
  const [provider, setProvider] = useState('');
  const [tab, setTab] = useState('policies');
  const [policies, setPolicies] = useState<FailureSemanticPolicy[]>([]);
  const [signals, setSignals] = useState<FailureSemanticSignal[]>([]);
  const [overrides, setOverrides] = useState<OverrideShape>({});
  const [draft, setDraft] = useState<Record<string, FailureSemanticPolicy>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hits, setHits] = useState<FailureProvenanceEntry[]>([]);
  const [dropped, setDropped] = useState(0);
  const [hitsLoading, setHitsLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await failureSemanticsAPI.get(provider || undefined);
      setPolicies(data.policies || []);
      setSignals(data.signals || []);
      setOverrides(data.overrides || {});
      setDraft({});
    } catch {
      message.error('读取失败语义失败');
    } finally {
      setLoading(false);
    }
  }, [provider]);

  const loadHits = useCallback(async () => {
    setHitsLoading(true);
    try {
      const data = await failureSemanticsAPI.hits({ limit: 100, provider: provider || undefined });
      setHits(data.entries);
      setDropped(data.dropped);
    } catch {
      message.error('读取最近命中失败（server 未运行？）');
    } finally {
      setHitsLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tab === 'hits') void loadHits();
  }, [tab, loadHits]);

  const providerOptions = useMemo(() => {
    const set = new Set<string>();
    signals.forEach((signal) => {
      if (signal.provider && signal.provider !== 'all') set.add(signal.provider);
    });
    return [{ label: '全部 Provider', value: '' }, ...Array.from(set).sort().map((value) => ({ label: value, value }))];
  }, [signals]);

  const visibleSignals = useMemo(() => {
    if (!provider) return signals;
    return signals.filter((signal) => signal.provider === provider || signal.provider === 'all');
  }, [signals, provider]);

  const policyRows = useMemo(() => {
    if (!provider) return policies;
    const visible = new Set(visibleSignals.map((signal) => signal.semantic));
    return policies.filter((policy) => visible.has(policy.kind));
  }, [policies, provider, visibleSignals]);

  const updateDraft = (kind: string, patch: Partial<FailureSemanticPolicy>) => {
    const base = draft[kind] || policies.find((policy) => policy.kind === kind);
    if (!base) return;
    setDraft({ ...draft, [kind]: { ...base, ...patch } });
  };

  const savePolicies = async () => {
    const nextPolicies: Record<string, OverridePolicy> = { ...(overrides.policies || {}) };
    Object.entries(draft).forEach(([kind, row]) => {
      const before = policies.find((policy) => policy.kind === kind);
      const patch: OverridePolicy = { ...(nextPolicies[kind] || {}) };
      if (row.threshold !== undefined && row.threshold !== before?.threshold) patch.threshold = row.threshold;
      if (row.failure_window_ms !== undefined && row.failure_window_ms !== before?.failure_window_ms) {
        patch.failure_window_ms = row.failure_window_ms;
      }
      if (row.default_cooldown_ms !== undefined && row.default_cooldown_ms !== before?.default_cooldown_ms) {
        patch.default_cooldown_ms = row.default_cooldown_ms;
      }
      if (Object.keys(patch).length > 0) nextPolicies[kind] = patch;
    });
    setSaving(true);
    try {
      const next: OverrideShape = { ...overrides, policies: nextPolicies };
      await configAPI.updateServer({
        upstreamFailurePolicy: toServerFailurePolicy(next)
      });
      message.success('已保存，热生效');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? `保存失败：${error.message}` : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const toggleSignal = async (signal: FailureSemanticSignal, enabled: boolean) => {
    const next: OverrideShape = {
      ...overrides,
      policies: { ...(overrides.policies || {}) },
      signals: [...(overrides.signals || [])],
      disable: [...(overrides.disable || [])]
    };
    if (signal.source === 'global_override') {
      next.signals = (next.signals || []).map((entry) =>
        entry.id === signal.id ? { ...entry, enabled } : entry
      );
    } else if (enabled) {
      next.disable = (next.disable || []).filter((id) => id !== signal.id);
    } else if (!(next.disable || []).includes(signal.id)) {
      next.disable = [...(next.disable || []), signal.id];
    }
    setSaving(true);
    try {
      await configAPI.updateServer({ upstreamFailurePolicy: toServerFailurePolicy(next) });
      message.success(enabled ? '已启用' : '已停用');
      await load();
    } catch {
      message.error('保存失败');
    } finally {
      setSaving(false);
    }
  };

  const policyColumns = [
    {
      title: '语义',
      dataIndex: 'kind',
      render: (value: string) => <span className="aih-mono">{value}</span>
    },
    {
      title: '动作',
      dataIndex: 'action',
      render: (value: string) => <Tag>{actionLabels[value] || value}</Tag>
    },
    {
      title: '阈值',
      dataIndex: 'threshold',
      width: 110,
      render: (value: number | undefined, row: FailureSemanticPolicy) => {
        if (row.action !== 'model_cooldown') return <span className="aih-muted">—</span>;
        return (
          <InputNumber
            min={1}
            max={10}
            size="small"
            value={draft[row.kind]?.threshold ?? value}
            onChange={(next) => updateDraft(row.kind, { threshold: next ?? undefined })}
          />
        );
      }
    },
    {
      title: '窗口 (ms)',
      dataIndex: 'failure_window_ms',
      width: 140,
      render: (value: number | undefined, row: FailureSemanticPolicy) => {
        if (row.action !== 'model_cooldown') return <span className="aih-muted">—</span>;
        return (
          <InputNumber
            min={0}
            step={1000}
            size="small"
            value={draft[row.kind]?.failure_window_ms ?? value}
            onChange={(next) => updateDraft(row.kind, { failure_window_ms: next ?? undefined })}
          />
        );
      }
    },
    {
      title: '冷却 (ms)',
      dataIndex: 'default_cooldown_ms',
      width: 140,
      render: (value: number | undefined, row: FailureSemanticPolicy) => {
        if (row.action !== 'model_cooldown') return <span className="aih-muted">—</span>;
        return (
          <InputNumber
            min={1000}
            step={1000}
            size="small"
            value={draft[row.kind]?.default_cooldown_ms ?? value}
            onChange={(next) => updateDraft(row.kind, { default_cooldown_ms: next ?? undefined })}
          />
        );
      }
    },
    {
      title: '阻塞范围',
      dataIndex: 'block_scopes',
      render: (value: string[] | undefined) =>
        value && value.length > 0 ? value.map((scope) => <Tag key={scope}>{scopeLabels[scope] || scope}</Tag>) : <span className="aih-muted">—</span>
    },
    {
      title: '来源',
      key: 'source',
      render: (_: unknown, row: FailureSemanticPolicy) =>
        overrides.policies && overrides.policies[row.kind] ? <Tag color="blue">全局覆盖</Tag> : <span className="aih-muted">内置契约</span>
    }
  ];

  const signalColumns = [
    {
      title: 'Provider',
      dataIndex: 'provider',
      width: 110,
      render: (value: string) => <span className="aih-mono">{value}</span>
    },
    {
      title: '匹配',
      key: 'matcher',
      render: (_: unknown, row: FailureSemanticSignal) => <span className="aih-mono">{matcherText(row)}</span>
    },
    {
      title: '语义',
      dataIndex: 'semantic',
      render: (value: string) => <span className="aih-mono">{value}</span>
    },
    {
      title: '范围',
      dataIndex: 'block_scope',
      width: 110,
      render: (value: string | undefined) =>
        value ? <Tag>{scopeLabels[value] || value}</Tag> : <span className="aih-muted">—</span>
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 120,
      render: (value: string | undefined) => <span className="aih-muted">{sourceLabels[value || 'builtin_contract'] || value}</span>
    },
    {
      title: '启用',
      key: 'enabled',
      width: 90,
      render: (_: unknown, row: FailureSemanticSignal) => (
        <Switch
          size="small"
          loading={saving}
          checked={signalEnabled(row, overrides)}
          onChange={(next) => void toggleSignal(row, next)}
        />
      )
    }
  ];

  const hitColumns = [
    {
      title: '时间',
      dataIndex: 'atMs',
      width: 130,
      render: (value: number) => <span className="aih-mono">{formatTime(value)}</span>
    },
    {
      title: '账号',
      dataIndex: 'accountRef',
      render: (value: string) => <span className="aih-mono">{value}</span>
    },
    { title: '模型', dataIndex: 'model' },
    {
      title: 'HTTP',
      dataIndex: 'httpStatus',
      width: 80,
      render: (value: number | undefined) => (value ? <Tags status={value} /> : <span className="aih-muted">—</span>)
    },
    {
      title: '语义',
      dataIndex: 'semantic',
      render: (value: string) => <span className="aih-mono">{value}</span>
    },
    {
      title: '动作',
      dataIndex: 'action',
      render: (value: string) => <Tag>{actionLabels[value] || value}</Tag>
    },
    {
      title: '来源 : 信号',
      key: 'source',
      render: (_: unknown, row: FailureProvenanceEntry) => (
        <span className="aih-mono aih-muted">
          {sourceLabels[row.source] || row.source || '—'}
          {row.signalId ? ` : ${row.signalId}` : ''}
        </span>
      )
    },
    {
      title: '冷却至',
      dataIndex: 'cooldownUntilMs',
      width: 130,
      render: (value: number | undefined) => <span className="aih-mono aih-muted">{formatTime(value)}</span>
    }
  ];

  return (
    <div className="failure-semantics-panel">
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          style={{ minWidth: 180 }}
          value={provider}
          options={providerOptions}
          onChange={setProvider}
          placeholder="Provider"
        />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          刷新
        </Button>
        <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void savePolicies()}>
          保存语义参数
        </Button>
        <span className="aih-muted">账号级规则优先于这里的全局覆盖；保存后无需重启。</span>
      </Space>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'policies',
            label: '语义与策略',
            children: (
              <Table
                size="small"
                rowKey="kind"
                loading={loading}
                pagination={false}
                dataSource={policyRows}
                columns={policyColumns}
              />
            )
          },
          {
            key: 'signals',
            label: '信号表',
            children: (
              <Table
                size="small"
                rowKey="id"
                loading={loading}
                pagination={false}
                dataSource={visibleSignals}
                columns={signalColumns}
              />
            )
          },
          {
            key: 'hits',
            label: '最近命中',
            children: (
              <>
                <Space style={{ marginBottom: 8 }}>
                  <Button icon={<ReloadOutlined />} loading={hitsLoading} onClick={() => void loadHits()}>
                    刷新命中
                  </Button>
                  <span className="aih-muted">缓冲区丢弃 {dropped} 条</span>
                </Space>
                <Table
                  size="small"
                  rowKey={(row) => `${row.atMs}-${row.accountRef}-${row.model}-${row.signalId}`}
                  loading={hitsLoading}
                  pagination={{ pageSize: 20 }}
                  dataSource={hits}
                  columns={hitColumns}
                />
              </>
            )
          }
        ]}
      />
    </div>
  );
};

const Tags: React.FC<{ status: number }> = ({ status }) => (
  <Tag color={status >= 500 ? 'red' : status === 429 ? 'orange' : 'default'}>{status}</Tag>
);

export default FailureSemantics;