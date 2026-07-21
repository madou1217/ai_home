import { useCallback, useRef } from 'react';
import { providerNames } from '@/components/chat/ProviderIcon';
import type { Provider } from '@/types';
import {
  buildAssistantCompletionNotification,
  shouldNotifyAssistantCompleted,
} from '@/pages/chat-notification.js';

export interface AssistantCompletionNotifier {
  readonly requestPermission: () => void;
  readonly notify: (provider: Provider, content: string) => void;
}

export function useAssistantCompletionNotification(): AssistantCompletionNotifier {
  const permissionRequestedRef = useRef(false);
  const requestPermission = useCallback((): void => {
    if (typeof window === 'undefined' || typeof Notification === 'undefined') return;
    if (Notification.permission !== 'default' || permissionRequestedRef.current) return;
    permissionRequestedRef.current = true;
    Notification.requestPermission().catch(() => {});
  }, []);
  const notify = useCallback((provider: Provider, content: string): void => {
    if (typeof window === 'undefined' || typeof Notification === 'undefined') return;
    if (!shouldNotifyAssistantCompleted({
      permission: Notification.permission,
      visibilityState: document.visibilityState,
      hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : true,
    })) return;
    const payload = buildAssistantCompletionNotification(provider, content, providerNames);
    try { new Notification(payload.title, { body: payload.body }); } catch (_error) {}
  }, []);
  return { requestPermission, notify };
}
