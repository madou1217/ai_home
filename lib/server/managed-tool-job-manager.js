'use strict';

const {
  listManagedTools,
  planManagedToolAction
} = require('../cli/services/toolkit/tool-manager');
const { executeLifecyclePlan } = require('../cli/services/toolkit/lifecycle-plan-executor');
const {
  createToolkitResourceJobManager,
  desiredStateReached,
  isTerminalStatus,
  serializeToolkitResourceJob
} = require('./toolkit-resource-job-manager');

function serializeManagedToolJob(job) {
  return serializeToolkitResourceJob(job);
}

function createManagedToolJobManager(options = {}) {
  return createToolkitResourceJobManager({
    ...options,
    source: 'managed-tool',
    kind: 'managed-tool',
    idPrefix: 'managed-tool-action',
    eventType: 'managed-tool-job',
    waitingLabel: '等待网络工具操作开始',
    failureLabel: '网络工具操作失败。',
    cancelledLabel: '网络工具任务已取消。',
    planAction: typeof options.planAction === 'function' ? options.planAction : planManagedToolAction,
    runPlan: typeof options.runPlan === 'function'
      ? options.runPlan
      : (plan, runtimeOptions) => executeLifecyclePlan(plan, {
          ...runtimeOptions,
          errorPrefix: 'managed_tool_action'
        }),
    probeResource: typeof options.probeTool === 'function'
      ? options.probeTool
      : (toolId, runtimeOptions) => listManagedTools(runtimeOptions).tools.find((tool) => tool.id === toolId) || null
  });
}

module.exports = {
  createManagedToolJobManager,
  desiredStateReached,
  isTerminalStatus,
  serializeManagedToolJob
};
