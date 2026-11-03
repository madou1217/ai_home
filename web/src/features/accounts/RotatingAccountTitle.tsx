'use client';

import React from 'react';
import { Tooltip, message } from 'antd';
import type { Account } from '@/types';

// 账号标题的「多身份轮播」。
//
// 为什么要轮播：一个账号可能同时有昵称、手机号、邮箱、CLI ID，单行放不下，
// 而用户在不同场景需要不同身份（对照 CLI 用 ID、确认账号用手机号/邮箱）。
// 行为约定：
//   * 每 4 秒切换一次（3–5s 区间内）；
//   * 鼠标移入暂停，移出恢复；
//   * 点击复制当前文本；
//   * 按住左右拖拽切换上一项/下一项（超过 32px 才算拖拽，避免误触）。

const ROTATE_INTERVAL_MS = 4000;
const DRAG_STEP_PX = 32;

export function buildAccountTitleItems(record: Account): string[] {
  const items: string[] = [];
  const push = (value: string) => {
    const text = String(value || '').trim();
    if (text && !items.includes(text)) items.push(text);
  };
  push(record.displayId ? `#${record.displayId}` : '');
  const name = String(record.displayName || '').trim();
  push(name);
  const email = String(record.email || '').trim();
  const phone = /^(\d{6,})@phone\.local$/i.exec(email);
  if (phone) push(phone[1]);
  if (email && email !== name) push(email);
  return items;
}

interface RotatingAccountTitleProps {
  record: Account;
  className?: string;
  style?: React.CSSProperties;
}

export function RotatingAccountTitle({ record, className, style }: RotatingAccountTitleProps) {
  const items = React.useMemo(() => buildAccountTitleItems(record), [record]);
  const [index, setIndex] = React.useState(0);
  const [paused, setPaused] = React.useState(false);
  const dragRef = React.useRef({ active: false, x: 0, moved: false });
  const signature = items.join('\u0000');

  React.useEffect(() => { setIndex(0); }, [signature]);
  React.useEffect(() => {
    if (paused || items.length < 2) return undefined;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % items.length);
    }, ROTATE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [paused, items.length, signature]);

  if (items.length === 0) return null;
  const current = items[Math.min(index, items.length - 1)];

  const copyCurrent = () => {
    try {
      const result = navigator.clipboard?.writeText(current);
      if (result && typeof result.then === 'function') {
        result.then(() => message.success(`已复制：${current}`)).catch(() => null);
      } else {
        message.success(`已复制：${current}`);
      }
    } catch (_error) {
      // 剪贴板不可用时静默；不影响轮播。
    }
  };

  return (
    <Tooltip
      title={items.length > 1 ? '点击复制 · 左右拖拽切换' : '点击复制'}
      mouseEnterDelay={0.5}
    >
      <span
        className={className}
        style={{ cursor: 'pointer', userSelect: 'none', ...style }}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => {
          setPaused(false);
          dragRef.current.active = false;
        }}
        onPointerDown={(event: React.PointerEvent) => {
          dragRef.current = { active: true, x: event.clientX, moved: false };
        }}
        onPointerMove={(event: React.PointerEvent) => {
          const drag = dragRef.current;
          if (!drag.active) return;
          const delta = event.clientX - drag.x;
          if (Math.abs(delta) < DRAG_STEP_PX) return;
          drag.x = event.clientX;
          drag.moved = true;
          setPaused(true);
          setIndex((currentIndex) => (delta > 0
            ? (currentIndex - 1 + items.length) % items.length
            : (currentIndex + 1) % items.length));
        }}
        onPointerUp={() => { dragRef.current.active = false; }}
        onPointerCancel={() => { dragRef.current.active = false; }}
        onClick={() => {
          if (dragRef.current.moved) {
            dragRef.current.moved = false;
            return;
          }
          copyCurrent();
        }}
      >
        <span key={current} className="aih-fade-in">{current}</span>
      </span>
    </Tooltip>
  );
}

