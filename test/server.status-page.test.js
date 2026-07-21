'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderProxyStatusPage } = require('../lib/server/status-page');

test('status page renders runtime account identity from accountRef', () => {
  const html = renderProxyStatusPage();

  assert.match(html, /<th>accountRef<\/th>/);
  assert.match(html, /esc\(a\.accountRef\)/);
  assert.doesNotMatch(html, /esc\(a\.id\)/);
});
