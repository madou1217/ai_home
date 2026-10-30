import { useCallback, useRef, type ClipboardEvent } from 'react';
import { Input, message } from 'antd';
import type { ChatAccount } from '@/types';
import type { SessionProjectionStore, SessionRuntimeController } from '@/chat-runtime';
import type { RuntimeComposerCatalogState } from './use-runtime-composer-catalog';
import type { ApprovalMode } from './session-surface-policy';
import type { SessionRuntimeActions } from './session-runtime-actions';
import ComposerToolbar from './ComposerToolbar';
import ComposerAttachmentPreview from './ComposerAttachmentPreview';
import SessionMetrics from './SessionMetrics';
import ChatSessionSettings from './ChatSessionSettings';
import { useComposerController } from './use-composer-controller';
import styles from './session-runtime.module.css';
import { CHAT_ATTACHMENT_ACCEPT, buildPastedTextFile, shouldConvertLargePaste } from '@/components/chat/attachment-files';

export interface ComposerProps {
  readonly workspaceMode?: 'chat' | 'work';
  readonly store: SessionProjectionStore;
  readonly actions: SessionRuntimeActions;
  readonly accounts: readonly ChatAccount[];
  readonly accountRef: string;
  readonly provider: string;
  readonly projectPath?: string;
  /** 会话尚未绑定原生/运行时会话（新会话草稿）。 */
  readonly draft?: boolean;
  readonly catalog: RuntimeComposerCatalogState;
  readonly selectedModel: string;
  readonly approvalMode: ApprovalMode;
  readonly onAccountChange: (account: ChatAccount) => void;
  readonly onModelChange: (model: string) => void;
  readonly onApprovalModeChange: (mode: ApprovalMode) => void;
  readonly uploadAttachments: SessionRuntimeController['uploadAttachments'];
  readonly terminalOpen: boolean;
  readonly onToggleTerminal: () => void;
}

export default function Composer(props: ComposerProps) {
  const controller = useComposerController(props);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectImages = useCallback(() => fileInputRef.current?.click(), []);
  const compactContext = useCallback((): void => {
    void props.actions.executeSlash('compact').catch((error) => {
      message.error(error instanceof Error ? error.message : '压缩失败');
    });
  }, [props.actions]);
  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.clipboardData?.files || []);
    if (files.length > 0) {
      if (!controller.canAttach) {
        event.preventDefault();
        message.error('当前投递方式不支持附件');
        return;
      }
      event.preventDefault();
      void controller.addAttachments(files);
      return;
    }
    const text = event.clipboardData?.getData('text/plain') || '';
    if (!shouldConvertLargePaste(text)) return;
    event.preventDefault();
    if (!controller.canAttach) {
      message.error('当前投递方式不支持大文本附件');
      return;
    }
    void controller.addAttachments([buildPastedTextFile(text)]);
  }, [controller]);
  return (
    <div className={styles.composerStack}>
      {props.workspaceMode === 'chat' ? (
        <div className={styles.chatSessionBar} aria-label="会话状态">
          <div className={styles.chatSessionSummary}>
            <SessionMetrics store={props.store} actions={props.actions} onCompact={compactContext} />
          </div>
          <ChatSessionSettings store={props.store} actions={props.actions} />
        </div>
      ) : null}
      <section className={styles.composer} aria-label="消息输入"
      onDragOver={(event) => { if (controller.canAttach) event.preventDefault(); }}
      onDrop={(event) => {
        event.preventDefault();
        if (controller.canAttach) void controller.addAttachments(Array.from(event.dataTransfer.files));
      }}>
      {controller.slashMatches.length > 0 ? (
        <div className={styles.slashSuggestions}>
          {controller.slashMatches.map((command) => (
            <button key={command} type="button" onClick={() => controller.setInput(`/${command} `)}>
              /{command}
            </button>
          ))}
        </div>
      ) : null}
      <ComposerAttachmentPreview
        attachments={controller.attachments}
        onRemove={controller.removeAttachment}
        onRetry={(key) => { void controller.retryAttachment(key); }}
      />
      <Input.TextArea
        value={controller.input}
        autoSize={{ minRows: 2, maxRows: 8 }}
        placeholder={controller.policy.turnActive ? '插话，或加入本轮后的队列…'
          : props.workspaceMode === 'chat' ? '发送消息…' : '向 AIH Chat Runtime 发送消息…'}
        onChange={(event) => controller.setInput(event.target.value)}
        onKeyDown={(event) => controller.handleKeyDown(event)}
        onPaste={handlePaste}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept={CHAT_ATTACHMENT_ACCEPT}
        multiple
        hidden
        onChange={(event) => {
          void controller.addAttachments(Array.from(event.target.files || []));
          event.target.value = '';
        }}
      />
        <ComposerToolbar
          props={props}
          controller={controller}
          onSelectImages={selectImages}
        />
      </section>
    </div>
  );
}
