import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { InputNumber, Select, Space, Switch, Table, Tabs, Tag, message } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  PauseCircleOutlined,
  ReloadOutlined,
  StopOutlined
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type {
  FailureProvenanceEntry,
  FailureSemanticPolicy,
  FailureSemanticSignal
} from '@/types';
import { configAPI, failureSemanticsAPI } from '@/services/api';
import type { FailureSemanticsOverrides } from '@/services/api';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import SaveActionBar from '@/components/ui/SaveActionBar';
import { SettingRow, SettingSection } from '@/components/ui/SettingSection';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import HudStateView from '@/components/hud/HudStateView';

/**
 * 失败语义页：把「状态码/错误码 → 语义 → 动作/阈值/窗口/冷却」与「最近命中」
 * 放在同一处。配置写回 config:server 的 upstreamFailurePolicy，保存后服务端热生效。
 */

type OverridePolicy = {
  threshold?: number;
  failure_window_ms?: number;
  default_cooldown_ms?: number;
};

type OverrideShape = FailureSemanticsOverrides;

type InlineFeedback = {
  tone: 'success' | 'error';
  text: string;
};

const ACTION_META: Record<string, { label: string; icon: React.ReactNode }> = {
  model_cooldown: { label: '模型冷却', icon: <PauseCircleOutlined /> },
  no_state_change: { label: '不改状态', icon: <CheckCircleOutlined /> },
  credential_block: { label: '凭据阻塞', icon: <CloseCircleOutlined /> },
  quota_block: { label: '额度阻塞', icon: <ExclamationCircleOutlined /> },
  policy_block: { label: '策略阻塞', icon: <StopOutlined /> }
};

const SEMANTIC_DESCRIPTIONS: Record<string, { label: string; desc: string }> = {
  rate_limit: { label: '触发限流', desc: '上游返回速率限制，按冷却策略暂避' },
  quota_exhausted: { label: '额度耗尽', desc: '账号余额或配额不足，触发额度阻塞' },
  auth_invalid: { label: '认证失效', desc: '凭据过期、吊销或鉴权失败' },
  permission_denied: { label: '权限不足', desc: '账号无权访问目标模型或接口' },
  policy_violation: { label: '策略拦截', desc: '请求或账号触发风控与合规限制' },
  model_unavailable: { label: '模型不可用', desc: '上游模型下线、未开通或暂时不可达' },
  server_error: { label: '服务端异常', desc: '上游 5xx 或网关临时故障' },
  transient_error: { label: '瞬时故障', desc: '短暂网络抖动或上游过载' },
  bad_request: { label: '请求无效', desc: '调用参数错误，不修改账号健康状态' }
};

const SCOPE_LABELS: Record<string, string> = {
  account: '账号',
  account_model: '账号+模型'
};

