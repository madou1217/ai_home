'use strict';

const { planEnvironmentToolAction } = require('../cli/services/toolkit/environment/lifecycle');
const { executeEnvironmentPlan } = require('../cli/services/toolkit/environment/plan-executor');
const { getEnvironmentToolAdapter } = require('../cli/services/toolkit/environment/tools');
const {
  createToolkitResourceJobManager,
  desiredStateReached,
  isTerminalStatus,
  serializeToolkitResourceJob
} = require('./toolkit-resource-job-manager');

function serializeEnvironmentJob(job) {
  return serializeToolkitResourceJob(job && {
    ...job,
    source: job.source || 'environment',
    kind: job.kind || 'environment',
    resourceId: job.resourceId || job.toolId
  });
}

function createEnvironmentToolJobManager(options = {}) {
  const probeTool = typeof options.probeTool === 'function'
    ? options.probeTool
    : (toolId, runtimeOptions) => getEnvironmentToolAdapter(toolId)?.detect(runtimeOptions)
      || { installed: false, version: '', executablePath: '', managedVersions: [] };

  return createToolkitResourceJobManager({
    ...options,
    source: 'environment',
    kind: 'environment',
    idPrefix: 'environment-action',
    eventType: 'environment-job',
    waitingLabel: '等待运行环境操作开始',
    failureLabel: '运行环境操作失败。',
    cancelledLabel: '运行环境任务已取消。',
    serializeJob: serializeEnvironmentJob,
    planAction: typeof options.planAction === 'function'
      ? options.planAction
      : planEnvironmentToolAction,
    runPlan: typeof options.runPlan === 'function'
      ? options.runPlan
      : executeEnvironmentPlan,
    probeResource: probeTool
  });
}

module.exports = {
  createEnvironmentToolJobManager,
  desiredStateReached,
  isTerminalStatus,
  serializeEnvironmentJob
};
