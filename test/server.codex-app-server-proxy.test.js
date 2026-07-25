const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeDefaultAccountRef } = require('../lib/account/default-account-store');
const {
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const {
  createCodexAppServerProxy,
  isCodexAppServerUpgradePath,
  rewriteCodexAppServerClientMessage
} = require('../lib/server/codex-app-server-proxy');
const {
  rememberThreadResumeRequestMessage,
  patchThreadResumeResponseMessage
} = require('../lib/server/codex-thread-resume-response-patch');

function registerCodexAccount(aiHomeDir, cliAccountId, identitySeed) {
  return registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId,
    identitySeed
  }).accountRef;
}

async function captureAppServerSpawn(deps) {
  const spawns = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.emit('exit', 0, null);
    return true;
  };

  const proxy = createCodexAppServerProxy({
    ...deps,
    path,
    resolveCliPath: () => '/tmp/codex.aih-original',
    spawn(command, args, options) {
      spawns.push({ command, args, options });
      return child;
    }
  });
  const server = http.createServer();
  let handlePromise = null;
  server.on('upgrade', (req, socket, head) => {
    handlePromise = proxy.handleUpgrade(req, socket, head);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/v0/codex/app-server`);
  await once(client, 'open');
  await handlePromise;
  const closePromise = once(client, 'close');
  client.close();
  await closePromise;
  await new Promise((resolve) => server.close(resolve));
  return spawns[0];
}

test('isCodexAppServerUpgradePath accepts root and legacy codex app-server paths', () => {
  assert.equal(isCodexAppServerUpgradePath('/'), true);
  assert.equal(isCodexAppServerUpgradePath('/v0/codex/app-server'), true);
  assert.equal(isCodexAppServerUpgradePath('/v1/responses'), false);
});

test('Codex app-server receives the default API key only through its environment', async (t) => {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-app-server-key-'));
  const aiHomeDir = path.join(hostHomeDir, '.ai_home');
  const apiKey = 'sk-test-remote-app-server';
  t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));

  const accountRef = registerCodexAccount(
    aiHomeDir,
    '1',
    'api-key:codex:remote-app-server-test'
  );
  writeAccountCredentials(fs, aiHomeDir, accountRef, {
    OPENAI_API_KEY: apiKey
  });
  writeDefaultAccountRef(fs, aiHomeDir, 'codex', accountRef);

  const spawned = await captureAppServerSpawn({
    fs,
    aiHomeDir,
    hostHomeDir,
    processObj: {
      env: {
        HOME: hostHomeDir
      }
    }
  });

  assert.deepEqual(spawned.args, ['app-server', '--listen', 'stdio://']);
  assert.equal(spawned.options.env.OPENAI_API_KEY, apiKey);
  assert.equal(JSON.stringify(spawned.args).includes(apiKey), false);
});

test('Codex app-server removes an inherited API key for the default OAuth account', async (t) => {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-app-server-oauth-'));
  const aiHomeDir = path.join(hostHomeDir, '.ai_home');
  t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));

  const accountRef = registerCodexAccount(
    aiHomeDir,
    '2',
    'oauth:codex:remote-app-server@example.test'
  );
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    auth: {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'oauth-access-token',
        refresh_token: 'oauth-refresh-token'
      }
    }
  });
  writeDefaultAccountRef(fs, aiHomeDir, 'codex', accountRef);

  const spawned = await captureAppServerSpawn({
    fs,
    aiHomeDir,
    hostHomeDir,
    processObj: {
      env: {
        HOME: hostHomeDir,
        OPENAI_API_KEY: 'stale-shell-key'
      }
    }
  });

  assert.equal(spawned.options.env.OPENAI_API_KEY, undefined);
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
