import type { ReactNode } from 'react';
import { ProTable } from '@ant-design/pro-components';
import type { ProColumns, ProTableProps } from '@ant-design/pro-components';
import { Empty, Skeleton, Grid } from 'antd';
import '../../styles/unified.css';
import '../mobile/mobile-cards.css';

export interface ListTableProps<T extends Record<string, any>, U extends Record<string, any> = Record<string, any>>
  extends Omit<ProTableProps<T, U>, 'search' | 'options' | 'pagination' | 'columns' | 'rowKey' | 'toolBarRender' | 'toolbar'> {
  columns: ProColumns<T>[];
  rowKey?: string | ((row: T) => string);
  /** 工具栏额外区（按钮等），放在右上角，左侧不允许放 action */
  toolBarRender?: ProTableProps<T, U>['toolBarRender'];
  /** 工具栏右侧的额外筛选区（tab/menu 切换等），含 menu type="tab"，禁止外层 Tabs 包表格 */
  toolbar?: ProTableProps<T, U>['toolbar'];
  dataSource?: readonly T[];
  loading?: boolean;
  children?: ReactNode;
}

const emptyText = (
  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
);

// 全站统一的列表骨架屏：首屏加载（loading 且无缓存数据）时展示，列头沿用真实
// 列标题、行用 Skeleton 占位，节奏与表格一致，替代 ProTable 默认的转圈空态。
function ListTableSkeleton<T extends Record<string, any>>({ columns, rows = 5 }: { columns: ProColumns<T>[]; rows?: number }) {
  const cells = columns.slice(0, 6);
  const gridStyle = { gridTemplateColumns: `repeat(${cells.length || 1}, minmax(0, 1fr))` };
  return (
    <div className="unified-list-table-skeleton" aria-busy="true" aria-live="polite">
      <div className="unified-list-table-skeleton-head" style={gridStyle}>
        {cells.map((column, index) => (
          <span className="unified-list-table-skeleton-headcell" key={index}>
            {typeof column.title === 'string' ? column.title : ''}
          </span>
        ))}
      </div>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div className="unified-list-table-skeleton-row" key={rowIndex} style={gridStyle}>
          {cells.map((_column, cellIndex) => (
            <Skeleton.Input active size="small" block key={cellIndex} />
          ))}
        </div>
      ))}
    </div>
  );
}

// 从一列取原始值：优先 dataIndex，回退到 render 的第一参数（多数列把它当 value/dom 用）。
function getColumnValue<T extends Record<string, any>>(column: ProColumns<T>, row: T) {
  const di = (column as any).dataIndex;
  if (di == null) return undefined;
  if (Array.isArray(di)) return di.reduce((acc: any, k: any) => (acc == null ? acc : acc[k]), row);
  return row[di];
}

function renderColumnCell<T extends Record<string, any>>(column: ProColumns<T>, row: T, index: number): ReactNode {
  const value = getColumnValue(column, row);
  if (typeof column.render === 'function') {
    // ProColumns render 签名 (dom, entity, index, action, schema)；这些列不用 action/schema，传 value 作 dom。
    return (column.render as any)(value, row, index, undefined, undefined);
  }
  return value == null || value === '' ? '-' : (value as ReactNode);
}

/**
 * ListTable 移动端降级：把宽表格换成卡片列表 + 无分页（手机不做横向滚动、不做显式分页，
 * 滚动即看全）。这是全站表格的统一移动方案；需要更精致布局的页面可自行在 isMobile 时
 * 绕过 ListTable 渲染专属卡片（如账号/用量/别名页）。
 *
 * 规则：第一列作为卡片标题；有标题的列渲染成 label:value 行；无标题列（操作/展开）汇到卡片脚。
 */
