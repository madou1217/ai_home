import type { ReactNode } from 'react';
import './mobile-cards.css';

export interface MobileStatItem {
  key: string;
  /** 指标名（小号弱色） */
  label: ReactNode;
  /** 主数值（大号加粗） */
  value: ReactNode;
  /** 补充说明（极小号弱色，一行） */
  hint?: ReactNode;
  /** 数值前的状态点颜色（可选） */
  dotColor?: string;
  /** 数值自定义颜色（如成本用绿色、告警用红色） */
  valueColor?: string;
}

/**
 * 移动端指标网格 —— 专为手机设计的统计块，替代桌面 StatisticCard.Group。
 *
 * 为什么不复用 StatisticCard.Group：它 direction="row" 会把 4 张卡强挤在一行，
 * 手机窄屏下中文标题被逐字竖排（「运/行/会/话」）。这里改成 2 列网格、数值不换行，
 * 视觉锚定站点 design-tokens（圆角/边框/间距/字重），与桌面同一套品牌语言。
 */
export default function MobileStatGrid({
  items,
  columns = 2,
}: {
  items: MobileStatItem[];
  columns?: 2 | 3;
}) {
  return (
    <div className="mobile-stat-grid" data-cols={columns}>
      {items.map((it) => (
        <div key={it.key} className="mobile-stat-tile">
          <div className="mobile-stat-label">
            {it.dotColor ? (
              <span className="mobile-stat-dot" style={{ background: it.dotColor }} />
            ) : null}
            <span>{it.label}</span>
          </div>
          <div
            className="mobile-stat-value"
            style={it.valueColor ? { color: it.valueColor } : undefined}
          >
            {it.value}
          </div>
          {it.hint ? <div className="mobile-stat-hint">{it.hint}</div> : null}
        </div>
      ))}
    </div>
  );
}
