import { memo } from 'react';
import { CheckOutlined } from '@ant-design/icons';
import type { ToolkitSecondaryItem } from './toolkit-navigation-config';

export interface ToolkitSecondaryNavProps {
  sectionLabel: string;
  items: ToolkitSecondaryItem[];
  activePanelId: string;
  onSelect: (panelId: string) => void;
}

export const ToolkitSecondaryNav = memo(function ToolkitSecondaryNav({
  sectionLabel,
  items,
  activePanelId,
  onSelect
}: ToolkitSecondaryNavProps) {
  return (
    <nav className="toolkit-secondary-nav" aria-label={`${sectionLabel}二级导航`}>
      <div className="toolkit-secondary-nav-head">
        <span className="toolkit-secondary-nav-label">{sectionLabel}</span>
        <span className="toolkit-secondary-nav-count" aria-hidden="true">{items.length}</span>
      </div>
      <div className="toolkit-secondary-nav-list">
        {items.map((item) => {
          const isActive = item.id === activePanelId;
          return (
            <button
              key={item.id}
              type="button"
              className="toolkit-secondary-nav-item"
              data-active={isActive || undefined}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onSelect(item.id)}
            >
              <span className="toolkit-secondary-nav-icon" aria-hidden="true">{item.icon}</span>
              <span className="toolkit-secondary-nav-text">{item.label}</span>
              {isActive ? (
                <CheckOutlined className="toolkit-secondary-nav-check" aria-hidden="true" />
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
});

export default ToolkitSecondaryNav;
