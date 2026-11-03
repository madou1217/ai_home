'use strict';

const crypto = require('node:crypto');

function branchSessionId(commandId) {
  return `session-${crypto.createHash('sha256').update(commandId).digest('hex')}`;
}

module.exports = { branchSessionId };
