import ServiceWidgetGrid from '@/components/dashboard/ServiceWidgetGrid';
import { useState } from 'react';
import { message, Tag, Tooltip } from 'antd';
import {
  ReloadOutlined,
  FolderOutlined,
  MessageOutlined,
  CopyOutlined,
  CheckOutlined,
  CompassOutlined,
  ArrowRightOutlined,
  SwapOutlined,
  WarningOutlined
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import Button from '@/components/ui/AppButton';
import PageScaffold from '@/components/ui/PageScaffold';
import type { Provider } from '@/types';
import ProviderIcon, { providerNames } from '@/components/chat/ProviderIcon';
import RuntimeStatusTag from '@/components/runtime/RuntimeStatusTag';
import { useGatewayDashboard } from '@/features/dashboard/use-gateway-dashboard';
import {
  buildChatJumpPath,
  buildRuntimeParams,
  describeErrorPipeline,
  extractProjectBasename,
  formatPercent,
  formatRecentErrorMessage,
  formatSessionShortId,
  formatUptime,
  getOverallHealth,
  getOverallHealthMeta,
  getRecentErrorProvider,
  getSuccessTone,
  normalizeQueueCount,
  resolveFriendlyAccountDisplay,
  sumRunningQueue,
  type ProviderRow
} from '@/features/dashboard/dashboard-presentation';
import '../styles/unified.css';
import './Dashboard.css';

// Hero 成功率数值的发光色调（纯展示映射，见 heroSuccessTone）
const HERO_VALUE_GLOW: Record<'healthy' | 'warning' | 'error' | 'neutral', string> = {
  healthy: 'hud-glow-success',
  warning: 'hud-glow-warning',
  error: 'hud-glow-danger',
  neutral: ''
};

// HUD 指示灯：与 health.dot 一一对应（纯展示映射），连接中用呼吸的 info 灯。
const HEALTH_LED_CLASS: Record<string, string> = {
  idle: 'hud-led--info hud-led--live',
  ok: 'hud-led--ok',
  warn: 'hud-led--warn',
  crit: 'hud-led--err'
};

// 移动端（< 768px）由 web/src/mobile/pages/MobileDashboard.tsx 独立渲染，本页只承担桌面布局。
export default function Dashboard() {
  const navigate = useNavigate();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const {
    status,
    metrics,
    accountByRef,
    webuiAccountsLoaded,
    accountHealth,
    loading,
    cooldownClearing,
    displayedUptimeSec,
    providerRows,
    routeRows,
    recentErrors,
    handleClearCooldown,
    handleRefreshDashboard
  } = useGatewayDashboard();

  const copyErrorText = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      message.success('错误详情已复制到剪贴板');
      setTimeout(() => {
        setCopiedKey((curr) => (curr === key ? null : curr));
      }, 2000);
    } catch (_err) {
      message.error('复制失败，请手动复制');
    }
  };

  const jumpToChat = (options: { projectPath?: string; sessionId?: string }) => {
    navigate(buildChatJumpPath(options));
  };

  const recentErrorRows = recentErrors.slice(0, 8).map((item, index) => ({ ...item, __key: `${item.at || 'unknown'}-${index}` }));

  const routeTotalMax = Math.max(routeRows[0]?.count || 0, 1);

  // ── 健康计算(口径与账号页一致:分母为全部持久化账号,分子为 display-state=healthy) ──
  const totalAccounts = accountHealth.total;
  const healthyAccounts = accountHealth.healthy;
  const degradedCount = Math.max(0, totalAccounts - healthyAccounts);
  const healthPct = totalAccounts > 0 ? Math.round((healthyAccounts / totalAccounts) * 100) : 0;
  const overallHealth = getOverallHealth({
    statusLoaded: Boolean(status),
    accountsLoaded: webuiAccountsLoaded,
    total: totalAccounts,
    healthy: healthyAccounts
  });
  const health = getOverallHealthMeta(overallHealth, degradedCount);
  const healthLedClass = HEALTH_LED_CLASS;
  // 成功率徽标阈值:无请求不评健康色;>=95% 健康,>=80% 告警,<80% 异常。
  const totalRequestsCount = Number(metrics?.totalRequests || 0);
  const successRateStatus = getSuccessTone(totalRequestsCount, metrics?.successRate);
  // Hero 成功率取自 status（与 KPI 条的 metrics 口径分开），色调按其自身数值、同一阈值映射
  const heroSuccessTone = getSuccessTone(status?.totalRequests, status?.successRate);
  const totalQueueRunning = sumRunningQueue(status);

  const runtimeParams = buildRuntimeParams(status, displayedUptimeSec);

  const renderProviderCard = (row: ProviderRow) => {
    const pct = row.total > 0 ? Math.round((row.active / row.total) * 100) : 0;
    const running = normalizeQueueCount(row.queue?.running);
    const queued = normalizeQueueCount(row.queue?.queued);
    const conc = normalizeQueueCount(row.queue?.maxConcurrency, 1);
    const offline = row.total === 0;
    const statusEntries = Object.entries(row.statuses || {}).filter(([, c]) => Number(c) > 0);
    return (
      <div className={`dash-pcard hud-panel hud-panel--sm${offline ? ' dash-pcard--offline' : ''}`} key={row.key}>
        <div className="dash-pcard-head">
          <ProviderIcon provider={row.provider} size={18} />
          <span className="dash-pcard-name">{providerNames[row.provider as keyof typeof providerNames] || row.provider}</span>
          <span className={`dash-pcard-ratio${pct < 100 && !offline ? ' warn' : ''}`}>{row.active}/{row.total}</span>
        </div>
        <div className="dash-bar">
          <span className={`dash-bar-fill${pct < 100 ? ' warn' : ''}`} style={{ width: `${offline ? 0 : pct}%` }} />
        </div>
        <div className="dash-pcard-stats">
          <span>队列 {running}/{queued}<i>并发 {conc}</i></span>
          <span>请求 {row.requests} · <b className="ok">✓{row.success}</b> · <b className="bad">✗{row.failures}</b></span>
        </div>
        {statusEntries.length > 0 ? (
          <div className="dash-pcard-tags">
            {statusEntries.map(([s, c]) => (
              <span key={s}><RuntimeStatusTag status={s} /> {c}</span>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <PageScaffold ghost code="DASHBOARD"
      className="dash-page"
      title="网关仪表盘"
      subTitle="展示本地 Server 调度、熔断、恢复和队列的真实运行态。"
      extra={[
        <Button key="clear" onClick={handleClearCooldown} loading={cooldownClearing}>
          清空冷却
        </Button>,
        <Button
          key="refresh"
          type="primary"
          icon={<ReloadOutlined />}
          onClick={handleRefreshDashboard}
          loading={loading}
        >
          刷新
        </Button>
      ]}
    >
      <div className="dash-kpi">
        <ServiceWidgetGrid
          widgets={[
            {
              title: "服务健康度",
              value: `${healthPct}%`,
              subtitle: `可用账号 ${healthyAccounts} / 总数 ${totalAccounts}`,
              status: overallHealth === 'critical' ? 'error' : overallHealth === 'degraded' ? 'warning' : 'healthy',
              trend: health.label,
            },
            {
              title: "总请求吞吐",
              value: totalRequestsCount.toLocaleString(),
              subtitle: totalRequestsCount > 0 ? `成功率 ${formatPercent(metrics?.successRate)}` : '暂无请求',
              status: successRateStatus,
              valueTone: 'accent',
            },
            {
              title: "并发排队中",
              value: totalQueueRunning,
              subtitle: "实时活跃 Session 队列",
              status: totalQueueRunning > 10 ? 'warning' : 'healthy',
            },
            {
              title: "运行时间",
              value: formatUptime(displayedUptimeSec),
              subtitle: `后端 ${status?.backend || 'Node'}`,
              status: 'healthy',
              valueTone: 'accent',
            },
          ]}
        />
      </div>
      {/* ── Hero:系统健康一眼概览 ── */}
      <div className={`dash-hero hud-panel dash-hero--${overallHealth}`}>
        <div className="dash-hero-head">
          <span className="dash-hero-status">
            <span className={`dash-dot dash-dot--${health.dot} hud-led ${healthLedClass[health.dot] || ''}`} />
            {health.label}
          </span>
          <span className="dash-hero-uptime">运行 {formatUptime(displayedUptimeSec)}</span>
        </div>
        <div className="dash-hero-body">
          <div className="dash-hero-metric">
            <div className={`dash-hero-value dash-hero-value--${heroSuccessTone} hud-display ${HERO_VALUE_GLOW[heroSuccessTone]}`}>{Number(status?.totalRequests || 0) > 0 ? formatPercent(status?.successRate) : '—'}</div>
            <div className="dash-hero-cap hud-label">{Number(status?.totalRequests || 0) > 0 ? '请求成功率' : '暂无请求'}</div>
          </div>
          <div className="dash-hero-side">
            <div className="dash-hero-health">
              <div className="dash-hero-health-row">
                <span>健康账号</span>
                <span><b>{healthyAccounts}</b> / {totalAccounts}</span>
              </div>
              <div className="dash-bar">
                <span className={`dash-bar-fill${healthPct < 100 ? ' warn' : ''}`} style={{ width: `${healthPct}%` }} />
              </div>
            </div>
            <div className="dash-hero-chips">
              <span className="dash-chip"><b>{status?.totalRequests || 0}</b> 请求</span>
              <span className="dash-chip"><b>{formatPercent(status?.timeoutRate)}</b> 超时</span>
              <span className="dash-chip"><b>{totalQueueRunning}</b> 运行中</span>
            </div>
          </div>
        </div>
      </div>

      {status?.cooldownAccounts ? (
        <div className="dash-inline-note" role="status">
          <WarningOutlined className="dash-inline-note-icon" aria-hidden />
          <span>{`当前共有 ${status.cooldownAccounts} 个账号处于非健康态，已被调度层临时摘除。`}</span>
        </div>
      ) : null}

      {/* ── Provider 运行状态:健康卡片(手机竖排、桌面网格) ── */}
      <div className="dash-block-title">Provider 运行状态</div>
      <div className="dash-provider-grid">
        {providerRows.map(renderProviderCard)}
      </div>

      {/* ── 最近错误:有才显示 ── */}
      {recentErrorRows.length > 0 ? (
        <>
          <div className="dash-block-title">最近错误<span className="dash-block-count">{recentErrorRows.length}</span></div>
          <div className="dash-error-list">
            {recentErrorRows.map((item) => {
              const provider = getRecentErrorProvider(item);
              const account = item.accountRef ? accountByRef.get(item.accountRef) : undefined;
              const friendlyAccount = resolveFriendlyAccountDisplay(item, account);
              const projectBasename = extractProjectBasename(item.projectPath, item.projectDirName);
              const sessionShortId = formatSessionShortId(item.sessionId);
              const errorText = formatRecentErrorMessage(item);
              const isCopied = copiedKey === item.__key;

              const {
                sourceProtocolLabel,
                targetProviderLabel,
                isCrossRoute,
                displayRequestedModel,
                displayEffectiveModel,
                isAlias,
                showPipeline
              } = describeErrorPipeline(item);

              return (
                <div className="dash-error-item hud-panel hud-panel--sm" key={item.__key}>
                  <div className="dash-error-top">
                    <div className="dash-error-account-info">
                      {provider ? <ProviderIcon provider={provider as Provider} size={16} /> : null}
                      <span className="dash-error-account-label" title={friendlyAccount}>
                        {friendlyAccount}
                      </span>
                    </div>
                    <div className="dash-error-meta-right">
                      {item.at ? (
                        <span className="dash-error-time" title={item.at}>
                          {new Date(item.at).toLocaleTimeString()}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="dash-error-copy-btn"
                        onClick={() => copyErrorText(errorText, item.__key)}
                        title="复制错误详情"
                      >
                        {isCopied ? <CheckOutlined className="dash-error-copy-ok" /> : <CopyOutlined />}
                      </button>
                    </div>
                  </div>

                  {/* 调用链路与别名映射条（Cross-Provider 路由 / 模型别名链） */}
                  {showPipeline ? (
                    <div className="dash-error-pipeline">
                      {isCrossRoute ? (
                        <div className="dash-error-chain-step">
                          <span className="dash-chain-pill source">
                            {item.familyProvider ? <ProviderIcon provider={item.familyProvider as Provider} size={13} /> : null}
                            <span>{sourceProtocolLabel || item.familyProvider?.toUpperCase()}</span>
                          </span>
                          <ArrowRightOutlined className="dash-chain-arrow" />
                          <span className="dash-chain-pill target">
                            {provider ? <ProviderIcon provider={provider as Provider} size={13} /> : null}
                            <span>{targetProviderLabel}</span>
                          </span>
                        </div>
                      ) : (
                        <div className="dash-error-chain-step">
                          <span className="dash-chain-pill target">
                            {provider ? <ProviderIcon provider={provider as Provider} size={13} /> : null}
                            <span>{targetProviderLabel}</span>
                          </span>
                        </div>
                      )}

                      {isAlias && displayRequestedModel && displayEffectiveModel ? (
                        <div className="dash-error-alias-step">
                          <span className="dash-alias-pill req" title={`客户端请求模型: ${displayRequestedModel}`}>
                            {displayRequestedModel}
                          </span>
                          <SwapOutlined className="dash-chain-arrow" />
                          <span className="dash-alias-pill eff" title={`实际生效模型: ${displayEffectiveModel}`}>
                            {displayEffectiveModel}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {/* 上下文元信息徽标：模型、项目、会话、路由 */}
                  <div className="dash-error-chips">
                    {item.model && !isAlias ? (
                      <Tag className="dash-error-tag dash-error-tag--model" title={`请求模型: ${item.model}`}>
                        {item.model}
                      </Tag>
                    ) : null}

                    {item.projectPath ? (
                      <Tooltip title={`项目路径: ${item.projectPath} (点击在会话中打开)`}>
                        <Tag
                          className="dash-error-tag dash-error-tag--project clickable"
                          icon={<FolderOutlined />}
                          onClick={() => jumpToChat({ projectPath: item.projectPath })}
                        >
                          {projectBasename}
                        </Tag>
                      </Tooltip>
                    ) : null}

                    {item.sessionId ? (
                      <Tooltip title={`会话 ID: ${item.sessionId} (点击直达该会话)`}>
                        <Tag
                          className="dash-error-tag dash-error-tag--session clickable"
                          icon={<MessageOutlined />}
                          onClick={() => jumpToChat({ projectPath: item.projectPath, sessionId: item.sessionId })}
                        >
                          {sessionShortId}
                        </Tag>
                      </Tooltip>
                    ) : null}

                    {item.route && item.route !== '/v1/chat/completions' ? (
                      <Tag className="dash-error-tag dash-error-tag--route" icon={<CompassOutlined />}>
                        {item.route}
                      </Tag>
                    ) : null}
                  </div>

                  {/* 错误消息正文 */}
                  <div className="dash-error-msg">{errorText}</div>
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      {/* ── 热点路由:有才显示,用占比条 ── */}
      {routeRows.length > 0 ? (
        <>
          <div className="dash-block-title">热点路由</div>
          <div className="dash-route-list hud-panel">
            {routeRows.map((r) => (
              <div className="dash-route-item" key={r.key}>
                <div className="dash-route-line">
                  <span className="dash-route-name" title={r.route}>{r.route}</span>
                  <span className="dash-route-count">{r.count}</span>
                </div>
                <div className="dash-bar dash-bar--slim">
                  <span className="dash-bar-fill acc" style={{ width: `${Math.round((r.count / routeTotalMax) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {/* ── 运行参数:降级为可折叠紧凑区(静态配置、低频关注) ── */}
      <details className="dash-params hud-panel">
        <summary>服务运行参数</summary>
        <div className="dash-params-grid">
          {runtimeParams.map(([k, v]) => (
            <div className="dash-param" key={k}>
              <span className="dash-param-k">{k}</span>
              <span className="dash-param-v">{v}</span>
            </div>
          ))}
        </div>
      </details>
    </PageScaffold>
  );
}
