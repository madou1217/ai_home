import './account-status.css';
import type { HealthTier } from './types';

const LEGEND_ITEMS: Array<{ tier: HealthTier; label: string }> = [
  { tier: 'operational', label: '正常 ≥99%' },
  { tier: 'degraded', label: '轻微异常 ≥90%' },
  { tier: 'partial', label: '部分异常 ≥50%' },
  { tier: 'major', label: '严重异常 <50%' },
  { tier: 'none', label: '无数据' }
];

export default function TierLegend({ className }: { className?: string }) {
  return (
    <div className={`account-status-legend${className ? ` ${className}` : ''}`}>
      {LEGEND_ITEMS.map((item) => (
        <span key={item.tier} className="account-status-legend__item">
          <span className={`account-status-legend__swatch account-status-legend__swatch--${item.tier}`} />
          {item.label}
        </span>
      ))}
    </div>
  );
}
