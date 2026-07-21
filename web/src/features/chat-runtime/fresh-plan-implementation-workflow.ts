import { createWebCommandId } from './command-id';
import type { SessionRuntimeTarget } from './session-surface-policy';

export const FRESH_PLAN_IMPLEMENTATION_PREFIX = [
  "A previous agent produced the plan below to accomplish the user's task.",
  'Implement the plan in a fresh context. Treat the plan as the source of',
  'user intent, re-read files as needed, and carry the work through',
  'implementation and verification.',
].join(' ');

type CommandIdFactory = (scope?: string) => string;

export interface FreshPlanRuntimeSession {
  readonly canonicalSessionId: string;
  readonly submit: (commandId: string, content: string) => Promise<unknown>;
  readonly waitForNativeSessionId: () => Promise<string>;
  readonly close: () => void;
}

export interface FreshPlanRuntimePort {
  readonly open: (target: SessionRuntimeTarget) => Promise<FreshPlanRuntimeSession>;
  readonly resume?: (canonicalSessionId: string) => Promise<FreshPlanRuntimeSession>;
}

export interface FreshPlanImplementationResult {
  readonly canonicalSessionId: string;
  readonly nativeSessionId: string;
}

interface FreshPlanInput {
  readonly key: string;
  readonly target: SessionRuntimeTarget;
  readonly content: string;
}

interface FreshPlanAttempt {
  readonly inputKey: string;
  readonly session: FreshPlanRuntimeSession;
  readonly commandId: string;
  stage: 'submit' | 'binding' | 'completed';
  result?: FreshPlanImplementationResult;
  closed: boolean;
}

interface FreshPlanRecovery {
  readonly inputKey: string;
  readonly commandId: string;
  canonicalSessionId?: string;
}

export class FreshPlanRuntimeOpenError extends Error {
  readonly name = 'FreshPlanRuntimeOpenError';

  constructor(
    readonly canonicalSessionId: string,
    readonly originalError: unknown,
  ) {
    super('chat_fresh_runtime_open_failed');
  }
}

export class FreshPlanImplementationError extends Error {
  readonly name = 'FreshPlanImplementationError';

  constructor(
    code: string,
    readonly canonicalSessionId: string | undefined,
    readonly retryable: boolean,
    readonly originalError?: unknown,
  ) {
    super(code);
  }
}

export class FreshPlanImplementationWorkflow {
  private attempt?: FreshPlanAttempt;
  private recovery?: FreshPlanRecovery;
  private blockedCreation?: { readonly inputKey: string; readonly error: Error };
  private inFlight?: Promise<FreshPlanImplementationResult>;
  private disposed = false;

  constructor(
    private readonly port: FreshPlanRuntimePort,
    private readonly commandIdFactory: CommandIdFactory = createWebCommandId,
  ) {}

  execute(
    target: SessionRuntimeTarget,
    sourceTurnId: string,
    planMarkdown: string,
  ): Promise<FreshPlanImplementationResult> {
    if (this.disposed) return Promise.reject(new Error('chat_fresh_workflow_disposed'));
    const input = freshPlanInput(target, sourceTurnId, planMarkdown);
    this.assertCompatibleInput(input.key);
    const completed = this.attempt?.result;
    if (completed) return Promise.resolve(completed);
    if (this.inFlight) return this.inFlight;
    this.recovery ||= {
      inputKey: input.key,
      commandId: this.commandIdFactory('fresh-plan-submit'),
    };
    const task = this.run(input);
    this.inFlight = task;
    void task.then(
      () => this.clearInFlight(task),
      () => this.clearInFlight(task),
    );
    return task;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closeAttempt();
  }

  private async run(input: FreshPlanInput): Promise<FreshPlanImplementationResult> {
    const attempt = this.attempt || await this.connect(input);
    if (attempt.stage === 'submit') await this.submit(attempt, input.content);
    if (attempt.stage === 'binding') await this.bind(attempt);
    return attempt.result as FreshPlanImplementationResult;
  }

  private async submit(attempt: FreshPlanAttempt, content: string): Promise<void> {
    try {
      await attempt.session.submit(attempt.commandId, content);
      attempt.stage = 'binding';
    } catch (error) {
      throw pendingError(
        'chat_fresh_plan_submission_pending',
        attempt.session.canonicalSessionId,
        error,
      );
    }
  }

  private async bind(attempt: FreshPlanAttempt): Promise<void> {
    try {
      const nativeSessionId = requiredText(
        await attempt.session.waitForNativeSessionId(),
        'chat_fresh_native_session_pending',
      );
      attempt.result = {
        canonicalSessionId: attempt.session.canonicalSessionId,
        nativeSessionId,
      };
      attempt.stage = 'completed';
      this.closeAttempt();
    } catch (error) {
      throw pendingError(
        'chat_fresh_native_session_pending',
        attempt.session.canonicalSessionId,
        error,
      );
    }
  }

