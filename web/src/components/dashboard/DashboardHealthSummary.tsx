import { memo, type CSSProperties } from 'react';
import { ArrowRightOutlined, ClearOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import SettingStatusTag, { type SettingStatusState } from '@/components/ui/SettingStatusTag';
import AnimatedValue from '@/components/ui/AnimatedValue';
import {
  formatPercent,
  formatUptime,
  type DashboardNextAction,
  type OverallHealth
} from '@/features/dashboard/dashboard-presentation';
import type { DashboardLiveState } from '@/features/dashboard/use-gateway-dashboard';

export interface DashboardHealthSummaryProps {
  overallHealth: OverallHealth;
  healthLabel: string;
  liveState: DashboardLiveState;
  healthyAccounts: number;
  totalAccounts: number;
  healthPct: number;
  timeoutRate?: number;
  backendName?: string;
  displayedUptimeSec: number | null;
  nextAction: DashboardNextAction;
  cooldownClearing: boolean;
  onClearCooldown: () => void;
  onOpenAccounts: () => void;
}

function resolveHealthStatus(health: OverallHealth): SettingStatusState {
  switch (health) {
    case 'healthy': return 'applied';
    case 'degraded': return 'dirty';
    case 'critical': return 'error';
    default: return 'saving';
  }
}

function resolveLiveLabel(liveState: DashboardLiveState): { status: SettingStatusState; label: string } {
  if (liveState === 'live') return { status: 'applied', label: '实时推送' };
  if (liveState === 'degraded') return { status: 'dirty', label: '轮询回退' };
  return { status: 'saving', label: '连接中' };
}

/**
 * 网关首屏健康结论条：用单一权威入口回答“网关是否健康、下一步做什么”，
 * 不与 KPI 条重复堆叠同一告警文案。
 */
export const DashboardHealthSummary = memo(function DashboardHealthSummary({
  overallHealth,
  healthLabel,
  liveState,
  healthyAccounts,
  totalAccounts,
  healthPct,
  timeoutRate,
  backendName,
  displayedUptimeSec,
  nextAction,
  cooldownClearing,
  onClearCooldown,
  onOpenAccounts
}: DashboardHealthSummaryProps) {
  const liveTag = resolveLiveLabel(liveState);

  return (
    <section
      className={`dash-summary hud-panel dash-summary--${overallHealth}`}
      aria-label="网关健康结论"
    >
      <div className="dash-summary-main">
        <div className="dash-summary-head">
          <SettingStatusTag status={resolveHealthStatus(overallHealth)} label={healthLabel} />
          <SettingStatusTag status={liveTag.status} label={liveTag.label} compact live="off" />
          <span className="dash-summary-meta">
            {backendName || 'Node'} · 运行 {formatUptime(displayedUptimeSec)}
          </span>
        </div>

        <p className="dash-summary-guidance">{nextAction.summary}</p>

        <div className="dash-summary-progress">
          <div className="dash-summary-progress-row">
            <span>健康账号占比</span>
            <span>
              <b><AnimatedValue>{healthyAccounts}</AnimatedValue></b> / {totalAccounts}
              {typeof timeoutRate === 'number' && timeoutRate > 0 ? ` · 超时 ${formatPercent(timeoutRate)}` : ''}
            </span>
          </div>
          <div className="dash-bar">
            <span
              className={`dash-bar-fill${healthPct < 100 ? ' warn' : ''}`}
              style={{ '--aih-fill': totalAccounts > 0 ? healthPct / 100 : 0 } as CSSProperties}
            />
          </div>
        </div>
      </div>

      {nextAction.kind !== 'none' && nextAction.actionLabel ? (
        <div className="dash-summary-action">
          {nextAction.kind === 'clear_cooldown' ? (
            <Button
              type="primary"
              size="small"
              icon={<ClearOutlined />}
              loading={cooldownClearing}
              onClick={onClearCooldown}
            >
              {nextAction.actionLabel}
            </Button>
          ) : (
            <Button
              type="primary"
              size="small"
              icon={<ArrowRightOutlined />}
              onClick={onOpenAccounts}
            >
              {nextAction.actionLabel}
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
});

export default DashboardHealthSummary;
