'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../web/node_modules/typescript');

const source = fs.readFileSync(require.resolve('../web/src/components/hud/gateway-failure-policy.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports });
const policy = mod.exports;

const network = new Error('Network Error');
const serverDown = { response: { status: 502 } };
const unauthorized = { response: { status: 401 } };
const keyMissing = { response: { status: 503, data: { error: 'webui_unauthorized' } } };

test('one or two transient failures do not mark the gateway offline', () => {
  let state = policy.INITIAL_FAILURE_STATE;
  state = policy.recordGatewayFailure(state, network);
  assert.equal(state.offline, false);
  state = policy.recordGatewayFailure(state, serverDown);
  assert.equal(state.offline, false);
  state = policy.recordGatewayFailure(state, network);
  assert.equal(state.offline, true, 'third consecutive failure goes offline');
});

test('a success in between resets the counter', () => {
  let state = policy.recordGatewayFailure(policy.recordGatewayFailure(policy.INITIAL_FAILURE_STATE, network), network);
  state = policy.recordGatewaySuccess();
  state = policy.recordGatewayFailure(state, network);
  assert.deepEqual({ ...state }, { consecutiveFailures: 1, offline: false });
});

test('credential problems go offline immediately because retrying cannot fix them', () => {
  assert.equal(policy.recordGatewayFailure(policy.INITIAL_FAILURE_STATE, unauthorized).offline, true);
  assert.equal(policy.recordGatewayFailure(policy.INITIAL_FAILURE_STATE, keyMissing).offline, true);
  assert.equal(policy.isConfigurationFailure({ response: { status: 503, data: { error: 'busy' } } }), false);
});

test('failures retry quickly, then fall back to the normal interval', () => {
  const interval = 15000;
  let state = policy.INITIAL_FAILURE_STATE;
  assert.equal(policy.nextPollDelay(state, interval), interval);
  state = policy.recordGatewayFailure(state, network);
  assert.equal(policy.nextPollDelay(state, interval), 2000);
  state = policy.recordGatewayFailure(state, network);
  assert.equal(policy.nextPollDelay(state, interval), 5000);
  state = policy.recordGatewayFailure(state, network);
  assert.equal(policy.nextPollDelay(state, interval), interval, 'offline keeps polling at the normal pace');
});
