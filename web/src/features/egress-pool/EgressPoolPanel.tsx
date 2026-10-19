import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Empty, Input, Segmented, Spin, Switch, Table, Tag, Tooltip, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  AimOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  SwapOutlined,
  ThunderboltOutlined,
  UnlockOutlined,
  WarningOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import ToolkitStatusTrack from '@/components/toolkit/ToolkitStatusTrack';
import { accountsAPI } from '@/services/api';
import { egressPoolAPI } from './egress-pool-api';
import {
  COOLDOWN_RULES,
  eventReasonLabel,
  failureKindLabel,
  filterNodes,
  formatAgo,
  formatDuration,
  nodeHealth,
  sortNodes,
  successRate,
  type NodeFilter
} from './egress-pool-presentation';
import type { EgressPoolEvent, EgressPoolNode, EgressPoolView } from './types';
import './EgressPoolPanel.css';

const REFRESH_INTERVAL_MS = 5000;

const EVENT_ICON: Record<string, JSX.Element> = {
  switch: <SwapOutlined />,
  cooldown: <ClockCircleOutlined />,
  recovered: <CheckCircleOutlined />,
  probe_failed: <WarningOutlined />
};

function describeEvent(event: EgressPoolEvent): string {
  switch (event.type) {
    case 'switch':
      return `${event.from || '—'} → ${event.node}${event.reason ? ` · ${eventReasonLabel(event.reason)}` : ''}`;
    case 'cooldown':
      return `${event.node} 冷却 ${formatDuration(event.cooldownMs || 0)} · ${failureKindLabel(event.kind || '')}`;
    case 'recovered':
      return `${event.node} 恢复 · ${eventReasonLabel(event.reason)}${event.latencyMs ? ` · ${event.latencyMs}ms` : ''}`;
    case 'probe_failed':
      return `${event.node} 探测失败`;
    default:
      return event.node;
  }
}

function shortRef(ref: string) {
  return ref.length > 14 ? `${ref.slice(0, 9)}…${ref.slice(-4)}` : ref;
}

/**
 * 出口池面板：哪个账号经哪个节点出网、每个节点的成败与冷却、恢复探测与事件流。
 * 数据来自 GET /v0/webui/egress-pool（节点账本，见 lib/runtime/egress-pool-node-health.js）。
 */
