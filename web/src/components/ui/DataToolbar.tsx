import type { ReactNode } from 'react';

interface DataToolbarProps {
  filters?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export default function DataToolbar({ filters, actions, className = '' }: DataToolbarProps) {
  // 列表工具条固定为左筛选、右操作，后续表格/卡片列表复用同一布局。
  return (
    <div className={`data-toolbar ${className}`.trim()}>
      <div className="data-toolbar-filters">{filters}</div>
      <div className="data-toolbar-actions">{actions}</div>
    </div>
  );
}
