'use strict';

const { isGrokSessionId } = require('./grok-model-usage-scanner');
const { createSessionUsageRefresh, isTerminalSessionEvent } = require('./session-usage-refresh');

function createGrokUsageRefresh(options = {}) {
  const service = options.modelUsageService;
  return createSessionUsageRefresh({
    ...options, label: 'Grok',
    enabled: options.enabled !== false && typeof service?.scanGrokSessionUsage === 'function',
    scan: entry => service.scanGrokSessionUsage(entry.sessionId),
    resolveSession: event => event.provider === 'grok' && isGrokSessionId(event.sessionId) && isTerminalSessionEvent(event)
      ? { provider: 'grok', sessionId: event.sessionId } : null
  });
}

module.exports = { createGrokUsageRefresh };
