export interface ListTablePaginationWindow {
  pageSize: number;
  page: number;
}

/**
 * 计算 ListTable 的分页窗口。
 *
 * 独立成纯函数是为了给服务端分页（total 来自接口、dataSource 只含当前页）留一个
 * 可直接单测的边界：页大小至少为 1，总数非负，当前页超出最大页时收敛到最后一页。
 */
export function resolveListTablePagination(
  total: number,
  pageSize: number,
  current: number,
): ListTablePaginationWindow {
  const safePageSize = Math.max(1, Math.floor(pageSize) || 0);
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 0;
  const maxPage = Math.max(1, Math.ceil(safeTotal / safePageSize));
  const safeCurrent = Number.isFinite(current) ? Math.max(1, Math.floor(current)) : 1;
  return {
    pageSize: safePageSize,
    page: Math.min(safeCurrent, maxPage),
  };
}
