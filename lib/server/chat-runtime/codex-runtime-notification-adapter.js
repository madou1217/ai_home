'use strict';

const crypto = require('node:crypto');

const HOOK_STATUSES = Object.freeze({
  blocked: 'failed',
  completed: 'completed',
  failed: 'failed',
  running: 'running',
  stopped: 'cancelled'
});

function mapCodexHookNotification(params = {}, completed = false) {
  const run = record(params.run);
  const itemId = text(run.id);
  const eventName = text(run.eventName);
  if (!itemId || !eventName) return null;
  const status = HOOK_STATUSES[text(run.status)] || (completed ? 'completed' : 'running');
  const item = {
    id: itemId,
    kind: 'tool',
    createdAt: timestamp(run.startedAt),
    status,
    content: hookContent(run, eventName),
    detail: {
      name: `Hook: ${eventName}`,
      input: compact({
        executionMode: text(run.executionMode) || undefined,
        handlerType: text(run.handlerType) || undefined,
        scope: text(run.scope) || undefined,
        sourcePath: text(run.sourcePath) || undefined
      }),
      ...(completed ? {
        result: compact({
          durationMs: finiteNumber(run.durationMs),
          entries: hookEntries(run.entries),
          status: text(run.status) || status
        })
      } : {})
    }
  };
  if (completed) item.updatedAt = timestamp(run.completedAt || run.startedAt);
  const turnId = text(params.turnId);
  if (turnId) item.turnId = turnId;
  return {
    type: completed ? 'timeline.item.completed' : 'timeline.item.started',
    ...(turnId ? { turnId } : {}),
    itemId,
    payload: { item }
  };
}

function mapCodexWarningNotification(params = {}) {
  const message = text(params.message);
  if (!message) return null;
  const itemId = warningItemId(params.threadId, message);
  return {
    type: 'timeline.item.completed',
    itemId,
    payload: {
      item: {
        id: itemId,
        kind: 'notice',
        createdAt: 0,
        updatedAt: 0,
        status: 'completed',
        content: message,
        detail: { code: 'codex_warning', level: 'warning' }
      }
    }
  };
}

function hookContent(run, eventName) {
  const statusMessage = text(run.statusMessage);
  if (statusMessage) return statusMessage;
  const entries = hookEntries(run.entries).map((entry) => entry.text).filter(Boolean);
  return entries.join('\n') || `${eventName} hook`;
}

function hookEntries(value) {
  return (Array.isArray(value) ? value : []).map((entry) => compact({
    kind: text(entry && entry.kind) || undefined,
    text: text(entry && entry.text) || undefined
  })).filter((entry) => entry.kind || entry.text);
}

function warningItemId(threadId, message) {
  const digest = crypto.createHash('sha256')
    .update(`${text(threadId)}\0${message}`)
    .digest('hex')
    .slice(0, 24);
  return `codex-warning:${digest}`;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function timestamp(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

module.exports = {
  mapCodexHookNotification,
  mapCodexWarningNotification
};
