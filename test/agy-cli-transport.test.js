const test = require('node:test');
const assert = require('node:assert/strict');

const agyCliTransport = require('../lib/server/agy-cli-transport');

test('deprecated AGY CLI transport is not an executable reverse-proxy transport', () => {
  assert.equal(agyCliTransport.removed, true);
  assert.equal(Object.prototype.hasOwnProperty.call(agyCliTransport, 'fetchAgyCliAnthropicMessage'), false);
});
