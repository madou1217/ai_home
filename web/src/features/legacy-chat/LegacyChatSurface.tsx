import { MessageArea } from '@/components/chat';
import {
  shouldUseExternalPending,
} from '@/components/chat/provider-pending-policy.js';
import {
  supportsMidRunSteer,
} from '@/components/chat/provider-capabilities.js';
import type { InteractivePrompt } from '@/types';
import type {
  LegacyChatCatalogPort,
  LegacyChatSelectionPort,
} from './legacy-runtime-ports';
import { findProjectBySessionId } from './project-selection-policy';
import type { LegacyComposerActions } from './use-legacy-composer-actions';
import type { LegacyQueueActions } from './use-legacy-queue-actions';
import type { LegacySessionRuntime } from './use-legacy-session-orchestration';

interface LegacyChatSurfaceProps {
  readonly mobile: boolean;
  readonly selection: Pick<
    LegacyChatSelectionPort,
    | 'account'
    | 'approvalMode'
    | 'changeAccount'
    | 'changeApprovalMode'
    | 'changeModel'
    | 'changeSession'
    | 'model'
    | 'session'
  >;
  readonly catalog: Pick<LegacyChatCatalogPort, 'accounts' | 'projects'>;
  readonly runtime: LegacySurfaceRuntime;
  readonly composer: Pick<
    LegacyComposerActions,
    'changeImages' | 'changeInput' | 'images' | 'input' | 'send' | 'stop'
  >;
  readonly queueActions: LegacyQueueActions;
  readonly onSelectPlanChoice: (choice: string, prompt: InteractivePrompt) => Promise<void>;
}

interface LegacySurfaceRuntime {
  readonly history: Pick<
    LegacySessionRuntime['history'],
    'hasMoreHistory' | 'loadMoreHistory' | 'messages' | 'watchPendingStatus'
  >;
  readonly queue: Pick<LegacySessionRuntime['queue'], 'selectedMessages'>;
  readonly runs: Pick<
    LegacySessionRuntime['runs'],
    'loading' | 'selectedPrompt' | 'selectedStatusText'
  >;
  readonly terminal: Pick<
    LegacySessionRuntime['terminal'],
    'close' | 'registerWriter' | 'resize' | 'selectedRun' | 'sendInput'
  >;
}

export function LegacyChatSurface({
  mobile,
  selection,
  catalog,
  runtime,
  composer,
  queueActions,
  onSelectPlanChoice,
}: LegacyChatSurfaceProps) {
  const { history, queue, runs, terminal } = runtime;
  const terminated = !selection.session.draft && !findProjectBySessionId(catalog.projects, {
    sessionId: selection.session.id,
    provider: selection.session.provider,
    projectPath: selection.session.projectPath,
  });
  const canSteer = supportsMidRunSteer(
    selection.account?.provider || '',
    selection.account?.apiKeyMode,
  );

  return (
    <MessageArea
      mobile={mobile}
      session={selection.session}
      isTerminated={terminated}
      messages={history.messages}
      accounts={catalog.accounts}
      selectedAccount={selection.account}
      selectedModel={selection.model}
      input={composer.input}
      loading={runs.loading}
      loadingStatusText={runs.selectedStatusText}
      queuedMessages={queue.selectedMessages}
      externalPending={Boolean(
        !runs.loading
        && history.watchPendingStatus
        && shouldUseExternalPending(selection.session.provider),
      )}
      externalPendingStatusText={history.watchPendingStatus || runs.selectedStatusText}
      interactivePrompt={runs.selectedPrompt}
      hasMoreHistory={history.hasMoreHistory}
      images={composer.images}
      onLoadMore={history.loadMoreHistory}
      onInputChange={composer.changeInput}
      onSend={composer.send}
      onStop={composer.stop}
      onEditQueuedMessage={queueActions.edit}
      onRemoveQueuedMessage={queueActions.remove}
      onSendQueuedMessageNow={queueActions.sendNow}
      onSteerQueuedMessage={canSteer ? queueActions.steer : undefined}
      approvalMode={selection.approvalMode}
      onApprovalModeChange={selection.account?.provider === 'claude' && !selection.account.apiKeyMode
        ? selection.changeApprovalMode
        : undefined}
      onSelectPlanChoice={onSelectPlanChoice}
      terminalRun={terminal.selectedRun(selection.session)}
      onRegisterTerminalWriter={terminal.registerWriter}
      onTerminalInput={terminal.sendInput}
      onTerminalResize={terminal.resize}
      onCloseTerminal={terminal.close}
      onAccountChange={(account) => {
        selection.changeAccount(account);
        if (selection.session.draft) {
          selection.changeSession({ ...selection.session, provider: account.provider });
        }
      }}
      onModelChange={selection.changeModel}
      onImagesChange={composer.changeImages}
      terminalCwd={selection.session.projectPath}
    />
  );
}
