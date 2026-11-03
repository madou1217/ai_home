'use strict';

const { getTranslationProviderFacade } = require('./provider-facade');

// Preferences arrive normalized by the settings boundary. Resolve capabilities
// here, while keeping unavailable providers in the plan so attempts stay visible.
function planTranslationRoutes(routes, options = {}) {
  const facade = options.facade || getTranslationProviderFacade();
  const operation = String(options.operation || 'selection').trim().toLowerCase();
  return (Array.isArray(routes) ? routes : [])
    .map((route, index) => ({ route, index }))
    .filter(({ route }) => route && route.enabled !== false
      && Array.isArray(route.operations) && route.operations.includes(operation))
    .sort((left, right) => {
      const priority = (entry) => Number.isFinite(Number(entry.route.priority)) ? Number(entry.route.priority) : entry.index;
      return priority(left) - priority(right) || left.index - right.index;
    })
    .map(({ route }) => ({ route, operation, descriptor: facade.resolve(route, operation) }));
}

module.exports = { planTranslationRoutes };
