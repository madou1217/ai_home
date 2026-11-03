import { createWebCommandId } from './command-id';

export const PLAN_IMPLEMENTATION_MESSAGE = 'Implement the plan.';

type CommandIdFactory = (scope?: string) => string;

export interface PlanImplementationRuntimePort {
  readonly confirmPolicy: (commandId: string) => Promise<unknown>;
  readonly submit: (commandId: string, content: string) => Promise<unknown>;
}

interface PlanImplementationAttempt {
  readonly sourceTurnId: string;
  readonly policyCommandId: string;
  readonly submitCommandId: string;
  stage: 'policy' | 'submit' | 'completed';
}

export class PlanImplementationWorkflow {
  private attempt?: PlanImplementationAttempt;
  private inFlight?: Promise<void>;

  constructor(
    private readonly port: PlanImplementationRuntimePort,
    private readonly commandIdFactory: CommandIdFactory = createWebCommandId,
  ) {}

  execute(sourceTurnId: string): Promise<void> {
    const attempt = this.resolveAttempt(requiredText(sourceTurnId));
    if (attempt.stage === 'completed') return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const task = this.run(attempt);
    this.inFlight = task;
    void task.then(
      () => this.clearInFlight(task),
      () => this.clearInFlight(task),
    );
    return task;
  }

  private resolveAttempt(sourceTurnId: string): PlanImplementationAttempt {
    const current = this.attempt;
    if (current?.sourceTurnId === sourceTurnId) return current;
    if (current && current.stage !== 'completed') {
      throw new Error('chat_plan_implementation_in_progress');
    }
    const next: PlanImplementationAttempt = {
      sourceTurnId,
      policyCommandId: this.commandIdFactory('plan-policy'),
      submitCommandId: this.commandIdFactory('plan-submit'),
      stage: 'policy',
    };
    this.attempt = next;
    return next;
  }

  private async run(attempt: PlanImplementationAttempt): Promise<void> {
    if (attempt.stage === 'policy') {
      await this.port.confirmPolicy(attempt.policyCommandId);
      attempt.stage = 'submit';
    }
    if (attempt.stage === 'submit') {
      await this.port.submit(attempt.submitCommandId, PLAN_IMPLEMENTATION_MESSAGE);
      attempt.stage = 'completed';
    }
  }

  private clearInFlight(task: Promise<void>): void {
    if (this.inFlight === task) this.inFlight = undefined;
  }
}

function requiredText(value: string): string {
  const text = value.trim();
  if (!text) throw new Error('chat_plan_turn_id_required');
  return text;
}
