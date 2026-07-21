import { useCallback, useRef, type ClipboardEvent } from 'react';
import { Input } from 'antd';
import type { Account } from '@/types';
import type { SessionProjectionStore, SessionRuntimeController } from '@/chat-runtime';
import type { RuntimeComposerCatalogState } from './use-runtime-composer-catalog';
import type { ApprovalMode } from './session-surface-policy';
import type { SessionRuntimeActions } from './session-runtime-actions';
import ComposerToolbar from './ComposerToolbar';
import ComposerAttachmentPreview from './ComposerAttachmentPreview';
import { useComposerController } from './use-composer-controller';
import styles from './session-runtime.module.css';

export interface ComposerProps {
  readonly store: SessionProjectionStore;
  readonly actions: SessionRuntimeActions;
  readonly accounts: readonly Account[];
  readonly accountRef: string;
  readonly catalog: RuntimeComposerCatalogState;
  readonly selectedModel: string;
  readonly approvalMode: ApprovalMode;
  readonly onAccountChange: (account: Account) => void;
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
  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!controller.canAttach) return;
    const files = Array.from(event.clipboardData?.files || []).filter((file) => (
      file.type.startsWith('image/')
    ));
    if (files.length === 0) return;
    event.preventDefault();
    void controller.addAttachments(files);
  }, [controller]);
  return (
    <section className={styles.composer} aria-label="消息输入">
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
      />
      <Input.TextArea
        value={controller.input}
        autoSize={{ minRows: 2, maxRows: 8 }}
        placeholder={controller.policy.turnActive ? '插话，或加入本轮后的队列…' : '向 AIH Chat Runtime 发送消息…'}
        onChange={(event) => controller.setInput(event.target.value)}
        onKeyDown={(event) => controller.handleKeyDown(event)}
        onPaste={handlePaste}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
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
  );
}
