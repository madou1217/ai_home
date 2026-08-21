import React, { useId } from 'react';

/**
 * 食人花的头：侧视朝左，上下颚绕右后方的铰接点开合。
 *
 * 口腔不是画在两颚之间的一小块，而是一整片被头轮廓裁出来的深色内壁——张多大
 * 角度，缝里露出的都是口腔，颚转出去也不会露馅。牙齿长在各自颚的内缘上，跟着
 * 那片颚一起转，所以咬合时上下牙是真的合上。
 *
 * 原地植株与 Portal 攻击层共用这一个组件，任何时刻只有一处在画。
 */
const QuotaPlantHead = ({ className = '' }: { className?: string }) => {
  const clipId = `quota-maw-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  return (
    <svg
      className={['quota-head', className].filter(Boolean).join(' ')}
      viewBox="0 0 24 24"
      focusable="false"
      aria-hidden="true"
    >
      <defs>
        <clipPath id={clipId}>
          {/* 头闭合时的轮廓：口腔只在这个范围里露出来。 */}
          <ellipse cx="11.4" cy="12" rx="9.9" ry="10.1" />
        </clipPath>
      </defs>

      <g clipPath={`url(#${clipId})`}>
        <rect className="quota-head-throat" x="0" y="0" width="24" height="24" />
        <path
          className="quota-head-gullet"
          d="M20 12C20 15 17 17.4 13 17.4C9 17.4 6 15 6 12C6 9 9 6.6 13 6.6C17 6.6 20 9 20 12Z"
        />
        <path
          className="quota-head-tongue"
          d="M4.5 13.6C7 12.6 11 12.7 13.6 14C15 14.7 14.7 16.2 12.8 16.6C9.6 17.2 6 16.6 4.3 15.5C3.2 14.8 3.4 14 4.5 13.6Z"
        />
      </g>

      <g className="quota-head-jaw quota-head-jaw--upper">
        <path
          className="quota-head-lip"
          d="M20.8 12L2.4 11.1C0.4 10.4 0.4 7.9 2.4 5.5C5.8 1.4 13.6 0.4 17.8 3.7C20 5.5 20.8 8.4 20.8 12Z"
        />
        <path className="quota-head-teeth" d="M4.2 11.1L6.4 15.4L8.8 11.3ZM11.4 11.5L13.6 15.2L15.8 11.7Z" />
        <path className="quota-head-spot" d="M7.4 6.6a1.55 1.55 0 1 0 0.01 0Z" />
        <path className="quota-head-spot" d="M12.4 4.6a1.2 1.2 0 1 0 0.01 0Z" />
        <path className="quota-head-spot" d="M16.4 6.4a1 1 0 1 0 0.01 0Z" />
      </g>

      <g className="quota-head-jaw quota-head-jaw--lower">
        <path
          className="quota-head-lip"
          d="M20.8 12L2.4 12.9C0.4 13.6 0.4 16.1 2.4 18.5C5.8 22.6 13.6 23.6 17.8 20.3C20 18.5 20.8 15.6 20.8 12Z"
        />
        <path className="quota-head-teeth" d="M5.6 12.9L7.8 8.9L10 12.7ZM12.8 12.5L14.8 9L16.8 12.4Z" />
        <path className="quota-head-spot" d="M8.2 18.4a1.35 1.35 0 1 0 0.01 0Z" />
      </g>
    </svg>
  );
};

export default QuotaPlantHead;
