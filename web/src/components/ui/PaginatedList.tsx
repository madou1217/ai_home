import { Empty, Pagination } from 'antd';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

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
  const total = items.length;
  const safePageSize = Math.max(1, pageSize);
  const maxPage = Math.max(1, Math.ceil(total / safePageSize));
  // 数据变化导致当前页越界时，渲染时先收敛到最后一页。
  const currentPage = Math.min(page, maxPage);
  const visibleItems = useMemo(() => {
    const start = (currentPage - 1) * safePageSize;
    return items.slice(start, start + safePageSize);
  }, [currentPage, items, safePageSize]);

  if (total === 0) {
    return <Empty description={emptyText} image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  return (
    <div className={`paginated-list ${className}`.trim()}>
      <div className="paginated-list-grid">
        {visibleItems.map((item, index) => renderItem(item, (currentPage - 1) * safePageSize + index))}
      </div>
      {total > safePageSize ? (
        <div className="paginated-list-pagination">
          <Pagination
            size="small"
            current={currentPage}
            pageSize={safePageSize}
            total={total}
            showSizeChanger={false}
            onChange={setPage}
          />
        </div>
      ) : null}
    </div>
  );
}
