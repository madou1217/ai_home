'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  __private
} = require('../lib/server/webui-model-refresh-scheduler');

test('scheduled model refresh scopes accounts by accountRef', () => {
  const scope = __private.buildScheduledAccountScope({
    provider: 'gemini',
    account: {
      id: '7',
      accountRef: 'acct_0123456789abcdefabcd',
      provider: 'gemini',
      accessToken: 'token'
    }
  });

  assert.deepEqual(scope, {
    accountRef: 'acct_0123456789abcdefabcd'
  });
  assert.equal(Object.prototype.hasOwnProperty.call(scope, 'provider'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(scope, 'uniqueKey'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(scope, 'accountKey'), false);
});

test('scheduled model refresh has no fallback when accountRef is missing', () => {
  const scope = __private.buildScheduledAccountScope({
    provider: 'agy',
    account: {
      id: '3',
      provider: 'agy',
      accessToken: 'token'
    }
  });

  assert.deepEqual(scope, {
    accountRef: ''
  });
  assert.equal(Object.prototype.hasOwnProperty.call(scope, 'provider'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(scope, 'uniqueKey'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(scope, 'accountKey'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(scope, 'accountId'), false);
});
