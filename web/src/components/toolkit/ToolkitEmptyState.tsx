import type { ReactNode } from 'react';
import './ToolkitPanels.css';

export interface ToolkitEmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

/**
 * 紧凑空状态：明确说明现状并提供唯一清晰下一步操作。
 */
export default function ToolkitEmptyState({ title, description, action }: ToolkitEmptyStateProps) {
  return (
    <div className="toolkit-panel-empty" role="status">
      <p className="toolkit-panel-empty-title">{title}</p>
      {description ? <p className="toolkit-panel-empty-desc">{description}</p> : null}
      {action ? <div>{action}</div> : null}
    </div>
  );
}
