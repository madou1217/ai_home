import type { CSSProperties } from 'react';

/**
 * 全站移动端唯一的「返回」按钮。
 *
 * 统一的只有**图标(粗 chevron)、无障碍语义、可选尾随标签、点击接线**——即所有页面
 * 返回按钮的观感与手感完全一致。而按钮外壳(尺寸/边框/底色)由调用方经 `className`
 * 传入(各页自己的 icon-button 家族:m-icon-btn / msx-iconbtn / Chat 的 mobileBack),
 * 以便返回按钮与所在页面其它按钮保持协调,不制造新的兄弟错位。
 *
 * 目标(target)不统一:各页保留自己的语义——Models 回账号页、会话页回上一屏、
 * Chat 是主从视图内的返回列表。只统一「怎么长、怎么按」,不统一「去哪」。
 */
export interface MobileBackButtonProps {
  onClick: () => void;
  /** 外壳样式类(默认沿用标准 m-icon-btn)。 */
  className?: string;
  /** 可选尾随文字(如 Chat 主从返回的「会话」)。 */
  label?: string;
  /** 无障碍/hover 提示,默认「返回」。 */
  title?: string;
  disabled?: boolean;
  style?: CSSProperties;
}

const BackChevron = () => (
  <svg
    width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
  >
    <path d="M15 18l-6-6 6-6" />
  </svg>
);

export default function MobileBackButton({
  onClick,
  className = 'm-icon-btn',
  label,
  title = '返回',
  disabled,
  style,
}: MobileBackButtonProps) {
  return (
    <button
      type="button"
      className={className}
      style={style}
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      title={title}
    >
      <BackChevron />
      {label ? <span>{label}</span> : null}
    </button>
  );
}