export default function EgressPoolPanel() {
  const [view, setView] = useState<EgressPoolView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [filter, setFilter] = useState<NodeFilter>('all');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState('');
  const [accountLabels, setAccountLabels] = useState<Record<string, string>>({});
  // 本地时钟：冷却倒计时按秒走，不必每秒请求服务端。
  const fetchedAtRef = useRef(Date.now());
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      const next = await egressPoolAPI.view();
      fetchedAtRef.current = Date.now();
      setView(next);
      setError('');
    } catch (loadError: unknown) {
      setError((loadError as Error)?.message || '出口池状态读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => { void load(); }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    accountsAPI.list()
      .then((response) => {
        const labels: Record<string, string> = {};
        (response.accounts || []).forEach((account) => {
          labels[account.accountRef] = `${account.provider} · ${account.displayName || account.email || shortRef(account.accountRef)}`;
        });
        setAccountLabels(labels);
      })
      .catch(() => {});
  }, []);

  const elapsed = now - fetchedAtRef.current;
  const serverNow = (view?.serverTime || fetchedAtRef.current) + elapsed;
  const status = view?.status || null;
  const activeNode = status?.activeNode || '';
  const nodes = useMemo(() => (view?.nodes || []).map((node) => {
    const remaining = Math.max(0, node.cooldownRemainingMs - elapsed);
    return { ...node, cooldownRemainingMs: remaining, cooling: node.cooling && remaining > 0 };
  }), [view, elapsed]);
  const visibleNodes = useMemo(
    () => sortNodes(filterNodes(nodes, filter, query), activeNode),
    [nodes, filter, query, activeNode]
  );
  const coolingCount = nodes.filter((node) => node.cooling).length;
  const probedOk = nodes.filter((node) => node.probe?.ok).length;
  const activeEntry = nodes.find((node) => node.name === activeNode);
  const accountLabel = (ref: string) => accountLabels[ref] || shortRef(ref);

  const runAction = async (key: string, action: () => Promise<{ ok: boolean; error?: string }>, success: string) => {
    setBusy(key);
    try {
      const result = await action();
      if (result.ok) message.success(success);
      else message.warning(result.error || '操作未完成');
      await load();
    } catch (actionError: unknown) {
      message.error((actionError as Error)?.message || '操作失败');
    } finally {
      setBusy('');
    }
  };

  const columns: ColumnsType<EgressPoolNode> = [
    {
      title: '节点',
      key: 'node',
      render: (_value, node) => (
        <div className="egress-node-cell">
          <span className="egress-node-label">{node.label}</span>
          <span className="egress-node-meta">
            <code>{node.name}</code>
            <span>{node.protocol} · {node.server}:{node.port}</span>
          </span>
        </div>
      )
    },
    {
      title: '状态',
      key: 'status',
      width: 210,
      render: (_value, node) => {
        const health = nodeHealth(node, activeNode);
        return (
          <div className="egress-status-cell" data-tone={health.tone}>
            <span className="egress-status-dot" aria-hidden="true" />
            <span>{health.label}</span>
            {node.cooling && (
              <span className="egress-countdown" aria-label="剩余冷却">{formatDuration(node.cooldownRemainingMs)}</span>
            )}
          </div>
        );
      }
    },
    {
      title: '延迟',
      key: 'probe',
      width: 110,
      render: (_value, node) => node.probe
        ? (
          <Tooltip title={`探测于 ${formatAgo(node.probe.at, serverNow)}`}>
            <span className="egress-latency" data-ok={node.probe.ok || undefined}>
              {node.probe.ok ? `${node.probe.latencyMs}ms` : '超时'}
            </span>
          </Tooltip>
        )
        : <span className="egress-muted">—</span>
    },
    {
      title: '请求',
      key: 'uses',
      width: 150,
      render: (_value, node) => {
        const rate = successRate(node);
        return (
          <div className="egress-usage-cell">
            <span>{node.uses} 次 · {rate === null ? '—' : `${rate}%`}</span>
            <span className="egress-rate-bar" aria-hidden="true">
              <span style={{ width: `${rate ?? 0}%` }} />
            </span>
          </div>
        );
      }
    },
    {
      title: '最近失败',
      key: 'failure',
      width: 150,
      render: (_value, node) => node.lastFailureAt
        ? (
          <Tooltip title={Object.entries(node.failuresByKind).map(([kind, count]) => `${failureKindLabel(kind)} ${count} 次`).join(' / ')}>
            <span className="egress-failure">
              {failureKindLabel(node.lastFailureKind)}
              <small>{formatAgo(node.lastFailureAt, serverNow)}</small>
            </span>
          </Tooltip>
        )
        : <span className="egress-muted">无</span>
    },
    {
      title: '使用账号',
      key: 'accounts',
      width: 120,
      render: (_value, node) => node.accounts.length
        ? (
          <Tooltip
            title={(
              <div className="egress-account-tip">
                {node.accounts.map((entry) => (
                  <div key={entry.accountRef}>{accountLabel(entry.accountRef)} · {entry.uses} 次 · {formatAgo(entry.lastUsedAt, serverNow)}</div>
                ))}
              </div>
            )}
          >
            <Tag className="egress-account-count">{node.accounts.length} 个账号</Tag>
          </Tooltip>
        )
        : <span className="egress-muted">—</span>
    },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      render: (_value, node) => (
        <div className="egress-actions">
          <Tooltip title="切到这个节点出网">
            <Button
              size="small"
              icon={<AimOutlined />}
              disabled={node.name === activeNode}
              loading={busy === `select:${node.name}`}
              onClick={() => void runAction(`select:${node.name}`, () => egressPoolAPI.select(node.name), `已切到 ${node.label}`)}
              aria-label={`切换到 ${node.label}`}
            />
          </Tooltip>
          <Tooltip title="立即探测这个节点">
            <Button
              size="small"
              icon={<ThunderboltOutlined />}
              loading={busy === `probe:${node.name}`}
              onClick={() => void runAction(`probe:${node.name}`, () => egressPoolAPI.probe(node.name), '探测完成')}
              aria-label={`探测 ${node.label}`}
            />
          </Tooltip>
          {node.cooling && (
            <Tooltip title="解除冷却，让轮换重新使用它">
              <Button
                size="small"
                icon={<UnlockOutlined />}
                loading={busy === `clear:${node.name}`}
                onClick={() => void runAction(`clear:${node.name}`, () => egressPoolAPI.clearCooldown(node.name), '已解除冷却')}
                aria-label={`解除 ${node.label} 冷却`}
              />
            </Tooltip>
          )}
        </div>
      )
    }
  ];

  const readyTone = status?.ready ? 'success' : status?.starting ? 'info' : 'warning';
  const readyValue = status?.ready ? '运行中' : status?.starting ? '启动中' : '未运行';

  return (
    <section className="toolkit-page toolkit-domain-panel egress-pool-panel" aria-labelledby="egress-pool-title">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">EGRESS POOL</div>
          <h2 id="egress-pool-title">出口池</h2>
          <p>账号绑定「出口池」后经这里的节点出网：被限的节点自动冷却跳过，不可达的节点每分钟探测、通过即恢复。</p>
        </div>
        <div className="toolkit-header-actions">
          <span className="egress-auto-refresh">
            <Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} aria-label="自动刷新" />
            <span>自动刷新</span>
          </span>
          <Button
            icon={<ThunderboltOutlined />}
            disabled={!status?.ready}
            loading={busy === 'probe:all'}
            onClick={() => void runAction('probe:all', () => egressPoolAPI.probe(), '全部节点探测完成')}
          >
            全部探测
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => { setLoading(true); void load(); }}>刷新</Button>
        </div>
      </header>

      {error && <InlineNote tone="error" description={error}>出口池状态读取失败</InlineNote>}

      {loading && !view ? (
        <div className="toolkit-loading"><Spin size="large" tip="正在读取出口池" /></div>
      ) : view && !view.available ? (
        <InlineNote tone="info" description="当前 server 未启用出口池。">出口池不可用</InlineNote>
      ) : view ? (
        <div className="egress-pool-body aih-stagger">
          <ToolkitStatusTrack
            ariaLabel="出口池状态"
            items={[
              {
                label: '内核',
                value: readyValue,
                detail: status?.ready ? status.proxyUrl : (status?.lastError || '有账号绑定出口池时自动启动'),
                tone: readyTone
              },
              {
                label: '节点',
                value: `${nodes.length - coolingCount} / ${nodes.length} 可用`,
                detail: `${coolingCount} 个冷却中 · ${probedOk} 个探测通过`,
                tone: coolingCount > 0 ? 'warning' : 'success'
              },
              {
                label: '当前出口',
                value: activeEntry ? activeEntry.label : '—',
                detail: activeEntry ? `${activeEntry.name} · ${activeEntry.server}` : '内核未运行',
                tone: 'info'
              },
              {
                label: '绑定账号',
                value: `${view.boundAccounts.length} 个`,
                detail: view.boundAccounts.slice(0, 3).map((entry) => accountLabel(entry.accountRef)).join('、') || '还没有账号绑定出口池',
                tone: view.boundAccounts.length ? 'info' : 'neutral'
              }
            ]}
          />

          <ul className="egress-rules" aria-label="冷却规则">
            {COOLDOWN_RULES.map((rule) => (
              <li key={rule.kind} data-kind={rule.kind}>
                <strong>{rule.label}</strong>
                <span>{rule.detail}</span>
              </li>
            ))}
          </ul>

          <div className="egress-pool-grid">
            <section className="egress-nodes" aria-label="节点">
              <div className="egress-toolbar">
                <Segmented
                  value={filter}
                  onChange={(value) => setFilter(value as NodeFilter)}
                  options={[
                    { label: `全部 ${nodes.length}`, value: 'all' },
                    { label: '可用', value: 'healthy' },
                    { label: `冷却中 ${coolingCount}`, value: 'cooling' },
                    { label: '用过', value: 'used' }
                  ]}
                />
                <Input
                  allowClear
                  prefix={<SearchOutlined />}
                  placeholder="搜索节点名 / 服务器"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label="搜索节点"
                />
              </div>
              <Table
                size="small"
                rowKey="name"
                className="egress-node-table"
                columns={columns}
                dataSource={visibleNodes}
                pagination={visibleNodes.length > 20 ? { pageSize: 20, showSizeChanger: false } : false}
                rowClassName={(node) => [
                  node.name === activeNode ? 'egress-row-active' : '',
                  node.cooling ? 'egress-row-cooling' : ''
                ].filter(Boolean).join(' ')}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的节点" /> }}
                scroll={{ x: 980 }}
              />
            </section>

            <aside className="egress-events" aria-label="最近事件">
              <div className="egress-events-head">
                <ApiOutlined />
                <strong>最近事件</strong>
                <small>{view.events.length} 条</small>
              </div>
              {view.events.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有切换或冷却" />
              ) : (
                <ol className="egress-event-list">
                  {view.events.slice(0, 60).map((event) => (
                    <li key={`${event.at}-${event.type}-${event.node}`} data-type={event.type}>
                      <span className="egress-event-icon" aria-hidden="true">{EVENT_ICON[event.type]}</span>
                      <span className="egress-event-body">
                        <span>{describeEvent(event)}</span>
                        <small>
                          {formatAgo(event.at, serverNow)}
                          {event.accountRef ? ` · ${accountLabel(event.accountRef)}` : ''}
                          {event.model ? ` · ${event.model}` : ''}
                        </small>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </aside>
          </div>
        </div>
      ) : null}
    </section>
  );
}
