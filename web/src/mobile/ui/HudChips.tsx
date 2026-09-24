import type { ReactNode } from 'react';

export interface HudChipItem {
  key: string;
  label: ReactNode;
  count?: number;
  icon?: ReactNode;
  disabled?: boolean;
}

interface Props {
  items: HudChipItem[];
  value: string;
  onChange: (key: string) => void;
  ariaLabel: string;
}

/** 横向滚动筛选条（单选）：切角芯片，选中为青色描边辉光。 */
export default function HudChips({ items, value, onChange, ariaLabel }: Props) {
  return (
    <div className="mhud-chips" role="tablist" aria-label={ariaLabel}>
      {items.map((item) => {
        const active = item.key === value;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={item.disabled}
            className={`mhud-chip${active ? ' is-active' : ''}`}
            onClick={() => onChange(item.key)}
          >
            {item.icon}
            <span>{item.label}</span>
            {typeof item.count === 'number' ? <span className="mhud-chip__count">{item.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
