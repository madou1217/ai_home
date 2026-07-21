import { protocolFailure, record, text } from './dto-guards';
import type {
  PlanStep,
  PlanStepStatus,
  TimelineDetailByKind,
} from './timeline-details';

const PLAN_STATES = new Set(['draft', 'proposed', 'accepted', 'rejected'] as const);
const PLAN_STEP_STATUSES = new Set<PlanStepStatus>([
  'pending', 'in_progress', 'completed',
]);

export function parsePlanDetail(value: unknown): TimelineDetailByKind['plan'] {
  const source = record(value, 'chat_runtime_timeline_detail_invalid');
  return {
    ...(source.state === undefined ? {} : { state: planState(source.state) }),
    ...(source.steps === undefined ? {} : { steps: planSteps(source.steps) }),
  };
}

function planSteps(value: unknown): readonly PlanStep[] {
  if (!Array.isArray(value)) return protocolFailure(code('steps'));
  return value.map((entry) => {
    const source = record(entry, code('steps'));
    return {
      step: text(source.step, code('step')),
      status: planStepStatus(source.status),
    };
  });
}

function planState(value: unknown): TimelineDetailByKind['plan']['state'] {
  const state = text(value, code('state')) as NonNullable<TimelineDetailByKind['plan']['state']>;
  if (!PLAN_STATES.has(state)) protocolFailure(code('state'));
  return state;
}

function planStepStatus(value: unknown): PlanStepStatus {
  const status = text(value, code('status')) as PlanStepStatus;
  if (!PLAN_STEP_STATUSES.has(status)) protocolFailure(code('status'));
  return status;
}

function code(field: string): string {
  return `chat_runtime_timeline_detail_${field}_invalid`;
}
