import type { ReactNode } from 'react';

interface SurfaceCardProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export default function SurfaceCard({ title, description, actions, children, className = '' }: SurfaceCardProps) {
  // 统一页面卡片的标题、说明和操作区，避免各页面重复写布局结构。
  return (
    <section className={`surface-card ${className}`.trim()}>
      {(title || description || actions) ? (
        <header className="surface-card-head">
          <div className="surface-card-copy">
            {title ? <h2>{title}</h2> : null}
            {description ? <p>{description}</p> : null}
          </div>
          {actions ? <div className="surface-card-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}
