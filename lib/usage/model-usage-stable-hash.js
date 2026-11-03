'use strict';

const crypto = require('node:crypto');

function stableHash(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 16);
}

module.exports = { stableHash };
