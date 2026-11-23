import { useMemo, type CSSProperties } from 'react';
import { ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import Button from '@/components/ui/AppButton';
import PageScaffold from '@/components/ui/PageScaffold';
import AnimatedValue from '@/components/ui/AnimatedValue';
import ServiceWidgetGrid from '@/components/dashboard/ServiceWidgetGrid';
import DashboardHealthSummary from '@/components/dashboard/DashboardHealthSummary';
import DashboardProviderGroups from '@/components/dashboard/DashboardProviderGroups';
import DashboardRecentErrors from '@/components/dashboard/DashboardRecentErrors';
import { useGatewayDashboard } from '@/features/dashboard/use-gateway-dashboard';
import {
  buildChatJumpPath,
  buildRuntimeParams,
  formatPercent,
  getOverallHealth,
  getOverallHealthMeta,
  getSuccessTone,
  groupProviderRows,
  resolveDashboardNextAction,
  sumRunningQueue
} from '@/features/dashboard/dashboard-presentation';
import '../styles/unified.css';
import './Dashboard.css';

// 移动端（< 768px）由 web/src/mobile/pages/MobileDashboard.tsx 独立渲染，本页只承担桌面布局。
export default function Dashboard() {
  const navigate = useNavigate();
  const {
    status,
    metrics,
    accountByRef,
    webuiAccountsLoaded,
    accountHealth,
    loading,
    cooldownClearing,
    liveState,
    displayedUptimeSec,
    providerRows,
    routeRows,
    recentErrors,
    handleClearCooldown,
    handleRefreshDashboard
  } = useGatewayDashboard();

  const jumpToChat = (options: { projectPath?: string; sessionId?: string }) => {
    navigate(buildChatJumpPath(options));
  };

  const routeTotalMax = Math.max(routeRows[0]?.count || 0, 1);

  // 健康计算（口径与账号页一致：分母为全部持久化账号，分子为 display-state=healthy）
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
  const totalRequestsCount = Number(metrics?.totalRequests || 0);
  const successRateStatus = getSuccessTone(totalRequestsCount, metrics?.successRate);
  const totalQueueRunning = sumRunningQueue(status);
  const cooldownAccounts = Number(status?.cooldownAccounts || 0);

  const providerGroups = useMemo(() => groupProviderRows(providerRows), [providerRows]);
  const nextAction = useMemo(
    () => resolveDashboardNextAction({
      overallHealth,
      totalAccounts,
      degradedCount,
      cooldownAccounts,
      attentionProviders: providerGroups.attention
    }),
    [cooldownAccounts, degradedCount, overallHealth, providerGroups.attention, totalAccounts]
  );

  const runtimeParams = buildRuntimeParams(status, displayedUptimeSec);

  return (
    <PageScaffold
      ghost
      code="DASHBOARD"
      className="dash-page"
      title="网关仪表盘"
      subTitle="本地网关运行态、Provider 调度与队列概览。"
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
      <DashboardHealthSummary
        overallHealth={overallHealth}
        healthLabel={health.label}
        liveState={liveState}
        healthyAccounts={healthyAccounts}
        totalAccounts={totalAccounts}
        healthPct={healthPct}
        timeoutRate={status?.timeoutRate}
        backendName={status?.backend}
        displayedUptimeSec={displayedUptimeSec}
        nextAction={nextAction}
        cooldownClearing={cooldownClearing}
        onClearCooldown={handleClearCooldown}
        onOpenAccounts={() => navigate('/accounts')}
      />

      <div className="dash-kpi">
        <ServiceWidgetGrid
          widgets={[
            {
              title: '健康账号',
              value: `${healthyAccounts}/${totalAccounts}`,
              subtitle: totalAccounts > 0 ? `占比 ${healthPct}%` : '暂无账号',
              status: overallHealth === 'critical' ? 'error' : overallHealth === 'degraded' ? 'warning' : 'healthy',
              statusLabel: overallHealth === 'critical' ? '无可用' : overallHealth === 'degraded' ? '部分降级' : '正常',
              onClick: () => navigate('/accounts')
            },
            {
              title: '请求成功率',
              value: totalRequestsCount > 0 ? formatPercent(metrics?.successRate) : '—',
              subtitle: totalRequestsCount > 0 ? `累计 ${totalRequestsCount.toLocaleString()} 次` : '暂无请求',
              status: successRateStatus,
              statusLabel: successRateStatus === 'neutral' ? '暂无数据' : successRateStatus === 'healthy' ? '达标' : '偏低'
            },
            {
              title: '活跃队列',
              value: totalQueueRunning,
              subtitle: '当前并发执行中',
              status: totalQueueRunning > 10 ? 'warning' : 'healthy',
              statusLabel: totalQueueRunning > 10 ? '高负载' : '平稳',
              valueTone: 'accent'
            },
            {
              title: '需关注 Provider',
              value: providerGroups.attention.length,
              subtitle: `已接入 ${providerGroups.attention.length + providerGroups.healthy.length} 个`,
              status: providerGroups.attention.length > 0 ? 'warning' : 'healthy',
              statusLabel: providerGroups.attention.length > 0 ? '待排查' : '正常'
            }
          ]}
        />
      </div>

      <DashboardProviderGroups groups={providerGroups} />

      <DashboardRecentErrors
        errors={recentErrors}
        accountByRef={accountByRef}
        onJumpToChat={jumpToChat}
      />

      {routeRows.length > 0 ? (
        <section aria-label="热点路由">
          <div className="dash-block-title">热点路由</div>
          <div className="dash-route-list hud-panel">
            {routeRows.map((r) => (
              <div className="dash-route-item" key={r.key}>
                <div className="dash-route-line">
                  <span className="dash-route-name" title={r.route}>{r.route}</span>
                  <span className="dash-route-count"><AnimatedValue>{r.count}</AnimatedValue></span>
                </div>
                <div className="dash-bar dash-bar--slim">
                  <span
                    className="dash-bar-fill acc"
                    style={{ '--aih-fill': routeTotalMax > 0 ? r.count / routeTotalMax : 0 } as CSSProperties}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

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
