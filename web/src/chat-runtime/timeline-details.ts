export type PlanStepStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanStep {
  readonly step: string;
  readonly status: PlanStepStatus;
}

export interface TimelineDetailByKind {
  message: { role: 'user' | 'assistant' | 'system'; phase?: string; model?: string };
  reasoning: { summary?: string; segments?: readonly string[] };
  plan: {
    state?: 'draft' | 'proposed' | 'accepted' | 'rejected';
    steps?: readonly PlanStep[];
  };
  tool: {
    name: string; callId?: string; input?: unknown; result?: unknown;
    exitCode?: number; server?: string;
  };
  shell: {
    command: string; cwd?: string; callId?: string; output?: string;
    exitCode?: number; processId?: number; actions?: readonly unknown[];
  };
  diff: { paths?: readonly string[]; patch?: string };
  file_change: { callId?: string; changes: readonly unknown[]; diff?: string };
  terminal: {
    stream: 'stdin' | 'stdout' | 'stderr'; terminalId?: string; artifactId?: string;
  };
  question: { interactionId: string; options?: readonly string[]; answered?: boolean };
  approval: { interactionId: string; action: string; decision?: 'allow' | 'deny' };
  subagent: { agentId: string; state?: string };
  command: { commandId: string; command: string };
  attachment: { name: string; mimeType: string; url?: string };
  artifact: { artifactId: string; name: string; mimeType: string; size?: number };
  notice: { level: 'info' | 'warning' | 'success' };
  error: { code: string; retryable?: boolean };
}