const SOURCE_LABELS: Record<string, string> = {
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

function renderActionTag(action: string) {
  const meta = ACTION_META[action];
  if (!meta) return <Tag>{action}</Tag>;
  return <Tag icon={meta.icon}>{meta.label}</Tag>;
}

const HttpStatusTag: React.FC<{ status: number }> = ({ status }) => {
  const label = status >= 500
    ? `5xx · ${status}`
    : status === 429
      ? `限流 · ${status}`
      : String(status);
  return (
    <Tag color={status >= 500 ? 'red' : status === 429 ? 'orange' : 'default'}>
      {label}
    </Tag>
  );
};

interface PolicyTableSectionProps {
  policyRows: FailureSemanticPolicy[];
  overrides: OverrideShape;
  draft: Record<string, FailureSemanticPolicy>;
  dirtyCount: number;
  loading: boolean;
  saving: boolean;
  loadError: string;
  feedback: InlineFeedback | null;
  onUpdateDraft: (kind: string, patch: Partial<FailureSemanticPolicy>) => void;
  onSave: () => void;
  onReset: () => void;
  onReload: () => void;
}

const PolicyTableSection: React.FC<PolicyTableSectionProps> = ({
  policyRows,
  overrides,
  draft,
  dirtyCount,
  loading,
  saving,
  loadError,
  feedback,
  onUpdateDraft,
  onSave,
  onReset,
  onReload
}) => {
  const columns = useMemo<ColumnsType<FailureSemanticPolicy>>(() => [
    {
      title: '语义',
      dataIndex: 'kind',
      width: 220,
      render: (value: string) => {
        const meta = SEMANTIC_DESCRIPTIONS[value];
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="aih-mono">{meta ? `${meta.label} (${value})` : value}</span>
            {meta ? <span className="aih-muted" style={{ fontSize: 12 }}>{meta.desc}</span> : null}
          </div>
        );
      }
    },
    {
      title: '动作',
      dataIndex: 'action',
      width: 130,
      render: (value: string) => renderActionTag(value)
    },
    {
      title: '阈值',
      dataIndex: 'threshold',
      width: 110,
      render: (value: number | undefined, row: FailureSemanticPolicy) => {
        if (row.action !== 'model_cooldown') return <span className="aih-muted">—</span>;
        return (
          <InputNumber
            aria-label={`${row.kind} 阈值`}
            min={1}
            max={10}
            size="small"
            value={draft[row.kind]?.threshold ?? value}
            onChange={(next) => onUpdateDraft(row.kind, { threshold: next ?? undefined })}
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
            aria-label={`${row.kind} 统计窗口`}
            min={0}
            step={1000}
            size="small"
            value={draft[row.kind]?.failure_window_ms ?? value}
            onChange={(next) => onUpdateDraft(row.kind, { failure_window_ms: next ?? undefined })}
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
            aria-label={`${row.kind} 默认冷却`}
            min={1000}
            step={1000}
            size="small"
            value={draft[row.kind]?.default_cooldown_ms ?? value}
            onChange={(next) => onUpdateDraft(row.kind, { default_cooldown_ms: next ?? undefined })}
          />
        );
      }
    },
    {
      title: '阻塞范围',
      dataIndex: 'block_scopes',
      width: 140,
      render: (value: string[] | undefined) =>
        value && value.length > 0
          ? value.map((scope) => <Tag key={scope}>{SCOPE_LABELS[scope] || scope}</Tag>)
          : <span className="aih-muted">—</span>
    },
    {
      title: '来源',
      key: 'source',
      width: 110,
      render: (_: unknown, row: FailureSemanticPolicy) => (
        overrides.policies && overrides.policies[row.kind]
          ? <SettingStatusTag status="applied" label="全局覆盖" compact />
          : <SettingStatusTag status="unset" label="内置契约" compact />
      )
    }
  ], [draft, onUpdateDraft, overrides.policies]);

  const sectionStatus = saving
    ? <SettingStatusTag status="saving" compact />
    : feedback?.tone === 'error'
      ? <SettingStatusTag status="error" compact />
      : dirtyCount > 0
        ? <SettingStatusTag status="dirty" label={`未保存 ${dirtyCount} 项`} compact />
        : <SettingStatusTag status="saved" label="已同步" compact />;

  return (
    <SettingSection
      title="语义与策略参数"
      description="仅「模型冷却」类语义支持覆盖阈值、统计窗口与默认冷却；账号级规则优先级高于全局覆盖。"
      status={sectionStatus}
      footer={(
        <SaveActionBar
          dirty={dirtyCount > 0}
          saving={saving}
          onSave={onSave}
          onReset={onReset}
          saveLabel="保存语义参数"
          cleanSaveLabel="已同步"
          effectSummary="保存后热生效，无需重启服务"
          feedback={feedback?.text}
          feedbackTone={feedback?.tone === 'error' ? 'error' : feedback?.tone === 'success' ? 'success' : 'muted'}
        />
      )}
    >
      {loadError ? (
        <div style={{ padding: '12px 18px 0' }}>
          <InlineNote
            tone="error"
            action={<Button size="small" type="link" onClick={onReload}>重试</Button>}
          >
            {loadError}
          </InlineNote>
        </div>
      ) : null}
      <div style={{ padding: '12px 18px', overflowX: 'auto' }}>
        <Table
          size="small"
          rowKey="kind"
          loading={loading}
          pagination={false}
          scroll={{ x: 'max-content' }}
          dataSource={policyRows}
          columns={columns}
          locale={{
            emptyText: <HudStateView compact code="NO_POLICIES" title="当前筛选下无语义策略" />
          }}
        />
      </div>
    </SettingSection>
  );
};

