import './account-status.css';
import { healthColorForRate } from './health';

// 色阶取样点：颜色在相邻取样点之间连续过渡（绿 → 黄 → 橙 → 红），不是离散的四档。
const LEGEND_RATES = [1, 0.98, 0.95, 0.9, 0.75, 0.5, 0];

export default function TierLegend({ className }: { className?: string }) {
  return (
    <div className={`account-status-legend${className ? ` ${className}` : ''}`} aria-label="成功率色阶">
      {LEGEND_RATES.map((rate) => (
        <span key={rate} className="account-status-legend__item">
          <span className="account-status-legend__swatch" style={{ background: healthColorForRate(rate) }} />
          {`${Math.round(rate * 100)}%`}
        </span>
      ))}
      <span className="account-status-legend__item">
        <span className="account-status-legend__swatch account-status-legend__swatch--none" />
        无数据
      </span>
    </div>
  );
}
