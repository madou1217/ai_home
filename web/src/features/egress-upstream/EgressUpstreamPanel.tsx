import { useCallback, useEffect, useMemo, useState } from 'react';
import { Empty, InputNumber, Segmented, Spin, Table, Tag, Tooltip, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  AimOutlined,
  ClearOutlined,
  CloudServerOutlined,
  GlobalOutlined,
  LinkOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  UndoOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import ToolkitStatusTrack from '@/components/toolkit/ToolkitStatusTrack';
import { egressUpstreamAPI } from './egress-upstream-api';
import RegionRulesEditor, { type RuleDraft } from './RegionRulesEditor';
import BulkEgressModal from './BulkEgressModal';
import {
  countryFlag,
  describeAccountEgress,
  describeGeo,
  describeVerdict,
  emptyMatch,
  formatTtl
} from './egress-upstream-presentation';
import type { EgressUpstream, EgressUpstreamAccount, EgressUpstreamNode, EgressUpstreamView, EgressVerdictStatus } from './types';
import './EgressUpstream.css';

const REFRESH_INTERVAL_MS = 15000;
const DAY_MS = 24 * 60 * 60 * 1000;

type NodeFilter = 'all' | EgressVerdictStatus;

function formatAgo(at: number, now: number) {
  if (!at) return '—';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

const EVIDENCE_LABEL: Record<string, string> = { ok: '可用', blocked: '被拒', reachable: '可连通' };
const EVIDENCE_SOURCE: Record<string, string> = { probe: '探测', traffic: '真实流量', credentialed: '带凭据探测', manual: '手动' };

/**
 * 上游地区策略面板（开发工具 → 网络 → 上游）：每个上游的账号与出口、地区规则、预置提示、
 * 节点 × 判定矩阵、实测（有效期 / 重测 / 重置）与本机当前出口。
 * 数据来自 GET /v0/webui/egress-upstreams（见 lib/server/egress-upstream-view.js）。
 */
export default function EgressUpstreamPanel() {
  const [view, setView] = useState<EgressUpstreamView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState('');
  const [filter, setFilter] = useState<NodeFilter>('all');
  const [ruleSeed, setRuleSeed] = useState<RuleDraft | null>(null);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [ttlDays, setTtlDays] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await egressUpstreamAPI.view();
      setView(next);
      setError('');
      setSelectedId((current) => (current && next.upstreams.some((item) => item.id === current) ? current : (next.upstreams[0]?.id || '')));
    } catch (loadError: unknown) {
      setError((loadError as Error)?.message || '上游策略读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => { void load(); }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const upstream = useMemo<EgressUpstream | null>(
    () => view?.upstreams.find((item) => item.id === selectedId) || null,
    [view, selectedId]
  );
  useEffect(() => {
    setSelectedAccounts([]);
    setTtlDays(upstream && upstream.policy.evidenceTtlMs ? Math.round(upstream.policy.evidenceTtlMs / DAY_MS * 10) / 10 : null);
  }, [upstream?.id, upstream?.policy.evidenceTtlMs]);  

  const now = view?.serverTime || Date.now();

  const run = async (key: string, action: () => Promise<{ ok: boolean; error?: string; background?: boolean; count?: number }>, success: string) => {
    setBusy(key);
    try {
      const result = await action();
      if (result.ok) message.success(result.background ? `已在后台测试 ${result.count} 个节点，完成后自动刷新` : success);
      else message.warning(result.error || '操作未完成');
      await load();
    } catch (actionError: unknown) {
      message.error((actionError as Error)?.message || '操作失败');
    } finally {
      setBusy('');
    }
  };

  const probe = (nodes?: string[]) => upstream
    ? run(`probe:${nodes?.join(',') || 'all'}`, () => egressUpstreamAPI.probe(upstream.id, nodes), '测试完成')
    : Promise.resolve();

  const saveRules = (rules: RuleDraft[]) => upstream
    ? run('rules', () => egressUpstreamAPI.savePolicy(upstream.id, { rules }), '规则已保存，车道已按新规则重排')
    : undefined;

  const nodeColumns: ColumnsType<EgressUpstreamNode> = [
    { title: '节点', key: 'label', render: (_v, node) => <span className="egress-up-node-label">{node.label}</span> },
    {
      title: '真实出口',
      key: 'geo',
      width: 230,
      render: (_v, node) => node.geo?.country
        ? (
          <Tooltip title={[node.geo.ip, node.geo.asn, node.geo.org].filter(Boolean).join(' · ')}>
            <span className="egress-up-geo">{describeGeo(node.geo)}</span>
          </Tooltip>
        )
        : <span className="egress-muted">查询中</span>
    },
    {
      title: '判定',
      key: 'verdict',
      width: 130,
      render: (_v, node) => {
        const verdict = describeVerdict(node.verdict);
        return <Tooltip title={node.verdict.detail}><Tag color={verdict.tone}>{verdict.label}</Tag></Tooltip>;
      }
    },
    {
      title: '实测',
      key: 'evidence',
      width: 170,
      render: (_v, node) => node.evidence
        ? (
          <Tooltip title={`${node.evidence.reason || ''} · ${EVIDENCE_SOURCE[node.evidence.source] || node.evidence.source}`}>
            <span className="egress-up-evidence" data-status={node.evidence.status} data-expired={node.evidence.expired || undefined}>
              {EVIDENCE_LABEL[node.evidence.status]} · {formatAgo(node.evidence.at, now)}{node.evidence.expired ? ' · 已过期' : ''}
            </span>
          </Tooltip>
        )
        : <span className="egress-muted">未测</span>
    },
    {
      title: '操作',
      key: 'actions',
      width: 130,
      render: (_v, node) => (
        <div className="egress-actions">
          <Tooltip title={`不带凭据经这个节点请求一次 ${upstream?.host}`}>
            <Button size="small" icon={<ThunderboltOutlined />} loading={busy === `probe:${node.name}`} onClick={() => void probe([node.name])} aria-label={`测试 ${node.label}`} />
          </Tooltip>
          {node.evidence ? (
            <Tooltip title="重置这条实测（下次按规则 / 提示判定并重测）">
              <Button size="small" icon={<UndoOutlined />} loading={busy === `reset:${node.identity}`}
                onClick={() => upstream && void run(`reset:${node.identity}`, () => egressUpstreamAPI.resetEvidence(upstream.id, [`node:${node.identity}`]), '已重置')}
                aria-label={`重置 ${node.label} 实测`} />
            </Tooltip>
          ) : null}
          {node.geo?.country && node.verdict.status !== 'denied' ? (
            <Tooltip title="据此加一条拒绝规则（预填该节点的国家与城市）">
              <Button size="small" icon={<AimOutlined />}
                onClick={() => setRuleSeed({ effect: 'deny', note: `${node.label} 所在地区不可用`, match: { ...emptyMatch(), country: [node.geo!.country], city: node.geo!.city ? [node.geo!.city] : [] } })}
                aria-label={`据 ${node.label} 生成规则`} />
            </Tooltip>
          ) : null}
        </div>
      )
    }
  ];

  const accountColumns: ColumnsType<EgressUpstreamAccount> = [
    { title: '账号', key: 'label', render: (_v, account) => <span>{account.label || account.accountRef}<small className="egress-muted"> · {account.provider}</small></span> },
    {
      title: '出口',
      key: 'egress',
      width: 260,
      render: (_v, account) => {
        const badge = describeAccountEgress(account);
        return (
          <span className="egress-up-account-egress">
            <Tag color={badge.tone}>{badge.label}</Tag>
            {badge.detail ? <small>{badge.detail}</small> : null}
          </span>
        );
      }
    },
    {
      title: '当前网络',
      key: 'network',
      width: 240,
      render: (_v, account) => {
        if (!account.network) return <span className="egress-muted">由出口池车道判定</span>;
        const verdict = describeVerdict({ status: account.network.status, source: account.network.source, soft: false });
        return (
          <Tooltip title={account.network.detail}>
            <span className="egress-up-account-network">
              {account.network.geoText || (account.network.exit === 'system' ? '系统代理' : '位置未知')}
              {account.network.status === 'denied' ? <Tag color="error">{verdict.label}</Tag> : null}
            </span>
          </Tooltip>
        );
      }
    }
  ];

  const nodes = upstream?.nodes || [];
  const visibleNodes = filter === 'all' ? nodes : nodes.filter((node) => node.verdict.status === filter);
  const deniedTotal = view?.upstreams.reduce((sum, item) => sum + item.deniedAccounts, 0) || 0;
  const direct = view?.network.direct || null;
  const bulkTargets = (upstream?.accounts || [])
    .filter((account) => selectedAccounts.includes(account.accountRef))
    .map((account) => ({ provider: account.provider, accountRef: account.accountRef, label: account.label }));

  return (
    <section className="toolkit-page toolkit-domain-panel egress-up-panel" aria-labelledby="egress-up-title">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">UPSTREAM POLICY</div>
          <h2 id="egress-up-title">上游地区策略</h2>
          <p>按上游（接口主机）维护哪些出口位置能用：规则 &gt; 实测（带有效期）&gt; 预置提示。出口池只放行允许的节点；不走出口池的账号在当前网络被拒时禁止使用。</p>
        </div>
        <div className="toolkit-header-actions">
          <Button icon={<GlobalOutlined />} loading={busy === 'network'} onClick={() => void run('network', () => egressUpstreamAPI.refreshNetwork(), '本机出口位置已更新')}>
            重新检测本机出口
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => { setLoading(true); void load(); }}>刷新</Button>
        </div>
      </header>

      {error && <InlineNote tone="error" description={error}>上游策略读取失败</InlineNote>}

      {loading && !view ? (
        <div className="toolkit-loading"><Spin size="large" tip="正在读取上游策略" /></div>
      ) : view ? (
        <div className="egress-up-body aih-stagger">
          <ToolkitStatusTrack
            ariaLabel="上游策略状态"
            items={[
              { label: '本机出口', value: direct ? describeGeo(direct.geo) : '检测中', detail: direct ? `${direct.geo.ip || ''} · ${formatAgo(direct.at, now)}` : '未绑定出口的账号按它判定', tone: 'info' },
              { label: '出口池', value: view.pool.ready ? `${view.pool.nodeCount} 个节点` : '未运行', detail: view.pool.ready ? `已查到 ${view.pool.geoKnown} 个节点的真实位置` : '有账号绑定出口池时自动启动', tone: view.pool.ready ? 'success' : 'neutral' },
              { label: '上游', value: `${view.upstreams.length} 个`, detail: deniedTotal ? `${deniedTotal} 个账号当前网络被拒` : '没有账号被当前网络拒绝', tone: deniedTotal ? 'danger' : 'success' }
            ]}
          />

          {view.upstreams.length === 0 ? (
            <Empty description="运行池里还没有账号" />
          ) : (
            <div className="egress-up-grid">
              <nav className="egress-up-list" aria-label="上游列表">
                {view.upstreams.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="egress-up-list-item"
                    data-active={item.id === selectedId || undefined}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <span className="egress-up-list-host"><CloudServerOutlined /> {item.host}</span>
                    <span className="egress-up-list-meta">
                      {item.providers.join(' / ')} · {item.accounts.length} 个账号
                      {item.official ? <Tag>官方</Tag> : <Tag>第三方</Tag>}
                    </span>
                    <span className="egress-up-list-flags">
                      {item.deniedAccounts ? <Tag color="error">{item.deniedAccounts} 个网络被拒</Tag> : null}
                      {item.unboundCount ? <Tag>{item.unboundCount} 个未设置出口</Tag> : null}
                      {item.policy.rules.length ? <Tag color="processing">{item.policy.rules.length} 条规则</Tag> : null}
                    </span>
                  </button>
                ))}
              </nav>

              {upstream ? (
                <div className="egress-up-detail" key={upstream.id}>
                  <section className="egress-up-section" aria-label="账号">
                    <div className="egress-up-section-head">
                      <strong>账号</strong>
                      <small>每个账号独立出口；同上游的账号共用这一份地区判定</small>
                      <Button size="small" type="primary" disabled={selectedAccounts.length === 0} onClick={() => setBulkOpen(true)}>
                        为所选 {selectedAccounts.length || ''} 个账号设置出口
                      </Button>
                    </div>
                    <Table
                      size="small"
                      rowKey="accountRef"
                      columns={accountColumns}
                      dataSource={upstream.accounts}
                      pagination={false}
                      rowSelection={{ selectedRowKeys: selectedAccounts, onChange: (keys) => setSelectedAccounts(keys.map(String)) }}
                      rowClassName={(account) => (account.network?.status === 'denied' ? 'egress-up-row-denied' : '')}
                    />
                  </section>

                  <section className="egress-up-section">
                    <RegionRulesEditor
                      rules={upstream.policy.rules}
                      saving={busy === 'rules'}
                      onSave={(rules) => void saveRules(rules)}
                      seed={ruleSeed}
                      onSeedConsumed={() => setRuleSeed(null)}
                    />
                  </section>

                  <section className="egress-up-section" aria-label="预置提示与实测有效期">
                    <div className="egress-up-section-head">
                      <strong>预置提示</strong>
                      <small>{upstream.official ? '来自 provider 描述符；只作提示，实测可用即推翻' : '第三方上游不继承官方提示，请按需加规则'}</small>
                    </div>
                    {upstream.hints.length ? (
                      <ul className="egress-up-hints">
                        {upstream.hints.map((hint) => (
                          <li key={hint.id}>
                            <span>{hint.note || '地区提示'}：{hint.match.country.map((code) => `${countryFlag(code)} ${code}`).join(' ')}</span>
                            <a href={hint.source} target="_blank" rel="noreferrer"><LinkOutlined /> 出处 · {hint.asOf}</a>
                          </li>
                        ))}
                      </ul>
                    ) : <span className="egress-muted">无</span>}
                    <div className="egress-up-ttl">
                      <span>实测有效期</span>
                      <InputNumber
                        size="small"
                        min={0.1}
                        max={365}
                        step={1}
                        value={ttlDays}
                        placeholder={formatTtl(upstream.effectiveTtlMs)}
                        onChange={(value) => setTtlDays(typeof value === 'number' ? value : null)}
                        addonAfter="天"
                        aria-label="实测有效期（天）"
                      />
                      <Button size="small" loading={busy === 'ttl'}
                        onClick={() => void run('ttl', () => egressUpstreamAPI.savePolicy(upstream.id, { evidenceTtlMs: ttlDays ? Math.round(ttlDays * DAY_MS) : 0 }), '有效期已保存')}>
                        保存
                      </Button>
                      <small className="egress-muted">
                        {upstream.policy.evidenceTtlMs ? '本上游单独设置' : `跟随全局（${formatTtl(upstream.effectiveTtlMs)}，aih server config set --egress-evidence-ttl-ms）`}；到期自动重测
                      </small>
                    </div>
                  </section>

                  <section className="egress-up-section" aria-label="节点判定">
                    <div className="egress-up-section-head">
                      <strong>节点 × {upstream.host}</strong>
                      <Segmented
                        size="small"
                        value={filter}
                        onChange={(value) => setFilter(value as NodeFilter)}
                        options={[
                          { label: `全部 ${nodes.length}`, value: 'all' },
                          { label: `允许 ${upstream.summary.allowed || 0}`, value: 'allowed' },
                          { label: `拒绝 ${upstream.summary.denied || 0}`, value: 'denied' },
                          { label: `待查 ${upstream.summary.pending || 0}`, value: 'pending' }
                        ]}
                      />
                      <span className="egress-up-section-actions">
                        <Button size="small" icon={<ThunderboltOutlined />} disabled={!view.pool.ready || view.probing} loading={busy === 'probe:all' || view.probing}
                          onClick={() => void probe()}>
                          {view.probing ? '后台测试中' : '全部重测'}
                        </Button>
                        <Button size="small" icon={<ClearOutlined />} disabled={upstream.evidence.length === 0} loading={busy === 'reset:all'}
                          onClick={() => void run('reset:all', () => egressUpstreamAPI.resetEvidence(upstream.id), '已重置全部实测')}>
                          重置全部实测
                        </Button>
                      </span>
                    </div>
                    {!view.pool.ready ? (
                      <InlineNote tone="info">出口池未运行：绑定任一账号到出口池后，这里显示每个节点对该上游的判定</InlineNote>
                    ) : (
                      <Table
                        size="small"
                        rowKey="identity"
                        columns={nodeColumns}
                        dataSource={visibleNodes}
                        pagination={visibleNodes.length > 15 ? { pageSize: 15, showSizeChanger: false } : false}
                        rowClassName={(node) => (node.verdict.status === 'denied' ? 'egress-up-row-denied' : '')}
                        scroll={{ x: 860 }}
                      />
                    )}
                  </section>
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
      <BulkEgressModal
        open={bulkOpen}
        upstream={upstream}
        groups={view?.groups || []}
        poolReady={Boolean(view?.pool.ready)}
        targets={bulkTargets}
        probing={busy.startsWith('probe:')}
        onProbe={async (nodes) => { await probe(nodes); }}
        onClose={(changed) => { setBulkOpen(false); if (changed) { setSelectedAccounts([]); void load(); } }}
      />
    </section>
  );
}
