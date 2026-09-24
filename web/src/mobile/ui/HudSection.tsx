import type { ReactNode } from 'react';

interface Props {
  title: ReactNode;
  code?: string;
  count?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
}

/** 分区：Orbitron 代号 + 标题 + 计数，下方单列内容。 */
export default function HudSection({ title, code, count, extra, children }: Props) {
  return (
    <section className="mhud-section">
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
