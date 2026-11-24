import type { ReactNode } from 'react';
import './ToolkitPanels.css';

export interface ToolkitPanelHeaderProps {
  titleId: string;
  title: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
  extra?: ReactNode;
}

/**
 * Toolkit 子面板统一页头：一行短标题 + 一句短说明 + 右侧操作槽位。
 * 保持与 PageScaffold 一致的视觉克制，避免多行免责说明或无语义装饰。
 */
export default function ToolkitPanelHeader({
  titleId,
  title,
  subtitle,
  status,
  extra
}: ToolkitPanelHeaderProps) {
  return (
    <header className="toolkit-panel-header-v2">
      <div className="toolkit-panel-header-copy">
        <div className="toolkit-panel-header-title-row">
          <h2 id={titleId}>{title}</h2>
          {status}
        </div>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {extra ? <div className="toolkit-panel-header-extra">{extra}</div> : null}
    </header>
  );
}
