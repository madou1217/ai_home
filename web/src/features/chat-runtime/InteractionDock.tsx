import { useSessionSelector } from '@/chat-runtime';
import type {
  PendingInteraction,
  SessionProjection,
  SessionProjectionStore,
} from '@/chat-runtime';
import ApprovalInteractionCard from './ApprovalInteractionCard';
import QuestionInteractionCard from './QuestionInteractionCard';
import { interactionLifecycleKey } from './interaction-view-model';
import type { SessionRuntimeActions } from './session-runtime-actions';
import styles from './session-runtime.module.css';

interface Props {
  readonly store: SessionProjectionStore;
  readonly actions: SessionRuntimeActions;
}

export default function InteractionDock({ store, actions }: Props) {
  const projection = useSessionSelector(store, selectInteractionDock);
  const { interactions } = projection;
  if (interactions.length === 0) return null;
  return (
    <section className={styles.interactionStack} aria-label="待处理交互">
      {interactions.map((interaction) => (
        <InteractionCard
          key={interactionLifecycleKey(interaction)}
          interaction={interaction}
          actions={actions}
          ready={projection.connectionState === 'connected'}
        />
      ))}
    </section>
  );
}

function InteractionCard({
  interaction,
  actions,
  ready,
}: {
  interaction: PendingInteraction;
  actions: SessionRuntimeActions;
  ready: boolean;
}) {
  return interaction.kind === 'approval'
    ? <ApprovalInteractionCard interaction={interaction} actions={actions} />
    : <QuestionInteractionCard interaction={interaction} actions={actions} ready={ready} />;
}

function selectInteractionDock(projection: SessionProjection) {
  return {
    interactions: projection.interactions,
    connectionState: projection.connectionState,
  };
}
