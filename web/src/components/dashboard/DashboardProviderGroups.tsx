import { memo, type CSSProperties } from 'react';
import AnimatedValue from '@/components/ui/AnimatedValue';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import ProviderIcon, { providerNames } from '@/components/chat/ProviderIcon';
import RuntimeStatusTag from '@/components/runtime/RuntimeStatusTag';
import {
  normalizeQueueCount,
  type ProviderRow,
  type ProviderRowGroups
} from '@/features/dashboard/dashboard-presentation';

export interface DashboardProviderGroupsProps {
  groups: ProviderRowGroups;
}

function renderProviderCard(row: ProviderRow, attention: boolean) {
  const pct = row.total > 0 ? Math.round((row.active / row.total) * 100) : 0;
  const running = normalizeQueueCount(row.queue?.running);
  const queued = normalizeQueueCount(row.queue?.queued);
  const conc = normalizeQueueCount(row.queue?.maxConcurrency, 1);
  const statusEntries = Object.entries(row.statuses || {}).filter(([, c]) => Number(c) > 0);
  const displayName = providerNames[row.provider as keyof typeof providerNames] || row.provider;

  return (
    <article
      className={`dash-pcard hud-panel hud-panel--sm${attention ? ' dash-pcard--attention' : ''}`}
      key={row.key}
    >
      <div className="dash-pcard-head">
        <ProviderIcon provider={row.provider} size={18} />
        <span className="dash-pcard-name">{displayName}</span>
        <span className={`dash-pcard-ratio${pct < 100 ? ' warn' : ''}`}>
          <AnimatedValue changeKey={`${row.active}/${row.total}`}>{row.active}/{row.total}</AnimatedValue>
        </span>
      </div>
      <div className="dash-bar">
        <span
          className={`dash-bar-fill${pct < 100 ? ' warn' : ''}`}
          style={{ '--aih-fill': pct / 100 } as CSSProperties}
        />
      </div>
      <div className="dash-pcard-stats">
        <span>队列 {running}/{queued}<i>并发 {conc}</i></span>
        <span>
          请求 {row.requests} · <b className="ok">成功 {row.success}</b>
          {row.failures > 0 ? <> · <b className="bad">失败 {row.failures}</b></> : null}
        </span>
      </div>
      {statusEntries.length > 0 ? (
        <div className="dash-pcard-tags">
          {statusEntries.map(([s, c]) => (
            <span key={s}><RuntimeStatusTag status={s} /> {c}</span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

/**
 * Provider 运行态分组：
 * - 需关注（降级或存在失败）优先展开并突出计数；
 * - 正常运行紧凑呈现；
 * - 未配置账号的 Provider 折叠收拢，避免首屏铺满空卡片墙。
 */
export const DashboardProviderGroups = memo(function DashboardProviderGroups({
  groups
}: DashboardProviderGroupsProps) {
  const activeCount = groups.attention.length + groups.healthy.length;

  return (
    <section className="dash-provider-section" aria-label="Provider 运行状态">
      <div className="dash-section-head">
        <div className="dash-block-title">Provider 运行状态</div>
        <div className="dash-section-tags">
          {groups.attention.length > 0 ? (
            <SettingStatusTag status="dirty" label={`需关注 ${groups.attention.length}`} compact live="off" />
          ) : null}
          <SettingStatusTag
            status={groups.healthy.length > 0 ? 'applied' : 'unset'}
            label={`正常 ${groups.healthy.length}`}
            compact
            live="off"
          />
          {groups.inactive.length > 0 ? (
            <SettingStatusTag status="unset" label={`未接入 ${groups.inactive.length}`} compact live="off" />
          ) : null}
        </div>
      </div>

      {groups.attention.length > 0 ? (
        <div className="dash-provider-group">
          <div className="dash-subgroup-label">需关注 · 存在降级或失败</div>
          <div className="dash-provider-grid">
            {groups.attention.map((row) => renderProviderCard(row, true))}
          </div>
        </div>
      ) : null}

      {groups.healthy.length > 0 ? (
        <div className="dash-provider-group">
          {groups.attention.length > 0 ? <div className="dash-subgroup-label">正常运行</div> : null}
          <div className="dash-provider-grid">
            {groups.healthy.map((row) => renderProviderCard(row, false))}
          </div>
        </div>
      ) : null}

      {activeCount === 0 ? (
        <div className="dash-provider-empty hud-panel hud-panel--sm">
          暂无已接入账号的 Provider，请前往「账号」页面添加。
        </div>
      ) : null}

      {groups.inactive.length > 0 ? (
        <details className="dash-inactive-providers hud-panel hud-panel--sm">
          <summary>
            <span>未接入 Provider（{groups.inactive.length}）</span>
            <span className="dash-inactive-preview">
              {groups.inactive
                .slice(0, 5)
                .map((row) => providerNames[row.provider as keyof typeof providerNames] || row.provider)
                .join(' · ')}
              {groups.inactive.length > 5 ? ' …' : ''}
            </span>
          </summary>
          <div className="dash-inactive-chips">
            {groups.inactive.map((row) => (
              <span className="dash-inactive-chip" key={row.key}>
                <ProviderIcon provider={row.provider} size={14} />
                <span>{providerNames[row.provider as keyof typeof providerNames] || row.provider}</span>
                <em>0 账号</em>
              </span>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
});

export default DashboardProviderGroups;
