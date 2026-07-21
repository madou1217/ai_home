import { getSessionRunKey } from '@/components/chat/active-run-state.js';
import { isAihServerAccount } from '@/components/chat/aih-server-account';
import { resolveQueuedMode } from '@/components/chat/queue-state.js';
import type { ChatAccount, InteractivePrompt, Session } from '@/types';
import type {
  DetachedRunBinding,
  LegacyRunMessageInput,
  QueuedSessionMessage,
} from './runtime-types';

export function normalizePromptChoice(choice: string): string | null {
  const normalized = String(choice || '').trim();
  return /^[1-9]\d*$/.test(normalized) ? normalized : null;
}

export function isApprovalPrompt(prompt: InteractivePrompt): prompt is InteractivePrompt & {
  approvalId: string;
  runId?: string;
} {
  const value = prompt as unknown as { kind?: string; approvalId?: string };
  return value.kind === 'approval' && Boolean(value.approvalId);
}

export function resolveDetachedRunId(
  session: Session | null,
  detachedRun: DetachedRunBinding | null,
): string {
  if (!session || session.draft || !detachedRun) return '';
  return getSessionRunKey(session) === detachedRun.sessionKey ? detachedRun.runId : '';
}

export function resolveQueueTargetKey(
  session: Session,
  activeRunKey: string,
  detachedRun: DetachedRunBinding | null,
): string {
  if (activeRunKey) return activeRunKey;
  return resolveDetachedRunId(session, detachedRun) ? getSessionRunKey(session) : '';
}

export function createQueuedMessage(
  account: ChatAccount,
  model: string,
  content: string,
  images: string[],
): QueuedSessionMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    content,
    images,
    createdAt: Date.now(),
    provider: account.provider,
    ...(isAihServerAccount(account)
      ? { gateway: true as const }
      : { accountRef: account.accountRef }),
    model: model || undefined,
    mode: resolveQueuedMode(account.provider, account.apiKeyMode),
  };
}

export function toRunInput(
  session: Session,
  account: ChatAccount,
  queued: QueuedSessionMessage,
): LegacyRunMessageInput {
  return {
    session,
    account,
    model: queued.model,
    content: queued.content,
    imageList: Array.isArray(queued.images) ? queued.images : [],
  };
}
