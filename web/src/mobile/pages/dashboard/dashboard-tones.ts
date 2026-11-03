import type { HudTone } from '@/mobile/ui';
import type { OverallHealth, SuccessTone } from '@/features/dashboard/dashboard-presentation';

/** 成功率色调（healthy / warning / error / neutral）→ HUD 语义色。 */
export const SUCCESS_TONE: Record<SuccessTone, HudTone> = {
  healthy: 'ok',
  warning: 'warn',
  error: 'err',
  neutral: 'muted'
};

/** 整体健康（与桌面 hero 同一判定）→ HUD 语义色。 */
export const HEALTH_TONE: Record<OverallHealth, HudTone> = {
  loading: 'info',
  healthy: 'ok',
  degraded: 'warn',
  critical: 'err'
};

/** RuntimeStatusTag 的 antd 状态色 → HUD 语义色（只映射真实状态）。 */
export function runtimeColorTone(color: string): HudTone {
  if (color === 'success') return 'ok';
  if (color === 'warning') return 'warn';
  if (color === 'error') return 'err';
  return 'muted';
}
