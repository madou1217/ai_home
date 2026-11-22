import { useCallback, useEffect, useMemo, useState } from 'react';
import { Empty, Input, Select, Space, Switch, Table, Tag, Tooltip, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  GlobalOutlined,
  PlusOutlined,
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
import type {
  EgressAccountProbeResult,
  EgressDiagnostics,
  EgressRoutingPolicy,
  EgressRoutingRuleType,
  EgressRoutingAction,
  EgressRoutingTestResult,
  EgressStrategyStatus,
  EgressUpstream,
  EgressUpstreamView
} from '@/features/egress-upstream/types';
import { accountsAPI, toolkitAPI, watchEgressUpstreams } from '@/services/api';
import type { Account, AccountEgressMode, ProxyStatusResponse } from '@/types';
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
  initialMode?: AccountEgressMode;
  initialProxyUrl?: string;
  initialSshId?: string;
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

const ROUTE_LABELS: Record<string, string> = {
  tun: 'TUN',
  'system-proxy': '系统代理',
  'direct-unknown': '直连（未探测到代理）',
  unknown: '未知'
};

const TUN_LABELS: Record<string, string> = {
  active: 'TUN 已启用',
  inactive: 'TUN 未启用',
  unknown: 'TUN 未知'
};

const PROCESS_LABELS: Record<string, string> = {
  'clash-verge': 'Clash Verge',
  mihomo: 'mihomo',
  'sing-box': 'sing-box',
  'aih-core': 'AIH 出口池内核'
};

const POOL_PHASE_LABELS: Record<string, { label: string; color: 'success' | 'warning' | 'error' | 'default' | 'processing' }> = {
  stopped: { label: '未运行', color: 'default' },
  starting: { label: '启动中', color: 'processing' },
  ready: { label: '就绪', color: 'success' },
  degraded: { label: '降级', color: 'warning' },
  failed: { label: '失败', color: 'error' }
};

const CORE_SOURCE_LABELS: Record<string, string> = {
  managed: '托管内核',
  path: 'PATH 内核',
  client: '客户端自带内核'
};

const ROUTING_ACTION_LABELS: Record<string, string> = {
  proxy: '出口池',
  direct: '直连',
  reject: '拒绝'
};

const STRATEGY_LAYER_LABELS: Record<string, string> = {
  application: '应用层',
  system: '系统层',
  network: '网络层'
};

const STRATEGY_STATUS_LABELS: Record<string, { label: string; color: 'success' | 'warning' | 'default' }> = {
  ready: { label: '可用', color: 'success' },
  degraded: { label: '待补齐', color: 'warning' },
  unavailable: { label: '当前不可用', color: 'default' }
};

function firstProxy(...values: Array<string | undefined | null>) {
  return values.map((value) => String(value || '').trim()).find(Boolean) || '';
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
        const sshName = row.entry?.egress?.mode === 'ssh'
          ? sshNames[String(row.entry.egress.proxyUrl || '')]
          : '';
        return (
          <div className="pn-cell">
            <Tag bordered={false} color={TONE_COLOR[egress.tone]}>{egress.label}</Tag>
            <small>{sshName || egress.detail}</small>
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

      <section className="pn-layers" aria-label="代理层">
        <div className="pn-layer-head">
          <strong>代理层</strong>
          <span>网络层与系统层由操作系统/代理客户端决定；应用层按 Provider 与账号选择。AIH 只做只读诊断，不会接管外部代理内核。</span>
        </div>
        <div className="pn-layer-grid">
          <div className="pn-layer">
            <span className="pn-layer-name">网络层</span>
            <span className="pn-layer-value">
              <Tag bordered={false} color={proxyStatus?.layer?.tun.state === 'active' ? 'success' : 'default'}>
                {TUN_LABELS[proxyStatus?.layer?.tun.state || ''] || 'TUN 未知'}
              </Tag>
              <span>{ROUTE_LABELS[proxyStatus?.layer?.effectiveRoute || ''] || proxyStatus?.layer?.effectiveRoute || '未知'}</span>
            </span>
            <small>
              {proxyStatus?.layer?.tun.owner
                ? `归属 ${proxyStatus.layer.tun.owner}`
                : proxyStatus?.layer?.tun.interfaceDetected ? '检测到虚拟网卡' : '未检测到虚拟网卡'}
            </small>
          </div>
          <div className="pn-layer">
            <span className="pn-layer-name">系统层</span>
            <span className="pn-layer-value">
              <Tag bordered={false} color={proxyStatus?.system?.enabled ? 'success' : 'default'}>
                {proxyStatus?.system?.enabled ? '系统代理已启用' : '系统代理未启用'}
              </Tag>
            </span>
            <small>
              {firstProxy(proxyStatus?.system?.httpsProxy, proxyStatus?.system?.httpProxy, proxyStatus?.system?.socksProxy) || '无系统代理'}
            </small>
            <small>
              环境代理：{firstProxy(proxyStatus?.env?.httpsProxy, proxyStatus?.env?.httpProxy, proxyStatus?.env?.allProxy) || '未设置'}
            </small>
          </div>
          <div className="pn-layer">
            <span className="pn-layer-name">工具层</span>
            <small>Git：{firstProxy(proxyStatus?.tools?.git?.httpsProxy, proxyStatus?.tools?.git?.httpProxy) || '未设置'}</small>
            <small>npm：{firstProxy(proxyStatus?.tools?.npm?.httpsProxy, proxyStatus?.tools?.npm?.httpProxy) || '未设置'}</small>
          </div>
          <div className="pn-layer">
            <span className="pn-layer-name">网关层</span>
            <small>{proxyStatus?.gateway?.proxyUrl ? `上游代理 ${proxyStatus.gateway.proxyUrl}` : '未设置（直连/系统网络）'}</small>
            <small>no_proxy：{proxyStatus?.gateway?.noProxy || '未设置'}</small>
          </div>
          <div className="pn-layer">
            <span className="pn-layer-name">应用层</span>
            <small>下方账号出口；未绑定时跟随 OAuth 授权网络。</small>
          </div>
        </div>
      </section>

      <section className="pn-strategies" aria-label="出口策略">
        <div className="pn-layer-head">
          <strong>出口策略</strong>
          <span>服务端策略目录与当前可用性；新增策略只需加一条声明，页面会自动出现。</span>
        </div>
        <div className="pn-strategy-grid">
          {strategies.map((strategy) => {
            const status = STRATEGY_STATUS_LABELS[strategy.status] || STRATEGY_STATUS_LABELS.unavailable;
            return (
              <div className="pn-strategy" data-status={strategy.status} key={strategy.id}>
                <div className="pn-strategy-head">
                  <strong>{strategy.label}</strong>
                  <Tag bordered={false} color={status.color}>{status.label}</Tag>
                </div>
                <div className="pn-strategy-meta">
                  <Tag bordered={false}>{STRATEGY_LAYER_LABELS[strategy.layer] || strategy.layer}</Tag>
                  {strategy.requiresMihomo ? <Tag bordered={false}>mihomo</Tag> : null}
                  {strategy.requiresSsh ? <Tag bordered={false}>SSH</Tag> : null}
                  <span className="pn-muted">
                    {strategy.boundAccounts ? `${strategy.boundAccounts} 个账号使用` : '暂无账号使用'}
                  </span>
                </div>
                <p>{strategy.description}</p>
                {strategy.reason ? <small>{strategy.reason}</small> : null}
                <Button
                  size="small"
                  type="link"
                  className="pn-strategy-action"
                  disabled={!rows.length || strategy.status === 'unavailable'}
                  onClick={() => openStrategy(strategy)}
                >
                  应用到全部账号
                </Button>
              </div>
            );
          })}
          {!strategies.length ? <span className="pn-muted">策略目录暂不可用；出口弹窗会再次尝试读取服务端目录。</span> : null}
        </div>
      </section>

      {routing ? (
        <section className="pn-routing" aria-label="路由与 DNS">
          <div className="pn-layer-head">
            <strong>路由与 DNS</strong>
            <span>规则按顺序匹配；proxy=当前账号车道，direct=直连，reject=拒绝。规则对 sing-box 每条车道分别生效；mihomo 内核使用全局规则，车道可能优先。</span>
          </div>
          <div className="pn-rule-list">
            {routing.rules.length ? routing.rules.map((rule, index) => (
              <div className="pn-rule-row" key={rule.id}>
                <Select
                  size="small"
                  value={rule.type}
                  options={[
                    { value: 'domain', label: '精确域名' },
                    { value: 'domain-suffix', label: '域名后缀' },
                    { value: 'domain-keyword', label: '域名关键词' },
                    { value: 'ip-cidr', label: 'IP 段' }
                  ]}
                  onChange={(value) => updateRoutingRule(index, { type: value as EgressRoutingRuleType })}
                />
                <Input
                  size="small"
                  value={rule.value}
                  placeholder={rule.type === 'ip-cidr' ? '10.0.0.0/8' : 'example.com'}
                  onChange={(event) => updateRoutingRule(index, { value: event.target.value })}
                />
                <Select
                  size="small"
                  value={rule.action}
                  options={[
                    { value: 'proxy', label: '出口池' },
                    { value: 'direct', label: '直连' },
                    { value: 'reject', label: '拒绝' }
                  ]}
                  onChange={(value) => updateRoutingRule(index, { action: value as EgressRoutingAction })}
                />
                <Tooltip title="上移">
                  <Button size="small" icon={<ArrowUpOutlined />} disabled={index === 0} onClick={() => moveRoutingRule(index, -1)} aria-label="上移规则" />
                </Tooltip>
                <Tooltip title="下移">
                  <Button size="small" icon={<ArrowDownOutlined />} disabled={index === routing.rules.length - 1} onClick={() => moveRoutingRule(index, 1)} aria-label="下移规则" />
                </Tooltip>
                <Tooltip title="删除">
                  <Button size="small" danger icon={<DeleteOutlined />} onClick={() => removeRoutingRule(index)} aria-label="删除规则" />
                </Tooltip>
              </div>
            )) : <span className="pn-muted">没有自定义规则；所有流量走出口池。</span>}
          </div>
          <div className="pn-routing-actions">
            <Button size="small" icon={<PlusOutlined />} onClick={addRoutingRule}>添加规则</Button>
          </div>
          <div className="pn-route-test">
            <span className="pn-layer-name">测试</span>
            <Input
              size="small"
              value={routingTestTarget}
              placeholder="api.example.com / 10.0.0.0/8"
              onChange={(event) => setRoutingTestTarget(event.target.value)}
              onPressEnter={() => void testRouting()}
            />
            <Button size="small" loading={routingTesting} onClick={() => void testRouting()}>测试已保存规则</Button>
            {routingTestResult ? (
              <Tag bordered={false} color={routingTestResult.matched ? (routingTestResult.action === 'reject' ? 'error' : routingTestResult.action === 'direct' ? 'default' : 'success') : 'success'}>
                {routingTestResult.matched
                  ? `${ROUTING_ACTION_LABELS[routingTestResult.action] || routingTestResult.action} · ${routingTestResult.type} ${routingTestResult.value}`
                  : '未命中 · 出口池'}
              </Tag>
            ) : null}
          </div>
          <div className="pn-dns-row">
            <span className="pn-layer-name">DNS</span>
            <Select
              size="small"
              value={routing.dns.mode}
              options={[
                { value: 'default', label: '内核默认' },
                { value: 'doh', label: 'DoH' },
                { value: 'plain', label: 'UDP' }
              ]}
              onChange={(value) => updateRoutingDNS({ mode: value as EgressRoutingPolicy['dns']['mode'] })}
            />
            {routing.dns.mode !== 'default' ? (
              <>
                <Input
                  size="small"
                  value={routing.dns.servers.join(',')}
                  placeholder={routing.dns.mode === 'doh' ? 'https://1.1.1.1/dns-query' : '223.5.5.5'}
                  onChange={(event) => updateRoutingDNS({ servers: event.target.value.split(',').map((item) => item.trim()) })}
                />
                <Select
                  size="small"
                  value={routing.dns.route}
                  options={[
                    { value: 'proxy', label: '经出口池' },
                    { value: 'direct', label: '直连' }
                  ]}
                  onChange={(value) => updateRoutingDNS({ route: value as EgressRoutingPolicy['dns']['route'] })}
                />
              </>
            ) : null}
          </div>
          <div className="pn-routing-foot">
            <span className="pn-routing-restart">
              <Switch size="small" checked={routingRestart} onChange={setRoutingRestart} /> 保存后重启出口池
            </span>
            <Button size="small" type="primary" loading={routingSaving} onClick={() => void saveRouting()}>
              保存路由/DNS
            </Button>
          </div>
          {routingStatus ? (
            <InlineNote tone={routingStatusTone === 'success' ? 'success' : routingStatusTone === 'error' ? 'error' : 'info'}>
              {routingStatus}
            </InlineNote>
          ) : null}
        </section>
      ) : null}

      {diagnostics ? (
        <section className="pn-diagnostics" aria-label="代理冲突检测">
          <div className="pn-upstream-head">
            <strong>冲突检测</strong>
            {(() => {
              const phase = POOL_PHASE_LABELS[diagnostics.pool.phase || ''] || POOL_PHASE_LABELS.stopped;
              return <Tag bordered={false} color={phase.color}>{phase.label}</Tag>;
            })()}
            {diagnostics.pool.mixedPort ? (
              <span className="pn-muted">端口 {diagnostics.pool.mixedPort}/{diagnostics.pool.controllerPort}</span>
            ) : null}
            {typeof diagnostics.pool.freshHealthy === 'number' ? (
              <span className="pn-muted">新鲜健康 {diagnostics.pool.freshHealthy} 个</span>
            ) : null}
            {diagnostics.pool.corePid ? (
              <span className="pn-muted">
                core pid {diagnostics.pool.corePid}{diagnostics.pool.coreVerified ? ' · 已验证' : ' · 身份未知'}
                {diagnostics.pool.coreKind ? ` · ${diagnostics.pool.coreKind}${diagnostics.pool.coreVersion ? ' ' + diagnostics.pool.coreVersion : ''}` : ''}
                {diagnostics.pool.coreSource ? ` · ${CORE_SOURCE_LABELS[diagnostics.pool.coreSource] || diagnostics.pool.coreSource}` : ''}
              </span>
            ) : null}
          </div>
          {diagnostics.conflicts.length ? (
            <InlineNote tone="error">{diagnostics.conflicts.join('；')}</InlineNote>
          ) : (
            <InlineNote tone="success">没有检测到端口或进程身份冲突；AIH 不会接管或结束外部代理内核。</InlineNote>
          )}
          {diagnostics.processes.length ? (
            <div className="pn-rules">
              {diagnostics.processes.map((process) => (
                <Tag bordered={false} key={`${process.kind}:${process.pid}`}>
                  {PROCESS_LABELS[process.kind] || process.kind} · pid {process.pid}
                </Tag>
              ))}
            </div>
          ) : null}
          {diagnostics.notes.map((note) => <span className="pn-muted" key={note}>{note}</span>)}
        </section>
      ) : null}

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