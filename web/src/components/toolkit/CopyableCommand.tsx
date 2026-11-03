import { CopyOutlined } from '@ant-design/icons';
import { Tooltip } from 'antd';
import Button from '@/components/ui/AppButton';
import { UNRESOLVED_COMMAND_PARAMETER as UNRESOLVED_PARAMETER } from './guided-command';
import { useCommandCopy } from './use-command-copy';

interface CopyableCommandProps {
  command: string;
  disabled?: boolean;
  disabledReason?: string;
  danger?: boolean;
  copyLabel?: string;
  compact?: boolean;
}

export default function CopyableCommand({
  command,
  disabled = false,
  disabledReason,
  danger = false,
  copyLabel = '复制命令',
  compact = false
}: CopyableCommandProps) {
  const { copying, copy } = useCommandCopy();
  const hasUnresolvedParameter = UNRESOLVED_PARAMETER.test(command);
  const copyDisabled = disabled || !command.trim() || hasUnresolvedParameter;
  const reason = disabledReason
    || (hasUnresolvedParameter ? '请先填写命令所需参数' : undefined);

  const handleCopy = async () => {
    if (copyDisabled) return;
    await copy(command);
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
