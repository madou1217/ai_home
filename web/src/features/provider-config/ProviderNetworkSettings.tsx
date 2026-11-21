import { useCallback, useEffect, useMemo, useState } from 'react';
import { Empty, Space, Table, Tag, Tooltip, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  GlobalOutlined,
  ReloadOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  UndoOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import BulkEgressModal from '@/features/egress-upstream/BulkEgressModal';
import { egressUpstreamAPI } from '@/features/egress-upstream/egress-upstream-api';
import { describeGeo } from '@/features/egress-upstream/egress-upstream-presentation';
import type { BulkEgressTarget } from '@/features/egress-upstream/bulk-egress';
import type { EgressAccountProbeResult, EgressUpstream, EgressUpstreamView } from '@/features/egress-upstream/types';
import { accountsAPI, watchEgressUpstreams } from '@/services/api';
import type { Account } from '@/types';
import {
  buildProviderNetworkRows,
  collectProviderRules,
  describeProbeResult,
  describeRowEgress,
  describeRowNetwork,
  type ProviderNetworkRow
} from './provider-network-model';
import './provider-network.css';

export interface ProviderNetworkSettingsProps {
  provider: string;
}

interface ConfiguringState {
  title: string;
  targets: BulkEgressTarget[];
  upstream: EgressUpstream | null;
}

function describeError(error: unknown): string {
  const response = (error as { response?: { data?: { message?: string; error?: string } } })?.response;
  return response?.data?.message || response?.data?.error || (error instanceof Error ? error.message : '请求失败');
}

const TONE_COLOR: Record<string, 'success' | 'error' | 'default' | 'processing' | 'warning'> = {
  success: 'success',
  error: 'error',
  default: 'default',
  processing: 'processing',
  warning: 'warning'
};

/**
 * Toolkit → agent/harness 高级设置 → 网络。
 *
 * 默认出口跟随 OAuth 授权时使用的服务端网络；账号可以独立设置出口（出口池 /
 * 代理地址 / 系统代理 / 直连）。这里只消费账号出口与上游地区策略的既有事实，
 * 不维护第二份网络配置。
 */
export default function ProviderNetworkSettings({ provider }: ProviderNetworkSettingsProps) {
  const normalizedProvider = provider.trim().toLowerCase();
  const [view, setView] = useState<EgressUpstreamView | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [probes, setProbes] = useState<Record<string, EgressAccountProbeResult>>({});
  const [probingNodes, setProbingNodes] = useState(false);
  const [configuring, setConfiguring] = useState<ConfiguringState | null>(null);

  const load = useCallback(async () => {
    const [viewResult, accountsResult] = await Promise.allSettled([
      egressUpstreamAPI.view(),
      accountsAPI.list()
    ]);
    if (viewResult.status === 'fulfilled') {
      setView(viewResult.value);
      setError('');
    } else {
      setView(null);
      setError(describeError(viewResult.reason));
    }
    if (accountsResult.status === 'fulfilled') {
      setAccounts((accountsResult.value.accounts || []).filter(
        (account) => String(account.provider || '').trim().toLowerCase() === normalizedProvider
      ));
    }
    setLoading(false);
  }, [normalizedProvider]);

  useEffect(() => {
    setLoading(true);
    setProbes({});
    void load();
  }, [load]);

  useEffect(() => {
    const source = watchEgressUpstreams();
    source.onmessage = () => {
      void load();
    };
    return () => source.close();
  }, [load]);

  const providerUpstreams = useMemo(
    () => (view?.upstreams || []).filter(
      (upstream) => (upstream.providers || []).some(
        (item) => String(item || '').trim().toLowerCase() === normalizedProvider
      )
    ),
    [normalizedProvider, view]
  );

  const rows = useMemo(
    () => buildProviderNetworkRows(accounts, providerUpstreams, provider),
    [accounts, provider, providerUpstreams]
  );

  const targetFor = useCallback((row: ProviderNetworkRow): BulkEgressTarget => ({
    provider: row.entry?.provider || normalizedProvider,
    accountRef: row.accountRef,
    label: row.label
  }), [normalizedProvider]);

  const openSingle = useCallback((row: ProviderNetworkRow) => {
    setConfiguring({
      title: `设置出口 · ${row.label}`,
      targets: [targetFor(row)],
      upstream: row.upstream
    });
  }, [targetFor]);

  const openAll = useCallback(() => {
    if (!rows.length) return;
    setConfiguring({
      title: `为全部账号设置出口 · ${rows.length} 个账号`,
      targets: rows.map(targetFor),
      upstream: providerUpstreams.length === 1 ? providerUpstreams[0] : null
    });
  }, [providerUpstreams, rows, targetFor]);

  const refreshNetwork = async () => {
    setBusy('network');
    try {
      await egressUpstreamAPI.refreshNetwork();
      message.success('本机出口位置已更新');
      await load();
    } catch (refreshError) {
      message.error(describeError(refreshError));
    } finally {
      setBusy('');
    }
  };

  const restoreDefault = async (row: ProviderNetworkRow) => {
    setBusy(`restore:${row.accountRef}`);
    try {
      await accountsAPI.saveAccountEgress(row.entry?.provider || normalizedProvider, row.accountRef, null);
      message.success('已恢复默认网络（OAuth 授权网络）');
      await load();
    } catch (restoreError) {
      message.error(describeError(restoreError));
    } finally {
      setBusy('');
    }
  };

  const testConnection = async (row: ProviderNetworkRow) => {
    if (!row.upstream) {
      message.warning('该账号没有可探测的上游主机');
      return;
    }
    setBusy(`probe:${row.accountRef}`);
    try {
      const result = await egressUpstreamAPI.probeAccount(row.upstream.id, row.accountRef);
      setProbes((current) => ({ ...current, [row.accountRef]: result }));
      if (result.status === 'reachable') message.success('连接可用');
      else if (result.status === 'blocked') message.warning(`连接不可用：${result.reason || result.error || '被拒绝'}`);
      else message.info(result.reason || result.error || '本次未执行探测');
      await load();
    } catch (probeError) {
      message.error(describeError(probeError));
    } finally {
      setBusy('');
    }
  };

  const probeNodes = async (nodes: string[]) => {
    const upstream = configuring?.upstream;
    if (!upstream) return;
    setProbingNodes(true);
    try {
      await egressUpstreamAPI.probe(upstream.id, nodes);
    } catch (probeError) {
      message.error(describeError(probeError));
    } finally {
      setProbingNodes(false);
    }
  };

  const columns: ColumnsType<ProviderNetworkRow> = [
    {
      title: '账号',
      key: 'account',
      render: (_value, row) => (
        <div className="pn-account">
          <span>{row.label}</span>
          {row.label !== row.accountRef ? <small>{row.accountRef}</small> : null}
        </div>
      )
    },
    {
      title: '出口',
      key: 'egress',
      width: 190,
      render: (_value, row) => {
        const egress = describeRowEgress(row);
        return (
          <div className="pn-cell">
            <Tag bordered={false} color={TONE_COLOR[egress.tone]}>{egress.label}</Tag>
            <small>{egress.detail}</small>
          </div>
        );
      }
    },
    {
      title: '当前网络',
      key: 'network',
      width: 220,
      render: (_value, row) => {
        const network = describeRowNetwork(row);
        return (
          <Tooltip title={network.detail}>
            <div className="pn-cell">
              <span className="pn-network-text">{network.geoText}</span>
              <Tag bordered={false} color={TONE_COLOR[network.verdictTone]}>{network.verdictLabel}</Tag>
            </div>
          </Tooltip>
        );
      }
    },
    {
      title: '最近测试',
      key: 'probe',
      width: 200,
      render: (_value, row) => {
        const result = probes[row.accountRef];
        if (!result) return <span className="pn-muted">未测试</span>;
        const summary = describeProbeResult(result);
        return (
          <Tooltip title={summary.detail}>
            <div className="pn-cell">
              <Tag bordered={false} color={TONE_COLOR[summary.tone]}>{summary.label}</Tag>
              <small className="pn-ellipsis">{summary.detail}</small>
            </div>
          </Tooltip>
        );
      }
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_value, row) => {
        const egress = describeRowEgress(row);
        return (
          <Space size={4}>
            <Tooltip title="设置这个账号的出口">
              <Button
                size="small"
                icon={<SettingOutlined />}
                onClick={() => openSingle(row)}
                aria-label={`设置 ${row.label} 的出口`}
              />
            </Tooltip>
            <Tooltip title="通过该账号当前出口真实请求一次上游">
              <Button
                size="small"
                icon={<ThunderboltOutlined />}
                loading={busy === `probe:${row.accountRef}`}
                disabled={!row.upstream}
                onClick={() => void testConnection(row)}
                aria-label={`测试 ${row.label} 的网络连接`}
              />
            </Tooltip>
            {egress.bound ? (
              <Tooltip title="恢复默认（OAuth 授权网络）">
                <Button
                  size="small"
                  icon={<UndoOutlined />}
                  loading={busy === `restore:${row.accountRef}`}
                  onClick={() => void restoreDefault(row)}
                  aria-label={`恢复 ${row.label} 的默认网络`}
                />
              </Tooltip>
            ) : null}
          </Space>
        );
      }
    }
  ];

  if (loading && !view && !accounts.length) {
    return <div className="pn pn--loading">正在读取账号与网络出口…</div>;
  }

  const direct = view?.network?.direct || null;

  return (
    <section className="pn" aria-label="网络与出口">
      <header className="pn-head">
        <div>
          <strong>网络与出口</strong>
          <span>
            官方账号需要可用网络。默认跟随 OAuth 授权时使用的服务端网络（直连或系统代理）；
            也可以为这个 Provider 或单个账号设置出口，设置后网关请求与 CLI 启动都会使用它。
          </span>
        </div>
        <Space size={6}>
          <Button
            size="small"
            icon={<GlobalOutlined />}
            loading={busy === 'network'}
            onClick={() => void refreshNetwork()}
          >
            重新检测本机出口
          </Button>
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            刷新
          </Button>
        </Space>
      </header>

      {error ? <InlineNote tone="error">网络出口读取失败：{error}</InlineNote> : null}

      <div className="pn-stats">
        <span>
          本机默认出口：
          <strong>{direct ? describeGeo(direct.geo) : '位置未知'}</strong>
          {direct?.stale ? <small className="pn-muted"> · 位置可能过期</small> : null}
        </span>
        <span>
          出口池：
          <strong>{view?.pool?.ready ? `${view.pool.nodeCount} 个节点` : '未启动'}</strong>
          {view?.pool?.ready && view.pool.geoKnown < view.pool.nodeCount
            ? <small className="pn-muted"> · {view.pool.nodeCount - view.pool.geoKnown} 个待查位置</small>
            : null}
        </span>
        <span>
          上游：
          <strong>{providerUpstreams.length ? providerUpstreams.map((upstream) => upstream.host).join('、') : '未发现'}</strong>
        </span>
      </div>

      <div className="pn-toolbar">
        <Button size="small" icon={<SettingOutlined />} disabled={!rows.length} onClick={openAll}>
          为全部账号设置出口
        </Button>
        <span className="pn-muted">
          {rows.length ? `共 ${rows.length} 个账号；未单独设置的账号跟随默认网络。` : '该 Provider 还没有账号。'}
        </span>
      </div>

      {rows.length ? (
        <Table
          className="pn-table"
          rowKey="accountRef"
          size="small"
          columns={columns}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 900 }}
        />
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该 Provider 暂无账号" />
      )}

      <div className="pn-upstreams">
        {providerUpstreams.map((upstream) => {
          const rules = collectProviderRules(upstream);
          return (
            <section className="pn-upstream" key={upstream.id} aria-label={`${upstream.host} 地区规则`}>
              <div className="pn-upstream-head">
                <strong>{upstream.host}</strong>
                <Tag bordered={false}>{upstream.official ? '官方' : '自定义'}</Tag>
                <span className="pn-muted">
                  允许 {upstream.summary.allowed} · 拒绝 {upstream.summary.denied} · 待查 {upstream.summary.pending}
                </span>
              </div>
              <div className="pn-rules">
                {rules.length ? rules.slice(0, 8).map((rule) => (
                  <Tooltip
                    key={rule.id}
                    title={[rule.note, rule.source === 'hint' ? '预置提示' : '用户规则'].filter(Boolean).join(' · ')}
                  >
                    <Tag bordered={false} color={rule.effect === 'deny' ? 'error' : 'success'}>
                      {rule.text}
                    </Tag>
                  </Tooltip>
                )) : (
                  <span className="pn-muted">没有地区限制规则（按出口位置默认放行）</span>
                )}
                {rules.length > 8 ? <span className="pn-muted">还有 {rules.length - 8} 条</span> : null}
              </div>
            </section>
          );
        })}
        {!providerUpstreams.length && view ? (
          <InlineNote tone="info">
            没有发现该 Provider 的上游主机：账号还没有可识别的官方端点，设置出口前先确认账号配置。
          </InlineNote>
        ) : null}
      </div>

      <BulkEgressModal
        open={Boolean(configuring)}
        title={configuring?.title}
        upstream={configuring?.upstream || null}
        groups={view?.groups || []}
        poolReady={Boolean(view?.pool?.ready)}
        targets={configuring?.targets || []}
        probing={probingNodes}
        onProbe={probeNodes}
        onClose={(changed) => {
          setConfiguring(null);
          if (changed) void load();
        }}
      />
    </section>
  );
}