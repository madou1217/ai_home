import { useState } from 'react';
import { CopyOutlined } from '@ant-design/icons';
import { message, Tooltip } from 'antd';
import Button from '@/components/ui/AppButton';

interface CopyableCommandProps {
  command: string;
  disabled?: boolean;
  disabledReason?: string;
  danger?: boolean;
  copyLabel?: string;
  compact?: boolean;
}

const UNRESOLVED_PARAMETER = /\{\{[^}]+\}\}|<[a-z][a-z0-9_-]*>/i;

export default function CopyableCommand({
  command,
  disabled = false,
  disabledReason,
  danger = false,
  copyLabel = '复制命令',
  compact = false
}: CopyableCommandProps) {
  const [copying, setCopying] = useState(false);
  const hasUnresolvedParameter = UNRESOLVED_PARAMETER.test(command);
  const copyDisabled = disabled || !command.trim() || hasUnresolvedParameter;
  const reason = disabledReason
    || (hasUnresolvedParameter ? '请先填写命令所需参数' : undefined);

  const handleCopy = async () => {
    if (copyDisabled) return;
    setCopying(true);
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('当前浏览器不支持剪贴板写入');
      }
      await navigator.clipboard.writeText(command);
      message.success('命令已复制');
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : '无法写入剪贴板';
      message.error(`复制失败：${detail}`);
    } finally {
      setCopying(false);
    }
  };

  const copyButton = (
    <Button
      size="small"
      type="text"
      danger={danger}
      icon={<CopyOutlined />}
      loading={copying}
      disabled={copyDisabled}
      aria-label={copyDisabled && reason ? `${copyLabel}，${reason}` : copyLabel}
      onClick={handleCopy}
    >
      {compact ? null : copyLabel}
    </Button>
  );

  return (
    <div className="toolkit-command" data-danger={danger || undefined}>
      <pre tabIndex={0} aria-label="可复制命令"><code>{command || '等待生成命令'}</code></pre>
      <Tooltip title={copyDisabled ? (reason || '命令暂不可复制') : copyLabel}>
        <span>{copyButton}</span>
      </Tooltip>
    </div>
  );
}
