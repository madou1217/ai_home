import type {
  SessionProjection,
  SessionQueueEntry,
  TimelineItem,
} from '@/chat-runtime';

export interface PlanImplementationPrompt {
  readonly turnId: string;
  readonly planItemId: string;
  readonly planMarkdown?: string;
}

export function resolvePlanImplementationPrompt(
  projection: SessionProjection,
): PlanImplementationPrompt | undefined {
  if (!canPrompt(projection)) return undefined;
  const turnId = latestTimelineTurnId(projection.items);
  if (!turnId || dismissedTurnId(projection) === turnId) return undefined;
  const plan = findProposedPlan(projection.items, turnId);
  if (!plan) return undefined;
  return {
    turnId,
    planItemId: plan.id,
    ...(plan.content?.trim() ? { planMarkdown: plan.content.trim() } : {}),
  };
}

function canPrompt(projection: SessionProjection): boolean {
  return projection.state === 'idle'
    && projection.policy.approvalMode === 'plan'
    && projection.interactions.length === 0
    && !projection.queue.some(isActiveQueueEntry);
}

function latestTimelineTurnId(items: readonly TimelineItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const turnId = items[index].turnId?.trim();
    if (turnId) return turnId;
  }
  return undefined;
}

function findProposedPlan(
  items: readonly TimelineItem[],
  turnId: string,
): Extract<TimelineItem, { kind: 'plan' }> | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (
      item.turnId === turnId
      && item.kind === 'plan'
      && item.status === 'completed'
      && item.detail.state === 'proposed'
    ) return item;
  }
  return undefined;
}

function dismissedTurnId(projection: SessionProjection): string {
  const value = projection.policy.planConfirmationDismissedTurnId;
  return typeof value === 'string' ? value.trim() : '';
}

function isActiveQueueEntry(entry: SessionQueueEntry): boolean {
  return entry.status === 'queued' || entry.status === 'leased' || entry.status === 'running';
}
