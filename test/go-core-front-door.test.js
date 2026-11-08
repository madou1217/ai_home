'use strict';

// P3 前门：开启时 Go 多开一个公开监听，Node 退到回环 port+1。
// 这里锁定参数合同，避免「开关打开但参数没传」导致 Go 只监听私有端点。

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildGoCoreInvocation } = require('../lib/cli/services/server/go-core-supervisor');

const base = {
  aiHomeDir: '/tmp/aih-home',
  managementKey: 'm'.repeat(32),
  clientKey: 'c'.repeat(32),
  binaryPath: '/bin/true',
  host: '127.0.0.1',
  port: 19550,
  publicPort: 9527,
  publicHost: '0.0.0.0',
  webDir: '/srv/web/dist'
};

function argValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

test('前门开启时追加公开监听、上游与静态目录参数', () => {
  const invocation = buildGoCoreInvocation({ ...base, frontDoor: true });
  assert.equal(argValue(invocation.args, '--front-door-listen'), '0.0.0.0:9527');
  assert.equal(argValue(invocation.args, '--front-door-upstream'), 'http://127.0.0.1:9528');
  assert.equal(argValue(invocation.args, '--web-dir'), '/srv/web/dist');
  assert.equal(argValue(invocation.args, '--port'), '19550');
});

test('前门关闭时参数与旧行为逐字一致', () => {
  const invocation = buildGoCoreInvocation({ ...base, frontDoor: false });
  assert.deepEqual(invocation.args, ['--host', '127.0.0.1', '--port', '19550']);
});