  private async connect(input: FreshPlanInput): Promise<FreshPlanAttempt> {
    const recovery = this.recovery as FreshPlanRecovery;
    let session: FreshPlanRuntimeSession;
    try {
      session = await this.openOrResume(input.target, recovery);
    } catch (error) {
      throw this.connectionFailure(input.key, recovery, error);
    }
    if (this.disposed) {
      session.close();
      throw new Error('chat_fresh_workflow_disposed');
    }
    this.assertSessionIdentity(input.key, recovery, session);
    const attempt: FreshPlanAttempt = {
      inputKey: input.key,
      session,
      commandId: recovery.commandId,
      stage: 'submit',
      closed: false,
    };
    this.attempt = attempt;
    return attempt;
  }

  private async openOrResume(
    target: SessionRuntimeTarget,
    recovery: FreshPlanRecovery,
  ): Promise<FreshPlanRuntimeSession> {
    if (!recovery.canonicalSessionId) return this.port.open(target);
    if (!this.port.resume) {
      throw new FreshPlanImplementationError(
        'chat_fresh_session_recovery_unavailable',
        recovery.canonicalSessionId,
        false,
      );
    }
    return this.port.resume(recovery.canonicalSessionId);
  }

  private connectionFailure(
    inputKey: string,
    recovery: FreshPlanRecovery,
    error: unknown,
  ): Error {
    if (error instanceof FreshPlanImplementationError && !error.retryable) {
      this.blockedCreation = { inputKey, error };
      return error;
    }
    const canonicalSessionId = runtimeOpenCanonicalSessionId(error)
      || recovery.canonicalSessionId;
    if (canonicalSessionId) {
      recovery.canonicalSessionId = canonicalSessionId;
      return pendingError(
        'chat_fresh_session_initialization_pending',
        canonicalSessionId,
        error,
      );
    }
    const failure = new FreshPlanImplementationError(
      'chat_fresh_session_creation_indeterminate',
      undefined,
      false,
      error,
    );
    this.blockedCreation = { inputKey, error: failure };
    return failure;
  }

  private assertSessionIdentity(
    inputKey: string,
    recovery: FreshPlanRecovery,
    session: FreshPlanRuntimeSession,
  ): void {
    const sessionId = normalizedText(session.canonicalSessionId);
    if (!sessionId) {
      this.blockSession(inputKey, session, undefined, 'chat_fresh_session_creation_indeterminate');
    }
    if (recovery.canonicalSessionId && recovery.canonicalSessionId !== sessionId) {
      this.blockSession(
        inputKey,
        session,
        recovery.canonicalSessionId,
        'chat_fresh_session_identity_mismatch',
      );
    }
    recovery.canonicalSessionId = sessionId;
  }

  private blockSession(
    inputKey: string,
    session: FreshPlanRuntimeSession,
    canonicalSessionId: string | undefined,
    code: string,
  ): never {
    session.close();
    const failure = new FreshPlanImplementationError(
      code,
      canonicalSessionId,
      false,
    );
    this.blockedCreation = { inputKey, error: failure };
    throw failure;
  }

  private assertCompatibleInput(inputKey: string): void {
    const activeInputKey = this.attempt?.inputKey || this.recovery?.inputKey;
    if (activeInputKey && activeInputKey !== inputKey) {
      throw new Error('chat_fresh_plan_attempt_conflict');
    }
    if (!this.blockedCreation) return;
    if (this.blockedCreation.inputKey !== inputKey) {
      throw new Error('chat_fresh_plan_attempt_conflict');
    }
    throw this.blockedCreation.error;
  }

  private closeAttempt(): void {
    const attempt = this.attempt;
    if (!attempt || attempt.closed) return;
    attempt.closed = true;
    attempt.session.close();
  }

  private clearInFlight(task: Promise<FreshPlanImplementationResult>): void {
    if (this.inFlight === task) this.inFlight = undefined;
  }
}

function freshPlanInput(
  target: SessionRuntimeTarget,
  sourceTurnId: string,
  planMarkdown: string,
): FreshPlanInput {
  const plan = requiredText(planMarkdown, 'chat_plan_markdown_required');
  const source = requiredText(sourceTurnId, 'chat_plan_turn_id_required');
  const fresh = freshTarget(target);
  return {
    key: JSON.stringify([
      fresh.provider,
      fresh.executionAccountRef,
      fresh.projectPath || '',
      source,
      plan,
    ]),
    target: fresh,
    content: `${FRESH_PLAN_IMPLEMENTATION_PREFIX}\n\n${plan}`,
  };
}

function freshTarget(target: SessionRuntimeTarget): SessionRuntimeTarget {
  const { nativeSessionId: _nativeSessionId, ...fresh } = target;
  return { ...fresh, policy: { approvalMode: 'confirm' } };
}

function pendingError(
  code: string,
  canonicalSessionId: string,
  originalError: unknown,
): FreshPlanImplementationError {
  return new FreshPlanImplementationError(
    code,
    canonicalSessionId,
    true,
    originalError,
  );
}

function runtimeOpenCanonicalSessionId(error: unknown): string {
  return error instanceof FreshPlanRuntimeOpenError
    ? normalizedText(error.canonicalSessionId)
    : '';
}

function requiredText(value: string, code: string): string {
  const text = normalizedText(value);
  if (!text) throw new Error(code);
  return text;
}

function normalizedText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}
