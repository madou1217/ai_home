import { useCallback, useEffect, useRef } from 'react';
import { message, Modal } from 'antd';
import {
  formatCliInstallConfirmationText,
  getCliInstallConfirmationRemainingSeconds,
  getProviderLabel,
} from '@/components/chat/provider-pending-policy.js';
import { chatAPI } from '@/services/api';
import type { ChatStreamEvent } from '@/types';
import { humanizeChatError } from './chat-error-policy';

type ConfirmationDecision = 'confirm' | 'cancel';
type ConfirmationModal = ReturnType<typeof Modal.confirm>;

interface ConfirmationDialog {
  readonly modal: ConfirmationModal;
  readonly timerId: number;
  decisionPending: boolean;
}

interface CliInstallConfirmationDialogs {
  readonly open: (event: ChatStreamEvent) => void;
  readonly dismiss: (confirmationId: string) => void;
}

const COUNTDOWN_TICK_MS = 250;

export function useCliInstallConfirmationDialogs(): CliInstallConfirmationDialogs {
  const dialogsRef = useRef(new Map<string, ConfirmationDialog>());

  const dismiss = useCallback((confirmationId: string): void => {
    const dialog = dialogsRef.current.get(confirmationId);
    if (!dialog) return;
    dialogsRef.current.delete(confirmationId);
    window.clearInterval(dialog.timerId);
    dialog.modal.destroy();
  }, []);

  const open = useCallback((event: ChatStreamEvent): void => {
    const confirmationId = String(event.confirmationId || '').trim();
    if (!confirmationId || dialogsRef.current.has(confirmationId)) return;
    if (getCliInstallConfirmationRemainingSeconds(event) <= 0) return;

    const submitDecision = async (decision: ConfirmationDecision): Promise<void> => {
      const dialog = dialogsRef.current.get(confirmationId);
      if (!dialog || dialog.decisionPending) return;
      dialog.decisionPending = true;
      try {
        await chatAPI.decideCliInstallConfirmation(confirmationId, decision);
        dismiss(confirmationId);
      } catch (error) {
        dialog.decisionPending = false;
        message.error(humanizeChatError(
          error,
          decision === 'cancel' ? '取消失败，安装可能已经开始' : '确认安装失败',
        ));
        throw error;
      }
    };

    const modal = Modal.confirm({
      title: `安装 ${getProviderLabel(event.provider)} CLI？`,
      content: formatCliInstallConfirmationText(event),
      okText: '立即安装',
      cancelText: '取消',
      closable: true,
      onOk: () => submitDecision('confirm'),
      onCancel: () => submitDecision('cancel'),
    });
    const timerId = window.setInterval(() => {
      if (getCliInstallConfirmationRemainingSeconds(event) <= 0) {
        dismiss(confirmationId);
        return;
      }
      modal.update({
        content: formatCliInstallConfirmationText(event),
      });
    }, COUNTDOWN_TICK_MS);
    dialogsRef.current.set(confirmationId, {
      modal,
      timerId,
      decisionPending: false,
    });
  }, [dismiss]);

  useEffect(() => () => {
    for (const confirmationId of dialogsRef.current.keys()) {
      dismiss(confirmationId);
    }
  }, [dismiss]);

  return { open, dismiss };
}
