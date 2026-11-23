import { memo, type ReactNode } from 'react';
import { Tabs } from 'antd';
import {
  TOOLKIT_SECTIONS,
  TOOLKIT_SECTION_ITEMS,
  TOOLKIT_SECTION_LABELS,
  type ToolkitSection
} from './toolkit-navigation-config';
import ToolkitSecondaryNav from './ToolkitSecondaryNav';

export interface ToolkitNavigationShellProps {
  activeSection: ToolkitSection;
  secondarySelection: Record<ToolkitSection, string>;
  onSectionChange: (nextSection: ToolkitSection) => void;
  onPanelSelect: (section: ToolkitSection, panelId: string) => void;
  renderSectionPanel: (section: ToolkitSection, panelId: string) => ReactNode;
}

export const ToolkitNavigationShell = memo(function ToolkitNavigationShell({
  activeSection,
  secondarySelection,
  onSectionChange,
  onPanelSelect,
  renderSectionPanel
}: ToolkitNavigationShellProps) {
  return (
    <div className="toolkit-console hud-panel">
      <Tabs
        className="toolkit-primary-tabs"
        activeKey={activeSection}
        animated={false}
        onChange={(value) => onSectionChange(value as ToolkitSection)}
        destroyInactiveTabPane
        items={TOOLKIT_SECTIONS.map((section) => {
          const activePanelId = secondarySelection[section.key];
          return {
            key: section.key,
            label: (
              <span className="toolkit-primary-tab-label">
                <span className="toolkit-primary-tab-icon" aria-hidden="true">{section.icon}</span>
                <span>{section.label}</span>
              </span>
            ),
            children: (
              <div className="toolkit-console-body">
                <ToolkitSecondaryNav
                  sectionLabel={TOOLKIT_SECTION_LABELS[section.key]}
                  items={TOOLKIT_SECTION_ITEMS[section.key]}
                  activePanelId={activePanelId}
                  onSelect={(panelId) => onPanelSelect(section.key, panelId)}
                />
                {renderSectionPanel(section.key, activePanelId)}
              </div>
            )
          };
        })}
      />
    </div>
  );
});

export default ToolkitNavigationShell;
