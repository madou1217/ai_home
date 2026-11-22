import { useCallback, useEffect, useMemo, useState } from 'react';
import { Space, message } from 'antd';
import { GlobalOutlined, ReloadOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import BulkEgressModal from '@/features/egress-upstream/BulkEgressModal';
import ProviderNetworkLayers from './ProviderNetworkLayers';
import ProviderNetworkStrategies from './ProviderNetworkStrategies';
import ProviderNetworkRouting from './ProviderNetworkRouting';
import ProviderNetworkDiagnostics from './ProviderNetworkDiagnostics';
import ProviderNetworkTable from './ProviderNetworkTable';
import ProviderNetworkUpstreams from './ProviderNetworkUpstreams';
import { egressUpstreamAPI } from '@/features/egress-upstream/egress-upstream-api';
import { describeGeo } from '@/features/egress-upstream/egress-upstream-presentation';
import type { BulkEgressTarget } from '@/features/egress-upstream/bulk-egress';
import type {
  EgressAccountProbeResult,
  EgressDiagnostics,
  EgressRoutingPolicy,
  EgressRoutingTestResult,
  EgressStrategyStatus,
  EgressUpstream,
  EgressUpstreamView
} from '@/features/egress-upstream/types';
import { accountsAPI, toolkitAPI, watchEgressUpstreams } from '@/services/api';
import type { Account, AccountEgressMode, ProxyStatusResponse } from '@/types';
import { buildProviderNetworkRows, type ProviderNetworkRow } from './provider-network-model';
import './provider-network.css';

export interface ProviderNetworkSettingsProps {
  provider: string;
}

interface ConfiguringState {
  title: string;
  targets: BulkEgressTarget[];
  upstream: EgressUpstream | null;
  initialMode?: AccountEgressMode;
  initialProxyUrl?: string;
  initialSshId?: string;
}

function describeError(error: unknown): string {
  const response = (error as { response?: { data?: { message?: string; error?: string } } })?.response;
  return response?.data?.message || response?.data?.error || (error instanceof Error ? error.message : '请求失败');
}

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
  const [proxyStatus, setProxyStatus] = useState<ProxyStatusResponse | null>(null);
  const [diagnostics, setDiagnostics] = useState<EgressDiagnostics | null>(null);
  const [strategies, setStrategies] = useState<EgressStrategyStatus[]>([]);
  const [routing, setRouting] = useState<EgressRoutingPolicy | null>(null);
  const [routingRestart, setRoutingRestart] = useState(true);
  const [routingSaving, setRoutingSaving] = useState(false);
  const [routingTestTarget, setRoutingTestTarget] = useState('');
  const [routingTestResult, setRoutingTestResult] = useState<EgressRoutingTestResult | null>(null);
  const [routingTesting, setRoutingTesting] = useState(false);
  const [routingStatus, setRoutingStatus] = useState('');
  const [routingStatusTone, setRoutingStatusTone] = useState<'info' | 'success' | 'error'>('info');
  const [sshNames, setSshNames] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const [viewResult, accountsResult, proxyResult, diagnosticsResult, candidatesResult, strategiesResult, routingResult] = await Promise.allSettled([
      egressUpstreamAPI.view(),
      accountsAPI.list(),
      toolkitAPI.getProxy(),
      egressUpstreamAPI.diagnostics(),
      toolkitAPI.listProxyCandidates(),
      egressUpstreamAPI.strategies(),
      egressUpstreamAPI.routing()
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
    setProxyStatus(proxyResult.status === 'fulfilled' ? proxyResult.value : null);
    setDiagnostics(diagnosticsResult.status === 'fulfilled' ? diagnosticsResult.value : null);
    if (candidatesResult.status === 'fulfilled') {
      const names: Record<string, string> = {};
      for (const item of candidatesResult.value) {
        names[item.id] = item.name;
      }
      setSshNames(names);
    }
    setStrategies(strategiesResult.status === 'fulfilled' ? strategiesResult.value : []);
    if (routingResult.status === 'fulfilled') {
      setRouting(routingResult.value);
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
    const currentMode = row.entry?.egress?.mode;
    const currentValue = String(row.entry?.egress?.proxyUrl || '');
    const knownMode = currentMode && currentMode !== 'node' && currentMode !== 'group'
      ? currentMode as AccountEgressMode
      : undefined;
    setConfiguring({
      title: `设置出口 · ${row.label}`,
      targets: [targetFor(row)],
      upstream: row.upstream,
      initialMode: knownMode,
      initialProxyUrl: knownMode === 'url' ? currentValue : '',
      initialSshId: knownMode === 'ssh' ? currentValue : ''
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

  const openStrategy = useCallback((strategy: EgressStrategyStatus) => {
    if (!rows.length) return;
    setConfiguring({
      title: `${strategy.label} · 应用到全部账号`,
      targets: rows.map(targetFor),
      upstream: providerUpstreams.length === 1 ? providerUpstreams[0] : null,
      initialMode: strategy.id as AccountEgressMode
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

  const updateRoutingRule = useCallback((index: number, patch: Partial<EgressRoutingPolicy['rules'][number]>) => {
    setRouting((current) => {
      if (!current) return current;
      const rules = current.rules.map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, ...patch } : rule));
      return { ...current, rules };
    });
  }, []);

  const addRoutingRule = useCallback(() => {
    setRouting((current) => current ? {
      ...current,
      rules: [...current.rules, {
        id: `r${Date.now().toString(36)}`,
        type: 'domain-suffix',
        value: '',
        action: 'proxy'
      }]
    } : current);
  }, []);

  const removeRoutingRule = useCallback((index: number) => {
    setRouting((current) => current ? { ...current, rules: current.rules.filter((_, i) => i !== index) } : current);
  }, []);

  const moveRoutingRule = useCallback((index: number, delta: number) => {
    setRouting((current) => {
      if (!current) return current;
      const next = index + delta;
      if (next < 0 || next >= current.rules.length) return current;
      const rules = [...current.rules];
      [rules[index], rules[next]] = [rules[next], rules[index]];
      return { ...current, rules };
    });
  }, []);

  const updateRoutingDNS = useCallback((patch: Partial<EgressRoutingPolicy['dns']>) => {
    setRouting((current) => current ? { ...current, dns: { ...current.dns, ...patch } } : current);
  }, []);

  const testRouting = async () => {
    if (!routingTestTarget.trim()) return;
    setRoutingTesting(true);
    try {
      setRoutingTestResult(await egressUpstreamAPI.testRouting(routingTestTarget.trim()));
    } catch (error) {
      message.error(describeError(error));
      setRoutingTestResult(null);
    } finally {
      setRoutingTesting(false);
    }
  };

  const saveRouting = async () => {
    if (!routing) return;
    setRoutingSaving(true);
    setRoutingStatus('');
    try {
      const payload: EgressRoutingPolicy = {
        ...routing,
        dns: {
          ...routing.dns,
          servers: routing.dns.servers.map((server) => server.trim()).filter(Boolean)
        }
      };
      const result = await egressUpstreamAPI.saveRouting(payload, routingRestart);
      if (result.policy) setRouting(result.policy);
      if (result.applied === false) {
        setRoutingStatusTone('error');
        setRoutingStatus(result.error || '已保存，但出口池重启失败；下次池启动生效。');
        message.warning('已保存，但出口池重启失败');
      } else {
        const suffix = routingRestart && view?.pool?.ready ? '，出口池已重启。' : '；下次池启动生效。';
        setRoutingStatusTone('success');
        setRoutingStatus(`路由/DNS 已保存${suffix}`);
        message.success('路由/DNS 已保存');
        await load();
      }
    } catch (error) {
      setRoutingStatusTone('error');
      setRoutingStatus(describeError(error));
      message.error(describeError(error));
    } finally {
      setRoutingSaving(false);
    }
  };


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
            应用层可选出口池（mihomo）、SSH 出口（AWS 等，无需 mihomo）、代理地址、系统代理、
            外部 TUN 或直连；设置后网关请求与 CLI 启动都会使用它。
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

      <ProviderNetworkLayers proxyStatus={proxyStatus} />

      <ProviderNetworkStrategies
        strategies={strategies}
        canApply={rows.length > 0}
        onApply={openStrategy}
      />

      {routing ? (
        <ProviderNetworkRouting
          routing={routing}
          restart={routingRestart}
          onRestartChange={setRoutingRestart}
          saving={routingSaving}
          testTarget={routingTestTarget}
          onTestTargetChange={setRoutingTestTarget}
          testResult={routingTestResult}
          testing={routingTesting}
          status={routingStatus}
          statusTone={routingStatusTone}
          onUpdateRule={updateRoutingRule}
          onAddRule={addRoutingRule}
          onRemoveRule={removeRoutingRule}
          onMoveRule={moveRoutingRule}
          onUpdateDNS={updateRoutingDNS}
          onTest={() => void testRouting()}
          onSave={() => void saveRouting()}
        />
      ) : null}

      {diagnostics ? <ProviderNetworkDiagnostics diagnostics={diagnostics} /> : null}

      <ProviderNetworkTable
        rows={rows}
        probes={probes}
        busy={busy}
        sshNames={sshNames}
        onOpen={openSingle}
        onProbe={(row) => void testConnection(row)}
        onRestore={(row) => void restoreDefault(row)}
        onOpenAll={openAll}
      />

      <ProviderNetworkUpstreams upstreams={providerUpstreams} hasView={Boolean(view)} />

      <BulkEgressModal
        open={Boolean(configuring)}
        title={configuring?.title}
        initialMode={configuring?.initialMode}
        initialProxyUrl={configuring?.initialProxyUrl}
        initialSshId={configuring?.initialSshId}
        strategies={strategies}
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
