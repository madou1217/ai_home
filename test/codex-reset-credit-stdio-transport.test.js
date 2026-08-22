'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

let subject = {};
try {
  subject = require('../lib/server/codex-reset-credit-stdio-transport');
} catch (_error) {}

const { createCodexResetCreditStdioTransport } = subject;
let rpcSubject = {};
try {
  rpcSubject = require('../lib/server/codex-app-server-stdio-rpc-client');
} catch (_error) {}
const { createCodexAppServerStdioRpcClient } = rpcSubject;
const ACCOUNT_REF = 'acct_11111111111111111111';

test('stdio RPC client initializes, verifies account identity, and never retries a request', async () => {
  assert.equal(typeof createCodexAppServerStdioRpcClient, 'function');
  const messages = [];
  const child = createFakeStdioChild((payload) => {
    messages.push(payload);
    if (payload.method === 'initialize') {
      child.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        result: { codexHome: '/profiles/account/.codex' }
      })}\n`);
    } else if (payload.method === 'account/read') {
      child.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        result: { account: { type: 'chatgpt', email: 'user@example.com' } }
      })}\n`);
    } else if (payload.method === 'account/rateLimits/read') {
      child.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        result: { rateLimitResetCredits: { availableCount: 1, credits: [] } }
      })}\n`);
    }
  });
  let identityChecks = 0;
  const client = createCodexAppServerStdioRpcClient({
    command: '/opt/codex',
    args: ['app-server', '--listen', 'stdio://'],
    cwd: '/profiles/account',
    env: { CODEX_HOME: '/profiles/account/.codex' },
    requestTimeoutMs: 1000,
    spawnImpl: () => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    accountIdentityValidator: async ({ initializeResult, accountResult }) => {
      identityChecks += 1;
      assert.equal(initializeResult.codexHome, '/profiles/account/.codex');
      assert.equal(accountResult.account.email, 'user@example.com');
      return { verified: true };
    }
  });

  const result = await client.request('account/rateLimits/read', {});
  client.close();

  assert.equal(result.rateLimitResetCredits.availableCount, 1);
  assert.equal(identityChecks, 1);
  assert.deepEqual(messages.map((message) => message.method), [
    'initialize',
    'initialized',
    'account/read',
    'account/rateLimits/read'
  ]);
  assert.equal(child.killCalls, 1);
});

test('stdio RPC timeout terminates the child before returning uncertainty', async () => {
  const child = createFakeStdioChild((message) => {
    if (message.method === 'initialize') {
      child.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { codexHome: '/profiles/account/.codex' }
      })}\n`);
      return;
    }
    if (message.method === 'account/read') {
      child.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { account: { type: 'chatgpt', email: 'user@example.com' } }
      })}\n`);
    }
  });
  const client = createCodexAppServerStdioRpcClient({
    command: '/opt/codex',
    args: ['app-server', '--listen', 'stdio://'],
    cwd: '/profiles/account',
    env: { CODEX_HOME: '/profiles/account/.codex' },
    requestTimeoutMs: 100,
    spawnImpl: () => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    accountIdentityValidator: async () => ({ verified: true })
  });

  let watchdog;
  try {
    await assert.rejects(
      Promise.race([
        client.request('account/rateLimits/read', {}),
        new Promise((_, reject) => {
          watchdog = setTimeout(() => reject(new Error('stdio timeout test watchdog')), 500);
        })
      ]),
      (error) => error.code === 'codex_app_server_stdio_timeout'
    );
  } finally {
    clearTimeout(watchdog);
  }
  assert.equal(child.killCalls, 1);
  client.close();
});

test('reset-credit management uses a one-shot account-scoped stdio app-server without tmux', async () => {
  assert.equal(typeof createCodexResetCreditStdioTransport, 'function');
  const runtimeDir = path.join('/profiles', ACCOUNT_REF);
  const createdClients = [];
  const identityValidator = async () => ({ verified: true });
  const transport = createCodexResetCreditStdioTransport({
    accountIdentityValidatorFactory: () => identityValidator,
    aiHomeDir: '/aih',
    buildProviderEnv(provider, receivedRuntimeDir, baseEnv, options) {
      assert.equal(provider, 'codex');
      assert.equal(receivedRuntimeDir, runtimeDir);
      assert.equal(options.accountRef, ACCOUNT_REF);
      assert.deepEqual(baseEnv, { PATH: '/usr/bin' });
      return {
        PATH: '/usr/bin',
        CODEX_HOME: path.join(runtimeDir, '.codex')
      };
    },
    buildPtyLaunch(command, args) {
      return { command, args };
    },
    createStdioClient(options) {
      const calls = [];
      const client = {
        calls,
        closeCalls: 0,
        async request(method, params) {
          calls.push({ method, params });
          return method === 'account/rateLimits/read'
            ? { rateLimitResetCredits: { availableCount: 1, credits: [] } }
            : { outcome: 'reset' };
        },
        close() {
          this.closeCalls += 1;
        }
      };
      createdClients.push({ client, options });
      return client;
    },
    env: { PATH: '/usr/bin' },
    getProfileDir: () => runtimeDir,
    platform: 'linux',
    resolveNativeCliLaunch: () => ({ command: '/opt/codex', prefixArgs: [] })
  });

  const listed = await transport.readRateLimits(ACCOUNT_REF);
  const consumed = await transport.consumeCredit(ACCOUNT_REF, {
    creditId: 'credit-1',
    idempotencyKey: '11111111-1111-4111-8111-111111111111'
  });

  assert.equal(listed.rateLimitResetCredits.availableCount, 1);
  assert.equal(consumed.outcome, 'reset');
  assert.equal(createdClients.length, 2);
  for (const { client, options } of createdClients) {
    assert.equal(options.command, '/opt/codex');
    assert.deepEqual(options.args, ['app-server', '--listen', 'stdio://']);
    assert.equal(options.env.AIH_CODEX_APP_SERVER_PASSTHROUGH, '1');
    assert.equal(options.accountIdentityValidator, identityValidator);
    assert.equal(client.closeCalls, 1);
  }
  assert.deepEqual(createdClients[0].client.calls, [{
    method: 'account/rateLimits/read',
    params: {}
  }]);
  assert.deepEqual(createdClients[1].client.calls, [{
    method: 'account/rateLimitResetCredit/consume',
    params: {
      creditId: 'credit-1',
      idempotencyKey: '11111111-1111-4111-8111-111111111111'
    }
  }]);
});

test('Windows reset-credit stdio preserves a spaced Codex .cmd path with verbatim spawning', async () => {
  assert.equal(typeof createCodexResetCreditStdioTransport, 'function');
  const createdClients = [];
  const codexPath = 'C:\\Program Files\\Codex CLI\\codex.cmd';
  const transport = createCodexResetCreditStdioTransport({
    accountIdentityValidatorFactory: () => async () => ({ verified: true }),
    aiHomeDir: 'C:\\aih',
    buildProviderEnv: () => ({ Path: 'C:\\Windows\\System32' }),
    createStdioClient(options) {
      createdClients.push(options);
      return {
        async request() {
          return { rateLimitResetCredits: { availableCount: 0, credits: [] } };
        },
        close() {}
      };
    },
    getProfileDir: () => `C:\\profiles\\${ACCOUNT_REF}`,
    platform: 'win32',
    resolveNativeCliLaunch: () => ({ command: codexPath, prefixArgs: [] })
  });

  await transport.readRateLimits(ACCOUNT_REF);

  assert.equal(createdClients.length, 1);
  assert.equal(createdClients[0].command, 'cmd.exe');
  assert.deepEqual(createdClients[0].args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(
    createdClients[0].args[3],
    `chcp 65001>nul & "${codexPath}" app-server --listen stdio://`
  );
  assert.equal(createdClients[0].spawnOptions.windowsVerbatimArguments, true);
});

test('reset-credit service no longer imports the resident app-server client pool', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'server', 'codex-reset-credit-service.js'),
    'utf8'
  );

  assert.doesNotMatch(source, /codex-app-server-client-pool/);
});

function createFakeStdioChild(onWrite) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new EventEmitter();
  child.stdin.destroyed = false;
  child.stdin.writableEnded = false;
  child.stdin.write = (chunk) => {
    for (const line of String(chunk || '').split('\n').filter(Boolean)) {
      onWrite(JSON.parse(line));
    }
    return true;
  };
  child.stdin.end = () => {
    child.stdin.writableEnded = true;
  };
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    return true;
  };
  return child;
}
