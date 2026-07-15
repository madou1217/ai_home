import type { CSSProperties, ReactNode } from 'react';
import { ProCard } from '@ant-design/pro-components';
import '../../styles/unified.css';

export interface SectionCardProps {
  title?: ReactNode;
  /** 右上角 action，与 PageScaffold.extra 保持一致的“只在右侧”语义 */
  extra?: ReactNode;
  /** 是否带外边框，默认 true（统一视觉） */
  bordered?: boolean;
  /** 标题下方是否带分割线，默认 true */
  headerBordered?: boolean;
  /** 横向间距（gutter），用于内部并排卡片；单卡片场景留空即可 */
  gutter?: number;
  /** 主内容 */
  children?: ReactNode;
  className?: string;
  /** 透传 bodyStyle，仅在确有特殊内距需求时使用；默认 16px 由 unified.css 兜底 */
  bodyStyle?: CSSProperties;
}

/**
 * 统一卡片包装 —— 全站唯一的 ProCard 用法。
 * 默认 16px padding、headerBordered、bordered、12px 圆角（见 unified.css）。
 * 禁止直接使用 ProCard。
 */
export default function SectionCard({
  title,
  extra,
  bordered = true,
  headerBordered = true,
  gutter,
  children,
  className = '',
  bodyStyle,
}: SectionCardProps) {
  return (
    <ProCard
      className={['unified-section-card', className].filter(Boolean).join(' ')}
      title={title}
      extra={extra}
      bordered={bordered}
      headerBordered={headerBordered}
      gutter={gutter}
      bodyStyle={bodyStyle}
      style={{ marginBottom: 20 }}
    >
      {children}
    </ProCard>
  );
}