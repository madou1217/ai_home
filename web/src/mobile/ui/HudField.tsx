import type { ReactNode } from 'react';

interface Props {
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  error?: ReactNode;
}

/** 移动端表单字段：大写标签 + 控件 + 说明 / 错误（控件本身用 antd，由全局 HUD 层着色）。 */
export default function HudField({ label, children, hint, required, error }: Props) {
  return (
    <div className={`mhud-field${error ? ' has-error' : ''}`}>
      <span className="mhud-field__label">
        {required ? <span className="mhud-field__req" aria-hidden="true">*</span> : null}
        {label}
      </span>
      {children}
      {error ? <span className="mhud-field__error">{error}</span> : hint ? <span className="mhud-field__hint">{hint}</span> : null}
    </div>
  );
}
