'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAccountAppProcessTitle,
  markAccountAppProcess
} = require('../lib/runtime/account-app-process-marker');

test('Toolkit 启动的 POSIX 账号 CLI 写入可由 ps 扫描的进程标题', () => {
  const processObj = {
    platform: 'darwin',
    argv: ['/usr/local/bin/node', '/repo/bin/ai-home.js', 'claude', '7'],
    env: {
      AIH_ACCOUNT_APP: '1',
      AIH_PROVIDER_ACCOUNT_REF: 'acct_0123456789abcdef0123'
    },
    title: 'node'
  };

  const title = markAccountAppProcess(processObj);

  assert.equal(title, 'aih claude 7 AIH_ACCOUNT_APP=1 AIH_PROVIDER_ACCOUNT_REF=acct_0123456789abcdef0123');
  assert.equal(processObj.title, title);
});

test('非 Toolkit 启动、非账号命令和 Windows 均不改写进程标题', () => {
  const base = {
    argv: ['/usr/local/bin/node', '/repo/bin/ai-home.js', 'claude', '7'],
    env: {},
    title: 'node'
  };
  assert.equal(markAccountAppProcess({ ...base, platform: 'darwin' }), '');
  assert.equal(markAccountAppProcess({
    ...base,
    platform: 'darwin',
    argv: ['/usr/local/bin/node', '/repo/bin/ai-home.js', 'server', 'serve'],
    env: { AIH_ACCOUNT_APP: '1' }
  }), '');
  assert.equal(markAccountAppProcess({
    ...base,
    platform: 'win32',
    env: { AIH_ACCOUNT_APP: '1' }
  }), '');
});

test('进程标题只接受规范 accountRef，缺失时仍可由 provider 与 CLI ID 回查', () => {
  assert.equal(buildAccountAppProcessTitle(
    ['/usr/local/bin/node', '/repo/bin/ai-home.js', 'codex', '3'],
    {
      AIH_ACCOUNT_APP: '1',
      AIH_PROVIDER_ACCOUNT_REF: 'unexpected-ref'
    }
  ), 'aih codex 3 AIH_ACCOUNT_APP=1');
});
