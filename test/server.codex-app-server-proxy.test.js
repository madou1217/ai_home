const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isCodexAppServerUpgradePath,
  rewriteCodexAppServerClientMessage
} = require('../lib/server/codex-app-server-proxy');
const {
  rememberThreadResumeRequestMessage,
  patchThreadResumeResponseMessage
} = require('../lib/server/codex-thread-resume-response-patch');

test('isCodexAppServerUpgradePath accepts root and legacy codex app-server paths', () => {
  assert.equal(isCodexAppServerUpgradePath('/'), true);
  assert.equal(isCodexAppServerUpgradePath('/v0/codex/app-server'), true);
  assert.equal(isCodexAppServerUpgradePath('/v1/responses'), false);
});

test('rewriteCodexAppServerClientMessage injects empty modelProviders and state-db mode for thread/list', () => {
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'thread/list',
    params: {
      cwd: '/tmp/project'
    }
  });
  const out = JSON.parse(rewriteCodexAppServerClientMessage(raw));
  assert.deepEqual(out.params.modelProviders, []);
  assert.equal(out.params.useStateDbOnly, true);
  assert.equal(out.params.cwd, '/tmp/project');
});

test('rewriteCodexAppServerClientMessage clears explicit modelProviders for shared session lists', () => {
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'thread/list',
    params: {
      cwd: '/tmp/project',
      modelProviders: ['aih_10']
    }
  });
  const out = JSON.parse(rewriteCodexAppServerClientMessage(raw));
  assert.deepEqual(out.params.modelProviders, []);
  assert.equal(out.params.useStateDbOnly, true);
});

test('rewriteCodexAppServerClientMessage can inject cwd for remote CLI resume', () => {
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'thread/list',
    params: {
      modelProviders: ['aih_10']
    }
  });
  const out = JSON.parse(rewriteCodexAppServerClientMessage(raw, { cwd: '/tmp/current-project' }));
  assert.equal(out.params.cwd, '/tmp/current-project');
  assert.deepEqual(out.params.modelProviders, []);
  assert.equal(out.params.useStateDbOnly, true);
});

test('rewriteCodexAppServerClientMessage keeps explicit cwd over injected cwd', () => {
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'thread/list',
    params: {
      cwd: '/tmp/request-project'
    }
  });
  const out = JSON.parse(rewriteCodexAppServerClientMessage(raw, { cwd: '/tmp/current-project' }));
  assert.equal(out.params.cwd, '/tmp/request-project');
});

test('rewriteCodexAppServerClientMessage strips remote-only config.profile on thread/resume', () => {
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'thread/resume',
    params: {
      threadId: '019db3a4-8880-76d2-abb5-2385b007cbc5',
      model: 'gpt-5.4',
      config: {
        profile: 'default',
        extra: 'keep-me'
      },
      persistExtendedHistory: true
    }
  });
  const out = JSON.parse(rewriteCodexAppServerClientMessage(raw));
  assert.equal(out.params.config.profile, undefined);
  assert.equal(out.params.config.extra, 'keep-me');
});

test('patchThreadResumeResponseMessage adds missing threadIds for remote resume bootstrap', () => {
  const contexts = new Map();
  rememberThreadResumeRequestMessage(JSON.stringify({
    jsonrpc: '2.0',
    id: 'resume-1',
    method: 'thread/resume',
    params: { threadId: '019e9d98-5f89-7561-b195-e448f4074c14' }
  }), contexts);

  const patched = JSON.parse(patchThreadResumeResponseMessage(JSON.stringify({
    jsonrpc: '2.0',
    id: 'resume-1',
    result: {
      thread: { id: '019e9d98-5f89-7561-b195-e448f4074c14' },
      model: 'gpt-5.5',
      modelProvider: 'aih_10'
    }
  }), contexts));

  assert.deepEqual(patched.result.threadIds, ['019e9d98-5f89-7561-b195-e448f4074c14']);
  assert.equal(contexts.size, 0);
});

test('rewriteCodexAppServerClientMessage removes empty config after stripping profile', () => {
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'thread/start',
    params: {
      cwd: '/tmp/project',
      config: {
        profile: 'default'
      }
    }
  });
  const out = JSON.parse(rewriteCodexAppServerClientMessage(raw));
  assert.equal(Object.prototype.hasOwnProperty.call(out.params, 'config'), false);
});

test('rewriteCodexAppServerClientMessage leaves other methods unchanged', () => {
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'thread/get',
    params: {
      id: 'abc'
    }
  });
  assert.equal(rewriteCodexAppServerClientMessage(raw), raw);
});

test('rewriteCodexAppServerClientMessage ignores non-json payloads', () => {
  assert.equal(rewriteCodexAppServerClientMessage('not-json'), 'not-json');
});