function ListTableMobileCards<T extends Record<string, any>>({
  columns,
  dataSource,
  rowKey,
}: {
  columns: ProColumns<T>[];
  dataSource?: readonly T[];
  rowKey?: string | ((row: T) => string);
}) {
  const rows = Array.isArray(dataSource) ? dataSource : [];
  if (rows.length === 0) return <>{emptyText}</>;

  // 操作类列（无标题，或 key/dataIndex/标题指向“操作”）汇到卡片脚整行排布、按钮可换行；
  // 其余有标题列走 label:value 行。
  const isActionColumn = (c: ProColumns<T>) => {
    if (c.title == null || c.title === '') return true;
    const id = String((c as any).key ?? (c as any).dataIndex ?? '').toLowerCase();
    if (/^(action|actions|operation|operate|op)$/.test(id)) return true;
    if (typeof c.title === 'string' && /^操作/.test(c.title)) return true;
    return false;
  };
  const visible = columns.filter((c) => (c as any).hideInTable !== true);
  const [titleCol, ...restCols] = visible;
  const labelled = restCols.filter((c) => !isActionColumn(c));
  const actionCols = restCols.filter((c) => isActionColumn(c));

  return (
    <div className="mobile-card-list">
      {rows.map((row, index) => {
        const key = typeof rowKey === 'function' ? rowKey(row) : (rowKey ? (row as any)[rowKey] : index);
        return (
          <div className="mobile-card" key={String(key ?? index)}>
            {titleCol ? <div className="ltcard-title">{renderColumnCell(titleCol, row, index)}</div> : null}
            {labelled.map((col, ci) => (
              <div className="ltcard-row" key={ci}>
                <span className="ltcard-label">{col.title as ReactNode}</span>
                <span className="ltcard-value">{renderColumnCell(col, row, index)}</span>
              </div>
            ))}
            {actionCols.length > 0 ? (
              <div className="ltcard-actions">
                {actionCols.map((col, ci) => (
                  <span key={ci}>{renderColumnCell(col, row, index)}</span>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 统一列表表格 —— 全站唯一的列表渲染方式。
 * 固定默认（FIXED，不可由各页再覆盖）：
 *  - search = false（不做顶部搜索表单）
 *  - options = false（隐藏 ProTable 自带刷新/列设置/密度）
 *  - pagination = { pageSize: 12, showSizeChanger: true, showQuickJumper: true }
 *  - 行 hover 由 unified.css 统一
 *  - 空态统一“暂无数据” + SIMP 图
 * 禁止直接使用 ProTable / Table。
 */
export default function ListTable<T extends Record<string, any>, U extends Record<string, any> = Record<string, any>>({
  columns,
  rowKey,
  toolBarRender,
  toolbar,
  children,
  ...rest
}: ListTableProps<T, U>) {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;

  // 首屏（loading 且无数据）走骨架屏；有缓存数据时即便 loading 也保持表格可见，
  // 仅由 ProTable 的轻量 overlay 提示刷新中，避免整表被遮罩闪白。
  const isFirstLoad = Boolean(rest.loading) && (!Array.isArray(rest.dataSource) || rest.dataSource.length === 0);
  if (isFirstLoad) {
    return <ListTableSkeleton columns={columns} />;
  }

  // 移动端：宽表格统一降级为卡片列表 + 无分页（避免横向溢出和显式分页）。
  if (isMobile) {
    return <ListTableMobileCards columns={columns} dataSource={rest.dataSource} rowKey={rowKey} />;
  }

  const fixedProps = {
    className: 'unified-list-table',
    columns,
    rowKey,
    search: false as const,
    options: false as const,
    pagination: {
      pageSize: 12,
      showSizeChanger: true,
      showQuickJumper: true,
      showTotal: (total: number) => `共 ${total} 条`,
    },
    toolBarRender,
    toolbar,
    locale: { emptyText },
    ...rest,
  };
  return (
    <ProTable {...(fixedProps as Omit<typeof fixedProps, 'rowKey'>)} rowKey={rowKey as never}>
      {children ? <span style={{ display: 'none' }}>{children}</span> : null}
    </ProTable>
  );
}