import React from 'react';

interface Props {
  className?: string;
}

/** 原位植株与 Portal 攻击层共用同一套头部和上下颚结构。 */
const QuotaPlantHead = ({ className = '' }: Props) => (
  <span className={['upstream-quota-plant-head-visual', className].filter(Boolean).join(' ')}>
    <span className="upstream-quota-plant-mouth-core" />
    <span className="upstream-quota-plant-head-half upstream-quota-plant-head-half--upper" />
    <span className="upstream-quota-plant-head-half upstream-quota-plant-head-half--lower" />
    <span className="upstream-quota-plant-eye-accent" />
  </span>
);

export default QuotaPlantHead;
