'use strict';

const errors = require('../../contracts/codex-relay/errors.json');

function writeCodexRelayError(response, code, statusCode, options = {}) {
  const definition = errors[code] || errors.upstream_temporarily_unavailable;
  response.statusCode = statusCode || definition.status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  if (code === 'unauthorized') response.setHeader('www-authenticate', 'Bearer');
  const message = typeof options.message === 'string' && options.message.trim()
    ? options.message.trim()
    : definition.message;
  const error = { message, type: definition.type, param: null, code };
  if (Number(options.retryAfterSeconds) > 0) error.retry_after_seconds = Math.ceil(Number(options.retryAfterSeconds));
  if (options.detail && typeof options.detail === 'string' && options.detail.trim()) error.detail = options.detail.trim();
  response.end(JSON.stringify({ error }));
}

module.exports = { writeCodexRelayError };
