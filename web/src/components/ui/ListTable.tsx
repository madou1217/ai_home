import type { ReactNode } from 'react';
import { ProTable } from '@ant-design/pro-components';
import type { ProColumns, ProTableProps } from '@ant-design/pro-components';
import { Empty } from 'antd';
import '../../styles/unified.css';

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