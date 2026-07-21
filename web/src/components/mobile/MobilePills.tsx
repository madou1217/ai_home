import type { ReactNode } from 'react';
import './mobile-pills.css';

export interface MobilePillItem {
  key: string;
  label: ReactNode;
}

interface Props {
  items: MobilePillItem[];
  activeKey: string;
  onChange: (key: string) => void;
  /** Optional trailing control rendered pinned to the right (e.g. a refresh button). */
  trailing?: ReactNode;
  /** Wrap onto multiple lines instead of horizontal-scrolling (use inside sheets/drawers). */
  wrap?: boolean;
}

/**
 * Native-mobile segmented selector: a single horizontally-scrollable row of
 * pills (touch-friendly, no cramped desktop tab strip). The active pill uses the
 * terracotta accent of the sessions design language.
 */
const MobilePills = ({ items, activeKey, onChange, trailing, wrap }: Props) => (
  <div className="mpills-wrap">
    <div className={`mpills${wrap ? ' wrap' : ''}`} role="tablist">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={item.key === activeKey}
          className={`mpill${item.key === activeKey ? ' active' : ''}`}
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
    {trailing ? <div className="mpills-trailing">{trailing}</div> : null}
  </div>
);

export default MobilePills;
