'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  INSTALL_LIFECYCLE_ACTIONS,
  defineInstallLifecycle
} = require('../lib/runtime/install-lifecycle');

test('安装生命周期接口强制三个基础动作并保留可扩展接口成员', () => {
  assert.deepEqual(INSTALL_LIFECYCLE_ACTIONS, ['install', 'update', 'uninstall']);
  const inspect = () => ({ ok: true });
  const lifecycle = defineInstallLifecycle({
    install: inspect,
    update: inspect,
    uninstall: inspect,
    inspect
  }, 'test lifecycle');

  assert.equal(lifecycle.install, inspect);
  assert.equal(lifecycle.update, inspect);
  assert.equal(lifecycle.uninstall, inspect);
  assert.equal(lifecycle.inspect, inspect);
  assert.throws(
    () => defineInstallLifecycle({ install: inspect, update: inspect }, 'invalid lifecycle'),
    /invalid lifecycle must implement uninstall\(\)/
  );
});
