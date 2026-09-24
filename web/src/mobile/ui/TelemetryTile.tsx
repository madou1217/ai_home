import type { ReactNode } from 'react';
import type { HudTone } from './HudCard';

interface Props {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  tone?: HudTone;
  /** 显示状态灯；'live' 为呼吸灯（仅用于真实的实时 / 运行中状态） */
  led?: boolean | 'live';
  sub?: ReactNode;
  /** 0–100 细轨；缺省不显示 */
  track?: number | null;
  onClick?: () => void;
  wide?: boolean;
}

/** 遥测卡：大号等宽数值 + 状态灯 + 大写标签 + 可选细轨。 */
export default function TelemetryTile({ label, value, unit, tone = 'info', led, sub, track, onClick, wide }: Props) {
  const content = (
    <>
      <span className="mhud-tile__label">
        {led ? <span className={`hud-led hud-led--${tone === 'muted' ? 'info' : tone}${led === 'live' ? ' hud-led--live' : ''}`} /> : null}
        {label}
      </span>
      <span className={`mhud-tile__value mhud-tone--${tone}`}>
        {value}
        {unit ? <span className="mhud-tile__unit">{unit}</span> : null}
      </span>
      {typeof track === 'number' && Number.isFinite(track) ? (
        <span className="mhud-track" aria-hidden="true">
          <span className={`mhud-track__fill mhud-bg--${tone}`} style={{ width: `${Math.max(0, Math.min(100, track))}%` }} />
        </span>
      ) : null}
      {sub ? <span className="mhud-tile__sub">{sub}</span> : null}
    </>
  );
  const className = `mhud-tile${wide ? ' mhud-tile--wide' : ''}`;
  if (onClick) {
    return (
      <button type="button" className={`${className} is-interactive`} onClick={onClick}>
        {content}
      </button>
    );
  }
  return <div className={className}>{content}</div>;
}

export function TelemetryGrid({ children }: { children: ReactNode }) {
  return <div className="mhud-tile-grid">{children}</div>;
}
