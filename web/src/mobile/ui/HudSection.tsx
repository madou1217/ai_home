import type { ReactNode } from 'react';

interface Props {
  title: ReactNode;
  code?: string;
  count?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  /** 附加到 section 根节点的 class（用于条件挂载时整段淡入） */
  className?: string;
}

/** 分区：Orbitron 代号 + 标题 + 计数，下方单列内容。 */
export default function HudSection({ title, code, count, extra, children, className }: Props) {
  return (
    <section className={`mhud-section${className ? ` ${className}` : ''}`}>
      <div className="mhud-section__head">
        <span className="mhud-section__mark" aria-hidden="true" />
        {code ? <span className="mhud-section__code">{code}</span> : null}
        <span className="mhud-section__title">{title}</span>
        {count !== undefined && count !== null ? <span className="mhud-section__count">{count}</span> : null}
        {extra ? <span className="mhud-section__extra">{extra}</span> : null}
      </div>
      <div className="mhud-section__body">{children}</div>
    </section>
  );
}
