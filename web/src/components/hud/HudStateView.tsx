import { memo, type ReactNode } from 'react';
import HudCube, { type HudCubeTone } from './HudCube';
import styles from './HudStateView.module.css';

export interface HudStateViewProps {
  variant?: 'empty' | 'loading';
  tone?: HudCubeTone;
  code?: string;
  title: ReactNode;
  description?: ReactNode;
  extra?: ReactNode;
  compact?: boolean;
  cubeSize?: number;
  className?: string;
}

/**
 * 通用 HUD 空状态 / 加载态组件：
 * 用可交互（empty）或果冻跳跃中（loading）的 3D 切面玻璃魔方替代单调灰图标/转圈。
 */
export const HudStateView = memo(function HudStateView({
  variant = 'empty',
  tone = 'cyan',
  code,
  title,
  description,
  extra,
  compact = false,
  cubeSize,
  className,
}: HudStateViewProps) {
  const resolvedSize = cubeSize ?? (compact ? 32 : 40);
  const resolvedCode = code ?? (variant === 'loading' ? 'SYS // SYNCING' : 'SYS // STANDBY');

  return (
    <div
      className={[
        styles.root,
        styles[`tone_${tone}`],
        compact ? styles.compact : '',
        className || '',
      ].filter(Boolean).join(' ')}
      role={variant === 'loading' ? 'status' : undefined}
      aria-live={variant === 'loading' ? 'polite' : undefined}
    >
      <HudCube
        size={resolvedSize}
        mode={variant === 'loading' ? 'loading' : 'empty'}
        tone={tone}
        interactive={variant === 'empty'}
        label={variant === 'empty' ? '点击弹跳全息魔方' : undefined}
      />
      {resolvedCode ? <span className={styles.code} aria-hidden="true">{resolvedCode}</span> : null}
      <div className={styles.title}>{title}</div>
      {description ? <p className={styles.description}>{description}</p> : null}
      {extra ? <div className={styles.actions}>{extra}</div> : null}
    </div>
  );
});

export default HudStateView;
