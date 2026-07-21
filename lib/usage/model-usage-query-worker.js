'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { createModelUsageService } = require('./model-usage-service');

const QUERY_METHODS = Object.freeze({
  getDashboard: 'getDashboard',
  getStats: 'getStats',
  getCostByModel: 'getCostByModel',
  getSessions: 'getSessions',
  getSessionDetail: 'getSessionDetail'
});

function serializeError(error) {
  return {
    name: String(error && error.name || 'Error'),
    code: String(error && error.code || ''),
    message: String(error && error.message || error || 'model_usage_query_failed'),
    stack: String(error && error.stack || '')
  };
}

const modelUsageService = createModelUsageService({
  ...(workerData && workerData.serviceOptions),
  enableAsyncQueries: false
});

parentPort.on('message', (message = {}) => {
  const id = Number(message.id) || 0;
  const method = QUERY_METHODS[String(message.method || '')];
  if (!id || !method) {
    parentPort.postMessage({
      id,
      ok: false,
      error: serializeError(Object.assign(
        new Error('model_usage_query_method_invalid'),
        { code: 'model_usage_query_method_invalid' }
      ))
    });
    return;
  }

  try {
    const result = modelUsageService[method](message.query || {});
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: serializeError(error) });
  }
});
