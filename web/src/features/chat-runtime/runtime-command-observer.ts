import type { ChatRuntimeCommandName } from '@/chat-runtime';

export interface RuntimeCommandNotice {
  readonly commandId: string;
  readonly type: ChatRuntimeCommandName;
}

export interface RuntimeCommandObserver {
  onCommandDispatch(notice: RuntimeCommandNotice): void;
  onCommandDispatchFailed(notice: RuntimeCommandNotice): void;
}

export const NOOP_RUNTIME_COMMAND_OBSERVER: RuntimeCommandObserver = Object.freeze({
  onCommandDispatch: () => {},
  onCommandDispatchFailed: () => {},
});
