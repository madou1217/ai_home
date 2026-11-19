import type { ManagedAppItem } from '@/types';

/**
 * 首屏检查（onboarding preflight）只属于 Claude Code CLI：
 * Claude 桌面端不走 CLI 的首屏检查流程，IDE 集成也不由 aih 启动。
 *
 * 高级设置页签与卡片入口文案共用这一处判定，避免两处各自推导 provider/type。
 */
export function supportsClaudePreflight(
  app: Pick<ManagedAppItem, 'type' | 'provider'> | null | undefined
): boolean {
  return app?.type === 'cli' && app.provider === 'claude';
}
