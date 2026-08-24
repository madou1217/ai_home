'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  buildRemoteControlProcessObject
} = require('../lib/server/codex-remote-control-account-context');

test('remote-control 子进程从 hook state 路径获取真实 AIH_HOME 与 Desktop 账号', () => {
  const aiHomeDir = path.join('/Users/tester', '.ai_home');
  const processObj = {
    env: {
      HOME: path.join(aiHomeDir, 'run', 'auth-projections', 'codex', 'acct_projection'),
      PATH: '/usr/bin'
    },
    pid: 123,
    execPath: '/usr/bin/node'
  };
  const childProcessObj = buildRemoteControlProcessObject(processObj, {
    desktopAccountRef: 'acct_0123456789abcdef0123'
  }, path.join(aiHomeDir, 'run', 'codex', 'desktop-hook-state.json'));

  assert.notEqual(childProcessObj, processObj);
  assert.equal(childProcessObj.pid, 123);
  assert.equal(childProcessObj.env.AIH_REMOTE_CONTROL_ACCOUNT_REF, 'acct_0123456789abcdef0123');
  assert.equal(childProcessObj.env.AIH_REMOTE_CONTROL_AI_HOME, aiHomeDir);
  assert.equal(childProcessObj.env.HOME, processObj.env.HOME);
  assert.equal(processObj.env.AIH_REMOTE_CONTROL_ACCOUNT_REF, undefined);
  assert.equal(processObj.env.AIH_REMOTE_CONTROL_AI_HOME, undefined);
});
