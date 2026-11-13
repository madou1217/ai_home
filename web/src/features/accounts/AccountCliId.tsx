import React from 'react';
import { Tooltip, message } from 'antd';
import type { Account } from '@/types';
import { writeClipboardText } from '@/utils/clipboard';

/** `aih <provider> <accountId>`：账号在 CLI 里的定位命令。 */
export function buildAccountCliCommand(record: Pick<Account, 'provider' | 'displayId'>): string {
  const id = String(record.displayId || '').trim();
  if (!id) return '';
  const provider = String(record.provider || '').trim();
  return provider ? `aih ${provider} ${id}` : '';
}

interface AccountCliIdProps {
  record: Account;
  className?: string;
  style?: React.CSSProperties;
}

// CLI 数字 ID（#N）不参与账号名轮播：它是命令参照，不是身份。
// 名字下方浅色单独一行，点击直接复制 `aih <provider> <id>`，省掉手拼命令。
export function AccountCliId({ record, className, style }: AccountCliIdProps) {
  const command = buildAccountCliCommand(record);
  if (!command) return null;
  const copy = () => {
    void writeClipboardText(command)
      .then(() => message.success(`已复制：${command}`))
      .catch(() => message.error('复制失败'));
  };
  return (
    <Tooltip title={`点击复制 ${command}`} mouseEnterDelay={0.5}>
      <span
        className={className}
        style={{ cursor: 'pointer', userSelect: 'none', ...style }}
        role="button"
        tabIndex={0}
        aria-label={`复制 ${command}`}
        onClick={copy}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          copy();
        }}
      >
        #{String(record.displayId).trim()}
      </span>
    </Tooltip>
  );
}