interface SignalTableSectionProps {
  signals: FailureSemanticSignal[];
  overrides: OverrideShape;
  loading: boolean;
  saving: boolean;
  feedback: InlineFeedback | null;
  onToggle: (signal: FailureSemanticSignal, enabled: boolean) => void;
}

const SignalTableSection: React.FC<SignalTableSectionProps> = ({
  signals,
  overrides,
  loading,
  saving,
  feedback,
  onToggle
}) => {
  const columns = useMemo<ColumnsType<FailureSemanticSignal>>(() => [
    {
      title: 'Provider',
      dataIndex: 'provider',
      width: 110,
      render: (value: string) => <span className="aih-mono">{value}</span>
    },
    {
      title: '匹配条件',
      key: 'matcher',
      render: (_: unknown, row: FailureSemanticSignal) => <span className="aih-mono">{matcherText(row)}</span>
    },
    {
      title: '映射语义',
      dataIndex: 'semantic',
      width: 180,
      render: (value: string) => <span className="aih-mono">{value}</span>
    },
    {
      title: '范围',
      dataIndex: 'block_scope',
      width: 110,
      render: (value: string | undefined) =>
        value ? <Tag>{SCOPE_LABELS[value] || value}</Tag> : <span className="aih-muted">—</span>
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 110,
      render: (value: string | undefined) => (
        <span className="aih-muted">{SOURCE_LABELS[value || 'builtin_contract'] || value}</span>
      )
    },
    {
      title: '状态',
      key: 'enabled',
      width: 120,
      render: (_: unknown, row: FailureSemanticSignal) => {
        const checked = signalEnabled(row, overrides);
        return (
          <Switch
            size="small"
            loading={saving}
            checked={checked}
            checkedChildren="启用"
            unCheckedChildren="停用"
            onChange={(next) => onToggle(row, next)}
          />
        );
      }
    }
  ], [onToggle, overrides, saving]);

  return (
    <SettingSection
      title="信号匹配表"
      description="按状态码、错误类型与错误码归类失败信号；启停开关会立即写回并热生效。"
      status={
        saving
          ? <SettingStatusTag status="saving" compact />
          : feedback?.tone === 'error'
            ? <SettingStatusTag status="error" compact />
            : <SettingStatusTag status="applied" label={`共 ${signals.length} 条`} compact />
      }
    >
      {feedback ? (
        <div style={{ padding: '12px 18px 0' }}>
          <InlineNote tone={feedback.tone}>{feedback.text}</InlineNote>
        </div>
      ) : null}
      <div style={{ padding: '12px 18px', overflowX: 'auto' }}>
        <Table
          size="small"
          rowKey="id"
          loading={loading}
          pagination={false}
          scroll={{ x: 'max-content' }}
          dataSource={signals}
          columns={columns}
          locale={{
            emptyText: <HudStateView compact code="NO_SIGNALS" title="当前筛选下无信号规则" />
          }}
        />
      </div>
    </SettingSection>
  );
};

interface HitsTableSectionProps {
  hits: FailureProvenanceEntry[];
  dropped: number;
  loading: boolean;
  error: string;
  onReload: () => void;
}

