import type { AggregatedProject, Session } from '@/types';
import type { PersistedChatSelection } from '@/features/legacy-chat/runtime-types';
import { shouldConsumeCanonicalRestoreIntent } from './canonical-session-selection';

interface RestoreObservation {
  readonly ready: boolean;
  readonly projects: readonly AggregatedProject[];
  readonly selectedSession: Session | null;
}

export class CanonicalRestoreIntent {
  private pending: boolean;

  constructor(private readonly initial: PersistedChatSelection) {
    this.pending = Boolean(initial.sessionId);
  }

  selection(): PersistedChatSelection {
    return this.pending ? this.initial : {};
  }

  observe(observation: RestoreObservation): void {
    if (!this.pending) return;
    if (shouldConsumeCanonicalRestoreIntent({
      ...observation,
      persistedSelection: this.initial,
    })) this.pending = false;
  }

  cancel(): void {
    this.pending = false;
  }

  isPending(): boolean {
    return this.pending;
  }
}
