import type { ReactNode } from 'react';

export type ToolkitTrackTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface ToolkitStatusTrackItem {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: ToolkitTrackTone;
}

interface ToolkitStatusTrackProps {
  items: ToolkitStatusTrackItem[];
  ariaLabel?: string;
}

export default function ToolkitStatusTrack({
  items,
  ariaLabel = '工具状态轨道'
}: ToolkitStatusTrackProps) {
  return (
    <ol className="toolkit-status-track" aria-label={ariaLabel}>
      {items.map((item, index) => (
        <li key={`${item.label}-${index}`} data-tone={item.tone || 'neutral'}>
          <span className="toolkit-status-track-index" aria-hidden="true">
            {String(index + 1).padStart(2, '0')}
          </span>
          <span className="toolkit-status-track-copy">
            <span className="toolkit-status-track-label">{item.label}</span>
            <strong>{item.value}</strong>
            {item.detail && <small>{item.detail}</small>}
          </span>
        </li>
      ))}
    </ol>
  );
}
