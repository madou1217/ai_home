import { LegacyChatSurface } from './LegacyChatSurface';
import type {
  LegacyChatCatalogPort,
  LegacyChatSelectionPort,
} from './legacy-runtime-ports';
import { useLegacyComposerActions } from './use-legacy-composer-actions';
import { useLegacyPromptActions } from './use-legacy-prompt-actions';
import { useLegacyQueueActions } from './use-legacy-queue-actions';
import { useLegacySessionOrchestration } from './use-legacy-session-orchestration';

export type {
  LegacyChatCatalogPort,
  LegacyChatSelectionPort,
} from './legacy-runtime-ports';

interface LegacyChatRuntimeProps {
  readonly mobile: boolean;
  readonly selection: LegacyChatSelectionPort;
  readonly catalog: LegacyChatCatalogPort;
  readonly onRunningSessionKeysChange: (keys: Set<string>) => void;
}

export default function LegacyChatRuntime({
  mobile,
  selection,
  catalog,
  onRunningSessionKeysChange,
}: LegacyChatRuntimeProps) {
  const runtime = useLegacySessionOrchestration({
    selection,
    catalog,
    onRunningSessionKeysChange,
  });
  const composer = useLegacyComposerActions({
    selection,
    refreshProjects: catalog.refreshProjects,
    runtime,
  });
  const queueActions = useLegacyQueueActions({
    session: selection.session,
    accounts: catalog.accounts,
    runtime,
    composer,
  });
  const onSelectPlanChoice = useLegacyPromptActions({
    sessionRef: selection.sessionRef,
    runtime,
  });

  return (
    <LegacyChatSurface
      mobile={mobile}
      selection={selection}
      catalog={catalog}
      runtime={runtime}
      composer={composer}
      queueActions={queueActions}
      onSelectPlanChoice={onSelectPlanChoice}
    />
  );
}
