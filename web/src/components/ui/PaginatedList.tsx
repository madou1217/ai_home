import { Empty, Grid, Pagination } from 'antd';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import HudStateView from '@/components/hud/HudStateView';
import { useFlipReorder } from '@/hooks/use-flip-reorder';
import { useSurfaceSwitch } from '@/hooks/use-surface-switch';

interface PaginatedListProps<T> {
  items: T[];
  pageSize?: number;
  emptyText?: string;
  className?: string;
  renderItem: (item: T, index: number) => ReactNode;
}

export default function PaginatedList<T>({
  items,
  pageSize = 12,
  emptyText = '暂无数据',
  className = '',
  renderItem
}: PaginatedListProps<T>) {
  const [page, setPage] = useState(1);
  const { surfaceRef, switchSurface } = useSurfaceSwitch<HTMLDivElement>();
  const total = items.length;
  const safePageSize = Math.max(1, pageSize);
  const maxPage = Math.max(1, Math.ceil(total / safePageSize));
  // 数据变化导致当前页越界时，渲染时先收敛到最后一页。
  const currentPage = Math.min(page, maxPage);
  const visibleItems = useMemo(() => {
    const start = (currentPage - 1) * safePageSize;
    return items.slice(start, start + safePageSize);
  }, [currentPage, items, safePageSize]);
  const screens = Grid.useBreakpoint();
  // 筛选/排序后子项若带 data-flip-key，就从旧位置滑到新位置（见 hooks/use-flip-reorder.ts）。
  const flipRef = useFlipReorder<HTMLDivElement>(visibleItems);

  if (total === 0) {
    if (screens.md === false) {
      return <Empty description={emptyText} image={Empty.PRESENTED_IMAGE_SIMPLE} />;
    }
    return <HudStateView compact code="NO_ITEMS" title={emptyText} />;
  }

  return (
    <div className={`paginated-list ${className}`.trim()}>
      {/* 翻页由预提交 surface 切换驱动旧页离场 + 新页进场；页内重排仍由 FLIP 接管。 */}
      <div ref={surfaceRef} className="paginated-list-surface">
        <div ref={flipRef} className="paginated-list-grid aih-fade-in">
          {visibleItems.map((item, index) => renderItem(item, (currentPage - 1) * safePageSize + index))}
        </div>
      </div>
      {total > safePageSize ? (
        <div className="paginated-list-pagination">
          <Pagination
            size="small"
            current={currentPage}
            pageSize={safePageSize}
            total={total}
            showSizeChanger={false}
            responsive
            onChange={(nextPage) => {
              switchSurface(() => setPage(nextPage), {
                current: currentPage,
                next: nextPage,
                direction: nextPage > currentPage ? 'forward' : 'backward'
              });
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
