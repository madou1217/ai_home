import type { ReactNode } from 'react';
import { PageContainer } from '@ant-design/pro-components';
import '../../styles/unified.css';

export interface PageScaffoldProps {
  /** 页面主标题 */
  title: ReactNode;
  /** 副标题（一句话说明，信息密度参考模型用量页） */
  subTitle?: ReactNode;
  /** 右上角操作区：所有页面级 action 只允许放这里，禁止在列表上方堆 Statistic */
  extra?: ReactNode;
  /** 紧凑的健康/状态条（Descriptions 风格），取代各页散落的 stat 卡片 */
  headerContent?: ReactNode;
  /** 主体内容，通常是若干 <SectionCard> / <ListTable> */
  children?: ReactNode;
  className?: string;
}

/**
 * 统一页面脚手架 —— 全站唯一的 PageContainer 包装。
 *
 * 固定规则（DESIGN_SYSTEM.md 的单一真相源）：
 *  - 不允许直接使用 PageContainer，必须经此组件
 *  - extra 仅放右上角 action；headerContent 放紧凑健康条，禁止平铺 Statistic 卡片
 *  - 页面 padding 固定 24px（见 unified.css），卡片 padding 固定 16px
 */
export default function PageScaffold({
  title,
  subTitle,
  extra,
  headerContent,
  children,
  className = '',
}: PageScaffoldProps) {
  return (
    <PageContainer
      className={['unified-page-scaffold', className].filter(Boolean).join(' ')}
      title={title}
      subTitle={subTitle}
      extra={extra}
      content={headerContent}
    >
      {children}
    </PageContainer>
  );
}