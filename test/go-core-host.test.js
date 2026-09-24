'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createGoCoreHost, resolveGoCoreSettings } = require('../lib/server/go-core-host');

const silentLog = { log() {}, error() {} };

function fakeSupervisorFactory(behaviour = {}) {
  const calls = { options: null, start: 0, stop: 0 };
  let state = 'stopped';
  const factory = (options) => {
    calls.options = options;
    state = options.enabled ? 'stopped' : 'disabled';
    return {
      status: () => ({
        enabled: options.enabled,
        state,
        pid: state === 'ready' ? 77 : 0,
        endpoint: state === 'ready' ? 'http://127.0.0.1:19550' : '',
        error: ''
      }),
      start: async () => {
        calls.start += 1;
        if (behaviour.failStart) {
          state = 'failed';
          const error = new Error('not ready');
          error.code = 'go_core_not_ready';
          throw error;
        }
        state = 'ready';
        return factory.lastStatus();
      },
      stop: async () => {
        calls.stop += 1;
        state = 'stopped';
      }
    };
  };
  factory.lastStatus = () => ({ state, endpoint: 'http://127.0.0.1:19550', pid: 77 });
  return { factory, calls };
}

test('resolveGoCoreSettings reads persisted config and lets AIH_GO_CORE_* override it', () => {
  assert.deepEqual(
    resolveGoCoreSettings({ goCoreEnabled: true, goCoreRoutes: ['gateway.models.list'] }, {}).routes,
    ['gateway.models.list']
  );
  assert.equal(resolveGoCoreSettings({ goCoreEnabled: true }, {}).enabled, true);
  assert.equal(resolveGoCoreSettings({ goCoreEnabled: true }, { AIH_GO_CORE_ENABLED: '0' }).enabled, false);
  const fromEnv = resolveGoCoreSettings({}, {
    AIH_GO_CORE_ENABLED: 'true',
    AIH_GO_CORE_ROUTES: 'gateway.props,gateway.models.list',
    AIH_GO_CORE_PORT: '19600'
  });
  assert.equal(fromEnv.enabled, true);
  assert.deepEqual(fromEnv.routes, ['gateway.props', 'gateway.models.list']);
  assert.equal(fromEnv.port, 19600);
  assert.equal(resolveGoCoreSettings({}, {}).enabled, false);
});

test('a disabled Go Core never spawns and claims no routes by default', async () => {
  const { factory, calls } = fakeSupervisorFactory();
  const host = createGoCoreHost({ settings: resolveGoCoreSettings({}, {}), createGoCoreSupervisor: factory, log: silentLog });

  await host.start();

  assert.equal(calls.start, 0);
  assert.deepEqual(host.status().routes, []);
  assert.equal(host.tryHandleHttp({ method: 'GET', headers: {} }, {}, { method: 'GET', pathname: '/v1/models' }), false);
});

test('an enabled Go Core gets boot-scoped distinct keys and is stopped with the host', async () => {
  const { factory, calls } = fakeSupervisorFactory();
  const host = createGoCoreHost({
    settings: resolveGoCoreSettings({ goCoreEnabled: true, goCoreRoutes: ['gateway.models.list'] }, {}),
    createGoCoreSupervisor: factory,
    aiHomeDir: '/tmp/aih-home',
    publicPort: 9527,
    log: silentLog
  });

  await host.start();
  await host.stop();

  assert.equal(calls.start, 1);
  assert.equal(calls.stop, 1);
  assert.equal(calls.options.enabled, true);
  assert.equal(calls.options.aiHomeDir, '/tmp/aih-home');
  assert.equal(calls.options.publicPort, 9527);
  const managementKey = calls.options.managementKey();
  const clientKey = calls.options.clientKey();
  assert.ok(managementKey.length >= 32 && clientKey.length >= 32);
  assert.notEqual(managementKey, clientKey);
  assert.deepEqual(host.status().routes, ['gateway.models.list']);
});

test('a failed Go Core start is reported but does not throw out of the Node host', async () => {
  const { factory } = fakeSupervisorFactory({ failStart: true });
  const errors = [];
  const host = createGoCoreHost({
    settings: resolveGoCoreSettings({ goCoreEnabled: true, goCoreRoutes: ['gateway.models.list'] }, {}),
    createGoCoreSupervisor: factory,
    log: { log() {}, error: (message) => errors.push(message) }
  });

  const status = await host.start();

  assert.equal(status.state, 'failed');
  assert.match(errors.join('\n'), /go_core_not_ready/);
});

test('routes assigned to a disabled Go Core are reported as failing closed', async () => {
  const errors = [];
  const { factory } = fakeSupervisorFactory();
  const host = createGoCoreHost({
    settings: resolveGoCoreSettings({ goCoreRoutes: ['gateway.models.list'] }, {}),
    createGoCoreSupervisor: factory,
    log: { log() {}, error: (message) => errors.push(message) }
  });

  await host.start();

  assert.match(errors.join('\n'), /fail closed with 503/);
});
