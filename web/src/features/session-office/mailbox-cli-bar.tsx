import type { FC, RefObject } from 'react';
import {
  CheckOutlined,
  CodeOutlined,
  CopyOutlined,
  DownOutlined,
  RightOutlined,
} from '@ant-design/icons';
import AppButton from '@/components/ui/AppButton';
import type { CliCommandMode } from './mailbox-helpers';
import type { EnrichedPeerMessage } from './session-office-types';

export interface MailboxCliBarProps {
  targetMessage: EnrichedPeerMessage;
  cliMode: CliCommandMode;
  cliSendTarget: string;
  cliCommandText: string;
  expanded: boolean;
  copiedKey: string | null;
  toggleBtnRef: RefObject<HTMLButtonElement>;
  onToggleExpanded: () => void;
  onModeChange: (mode: CliCommandMode) => void;
  onCopy: (key: string, text: string, successLabel: string) => void;
}

export const MailboxCliBar: FC<MailboxCliBarProps> = ({
  targetMessage,
  cliMode,
  cliSendTarget,
  cliCommandText,
  expanded,
  copiedKey,
  toggleBtnRef,
  onToggleExpanded,
  onModeChange,
  onCopy,
}) => {
  const effectiveMode: CliCommandMode = cliMode === 'send' && cliSendTarget ? 'send' : 'reply';
  const copyId = `cli:${targetMessage.id}:${effectiveMode}`;
  const isCopied = copiedKey === copyId;

  return (
    <footer
      className="office-mailbox-cli-footer"
      data-expanded={expanded ? 'true' : undefined}
      aria-label="CLI 回复命令"
    >
      <div className="office-mailbox-cli-top">
        <button
          ref={toggleBtnRef}
          type="button"
          className="office-mailbox-cli-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? '收起 CLI 回复命令' : '展开 CLI 回复命令'}
          onClick={onToggleExpanded}
        >
          {expanded ? <DownOutlined aria-hidden="true" /> : <RightOutlined aria-hidden="true" />}
          <CodeOutlined aria-hidden="true" />
          <span>CLI 命令</span>
        </button>

        {!expanded ? (
          <>
            <code className="office-mailbox-cli-preview" title={cliCommandText}>
              {cliCommandText}
            </code>
            <AppButton
              size="small"
              appVariant="secondary"
              aria-label="复制 CLI 命令"
              icon={isCopied ? <CheckOutlined /> : <CopyOutlined />}
              onClick={() =>
                onCopy(copyId, cliCommandText, '已复制 CLI 命令，可在终端填写正文后执行')
              }
            >
              {isCopied ? '已复制' : '复制'}
            </AppButton>
          </>
        ) : (
          <div className="office-mailbox-cli-modes" role="group" aria-label="CLI 命令类型">
            <button
              type="button"
              className="office-mailbox-mode-btn"
              data-active={effectiveMode === 'reply' ? 'true' : undefined}
              aria-pressed={effectiveMode === 'reply'}
              onClick={() => onModeChange('reply')}
            >
              回复 #{targetMessage.shortId || targetMessage.id.slice(0, 6)}
            </button>
            {cliSendTarget ? (
              <button
                type="button"
                className="office-mailbox-mode-btn"
                data-active={effectiveMode === 'send' ? 'true' : undefined}
                aria-pressed={effectiveMode === 'send'}
                onClick={() => onModeChange('send')}
              >
                发给对方
              </button>
            ) : null}
          </div>
        )}
      </div>

      {expanded ? (
        <div className="office-mailbox-cli-command-row">
          <code className="office-mailbox-cli-code" title={cliCommandText}>
            {cliCommandText}
          </code>
          <AppButton
            size="small"
            appVariant="primary"
            aria-label="复制 CLI 命令"
            icon={isCopied ? <CheckOutlined /> : <CopyOutlined />}
            onClick={() =>
              onCopy(copyId, cliCommandText, '已复制 CLI 命令，可在终端填写正文后执行')
            }
          >
            {isCopied ? '已复制' : '复制命令'}
          </AppButton>
        </div>
      ) : null}
    </footer>
  );
};
