'use strict';

const errors = require('../../contracts/codex-relay/errors.json');

function writeCodexRelayError(response, code, statusCode) {
  const definition = errors[code] || errors.upstream_temporarily_unavailable;
  response.statusCode = statusCode || definition.status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  if (code === 'unauthorized') response.setHeader('www-authenticate', 'Bearer');
  response.end(JSON.stringify({ error: { message: definition.message, type: definition.type, param: null, code } }));
}

module.exports = { writeCodexRelayError };
