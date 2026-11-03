'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_MAX_BUFFERED_BYTES,
  getRequestBodyBudgetSnapshot,
  reserveRequestBodyBytes,
  releaseRequestBodyBytes
} = require('../lib/server/request-body-budget');

test('request body budget rejects aggregate reservations and releases them', () => {
  const before = getRequestBodyBudgetSnapshot();
  assert.equal(before.bufferedBytes, 0);
  assert.equal(reserveRequestBodyBytes(DEFAULT_MAX_BUFFERED_BYTES), true);
  assert.equal(reserveRequestBodyBytes(1), false);
  assert.equal(getRequestBodyBudgetSnapshot().bufferedBytes, DEFAULT_MAX_BUFFERED_BYTES);
  releaseRequestBodyBytes(DEFAULT_MAX_BUFFERED_BYTES);
  assert.equal(getRequestBodyBudgetSnapshot().bufferedBytes, 0);
});
