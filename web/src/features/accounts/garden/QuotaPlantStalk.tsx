import React from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { GARDEN_STALK_SEGMENTS, getStalkSegments } from './plant-profile';
import type { GardenStalkSegment } from './plant-profile';

const Leaf = ({ side }: { side: 'left' | 'right' }) => (
  <svg
    className={`quota-plant-leaf quota-plant-leaf--${side}`}
    viewBox="0 0 15 9"
    focusable="false"
    aria-hidden="true"
  >
    <path
      className="quota-plant-leaf-blade"
      d="M14.6 4.2C10.6 0.2 4.6 -0.6 1 2.2C-0.2 3.1 0.2 4.7 1.8 5.7C5.4 7.9 11 7.6 14.6 4.2Z"
    />
    <path className="quota-plant-leaf-vein" d="M13.4 4.3C9.4 4.4 5.2 5 2 5.5" />
  </svg>
);

/**
 * 花茎：一串首尾相接的骨节，而不是一根刚体。
 *
 * 每节挂在上一节的顶端、绕自己的底端转，所以摇摆是一道从根部往上走的波——
 * 头永远最后到位，叶子跟着甩。这也是跳跃能有"重量"的前提：蓄力时整串向下
 * 压、腾空时向后甩、落地时抖两下，都是同一串骨节在动。
 */
function renderSegment(
  segments: GardenStalkSegment[],
  index: number,
  leafIndex: number,
  head: ReactNode
): ReactNode {
  const segment = segments[index];
  if (!segment) return head;
  return (
    <span
      className="quota-plant-seg"
      data-seg-index={index}
      style={{
        ['--seg-height' as string]: `${segment.height}px`,
        ['--seg-width' as string]: `${segment.width}px`,
        // 波从根往上传：越靠上的骨节起步越晚，形成鞭子一样的滞后。
        ['--seg-delay' as string]: `${index * 90}ms`,
        ['--seg-lag' as string]: index
      } as CSSProperties}
    >
      {index === leafIndex ? (
        <>
          <Leaf side="left" />
          <Leaf side="right" />
        </>
      ) : null}
      {renderSegment(segments, index + 1, leafIndex, head)}
    </span>
  );
}

const QuotaPlantStalk = ({ stemHeight, head }: { stemHeight: number; head: ReactNode }) => {
  const segments = getStalkSegments(stemHeight);
  return (
    <span className="quota-plant-stalk">
      {renderSegment(segments, 0, Math.min(1, GARDEN_STALK_SEGMENTS - 1), head)}
    </span>
  );
};

export default QuotaPlantStalk;
