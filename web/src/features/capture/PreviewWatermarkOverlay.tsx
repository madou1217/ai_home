// 预览水印层：在 PC / 手机预览画面上浅色平铺「AIH · provider · model」，
// 像弹幕一样随机分布。只在预览里显示，不参与截图/录制编码。
//
// 抓帧期间通过 hidden 隐藏该层，避免屏幕共享把水印录进产物。

import { useEffect, useRef, useState } from 'react';
import { buildPreviewWatermarkMarks, type PreviewWatermarkMark } from './watermark';
import styles from './preview-watermark.module.css';

interface Props {
  /** 已解析的水印文案；空串时不渲染。 */
  text: string;
  /** 抓帧/编码期间隐藏，保证产物干净。 */
  hidden?: boolean;
  className?: string;
}

export default function PreviewWatermarkOverlay({ text, hidden = false, className }: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [marks, setMarks] = useState<PreviewWatermarkMark[]>([]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const render = () => {
      setMarks(
        buildPreviewWatermarkMarks({
          text,
          width: layer.clientWidth,
          height: layer.clientHeight
        })
      );
    };
    render();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(render);
    observer.observe(layer);
    return () => observer.disconnect();
  }, [text]);

  if (!text) return null;

  return (
    <div
      ref={layerRef}
      className={`${styles.layer} ${hidden ? styles.hidden : ''} ${className ?? ''}`}
      aria-hidden="true"
      data-preview-watermark
    >
      {marks.map((mark, index) => (
        <span
          key={`${mark.leftPct}-${mark.topPct}-${index}`}
          className={styles.mark}
          style={{
            left: `${mark.leftPct}%`,
            top: `${mark.topPct}%`,
            opacity: mark.opacity,
            fontSize: `${mark.fontSizePx}px`,
            transform: `translate(-50%, -50%) rotate(${mark.rotateDeg}deg)`
          }}
        >
          {mark.text}
        </span>
      ))}
    </div>
  );
}
