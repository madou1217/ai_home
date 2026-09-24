import type { KeyboardEvent, ReactNode } from 'react';

export type HudTone = 'ok' | 'warn' | 'err' | 'info' | 'muted';

interface Props {
  children: ReactNode;
  title?: ReactNode;
  code?: string;
  extra?: ReactNode;
  /** 状态色：影响左上角标与标题发光 */
  tone?: HudTone;
  /** 选中 / 激活态（青色描边 + 辉光） */
  active?: boolean;
  onClick?: () => void;
  className?: string;
  ariaLabel?: string;
}

/** 移动端切角卡片：单列、全宽、缩比角标。可点击时整卡为 ≥44px 的按压区域。 */
export default function HudCard({ children, title, code, extra, tone, active, onClick, className, ariaLabel }: Props) {
  const interactive = typeof onClick === 'function';
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick?.();
    }
  };
  return (
    <div
      className={['mhud-card', tone ? `mhud-card--${tone}` : '', active ? 'is-active' : '', interactive ? 'is-interactive' : '', className || '']
        .filter(Boolean)
        .join(' ')}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={ariaLabel}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {(title || code || extra) && (
        <div className="mhud-card__head">
          <div className="mhud-card__titles">
            {code ? <span className="mhud-card__code">{code}</span> : null}
            {title ? <span className="mhud-card__title">{title}</span> : null}
          </div>
          {extra ? <div className="mhud-card__extra">{extra}</div> : null}
        </div>
      )}
      {children}
    </div>
  );
}
