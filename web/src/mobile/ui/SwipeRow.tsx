import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';

export interface SwipeAction {
  key: string;
  label: string;
  icon?: ReactNode;
  tone?: 'default' | 'primary' | 'danger';
  onAction: () => void;
  disabled?: boolean;
}

interface Props {
  children: ReactNode;
  /** 左滑露出的操作（全部对应真实处理函数） */
  actions?: SwipeAction[];
  /** 点按整行（通常打开详情抽屉） */
  onTap?: () => void;
  ariaLabel?: string;
}

const ACTION_WIDTH = 76;
const OPEN_THRESHOLD = 0.35;

/**
 * 等宽列表行 + 左滑操作。
 * - 横向滑动超过阈值吸附展开，纵向滚动不受影响（touch-action: pan-y）。
 * - 操作按钮始终在 DOM 中且可聚焦；键盘用户可 Tab 到它们（聚焦时自动展开）。
 * - 同一时刻只展开一行：展开时广播事件关闭其它行。
 */
export default function SwipeRow({ children, actions = [], onTap, ariaLabel }: Props) {
  const rowRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number; offset: number; locked: 'x' | 'y' | null } | null>(null);
  const moved = useRef(false);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const maxOffset = actions.length * ACTION_WIDTH;

  const close = useCallback(() => setOffset(0), []);

  useEffect(() => {
    const onOtherOpen = (event: Event) => {
      if ((event as CustomEvent).detail !== rowRef.current) close();
    };
    window.addEventListener('mhud-swipe-open', onOtherOpen);
    return () => window.removeEventListener('mhud-swipe-open', onOtherOpen);
  }, [close]);

  const open = () => {
    setOffset(-maxOffset);
    window.dispatchEvent(new CustomEvent('mhud-swipe-open', { detail: rowRef.current }));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!maxOffset || event.pointerType === 'mouse') return;
    start.current = { x: event.clientX, y: event.clientY, offset, locked: null };
    moved.current = false;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    const dx = event.clientX - s.x;
    const dy = event.clientY - s.y;
    if (!s.locked) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      s.locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (s.locked === 'x') {
        setDragging(true);
        try {
          (event.currentTarget as HTMLDivElement).setPointerCapture?.(event.pointerId);
        } catch {
          // 指针已结束（或为合成事件）时浏览器会抛错；捕获只是增强，失败不影响滑动
        }
      }
    }
    if (s.locked !== 'x') return;
    moved.current = true;
    setOffset(Math.max(-maxOffset, Math.min(0, s.offset + dx)));
  };

  const finish = () => {
    const s = start.current;
    start.current = null;
    if (!s || s.locked !== 'x') return;
    setDragging(false);
    if (-offset > maxOffset * OPEN_THRESHOLD) open();
    else close();
  };

  const onClick = () => {
    if (moved.current) {
      moved.current = false;
      return;
    }
    if (offset !== 0) {
      close();
      return;
    }
    onTap?.();
  };

  return (
    <div className="mhud-swipe" ref={rowRef}>
      {maxOffset > 0 && (
        <div className="mhud-swipe__actions" style={{ width: maxOffset }}>
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              className={`mhud-swipe__action mhud-swipe__action--${action.tone || 'default'}`}
              style={{ width: ACTION_WIDTH }}
              disabled={action.disabled}
              onFocus={open}
              onClick={() => {
                close();
                action.onAction();
              }}
            >
              {action.icon}
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      )}
      <div
        className={`mhud-swipe__content${dragging ? ' is-dragging' : ''}${onTap ? ' is-interactive' : ''}`}
        style={{ transform: `translate3d(${offset}px,0,0)` }}
        role={onTap ? 'button' : undefined}
        tabIndex={onTap ? 0 : undefined}
        aria-label={ariaLabel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onClick={onClick}
        onKeyDown={(event) => {
          if (!onTap) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onTap();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** 发丝分隔的等宽列表容器。 */
export function MonoList({ children, ariaLabel }: { children: ReactNode; ariaLabel?: string }) {
  return (
    <div className="mhud-list" role="list" aria-label={ariaLabel}>
      {children}
    </div>
  );
}
