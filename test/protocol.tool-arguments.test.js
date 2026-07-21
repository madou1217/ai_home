'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseToolArguments
} = require('../lib/protocol/tool-arguments');

test('tool argument parser returns objects and tolerates malformed JSON generically', () => {
  assert.deepEqual(parseToolArguments('{"query":"x"}'), { query: 'x' });
  assert.deepEqual(parseToolArguments(''), {});
  assert.deepEqual(parseToolArguments('not json'), {});
  assert.deepEqual(parseToolArguments('"scalar"'), {});
});
