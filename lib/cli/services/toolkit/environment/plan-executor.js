'use strict';

const {
  createOutputCollector,
  executeLifecyclePlan,
  resolveExecutionTarget
} = require('../lifecycle-plan-executor');

function executeEnvironmentPlan(plan, options = {}) {
  return executeLifecyclePlan(plan, { ...options, errorPrefix: 'environment_action' });
}

module.exports = {
  createOutputCollector,
  executeEnvironmentPlan,
  resolveExecutionTarget
};
