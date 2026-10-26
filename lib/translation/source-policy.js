'use strict';

const { getTranslationProviderFacade } = require('./provider-facade');
const { planTranslationRoutes } = require('./route-planner');

// Every possible fallback must accept auto before the shared request can omit
// source detection. Unknown/custom providers remain conservative by default.
function translationRoutesAllowAutoSource(routes, { facade = getTranslationProviderFacade(), operation = 'selection', useGatewayDefault = false } = {}) {
  const plan = planTranslationRoutes(routes, { facade, operation });
  if (plan.length) return plan.every(({ descriptor }) => descriptor?.capabilities?.sourceAuto === true);
  if (!useGatewayDefault) return false;
  const gateway = facade.list(operation).find((descriptor) => descriptor.config?.modelSource === 'gateway');
  return gateway?.capabilities?.sourceAuto === true;
}

module.exports = { translationRoutesAllowAutoSource };
