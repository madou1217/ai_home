'use strict';

const crypto = require('node:crypto');

function scheduleSessionPrewarm(service, session) {
  const sessionId = String(session && session.sessionId || '').trim();
  if (!sessionId || !service || typeof service.dispatchCommand !== 'function') return;
  const command = {
    commandId: `runtime-prewarm:${crypto.randomUUID()}`,
    type: 'runtime.prewarm',
    payload: {}
  };
  Promise.resolve()
    .then(() => service.dispatchCommand(sessionId, command))
    .catch(() => {});
}

module.exports = { scheduleSessionPrewarm };
