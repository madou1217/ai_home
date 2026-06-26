import { ReactNode } from 'react';
import './PageHero.css';

interface PageHeroProps {
  title: string;
  eyebrow?: string;
  sectionTitle?: string;
  description?: string;
  logo?: ReactNode;
  actions?: ReactNode;
}

export default function PageHero({ title, eyebrow, sectionTitle, description, logo, actions }: PageHeroProps) {
  const subtitle = description || sectionTitle || eyebrow || '';

  return (
    <div className="unified-hero">
      <div className="unified-hero-top">
        {logo ? <div className="unified-hero-logo">{logo}</div> : null}
        <div className="unified-hero-title-stack">
          <h1>{title}</h1>
          {/* 页面主标题统一为“标题 + 一句说明”，和模型用量页保持同一信息密度。 */}
          {subtitle ? <p className="unified-hero-subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="unified-hero-top-actions">{actions}</div> : null}
      </div>
    </div>
  );
}