const HitsTableSection: React.FC<HitsTableSectionProps> = ({
  hits,
  dropped,
  loading,
  error,
  onReload
}) => {
  const columns = useMemo<ColumnsType<FailureProvenanceEntry>>(() => [
    {
      title: '时间',
      dataIndex: 'atMs',
      width: 130,
      render: (value: number) => <span className="aih-mono">{formatTime(value)}</span>
    },
    {
      title: '账号',
      dataIndex: 'accountRef',
      width: 160,
      render: (value: string) => <span className="aih-mono">{value}</span>
    },
    { title: '模型', dataIndex: 'model', width: 160 },
    {
      title: 'HTTP',
      dataIndex: 'httpStatus',
      width: 110,
      render: (value: number | undefined) => (value ? <HttpStatusTag status={value} /> : <span className="aih-muted">—</span>)
    },
    {
      title: '语义',
      dataIndex: 'semantic',
      width: 160,
      render: (value: string) => <span className="aih-mono">{value}</span>
    },
    {
      title: '动作',
      dataIndex: 'action',
      width: 130,
      render: (value: string) => renderActionTag(value)
    },
    {
      title: '来源 : 信号',
      key: 'source',
      render: (_: unknown, row: FailureProvenanceEntry) => (
        <span className="aih-mono aih-muted">
          {SOURCE_LABELS[row.source] || row.source || '—'}
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
  ], []);

  return (
    <SettingSection
      title="最近命中记录"
      description="展示运行池最近 100 条失败语义判定结果，便于核对信号与冷却是否按预期触发。"
      status={
        error
          ? <SettingStatusTag status="error" label="读取失败" compact />
          : <SettingStatusTag status="applied" label={`已记录 ${hits.length} 条`} compact />
      }
      extra={(
        <Space size={8} wrap>
          <span className="aih-muted" style={{ fontSize: 12 }}>缓冲区丢弃 {dropped} 条</span>
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={onReload}>
            刷新命中
          </Button>
        </Space>
      )}
    >
      {error ? (
        <div style={{ padding: '12px 18px 0' }}>
          <InlineNote
            tone="error"
            action={<Button size="small" type="link" onClick={onReload}>重试</Button>}
          >
            {error}
          </InlineNote>
        </div>
      ) : null}
      <div style={{ padding: '12px 18px', overflowX: 'auto' }}>
        <Table
          size="small"
          rowKey={(row) => `${row.atMs}-${row.accountRef}-${row.model}-${row.signalId}`}
          loading={loading}
          pagination={{ pageSize: 20 }}
          scroll={{ x: 'max-content' }}
          dataSource={hits}
          columns={columns}
          locale={{
            emptyText: <HudStateView compact code="NO_HITS" title="暂无最近命中记录" />
          }}
        />
      </div>
    </SettingSection>
  );
};

const FailureSemantics: React.FC = () => {
  const [provider, setProvider] = useState('');
  const [tab, setTab] = useState('policies');
  const [policies, setPolicies] = useState<FailureSemanticPolicy[]>([]);
  const [signals, setSignals] = useState<FailureSemanticSignal[]>([]);
  const [overrides, setOverrides] = useState<OverrideShape>({});
  const [draft, setDraft] = useState<Record<string, FailureSemanticPolicy>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [policyFeedback, setPolicyFeedback] = useState<InlineFeedback | null>(null);
  const [signalFeedback, setSignalFeedback] = useState<InlineFeedback | null>(null);
  const [hits, setHits] = useState<FailureProvenanceEntry[]>([]);
  const [dropped, setDropped] = useState(0);
  const [hitsLoading, setHitsLoading] = useState(false);
  const [hitsError, setHitsError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await failureSemanticsAPI.get(provider || undefined);
      setPolicies(data.policies || []);
      setSignals(data.signals || []);
      setOverrides(data.overrides || {});
      setDraft({});
    } catch (error) {
      const text = error instanceof Error ? `读取失败语义失败：${error.message}` : '读取失败语义失败';
      setLoadError(text);
    } finally {
      setLoading(false);
    }
  }, [provider]);

  const loadHits = useCallback(async () => {
    setHitsLoading(true);
    setHitsError('');
    try {
      const data = await failureSemanticsAPI.hits({ limit: 100, provider: provider || undefined });
      setHits(data.entries);
      setDropped(data.dropped);
    } catch {
      setHitsError('读取最近命中失败，请确认网关服务已启动。');
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

  const dirtyCount = useMemo(() => {
    let count = 0;
    Object.entries(draft).forEach(([kind, row]) => {
      const before = policies.find((policy) => policy.kind === kind);
      if (!before) return;
      const changed =
        row.threshold !== before.threshold ||
        row.failure_window_ms !== before.failure_window_ms ||
        row.default_cooldown_ms !== before.default_cooldown_ms;
      if (changed) count += 1;
    });
    return count;
  }, [draft, policies]);

  const updateDraft = useCallback((kind: string, patch: Partial<FailureSemanticPolicy>) => {
    setPolicyFeedback(null);
    setDraft((prev) => {
      const base = prev[kind] || policies.find((policy) => policy.kind === kind);
      if (!base) return prev;
      return { ...prev, [kind]: { ...base, ...patch } };
    });
  }, [policies]);

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
    setPolicyFeedback(null);
    try {
      const next: OverrideShape = { ...overrides, policies: nextPolicies };
      await configAPI.updateServer({
        upstreamFailurePolicy: toServerFailurePolicy(next)
      });
      message.success('失败语义参数已保存并热生效');
      setPolicyFeedback({ tone: 'success', text: '已保存并热生效。' });
      await load();
    } catch (error) {
      const text = error instanceof Error ? `保存失败：${error.message}` : '保存失败';
      setPolicyFeedback({ tone: 'error', text });
    } finally {
      setSaving(false);
    }
  };

  const toggleSignal = useCallback(async (signal: FailureSemanticSignal, enabled: boolean) => {
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
    setSignalFeedback(null);
    try {
      await configAPI.updateServer({ upstreamFailurePolicy: toServerFailurePolicy(next) });
      setSignalFeedback({ tone: 'success', text: `已${enabled ? '启用' : '停用'}信号 ${signal.id} 并热生效。` });
      await load();
    } catch (error) {
      setSignalFeedback({
        tone: 'error',
        text: error instanceof Error ? `更新信号状态失败：${error.message}` : '更新信号状态失败'
      });
    } finally {
      setSaving(false);
    }
  }, [load, overrides]);

  return (
    <div className="failure-semantics-panel" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SettingSection
        title="失败语义范围"
        description="按 Provider 过滤失败语义、匹配信号与近期命中记录。"
        extra={(
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            刷新配置
          </Button>
        )}
      >
        <SettingRow
          title="Provider 筛选"
          description="留空查看全局与所有 Provider 的契约及覆盖规则。"
          htmlFor="failure-semantics-provider"
          control={(
            <Select
              id="failure-semantics-provider"
              style={{ width: '100%', maxWidth: 240 }}
              value={provider}
              options={providerOptions}
              onChange={setProvider}
              placeholder="全部 Provider"
            />
          )}
        />
      </SettingSection>

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'policies',
            label: `语义与策略 (${policyRows.length})`,
            children: (
              <PolicyTableSection
                policyRows={policyRows}
                overrides={overrides}
                draft={draft}
                dirtyCount={dirtyCount}
                loading={loading}
                saving={saving}
                loadError={loadError}
                feedback={policyFeedback}
                onUpdateDraft={updateDraft}
                onSave={() => void savePolicies()}
                onReset={() => {
                  setDraft({});
                  setPolicyFeedback(null);
                }}
                onReload={() => void load()}
              />
            )
          },
          {
            key: 'signals',
            label: `信号表 (${visibleSignals.length})`,
            children: (
              <SignalTableSection
                signals={visibleSignals}
                overrides={overrides}
                loading={loading}
                saving={saving}
                feedback={signalFeedback}
                onToggle={(signal, enabled) => void toggleSignal(signal, enabled)}
              />
            )
          },
          {
            key: 'hits',
            label: '最近命中',
            children: (
              <HitsTableSection
                hits={hits}
                dropped={dropped}
                loading={hitsLoading}
                error={hitsError}
                onReload={() => void loadHits()}
              />
            )
          }
        ]}
      />
    </div>
  );
};

export default FailureSemantics;
