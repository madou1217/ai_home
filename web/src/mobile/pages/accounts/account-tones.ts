import type { HudTone } from '@/mobile/ui';
import type { AccountBadgeStatus } from '@/features/accounts/AccountBadges';
import { getUsageBarTone } from '@/components/account/UsageSnapshotCell';

/** 桌面 antd Badge 状态 → HUD 语义色（只映射真实状态）。 */
export function badgeStatusTone(status: AccountBadgeStatus | string): HudTone {
  if (status === 'success') return 'ok';
  if (status === 'warning') return 'warn';
  if (status === 'error') return 'err';
  if (status === 'processing') return 'info';
  return 'muted';
}

/** 剩余额度色调：与桌面额度条同一阈值（> 80 正常、> 30 注意、其余告警）。 */
export function remainingTone(value: number | null): HudTone {
  const tone = getUsageBarTone(value);
  if (tone === 'ok') return 'ok';
  if (tone === 'warn') return 'warn';
  if (tone === 'danger') return 'err';
  return 'muted';
}

/** LED 类名：muted 用基础灯（无状态色）。 */
export function ledClass(tone: HudTone, live = false): string {
  const toneClass = tone === 'muted' ? '' : ` hud-led--${tone}`;
  return `hud-led${toneClass}${live ? ' hud-led--live' : ''}`;
}
