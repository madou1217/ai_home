export type CapabilitySupport = 'native' | 'emulated' | 'unsupported' | 'unknown';

export type ChatCapabilityName =
  | 'session.resume' | 'timeline.reasoning' | 'timeline.tool' | 'timeline.diff'
  | 'mode.plan' | 'interaction.question' | 'interaction.approval'
  | 'interaction.plan_confirmation' | 'turn.interrupt' | 'turn.steer.current'
  | 'turn.steer.tool_boundary' | 'turn.queue' | 'slash.execute'
  | 'terminal.stream' | 'run.adopt';

export interface CapabilityDescriptor {
  readonly support: CapabilitySupport;
  readonly reason?: string;
  readonly alternatives?: readonly string[];
}

export interface CapabilitySnapshot {
  readonly revision?: string;
  readonly capturedAt?: number;
  readonly capabilities?: Readonly<Partial<Record<ChatCapabilityName, CapabilityDescriptor>>>;
  readonly slashCommands?: readonly string[];
  readonly turnInterveneModes?: readonly string[];
}
