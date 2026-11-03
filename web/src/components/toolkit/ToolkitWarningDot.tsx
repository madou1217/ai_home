import { Tooltip } from 'antd';
import './ToolkitWarningDot.css';

export default function ToolkitWarningDot({ warning }: { warning?: string }) {
  if (!warning) return null;
  return (
    <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{warning}</span>} trigger={['hover', 'focus']}>
      <span className="toolkit-warning-dot" role="img" aria-label={warning} tabIndex={0}>
        <span className="hud-led hud-led--warn" aria-hidden="true" />
      </span>
    </Tooltip>
  );
}
