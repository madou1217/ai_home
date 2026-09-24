import type { ReactNode } from 'react';

interface Props {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  tone?: 'default' | 'primary' | 'danger';
  loading?: boolean;
  /** 显示文字（默认只显示图标，label 作为无障碍名称） */
  showLabel?: boolean;
}

/** 44×44 切角图标按钮。 */
export default function HudIconButton({ icon, label, onClick, disabled, tone = 'default', loading, showLabel }: Props) {
  return (
    <button
      type="button"
      className={`mhud-icon-btn mhud-icon-btn--${tone}${showLabel ? ' has-label' : ''}${loading ? ' is-loading' : ''}`}
      aria-label={label}
      title={label}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      onClick={onClick}
    >
      {icon}
      {showLabel ? <span>{label}</span> : null}
    </button>
  );
}
