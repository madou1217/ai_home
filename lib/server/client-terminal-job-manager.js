'use strict';

const {
  executeTerminalPlan,
  listClientTerminals,
  resolveTerminalActionPlan
} = require('../runtime/client-terminal');
const {
  createToolkitResourceJobManager,
  isTerminalStatus,
  serializeToolkitResourceJob
} = require('./toolkit-resource-job-manager');

function serializeTerminalJob(job) {
  return serializeToolkitResourceJob(job && {
    ...job,
    source: job.source || 'terminal',
    kind: job.kind || 'terminal',
    resourceId: job.resourceId || job.terminalId
  });
}

function planTerminalAction(input, options) {
  const planned = resolveTerminalActionPlan(input, options);
  if (!planned.ok) return planned;
  return {
    ...planned,
    tool: { id: planned.terminalId, name: planned.terminalId },
    plans: [{
      id: `${planned.terminalId}_${planned.action}`,
      label: planned.label,
      action: planned.action,
      file: planned.file,
      command: planned.file,
      args: [...(planned.args || [])],
      env: {}
    }]
  };
}

function createClientTerminalJobManager(options = {}) {
  const runPlan = typeof options.runPlan === 'function'
    ? options.runPlan
    : (plan, runtimeOptions) => executeTerminalPlan(plan, {
        ...runtimeOptions,
        runPlan: undefined
      });
  const probeTerminal = typeof options.probeTerminal === 'function'
    ? options.probeTerminal
    : (terminalId, runtimeOptions) => listClientTerminals(runtimeOptions)
      .find((terminal) => terminal.id === terminalId) || null;

  return createToolkitResourceJobManager({
    ...options,
    source: 'terminal',
    kind: 'terminal',
    idPrefix: 'terminal-action',
    eventType: 'terminal-job',
    waitingLabel: '等待终端操作开始',
    failureLabel: '终端操作失败。',
    cancelledLabel: '终端任务已取消。',
    serializeJob: serializeTerminalJob,
    planAction: typeof options.planAction === 'function' ? options.planAction : planTerminalAction,
    runPlan,
    probeResource: probeTerminal
  });
}

module.exports = {
  createClientTerminalJobManager,
  isTerminalStatus,
  serializeTerminalJob
};
