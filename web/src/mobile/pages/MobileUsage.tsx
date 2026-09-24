import { useState } from 'react';
import { Button, Input, Select, Spin, message } from 'antd';
import { CopyOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import ProviderIcon, { providerIds, providerNames } from '@/components/chat/ProviderIcon';
import type { UsageBreakdownTarget } from '@/features/model-usage/UsageBreakdownDrawer';
import {
  formatAccountScope,
  formatCacheRate,
  formatCost,
  formatTokens
} from '@/features/model-usage/model-usage-presentation';
import {
  USAGE_RANGE_OPTIONS,
  formatUsageTime,
  type UsageProviderFilter,
  type UsageRangeMode
} from '@/features/model-usage/model-usage-query';
import { useModelUsageDashboard } from '@/features/model-usage/use-model-usage-dashboard';
import type { MobilePageProps } from '@/mobile/mobile-routes';
import {
  EmptySignal,
  HudChips,
  HudField,
  HudIconButton,
  HudSection,
  MobilePage,
  MobileToolbar,
  MonoList,
  SwipeRow,
  TelemetryGrid,
  TelemetryTile,
  type HudChipItem,
  type HudTone
} from '@/mobile/ui';
import UsageBreakdownSheet from './usage/UsageBreakdownSheet';
import UsageRequestDetails from './usage/UsageRequestDetails';
import UsageTrendStrip from './usage/UsageTrendStrip';
import styles from './MobileUsage.module.css';

const LOCAL_INPUT_FORMAT = 'YYYY-MM-DDTHH:mm';

// 与桌面一致：逐个真实 Provider 平铺（用量按真实 Provider 结算，不收敛到产品族）
const PROVIDER_CHIPS: HudChipItem[] = [
  { key: '', label: '全部' },
  ...providerIds.map((provider) => ({
    key: provider,
    label: providerNames[provider],
    icon: <ProviderIcon provider={provider} size={14} />
  }))
];

const providerLabel = (provider: string) => providerNames[provider as keyof typeof providerNames] || provider;

/**
 * 移动端模型用量（/usage）。数据层 useModelUsageDashboard 与桌面 ModelUsage 同一套 API：
 * modelUsageAPI.startDashboardQuery / watchDashboardQueries / cancelDashboardQuery / scan / watchScan /
 * breakdown / requests，以及 accountsAPI.list（账号名映射）。
 */
export default function MobileUsage(_props: MobilePageProps) {
  const usage = useModelUsageDashboard();
  const [view, setView] = useState<'model' | 'session'>('model');
  const {
    rangeMode,
    range,
    provider,
    model,
    stats,
    models,
    sessions,
    trend,
    loading,
    hasDashboardSnapshot,
    dashboardLoadError,
    dashboardStatusText,
    modelSelectOptions,
    totalCacheTokens,
    overallCacheHitRate,
    scanActive
  } = usage;

  const copySessionId = async (sessionId: string) => {
    const value = String(sessionId || '').trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      message.success('会话 ID 已复制');
    } catch {
      message.error('复制失败');
    }
  };

  const openBreakdown = (target: UsageBreakdownTarget) => {
    void usage.openBreakdown(target);
  };

  const applyCustomBound = (index: 0 | 1, raw: string) => {
    // datetime-local 的值是 ISO 本地时间（YYYY-MM-DDTHH:mm），dayjs 原生可解析
    const next = dayjs(raw);
    if (!raw || !next.isValid()) return;
    const start = index === 0 ? next : range[0];
    const end = index === 1 ? next : range[1];
    if (end.isAfter(dayjs().endOf('day'))) {
      message.warning('结束时间不能晚于今天');
      return;
    }
    if (!start.isBefore(end)) {
      message.warning('开始时间需早于结束时间');
      return;
    }
    usage.handleRangeChange([start, end]);
  };

  const statusTone: HudTone = loading ? 'info' : dashboardLoadError ? 'err' : 'ok';
  const statusCode = loading ? 'SYNC' : dashboardLoadError ? 'ERR' : scanActive ? 'SCAN' : 'READY';
  const statusText = dashboardStatusText
    || (scanActive ? '扫描进行中' : `${range[0].format('MM-DD HH:mm')} → ${range[1].format('MM-DD HH:mm')}`);

  const toolbar = (
    <MobileToolbar
      start={(
        <span className={styles.status} role="status" aria-live="polite">
          <span className="mhud-status">
            <span className={`hud-led hud-led--${statusTone}${loading || scanActive ? ' hud-led--live' : ''}`} />
            <span className={`mhud-tone--${statusTone}`}>{statusCode}</span>
          </span>
          <span className={`${styles.statusText}${dashboardLoadError && !loading ? ' mhud-tone--err' : ''}`}>{statusText}</span>
        </span>
      )}
    >
      <HudIconButton icon={<ReloadOutlined />} label="刷新" onClick={usage.handleRefreshUsage} loading={loading} />
      <HudIconButton icon={<SyncOutlined />} label="扫描" tone="primary" onClick={() => void usage.handleScan()} loading={scanActive} />
    </MobileToolbar>
  );

  const listRows = view === 'model' ? models : sessions;

  return (
    <MobilePage toolbar={toolbar}>
      <div className={styles.filters}>
        <HudChips
          ariaLabel="时间范围"
          value={rangeMode}
          onChange={(key) => usage.handleRangeModeChange(key as UsageRangeMode)}
          items={USAGE_RANGE_OPTIONS.map((option) => ({ key: option.value, label: option.label }))}
        />
        {rangeMode === 'custom' ? (
          <div className={styles.customRange}>
            <HudField label="开始">
              <Input
                type="datetime-local"
                aria-label="开始时间"
                value={range[0].format(LOCAL_INPUT_FORMAT)}
                max={range[1].format(LOCAL_INPUT_FORMAT)}
                onChange={(event) => applyCustomBound(0, event.target.value)}
              />
            </HudField>
            <HudField label="结束">
              <Input
                type="datetime-local"
                aria-label="结束时间"
                value={range[1].format(LOCAL_INPUT_FORMAT)}
                min={range[0].format(LOCAL_INPUT_FORMAT)}
                max={dayjs().endOf('day').format(LOCAL_INPUT_FORMAT)}
                onChange={(event) => applyCustomBound(1, event.target.value)}
              />
            </HudField>
          </div>
        ) : null}
        <HudChips
          ariaLabel="来源 Provider"
          value={provider}
          onChange={(key) => usage.handleProviderChange(key as UsageProviderFilter)}
          items={PROVIDER_CHIPS}
        />
        <HudField label="模型">
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="全部模型"
            value={model || undefined}
            onChange={usage.handleModelChange}
            options={modelSelectOptions}
            style={{ width: '100%' }}
          />
        </HudField>
      </div>

      <div className={`${styles.body}${loading && hasDashboardSnapshot ? ` ${styles.bodyRefreshing}` : ''}`} aria-busy={loading}>
        {dashboardLoadError && !loading && !hasDashboardSnapshot ? (
          <div className={styles.loadError} role="alert">
            <span className={styles.inlineError}>加载模型用量失败：{dashboardLoadError}</span>
            <Button icon={<ReloadOutlined />} onClick={usage.handleRefreshUsage}>重试</Button>
          </div>
        ) : null}

        <TelemetryGrid>
          <TelemetryTile
            wide
            label="总 Tokens"
            led={loading ? 'live' : true}
            tone="info"
            value={formatTokens(stats.totalTokens)}
            sub={`${stats.totalCalls} 次调用 · ${stats.totalSessions} 个会话`}
          />
          <TelemetryTile label="Input" tone="info" value={formatTokens(stats.inputTokens)} sub="未含缓存读写" />
          <TelemetryTile label="Output" tone="info" value={formatTokens(stats.outputTokens)} sub={`推理 ${formatTokens(stats.reasoningOutputTokens)}`} />
          <TelemetryTile
            label="Cache"
            tone="info"
            value={formatTokens(totalCacheTokens)}
            sub={`读 ${formatTokens(stats.cacheReadInputTokens)} · 写 ${formatTokens(stats.cacheCreationInputTokens)}`}
          />
          <TelemetryTile
            label="缓存率"
            tone="warn"
            value={formatCacheRate(overallCacheHitRate)}
            track={overallCacheHitRate == null ? null : overallCacheHitRate * 100}
            sub="读取 / 全部输入侧 Tokens"
          />
          <TelemetryTile wide label="估算成本" tone="ok" value={formatCost(stats.totalCostUsd)} sub="USD · 按当前价格快照" />
        </TelemetryGrid>

        <HudSection title="时间趋势" code="TREND">
          <UsageTrendStrip trend={trend} />
        </HudSection>

        <HudSection title="用量排行" code="RANK">
          <HudChips
            ariaLabel="用量维度"
            value={view}
            onChange={(key) => setView(key as 'model' | 'session')}
            items={[
              { key: 'model', label: '按模型', count: models.length },
              { key: 'session', label: '按会话', count: sessions.length }
            ]}
          />
          {loading && listRows.length === 0 ? (
            <div className={styles.listLoading}><Spin /></div>
          ) : listRows.length === 0 ? (
            <EmptySignal
              description="当前范围内暂无用量记录，可执行扫描同步本地用量。"
              action={<Button icon={<SyncOutlined />} loading={scanActive} onClick={() => void usage.handleScan()}>扫描</Button>}
            />
          ) : view === 'model' ? (
            <MonoList ariaLabel="按模型用量">
              {models.map((row) => (
                <SwipeRow
                  key={`${row.provider}:${row.model || 'unknown'}`}
                  onTap={() => openBreakdown({ kind: 'model', row })}
                  ariaLabel={`查看 ${row.model || '未知模型'} 的账号分量`}
                >
                  <span className="mhud-row__icon"><ProviderIcon provider={row.provider} size={18} /></span>
                  <span className="mhud-row__main">
                    <span className="mhud-row__title">{row.model || '未知模型'}</span>
                    <span className="mhud-row__meta">
                      {providerLabel(row.provider)} · {formatAccountScope(row.accountCount, row.unattributedCalls)} · {row.calls} 次
                    </span>
                  </span>
                  <span className="mhud-row__side">
                    <span className="mhud-tone--info">{formatTokens(row.totalTokens)}</span>
                    <span className={styles.cost}>{formatCost(row.costUsd)}</span>
                  </span>
                </SwipeRow>
              ))}
            </MonoList>
          ) : (
            <MonoList ariaLabel="按会话用量">
              {sessions.map((row) => (
                <SwipeRow
                  key={`${row.provider}:${row.sessionId}`}
                  onTap={() => openBreakdown({ kind: 'session', row })}
                  ariaLabel={`查看会话 ${row.project || row.sessionId} 的账号与模型分量`}
                  actions={[{
                    key: 'copy',
                    label: '复制 ID',
                    icon: <CopyOutlined />,
                    onAction: () => void copySessionId(row.sessionId)
                  }]}
                >
                  <span className="mhud-row__icon"><ProviderIcon provider={row.provider} size={18} /></span>
                  <span className="mhud-row__main">
                    <span className="mhud-row__title">{row.project || row.sessionId}</span>
                    <span className="mhud-row__meta">
                      {providerLabel(row.provider)} · {formatAccountScope(row.accountCount, row.unattributedCalls)} · {formatUsageTime(row.updatedAtMs)}
                    </span>
                  </span>
                  <span className="mhud-row__side">
                    <span className="mhud-tone--info">{formatTokens(row.totalTokens)}</span>
                    <span className={styles.cost}>{formatCost(row.costUsd)}</span>
                  </span>
                </SwipeRow>
              ))}
            </MonoList>
          )}
        </HudSection>

        <UsageRequestDetails
          usage={usage.requestUsage}
          errors={usage.requestErrors}
          requested={usage.requestDetailsRequested}
          loading={usage.requestDetailsLoading}
          error={usage.requestDetailsError}
          limit={usage.requestDetailLimit}
          onRequest={() => void usage.loadRequestDetails()}
        />
      </div>

      <UsageBreakdownSheet
        target={usage.breakdownTarget}
        data={usage.breakdown}
        loading={usage.breakdownLoading}
        accountsByRef={usage.accountsByRef}
        onClose={usage.closeBreakdown}
        onCopySessionId={(sessionId) => void copySessionId(sessionId)}
      />
    </MobilePage>
  );
}
