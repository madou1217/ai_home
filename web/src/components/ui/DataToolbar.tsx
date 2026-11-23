import type { ReactNode } from 'react';

interface DataToolbarProps {
  filters?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export default function DataToolbar({ filters, actions, className = '' }: DataToolbarProps) {
  // 列表工具条固定为左筛选、右操作，空槽不渲染占位，窄屏自动折行。
  return (
    <div className={`data-toolbar ${className}`.trim()}>
      {filters ? <div className="data-toolbar-filters">{filters}</div> : null}
      {actions ? <div className="data-toolbar-actions">{actions}</div> : null}
    </div>
  );
}
