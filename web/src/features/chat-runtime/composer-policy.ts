import type { CapabilitySnapshot, SessionState } from '@/chat-runtime';
import type { ComposerDelivery } from './session-runtime-actions';

const ACTIVE_STATES = new Set<SessionState>([
  'starting', 'running', 'waiting_input', 'interrupting', 'completing', 'recovering',
]);

export interface ComposerPolicy {
  readonly turnActive: boolean;
  readonly deliveries: readonly ComposerDelivery[];
  readonly slashCommands: readonly string[];
  readonly canInterrupt: boolean;
}

export function resolveComposerPolicy(
  state: SessionState,
  capabilities?: CapabilitySnapshot,
): ComposerPolicy {
  const turnActive = ACTIVE_STATES.has(state);
  const deliveries: ComposerDelivery[] = turnActive ? [] : ['turn'];
  if (turnActive && supports(capabilities, 'turn.steer.current')) {
    deliveries.push('steer_current');
  }
  if (turnActive && supports(capabilities, 'turn.steer.tool_boundary')) {
    deliveries.push('after_tool_boundary');
  }
  if (turnActive && supports(capabilities, 'turn.queue')) deliveries.push('after_turn');
  return {
    turnActive,
    deliveries,
    slashCommands: turnActive ? [] : capabilities?.slashCommands || [],
    canInterrupt: turnActive && supports(capabilities, 'turn.interrupt'),
  };
}

export function canSubmitComposerInput(
  input: string,
  delivery: ComposerDelivery | undefined,
  busy: boolean,
  attachmentCount = 0,
): boolean {
  if (!delivery || busy) return false;
  if (delivery === 'turn') return Boolean(input.trim() || attachmentCount > 0);
  return Boolean(input.trim());
}

export function canSwitchComposerAccount(policy: ComposerPolicy): boolean {
  return !policy.turnActive;
}

function supports(
  snapshot: CapabilitySnapshot | undefined,
  name: 'turn.steer.current' | 'turn.steer.tool_boundary' | 'turn.queue' | 'turn.interrupt',
): boolean {
  const support = snapshot?.capabilities?.[name]?.support;
  return support === 'native' || support === 'emulated';
}
