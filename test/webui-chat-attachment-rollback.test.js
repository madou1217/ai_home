'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { registerAccountIdentity } = require('../lib/account/account-registration');
const { resolveProviderAttachmentRoot } = require('../lib/runtime/provider-storage-policy');
const { writeAccountCredentials } = require('../lib/server/account-credential-store');
const { handleChatRequest } = require('../lib/server/webui-chat-routes');
const nativeSessionChat = require('../lib/server/native-session-chat');

function createResponse() {
  const response = new EventEmitter();
  Object.assign(response, {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
      this.headersSent = true;
    },
    write(chunk = '') {
      this.body += String(chunk);
      return true;
    },
    end(chunk = '') {
      this.body += String(chunk);
      this.writableEnded = true;
    }
  });
  return response;
}

function createContext(root, payload) {
  const req = new EventEmitter();
  req.headers = {};
  const res = createResponse();
  const aiHomeDir = path.join(root, '.ai_home');
  const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'gemini',
    cliAccountId: '1',
    identitySeed: 'oauth:gemini:attachment-rollback@example.com'
  });
  writeAccountCredentials(fs, aiHomeDir, accountRef, { AIH_TEST_CONFIGURED: '1' });
  return {
    req,
    res,
    fs,
    aiHomeDir,
    state: {},
    options: {},
    deps: {
      hostHomeDir: root,
      sessionEventBus: { publish() { return true; } }
    },
    readRequestBody: async () => Buffer.from(JSON.stringify({ ...payload, accountRef }), 'utf8'),
    writeJson(response, statusCode, body) {
      response.statusCode = statusCode;
      response.end(JSON.stringify(body));
    },
    getToolConfigDir: () => path.join(root, 'config'),
    getProfileDir: () => path.join(root, 'profile'),
    loadServerRuntimeAccounts: () => ({}),
    ensureSessionStoreLinks() {},
    registerNativeChatRun() {},
    unregisterNativeChatRun() {},
    createChatEventMeta: (startedAt, extra = {}) => ({ startedAt, ...extra })
  };
}

function attachmentPayload(stream) {
  return {
    provider: 'gemini',
    sessionId: 'rollback-session',
    projectPath: os.tmpdir(),
    prompt: 'inspect attachment',
    stream,
    images: ['data:image/png;base64,YQ=='],
    messages: [{ role: 'user', content: 'inspect attachment' }]
  };
}

function assertAttachmentRootEmpty(root) {
  const attachmentRoot = resolveProviderAttachmentRoot(root, 'gemini');
  assert.deepEqual(fs.existsSync(attachmentRoot) ? fs.readdirSync(attachmentRoot) : [], []);
}

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!predicate() && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true, 'condition did not become true before timeout');
}

test('stream readiness failure rolls back materialized attachments', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-readiness-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalEnsureReady = nativeSessionChat.ensureNativeCliReadyForChat;
  nativeSessionChat.ensureNativeCliReadyForChat = async () => ({ ok: false, message: 'missing cli' });
  t.after(() => { nativeSessionChat.ensureNativeCliReadyForChat = originalEnsureReady; });

  const ctx = createContext(root, attachmentPayload(true));
  assert.equal(await handleChatRequest(ctx), true);
  assert.equal(ctx.res.statusCode, 200);
  assert.match(ctx.res.body, /"code":"cli_not_found"/);
  assertAttachmentRootEmpty(root);
});

test('non-stream readiness failure rolls back materialized attachments', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-json-readiness-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalEnsureReady = nativeSessionChat.ensureNativeCliReadyForChat;
  nativeSessionChat.ensureNativeCliReadyForChat = async () => ({
    ok: false,
    confirmationRequired: true,
    message: 'confirmation required'
  });
  t.after(() => { nativeSessionChat.ensureNativeCliReadyForChat = originalEnsureReady; });

  const ctx = createContext(root, attachmentPayload(false));
  assert.equal(await handleChatRequest(ctx), true);
  assert.equal(ctx.res.statusCode, 409);
  assertAttachmentRootEmpty(root);
});

test('detached stream failure rolls back attachments after the SSE client disconnects', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-detached-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalEnsureReady = nativeSessionChat.ensureNativeCliReadyForChat;
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  let rejectRun;
  let attachmentPath = '';
  nativeSessionChat.ensureNativeCliReadyForChat = async () => ({ ok: true });
  nativeSessionChat.spawnNativeSessionStream = (options) => {
    [attachmentPath] = options.imagePaths;
    return {
      runId: 'detached-rollback-run',
      abort() {},
      done: new Promise((_resolve, reject) => { rejectRun = reject; })
    };
  };
  t.after(() => {
    nativeSessionChat.ensureNativeCliReadyForChat = originalEnsureReady;
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  });

  const ctx = createContext(root, attachmentPayload(true));
  assert.equal(await handleChatRequest(ctx), true);
  assert.equal(fs.existsSync(attachmentPath), true);
  ctx.res.emit('close');
  rejectRun(Object.assign(new Error('native failed'), { code: 'native_session_failed' }));
  await waitFor(() => !fs.existsSync(attachmentPath));
  assertAttachmentRootEmpty(root);
});
