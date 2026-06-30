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
  ghost?: boolean;
  /**
   * 全屏铺满模式（如 AI 会话页）：隐藏页面标题头、去掉内容区内距、children 撑满高度，
   * 由页面自身的全高布局接管。普通文档页不要用。
   */
  fullBleed?: boolean;
}

/**
 * 统一页面脚手架 —— 全站唯一的 PageContainer 包装。
 *
 * 标准模式采用与 Settings 相同的布局结构：
 *  - PageContainer 只渲染页头（不包裹 children）
 *  - children 作为页头的兄弟元素渲染在 .unified-page-content wrapper 内
 *  - 外层 .unified-page-wrapper 提供统一的横向内距（桌面 32px / 移动 16px）
 *  - 页头内距归零，改由 wrapper 统一提供，确保页头文字与内容对齐
 */
export default function PageScaffold({
  title,
  subTitle,
  extra,
  headerContent,
  children,
  className = '',
  ghost,
  fullBleed,
}: PageScaffoldProps) {
  if (fullBleed) {
    return (
      <PageContainer
        className={['unified-page-scaffold', 'unified-page-scaffold--fullbleed', className]
          .filter(Boolean)
          .join(' ')}
        ghost
        header={{ title: '', breadcrumb: {} }}
      >
        {children}
      </PageContainer>
    );
  }
  return (
    <div className={['unified-page-wrapper', className].filter(Boolean).join(' ')}>
      <PageContainer
        className="unified-page-scaffold"
        title={title}
        subTitle={subTitle}
        extra={extra}
        content={headerContent}
        ghost={ghost}
      />
      <div className="unified-page-content">
        {children}
      </div>
    </div>
  );
}