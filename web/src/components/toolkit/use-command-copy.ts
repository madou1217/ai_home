import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import { writeClipboardText } from '@/utils/clipboard';

/** 命令复制：写入剪贴板并给出统一的成功 / 失败提示（桌面 CopyableCommand 与移动端命令块共用）。 */
export function useCommandCopy() {
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const copy = useCallback(async (command: string) => {
    setCopying(true);
    try {
      await writeClipboardText(command);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setCopied(false);
        timerRef.current = null;
      }, 1600);
      message.success('命令已复制');
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : '无法写入剪贴板';
      message.error(`复制失败：${detail}`);
    } finally {
      setCopying(false);
    }
  }, []);

  return { copying, copied, copy };
}
