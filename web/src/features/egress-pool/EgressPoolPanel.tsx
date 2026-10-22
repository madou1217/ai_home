import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Empty, Input, InputNumber, Segmented, Spin, Switch, Table, Tag, Tooltip, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  AimOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  StopOutlined,
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
  formatAgo,
  formatDuration,
  nodeHealth,
  successRate,
  type NodeFilter
} from './egress-pool-presentation';
import type { EgressPoolEvent, EgressPoolNode, EgressPoolView } from './types';
import './EgressPoolPanel.css';

const REFRESH_INTERVAL_MS = 5000;
// 节点表每页条数：2w 节点时表格不能吃全量数据（见 visibleNodes 的注释）。
const PAGE_SIZE = 50;

const EVENT_ICON: Record<string, JSX.Element> = {
  switch: <SwapOutlined />,
  cooldown: <ClockCircleOutlined />,
  recovered: <CheckCircleOutlined />,
  probe_failed: <WarningOutlined />,
  blocked: <StopOutlined />,
  unblocked: <CheckCircleOutlined />
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
    case 'blocked':
      return `${event.node} 被拦截 · ${eventReasonLabel(event.reason)}`;
    case 'unblocked':
      return `${event.node} 已放行 · ${eventReasonLabel(event.reason)}`;
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
  const [page, setPage] = useState(1);
  const [accountLabels, setAccountLabels] = useState<Record<string, string>>({});
  // 本地时钟：冷却倒计时按秒走，不必每秒请求服务端。
  const fetchedAtRef = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  // 分页/筛选的当前值给 load 用（避免把它塞进 useCallback 依赖导致每次变化都重建定时器）。
  const pageRef = useRef(1);
  const filterRef = useRef<NodeFilter>('all');
  const queryRef = useRef('');
  const versionRef = useRef('');

  const load = useCallback(async (overrides: { page?: number; filter?: NodeFilter; query?: string } = {}) => {
    const targetPage = overrides.page ?? pageRef.current;
    const targetFilter = overrides.filter ?? filterRef.current;
    const targetQuery = overrides.query ?? queryRef.current;
    try {
      const next = await egressPoolAPI.view({
        page: targetPage,
        pageSize: PAGE_SIZE,
        filter: targetFilter,
        query: targetQuery,
        // 只在同一页/同一筛选下用版本指纹换 304；换页或换筛选必须重新拿数据。
        version: versionRef.current
      });
      fetchedAtRef.current = Date.now();
      // null = 304：节点表没变，沿用上一份（省掉十几 MB 传输）。
      if (next) {
        setView(next);
        versionRef.current = next.version || '';
      }
      setError('');
    } catch (loadError: unknown) {
      setError((loadError as Error)?.message || '出口池状态读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // 唯一的取数 effect：挂载、换页、换筛选、改关键词都走它。
  // **换页/换筛选要作废版本指纹**（必须重新取数据）；单纯轮询/重挂载则保留，好让服务端回 304。
  useEffect(() => {
    const changed = pageRef.current !== page || filterRef.current !== filter || queryRef.current !== query;
    pageRef.current = page;
    filterRef.current = filter;
    queryRef.current = query;
    if (changed) versionRef.current = '';
    void load({ page, filter, query });
  }, [page, filter, query, load]);
  // 自动刷新：**页面不可见时不拉**（切到别的标签页仍在轮询会把整个节点表反复传一遍；
  // 节点多时那是每分钟十几 MB），回到前台立刻补一次。节点越多间隔越长，避免持续占带宽。
  useEffect(() => {
    if (!autoRefresh) return undefined;
    const nodeCount = view?.nodes.length || 0;
    const interval = nodeCount > 5000 ? REFRESH_INTERVAL_MS * 6 : nodeCount > 1000 ? REFRESH_INTERVAL_MS * 3 : REFRESH_INTERVAL_MS;
    let timer: number | null = null;
    // 轮询不带 overrides：沿用当前页与版本指纹，服务端没变就回 304（不重传节点表）。
    const tick = () => { if (document.visibilityState === 'visible') void load(); };
    const start = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = window.setInterval(tick, interval);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void load();
        start();
      } else if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (timer !== null) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [autoRefresh, load, view?.nodes.length]);
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
  // 服务端返回的**当前页**（筛选/排序/分页都在服务端做，见 lib/runtime/egress-pool-node-view.js）。
  // 前端不再对全量做过滤或切片 —— 那会让「服务端给了 50 条、前端又筛掉几条」，页数对不上。
  const nodes = useMemo(() => view?.nodes || [], [view]);
  const pagination = view?.pagination;
  const safePage = pagination?.page ?? page;
  const changeFilter = (next: NodeFilter) => { setPage(1); setFilter(next); };
  const changeQuery = (next: string) => { setPage(1); setQuery(next); };

  // 只在这一页上逐秒重算倒计时（50 条/秒，代价可忽略）。
  const visibleNodes = useMemo(() => nodes.map((node) => {
    const remaining = Math.max(0, node.cooldownRemainingMs - elapsed);
    return { ...node, cooldownRemainingMs: remaining, cooling: node.cooling && remaining > 0 };
  }), [nodes, elapsed]);
  // 计数走**服务端**（分页后前端只有一页数据，自己数会得出「本页 3 个冷却」这种错数）。
  // 没有 nodeCounts（全量旧行为）时才回退到本地统计。
  const nodeCounts = useMemo(() => view?.nodeCounts || {
    all: nodes.length,
    healthy: nodes.filter((node) => !node.blocked && !node.cooling && !(node.probe && node.probe.ok === false)).length,
    cooling: nodes.filter((node) => node.cooling).length,
    blocked: nodes.filter((node) => node.blocked).length,
    used: nodes.filter((node) => node.uses > 0).length
  }, [view, nodes]);
  const coolingCount = nodeCounts.cooling;
  const blockedCount = nodeCounts.blocked;
  const policy = view?.nodePolicy || null;
  const probedOk = useMemo(() => nodes.filter((node) => node.probe?.ok).length, [nodes]);
  const activeEntry = useMemo(() => nodes.find((node) => node.name === activeNode), [nodes, activeNode]);
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
            {node.blocked && node.blockedDetail && (
              <span className="egress-block-detail" title={node.blockedDetail}>{node.blockedDetail}</span>
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
      width: 240,
      render: (_value, node) => (
        <div className="egress-actions">
          <Tooltip title={node.blocked && node.blockedReason === 'node_blocked_manual' ? '放行：让它重新参与轮换' : '手动关闭：不再被选中出网（按出口身份记，重启后仍有效）'}>
            <Button
              size="small"
              danger={!node.blocked}
              type={node.blocked && node.blockedReason === 'node_blocked_manual' ? 'primary' : 'default'}
              icon={<StopOutlined />}
              loading={busy === `block:${node.name}`}
              onClick={() => void runAction(
                `block:${node.name}`,
                () => egressPoolAPI.setBlocked(node.name, !(node.blocked && node.blockedReason === 'node_blocked_manual')),
                node.blocked && node.blockedReason === 'node_blocked_manual' ? `已放行 ${node.label}` : `已关闭 ${node.label}`
              )}
              aria-label={`${node.blocked ? '放行' : '关闭'} ${node.label}`}
            />
          </Tooltip>
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
                value: `${nodes.length - coolingCount - blockedCount} / ${nodes.length} 可用`,
                detail: `${coolingCount} 个冷却中 · ${blockedCount} 个被拦截 · ${probedOk} 个探测通过`,
                tone: blockedCount > 0 ? 'warning' : coolingCount > 0 ? 'warning' : 'success'
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

          <section className="egress-policy" aria-label="节点拦截策略">
            <div className="egress-policy-head">
              <StopOutlined />
              <strong>节点拦截策略</strong>
              <small>{policy ? policy.summary : '未启用任何拦截'}</small>
            </div>
            <div className="egress-policy-controls">
              <label className="egress-policy-item">
                <Switch
                  size="small"
                  checked={Boolean(policy?.latency.enabled)}
                  loading={busy === 'policy:latency'}
                  disabled={!status?.ready}
                  onChange={(checked) => void runAction(
                    'policy:latency',
                    () => egressPoolAPI.updatePolicy({ latency: { enabled: checked } }),
                    checked ? '已启用延迟拦截' : '已关闭延迟拦截'
                  )}
                />
                <span>
                  延迟拦截
                  <InputNumber
                    size="small"
                    min={100}
                    max={15000}
                    step={500}
                    value={policy?.latency.maxMs ?? 3000}
                    disabled={!status?.ready || !policy?.latency.enabled}
                    onChange={(value) => {
                      const maxMs = Number(value);
                      if (!Number.isFinite(maxMs)) return;
                      void runAction('policy:latency', () => egressPoolAPI.updatePolicy({ latency: { maxMs } }), `延迟阈值已设为 ${maxMs}ms`);
                    }}
                    addonAfter="ms"
                    aria-label="延迟阈值"
                  />
                  <small>探测延迟超过它的节点不再被选中（默认 3000ms）</small>
                </span>
              </label>
              <label className="egress-policy-item">
                <Switch
                  size="small"
                  checked={Boolean(policy?.unreachable.enabled)}
                  loading={busy === 'policy:unreachable'}
                  disabled={!status?.ready}
                  onChange={(checked) => void runAction(
                    'policy:unreachable',
                    () => egressPoolAPI.updatePolicy({ unreachable: { enabled: checked } }),
                    checked ? '已启用「连不上」拦截' : '已关闭「连不上」拦截'
                  )}
                />
                <span>
                  连不上拦截
                  <small>探测超时 / 拒绝的节点不再被选中；被拦的节点仍会定期重探，恢复正常后自动放行</small>
                </span>
              </label>
              <label className="egress-policy-item">
                <span>
                  手动关闭 <strong>{policy?.disabledCount ?? 0}</strong> 个
                  <small>在节点行上点「关闭」；按出口身份记录，重启与节点重排后仍然有效</small>
                </span>
                {Boolean(policy?.disabledCount) && (
                  <Button
                    size="small"
                    icon={<UnlockOutlined />}
                    loading={busy === 'policy:clear'}
                    disabled={!status?.ready}
                    onClick={() => void runAction('policy:clear', () => egressPoolAPI.clearDisabled(), '已放行全部手动关闭的节点')}
                  >
                    全部放行
                  </Button>
                )}
              </label>
            </div>
          </section>

          <div className="egress-pool-grid">
            <section className="egress-nodes" aria-label="节点">
              <div className="egress-toolbar">
                <Segmented
                  value={filter}
                  onChange={(value) => changeFilter(value as NodeFilter)}
                  options={[
                    { label: `全部 ${nodeCounts.all}`, value: 'all' },
                    { label: `可用 ${nodeCounts.healthy}`, value: 'healthy' },
                    { label: `冷却中 ${nodeCounts.cooling}`, value: 'cooling' },
                    { label: `已拦截 ${nodeCounts.blocked}`, value: 'blocked' },
                    { label: `用过 ${nodeCounts.used}`, value: 'used' }
                  ]}
                />
                <Input
                  allowClear
                  prefix={<SearchOutlined />}
                  placeholder="搜索节点名 / 服务器"
                  value={query}
                  onChange={(event) => changeQuery(event.target.value)}
                  aria-label="搜索节点"
                />
              </div>
              <Table
                size="small"
                rowKey="name"
                className="egress-node-table"
                columns={columns}
                dataSource={visibleNodes}
                pagination={(pagination?.total ?? 0) > PAGE_SIZE
                  ? {
                      current: safePage,
                      pageSize: pagination?.pageSize ?? PAGE_SIZE,
                      total: pagination?.total ?? 0,
                      showSizeChanger: false,
                      onChange: setPage
                    }
                  : false}
                rowClassName={(node) => [
                  node.name === activeNode ? 'egress-row-active' : '',
                  node.cooling ? 'egress-row-cooling' : '',
                  node.blocked ? 'egress-row-blocked' : ''
                ].filter(Boolean).join(' ')}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的节点" /> }}
                scroll={{ x: 1020 }}
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
