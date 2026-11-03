import { useLayoutEffect, useRef, type ReactNode } from 'react';

/**
 * 仪表盘 / KPI 数值的「变化反馈」：值真的变了才播一次轻量跳字（从上方 3px、半透明落位），
 * 首次挂载与内容不变的轮询刷新都不播。只碰 opacity / transform，合成器完成，不触发重排。
 *
 * 用 `changeKey`（默认取 children 的文本）判断「变没变」：ReactNode 每次渲染都是新对象，
 * 不能直接比较引用。
 */
interface AnimatedValueProps {
  children: ReactNode;
  /** 变化判定用的稳定值；不传时用 children 为 string/number 时的文本 */
  changeKey?: string | number | null;
  className?: string;
}

const prefersReducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_error) {
    return false;
  }
};

export default function AnimatedValue({ children, changeKey, className }: AnimatedValueProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const key = changeKey !== undefined
    ? String(changeKey ?? '')
    : typeof children === 'string' || typeof children === 'number'
      ? String(children)
      : null;
  const previous = useRef(key);

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = key;
    if (key === null || before === null || before === key) return;
    const node = ref.current;
    if (!node || node.getClientRects().length === 0 || prefersReducedMotion()) return;
    node.animate(
      [
        { opacity: 0.35, transform: 'translateY(-3px)' },
        { opacity: 1, transform: 'none' }
      ],
      { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
    );
  }, [key]);

  return (
    <span ref={ref} className={className ? `aih-value ${className}` : 'aih-value'} data-animated-value="">
      {children}
    </span>
  );
}
