'use strict';

const STATUS_MAP = new Map([
  ['pending', 'pending'],
  ['inProgress', 'in_progress'],
  ['completed', 'completed']
]);

function mapCodexPlanUpdate(params = {}) {
  const turnId = text(params.turnId);
  const steps = normalizeSteps(params.plan);
  if (!turnId || !steps) return invalidPlanUpdate(params);
  const itemId = `codex-plan:${turnId}`;
  const explanation = text(params.explanation);
  const updatedAt = timestamp(params.updatedAtMs);
  const item = {
    id: itemId,
    turnId,
    kind: 'plan',
    createdAt: updatedAt,
    updatedAt,
    status: isComplete(steps) ? 'completed' : 'running',
    detail: {
      ...(explanation ? { explanation } : {}),
      steps
    }
  };
  if (explanation) item.content = explanation;
  return {
    type: 'timeline.item.updated',
    turnId,
    itemId,
    payload: { item }
  };
}

function normalizeSteps(value) {
  if (!Array.isArray(value)) return null;
  const steps = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const step = text(entry.step);
    const status = STATUS_MAP.get(entry.status);
    if (!step || !status) return null;
    steps.push({ step, status });
  }
  return steps;
}

function invalidPlanUpdate() {
  return {
    type: 'stream.error',
    payload: {
      error: 'invalid_codex_plan_update',
      message: 'Invalid Codex plan update',
      retryable: false
    }
  };
}

function isComplete(steps) {
  return steps.length > 0 && steps.every((step) => step.status === 'completed');
}

function timestamp(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

module.exports = { mapCodexPlanUpdate };
