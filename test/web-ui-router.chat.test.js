const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { handleWebUIRequest } = require('../lib/server/web-ui-router');
const { createSessionEventBus } = require('../lib/server/session-event-bus');
const nativeSessionChat = require('../lib/server/native-session-chat');
const nativeSlashCommands = require('../lib/server/native-slash-commands');
const httpUtils = require('../lib/server/http-utils');
const sessionReader = require('../lib/sessions/session-reader');
const { getPublicAccountRef } = require('../lib/account/public-account-ref');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountCredentials } = require('../lib/server/account-credential-store');
const { addOpenedProject } = require('../lib/server/webui-project-store');

const ACCOUNT_IDENTITIES = Object.freeze({
  geminiOne: { provider: 'gemini', cliAccountId: '1', identitySeed: 'oauth:gemini:chat-one@example.com' },
  geminiTwo: { provider: 'gemini', cliAccountId: '2', identitySeed: 'oauth:gemini:chat-two@example.com' },
  codexOne: { provider: 'codex', cliAccountId: '1', identitySeed: 'oauth:codex:chat-one@example.com' },
  codexTenThousand: { provider: 'codex', cliAccountId: '10000', identitySeed: 'oauth:codex:chat-10000@example.com' },
  claudeOne: { provider: 'claude', cliAccountId: '1', identitySeed: 'oauth:claude:chat-one@example.com' },
  claudeTwo: { provider: 'claude', cliAccountId: '2', identitySeed: 'oauth:claude:chat-two@example.com' },
  claudeThree: { provider: 'claude', cliAccountId: '3', identitySeed: 'oauth:claude:chat-three@example.com' },
  claudeFour: { provider: 'claude', cliAccountId: '4', identitySeed: 'oauth:claude:chat-four@example.com' },
  agyTwo: { provider: 'agy', cliAccountId: '2', identitySeed: 'oauth:agy:chat-two@example.com' },
  agyThree: { provider: 'agy', cliAccountId: '3', identitySeed: 'oauth:agy:chat-three@example.com' },
  opencodeOne: { provider: 'opencode', cliAccountId: '1', identitySeed: 'oauth:opencode:chat-one@example.com' }
});
const ACCOUNT_REFS = Object.freeze(Object.fromEntries(
  Object.entries(ACCOUNT_IDENTITIES).map(([key, identity]) => [
    key,
    getPublicAccountRef(`unique:${identity.identitySeed}`)
  ])
));
const sharedAiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-chat-db-'));

function registerChatAccount(aiHomeDir, identityKey, credentials = { AIH_TEST_CONFIGURED: '1' }) {
  const identity = ACCOUNT_IDENTITIES[identityKey];
  const registration = registerAccountIdentity(fs, aiHomeDir, identity);
  assert.equal(registration.accountRef, ACCOUNT_REFS[identityKey]);
  writeAccountCredentials(fs, aiHomeDir, registration.accountRef, credentials);
  return registration.accountRef;
}

Object.keys(ACCOUNT_IDENTITIES).forEach((identityKey) => registerChatAccount(sharedAiHomeDir, identityKey));
const originalRealHome = process.env.REAL_HOME;
const sandboxRealHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-chat-real-home-'));
process.env.REAL_HOME = sandboxRealHome;
test.after(() => {
  if (originalRealHome === undefined) delete process.env.REAL_HOME;
  else process.env.REAL_HOME = originalRealHome;
  fs.rmSync(sandboxRealHome, { recursive: true, force: true });
  fs.rmSync(sharedAiHomeDir, { recursive: true, force: true });
});

function createStreamResCapture() {
  const response = new EventEmitter();
  Object.assign(response, {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(code, headers = {}) {
      this.statusCode = code;
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

async function waitForStreamEnd(res, timeoutMs = 6000) {
  const startedAt = Date.now();
  while (!res.writableEnded && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!res.writableEnded) {
    assert.fail(`stream did not finish within ${timeoutMs}ms:\n${res.body}`);
  }
}

function createBaseDeps(overrides = {}) {
  return {
    fs,
    aiHomeDir: sharedAiHomeDir,
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    },
    readRequestBody: async (_req, _options) => null,
    accountStateIndex: {
      upsertAccountState() {},
      removeAccount() {},
      getAccountState() {
        return null;
      }
    },
    getToolAccountIds() {
      return [];
    },
    getToolConfigDir() {
      return '/tmp/config';
    },
    getProfileDir() {
      return '/tmp/profile';
    },
    loadServerRuntimeAccounts() {
      return { codex: [], gemini: [], claude: [] };
    },
    applyReloadState() {},
    checkStatus() {
      return { configured: true, accountName: 'test@example.com' };
    },
    ensureSessionStoreLinks() {},
    ...overrides
  };
}

function createAbortablePendingNativeStream(fields = {}) {
  const {
    doneResult = { content: '', sessionId: '' },
    onAbort,
    ...streamFields
  } = fields;
  let settled = false;
  let resolveDone = null;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  return {
    ...streamFields,
    abort() {
      if (!settled) {
        settled = true;
        resolveDone(doneResult);
      }
      if (typeof onAbort === 'function') onAbort();
    },
    done
  };
}

test('web ui chat streams native session resume as SSE events', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  nativeSessionChat.spawnNativeSessionStream = (options = {}) => {
    return {
      abort() {},
      done: new Promise((resolve) => {
        setTimeout(() => {
          options.onEvent({ type: 'delta', delta: '你好' });
          resolve({ content: '你好' });
        }, 0);
      })
    };
  };

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'gemini',
      accountRef: ACCOUNT_REFS.geminiOne,
      sessionId: 'gem-session-id',
      projectDirName: 'ai-home',
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: '你好',
      stream: true,
      messages: [{ role: 'user', content: '你好' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['Content-Type'], 'text/event-stream; charset=utf-8');
    assert.match(res.body, /"type":"ready"/);
    assert.match(res.body, /"type":"delta","delta":"你好"/);
    assert.match(res.body, /"type":"done"/);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui chat sends retry status immediately before the first content token', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  let finish = null;
  nativeSessionChat.spawnNativeSessionStream = (options = {}) => ({
    runId: 'native-run-retry-status',
    abort() {},
    done: new Promise((resolve) => {
      finish = () => {
        options.onEvent({ type: 'delta', delta: '恢复后的回复' });
        resolve({ content: '恢复后的回复', sessionId: 'claude-retry-session' });
      };
      setTimeout(() => options.onEvent({
        type: 'retry-status',
        phase: 'scheduled',
        source: 'upstream-api',
        provider: 'claude',
        attempt: 2,
        maxAttempts: 10,
        retryAfterMs: 1080,
        status: 429,
        reason: 'rate_limit'
      }), 0);
    })
  });

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'claude',
      accountRef: ACCOUNT_REFS.claudeOne,
      sessionId: 'claude-retry-session',
      projectDirName: '-Users-model-projects-feature-ai-home',
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: '你会什么',
      stream: true,
      messages: [{ role: 'user', content: '你会什么' }]
    };

    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: {},
      state: {},
      deps: createBaseDeps({
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      })
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(res.body, /"type":"retry-status"/);
    assert.match(res.body, /"attempt":2/);
    assert.doesNotMatch(res.body, /恢复后的回复/);

    finish();
    await waitForStreamEnd(res);
    assert.ok(res.body.indexOf('"type":"retry-status"') < res.body.indexOf('"type":"delta"'));
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui chat closes an already-started AGY stream with an SSE error when setup throws', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  nativeSessionChat.spawnNativeSessionStream = () => {
    const error = new Error('agy_stream_setup_failed');
    error.code = 'agy_stream_setup_failed';
    throw error;
  };

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    let jsonWrites = 0;
    const payload = {
      provider: 'agy',
      accountRef: ACCOUNT_REFS.agyTwo,
      sessionId: 'agy-session-id',
      projectDirName: 'agy-project',
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: '继续',
      stream: true,
      messages: [{ role: 'user', content: '继续' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: {},
      state: {},
      deps: createBaseDeps({
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8'),
        writeJson() {
          jsonWrites += 1;
          throw new Error('write_json_after_stream_start');
        }
      })
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.writableEnded, true);
    assert.equal(jsonWrites, 0);
    assert.match(res.body, /"type":"error"/);
    assert.match(res.body, /"code":"agy_stream_setup_failed"/);
    assert.match(res.body, /"mode":"native-session"/);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui native session chat publishes updates to session event bus', async (t) => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  const sessionEventBus = createSessionEventBus({
    fs: require('fs-extra'),
    resolveSessionFilePath() { return ''; }
  });
  t.after(() => {
    sessionEventBus.close();
  });

  nativeSessionChat.spawnNativeSessionStream = (options = {}) => ({
    runId: 'native-run-bus-test',
    abort() {},
    done: new Promise((resolve) => {
      setTimeout(() => {
        options.onEvent({ type: 'delta', delta: '你好' });
        resolve({ content: '你好', sessionId: options.sessionId });
      }, 0);
    })
  });

  try {
    const sessionId = 'gem-session-bus-id';
    const watchReq = new EventEmitter();
    watchReq.headers = {};
    const watchRes = createStreamResCapture();
    const deps = createBaseDeps({ sessionEventBus, hostHomeDir: sandboxRealHome });
    const watchHandled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/sessions/watch',
      url: new URL(`http://localhost/v0/webui/sessions/watch?provider=gemini&sessionId=${sessionId}&projectDirName=ai-home`),
      req: watchReq,
      res: watchRes,
      options: {},
      state: {},
      deps
    });
    assert.equal(watchHandled, true);
    const projectedPromptPath = path.join(
      sharedAiHomeDir,
      'run',
      'auth-projections',
      'gemini',
      ACCOUNT_REFS.geminiOne,
      '.gemini',
      'tmp',
      'model',
      'images',
      'prompt.png'
    );
    const nativePromptPath = path.join(sandboxRealHome, '.gemini', 'tmp', 'model', 'images', 'prompt.png');
    sessionEventBus.publish({ provider: 'gemini', sessionId, projectDirName: 'ai-home' }, {
      type: 'session:interactive-prompt',
      promptId: 'prompt-path-test',
      prompt: { promptId: 'prompt-path-test', question: `open ${projectedPromptPath}?` }
    });

    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'gemini',
      accountRef: ACCOUNT_REFS.geminiOne,
      sessionId,
      projectDirName: 'ai-home',
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: '你好',
      stream: true,
      messages: [{ role: 'user', content: '你好' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...deps,
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    await waitForStreamEnd(res);

    assert.equal(handled, true);
    assert.match(watchRes.body, /"source":"native-session-chat"/);
    assert.match(watchRes.body, /"eventType":"session:turn-started"/);
    assert.match(watchRes.body, /"eventType":"session:turn-completed"/);
    assert.match(watchRes.body, /"reason":"native_session_done"/);
    assert.equal(watchRes.body.includes(projectedPromptPath), false, watchRes.body);
    assert.equal(watchRes.body.includes(nativePromptPath), true);
    watchReq.emit('close');
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui chat strips unsupported gemini oauth native model before starting session', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  let seenOptions = null;
  nativeSessionChat.spawnNativeSessionStream = (options = {}) => {
    seenOptions = options;
    return {
      abort() {},
      done: Promise.resolve({ content: '你好', sessionId: options.sessionId || 'gem-session-id' })
    };
  };

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'gemini',
      accountRef: ACCOUNT_REFS.geminiOne,
      createSession: true,
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: '你好',
      model: 'gemini-3.1-pro-preview',
      stream: true,
      messages: [{ role: 'user', content: '你好' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(handled, true);
    assert.equal(seenOptions.provider, 'gemini');
    assert.equal(seenOptions.model, undefined);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui chat retries gemini native session on permission denied without leaking raw terminal error', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  const attempts = [];

  nativeSessionChat.spawnNativeSessionStream = (options = {}) => {
    attempts.push(String(options.accountRef || ''));
    if (String(options.accountRef) === ACCOUNT_REFS.geminiOne) {
      return {
        runId: `native-run-${options.accountRef}`,
        abort() {},
        done: new Promise((resolve, reject) => {
          setTimeout(() => {
            options.onEvent({
              type: 'session-created',
              sessionId: 'failed-session'
            });
            options.onEvent({
              type: 'terminal-output',
              text: 'The caller does not have permission\n'
            });
            options.onEvent({
              type: 'error',
              message: '当前 Gemini 账号无权限（PERMISSION_DENIED）'
            });
            const error = new Error('The caller does not have permission PERMISSION_DENIED');
            error.code = 'gemini_permission_denied';
            reject(error);
          }, 0);
        })
      };
    }
    return {
      runId: `native-run-${options.accountRef}`,
      abort() {},
      done: new Promise((resolve) => {
        setTimeout(() => {
          options.onEvent({
            type: 'session-created',
            sessionId: 'ok-session'
          });
          options.onEvent({
            type: 'delta',
            delta: '你好'
          });
          resolve({
            content: '你好',
            sessionId: 'ok-session'
          });
        }, 0);
      })
    };
  };

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'gemini',
      accountRef: ACCOUNT_REFS.geminiOne,
      sessionId: 'gem-session-id',
      projectDirName: 'ai-home',
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: '你好',
      stream: true,
      messages: [{ role: 'user', content: '你好' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        loadServerRuntimeAccounts() {
          return {
            codex: [],
            claude: [],
            gemini: [
              { accountRef: ACCOUNT_REFS.geminiOne, cooldownUntil: 0, authInvalidUntil: 0 },
              { accountRef: ACCOUNT_REFS.geminiTwo, cooldownUntil: 0, authInvalidUntil: 0 }
            ]
          };
        },
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(handled, true);
    assert.deepEqual(attempts, [ACCOUNT_REFS.geminiOne, ACCOUNT_REFS.geminiTwo]);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /"type":"ready"/);
    assert.match(res.body, /"type":"session-created","sessionId":"ok-session"/);
    assert.match(res.body, /"type":"delta","delta":"你好"/);
    assert.match(res.body, /"type":"done"/);
    assert.match(res.body, new RegExp(`"accountRef":"${ACCOUNT_REFS.geminiTwo}"`));
    assert.doesNotMatch(res.body, /"type":"terminal-output"/);
    assert.doesNotMatch(res.body, /The caller does not have permission/);
    assert.doesNotMatch(res.body, /gemini_stream_failed/);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui projects watch does not infer running state from session file cursor changes', async () => {
  const originalReadAllProjectsFromHost = sessionReader.readAllProjectsFromHost;
  const originalGetSessionFileCursor = sessionReader.getSessionFileCursor;
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-watch-idle-'));
  let cursor = 10;

  sessionReader.readAllProjectsFromHost = () => [{
    id: 'ai_home',
    name: 'ai-home',
    path: projectDir,
    provider: 'codex',
    sessions: [{
      id: 'session-1',
      title: 'resume',
      updatedAt: Date.now() - 60_000,
      projectDirName: 'ai_home'
    }]
  }];
  sessionReader.getSessionFileCursor = () => cursor;

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();

    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects/watch',
      url: new URL('http://localhost/v0/webui/projects/watch'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        fs
      }
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'text/event-stream');
    assert.match(res.body, /"type":"connected"/);

    cursor = 11;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    req.emit('close');

    assert.match(res.body, /"type":"runtime"/);
    assert.doesNotMatch(res.body, /"runningSessionKeys":\["codex:session-1:ai_home"\]/);
  } finally {
    sessionReader.readAllProjectsFromHost = originalReadAllProjectsFromHost;
    sessionReader.getSessionFileCursor = originalGetSessionFileCursor;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('web ui chat keeps native run alive on client disconnect (detached, not killed)', async () => {
  // 现行 detached 设计(webui-chat-routes.js:1114/1155 注释):刷新/导航/代理抖动断连时服务端
  // 【只 detach 不 kill】——native run 继续跑完写进 CLI 会话库,页面重连(/v0/webui/chat/runs)
  // 恢复"运行中/停止"。故客户端 res 'close' 【不得】abort 底层 run(否则并行子代理/长任务被腰斩)。
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  let aborted = false;
  let streamRef = null;
  nativeSessionChat.spawnNativeSessionStream = () => {
    streamRef = createAbortablePendingNativeStream({
      onAbort() {
        aborted = true;
      }
    });
    return streamRef;
  };

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'claude',
      accountRef: ACCOUNT_REFS.claudeTwo,
      sessionId: 'claude-session-id',
      projectDirName: 'ai-home',
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: '继续',
      stream: true,
      messages: [{ role: 'user', content: '继续' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    res.emit('close');

    assert.equal(handled, true);
    // detached:断连不 kill run。
    assert.equal(aborted, false);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
    // 收尾:结算 mock 的 pending done(仅 abort 时 resolve),否则悬挂 promise 拖住套件。
    if (streamRef && typeof streamRef.abort === 'function') streamRef.abort();
  }
});

test('web ui projects watch shares one runtime scanner across multiple watchers', async (t) => {
  const originalReadAllProjectsFromHost = sessionReader.readAllProjectsFromHost;
  const originalGetSessionFileCursor = sessionReader.getSessionFileCursor;
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-watch-shared-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  let readAllProjectsCalls = 0;

  sessionReader.readAllProjectsFromHost = () => {
    readAllProjectsCalls += 1;
    return [{
      id: 'ai_home',
      name: 'ai-home',
      path: '/Users/model/projects/feature/ai_home',
      provider: 'codex',
      sessions: [{
        id: 'shared-session',
        title: 'resume',
        updatedAt: Date.now(),
        projectDirName: 'ai_home'
      }]
    }];
  };
  sessionReader.getSessionFileCursor = () => 10;

  try {
    const state = {};
    const reqA = new EventEmitter();
    reqA.headers = {};
    const reqB = new EventEmitter();
    reqB.headers = {};
    const resA = createStreamResCapture();
    const resB = createStreamResCapture();

    await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects/watch',
      url: new URL('http://localhost/v0/webui/projects/watch'),
      req: reqA,
      res: resA,
      options: {},
      state,
      deps: createBaseDeps({ aiHomeDir })
    });

    await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects/watch',
      url: new URL('http://localhost/v0/webui/projects/watch'),
      req: reqB,
      res: resB,
      options: {},
      state,
      deps: createBaseDeps({ aiHomeDir })
    });

    reqA.emit('close');
    reqB.emit('close');

    assert.equal(readAllProjectsCalls, 1);
    assert.match(resA.body, /"type":"runtime"/);
    assert.match(resB.body, /"type":"runtime"/);
  } finally {
    sessionReader.readAllProjectsFromHost = originalReadAllProjectsFromHost;
    sessionReader.getSessionFileCursor = originalGetSessionFileCursor;
  }
});

test('web ui projects watch derives running state from provider hook lifecycle events', async (t) => {
  const originalReadAllProjectsFromHost = sessionReader.readAllProjectsFromHost;
  const originalGetSessionFileCursor = sessionReader.getSessionFileCursor;
  const sessionEventBus = createSessionEventBus({
    fs,
    resolveSessionFilePath() { return ''; }
  });
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-watch-hook-'));
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-watch-hook-state-'));
  t.after(() => {
    sessionEventBus.close();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });

  sessionReader.readAllProjectsFromHost = () => [{
    id: 'ai_home',
    name: 'ai-home',
    path: projectDir,
    provider: 'codex',
    sessions: [{
      id: 'session-stop-1',
      title: 'resume',
      updatedAt: Date.now() - 60_000,
      provider: 'codex',
      projectPath: projectDir,
      projectDirName: 'ai_home'
    }]
  }];
  sessionReader.getSessionFileCursor = () => 10;

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();

    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects/watch',
      url: new URL('http://localhost/v0/webui/projects/watch'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps({ aiHomeDir }),
        fs,
        sessionEventBus
      }
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    await new Promise((resolve) => setImmediate(resolve));

    sessionEventBus.publish({
      provider: 'codex',
      sessionId: 'session-stop-1',
      projectPath: projectDir
    }, {
      type: 'session:turn-started',
      source: 'official-hook',
      eventName: 'UserPromptSubmit',
      phase: 'turn-started'
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(res.body, /"runningSessionKeys":\["codex:session-stop-1:ai_home"\]/);

    sessionEventBus.publish({
      provider: 'codex',
      sessionId: 'session-stop-1',
      projectPath: projectDir
    }, {
      type: 'session:turn-completed',
      source: 'official-hook',
      eventName: 'Stop',
      phase: 'turn-completed'
    });
    await new Promise((resolve) => setImmediate(resolve));
    req.emit('close');

    assert.match(res.body, /"runningSessionKeys":\[\]/);
  } finally {
    sessionReader.readAllProjectsFromHost = originalReadAllProjectsFromHost;
    sessionReader.getSessionFileCursor = originalGetSessionFileCursor;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('web ui projects watch includes attached persistent sessions in running state', async (t) => {
  const originalReadAllProjectsFromHost = sessionReader.readAllProjectsFromHost;
  const originalGetSessionFileCursor = sessionReader.getSessionFileCursor;
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-watch-persist-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));

  sessionReader.readAllProjectsFromHost = () => [{
    id: 'ai_home',
    name: 'ai-home',
    path: projectDir,
    provider: 'codex',
    providers: ['codex'],
    sessions: [{
      id: 'session-live-1',
      title: 'persistent live',
      updatedAt: Date.now() - 60_000,
      provider: 'codex',
      projectPath: projectDir,
      projectDirName: 'ai_home'
    }]
  }];
  sessionReader.getSessionFileCursor = () => 11;

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();

    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects/watch',
      url: new URL('http://localhost/v0/webui/projects/watch'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        fs,
        collectPersistentSessionRunKeys: () => new Set(['codex:session-live-1:ai_home'])
      }
    });

    assert.equal(handled, true);
    await new Promise((resolve) => setImmediate(resolve));
    req.emit('close');

    assert.match(res.body, /"runningSessionKeys":\["codex:session-live-1:ai_home"\]/);
  } finally {
    sessionReader.readAllProjectsFromHost = originalReadAllProjectsFromHost;
    sessionReader.getSessionFileCursor = originalGetSessionFileCursor;
  }
});

test('web ui projects watch closes snapshot scheduler handles after last watcher closes', async () => {
  const originalReadAllProjectsFromHost = sessionReader.readAllProjectsFromHost;
  const originalGetSessionFileCursor = sessionReader.getSessionFileCursor;
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-watch-cleanup-home-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-watch-cleanup-project-'));
  const originalRealHome = process.env.REAL_HOME;
  const watchHandles = [];
  const fsWithWatch = Object.create(fs);
  fsWithWatch.watch = (targetPath) => {
    const handle = new EventEmitter();
    handle.targetPath = targetPath;
    handle.closed = false;
    handle.close = () => {
      handle.closed = true;
    };
    handle.unref = () => {};
    watchHandles.push(handle);
    return handle;
  };

  process.env.REAL_HOME = hostHomeDir;
  sessionReader.readAllProjectsFromHost = () => [{
    id: 'ai_home',
    name: 'ai-home',
    path: projectDir,
    provider: 'codex',
    sessions: [{
      id: 'session-cleanup-1',
      title: 'cleanup',
      updatedAt: Date.now(),
      provider: 'codex',
      projectPath: projectDir,
      projectDirName: 'ai_home'
    }]
  }];
  sessionReader.getSessionFileCursor = () => 10;

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const state = {};

    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects/watch',
      url: new URL('http://localhost/v0/webui/projects/watch'),
      req,
      res,
      options: {},
      state,
      deps: {
        ...createBaseDeps(),
        fs: fsWithWatch
      }
    });

    assert.equal(handled, true);
    assert.ok(watchHandles.length > 0);
    req.emit('close');
    assert.equal(watchHandles.every((handle) => handle.closed), true);
  } finally {
    sessionReader.readAllProjectsFromHost = originalReadAllProjectsFromHost;
    sessionReader.getSessionFileCursor = originalGetSessionFileCursor;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('web ui chat run input writes to active native stream', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  const writes = [];
  nativeSessionChat.spawnNativeSessionStream = () => {
    return createAbortablePendingNativeStream({
      runId: 'native-run-1',
      writeInput(input, options = {}) {
        writes.push({ input, options });
      }
    });
  };

  try {
    const streamReq = new EventEmitter();
    streamReq.headers = {};
    const streamRes = createStreamResCapture();
    const chatPayload = {
      provider: 'gemini',
      accountRef: ACCOUNT_REFS.geminiOne,
      sessionId: 'gem-session-id',
      projectDirName: 'ai-home',
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: '继续',
      stream: true,
      messages: [{ role: 'user', content: '继续' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req: streamReq,
      res: streamRes,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify(chatPayload), 'utf8')
      }
    });

    assert.equal(handled, true);
    assert.match(streamRes.body, /"runId":"native-run-1"/);

    const inputRes = createStreamResCapture();
    const inputHandled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat/runs/native-run-1/input',
      url: new URL('http://localhost/v0/webui/chat/runs/native-run-1/input'),
      req: { headers: {} },
      res: inputRes,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify({ input: 'y' }), 'utf8')
      }
    });

    assert.equal(inputHandled, true);
    assert.equal(inputRes.statusCode, 200);
    assert.deepEqual(writes, [
      {
        input: 'y',
        options: { appendNewline: true }
      }
    ]);
    streamReq.emit('close');
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui chat run input forwards active prompt id to native stream', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  const writes = [];
  nativeSessionChat.spawnNativeSessionStream = () => {
    return createAbortablePendingNativeStream({
      runId: 'native-run-prompt-input',
      writeInput(input, options = {}) {
        writes.push({ input, options });
      }
    });
  };

  try {
    const streamReq = new EventEmitter();
    streamReq.headers = {};
    const streamRes = createStreamResCapture();
    const chatPayload = {
      provider: 'codex',
      accountRef: ACCOUNT_REFS.codexOne,
      sessionId: 'codex-session-id',
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: '继续',
      stream: true,
      messages: [{ role: 'user', content: '继续' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req: streamReq,
      res: streamRes,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify(chatPayload), 'utf8')
      }
    });

    assert.equal(handled, true);
    assert.match(streamRes.body, /"runId":"native-run-prompt-input"/);

    const inputRes = createStreamResCapture();
    const inputHandled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat/runs/native-run-prompt-input/input',
      url: new URL('http://localhost/v0/webui/chat/runs/native-run-prompt-input/input'),
      req: { headers: {} },
      res: inputRes,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify({
          input: '1',
          promptId: 'codex-plan-abc123'
        }), 'utf8')
      }
    });

    assert.equal(inputHandled, true);
    assert.equal(inputRes.statusCode, 200);
    assert.deepEqual(writes, [
      {
        input: '1',
        options: {
          appendNewline: true,
          promptId: 'codex-plan-abc123'
        }
      }
    ]);
    streamReq.emit('close');
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui chat streams active native interactive prompt events', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  nativeSessionChat.spawnNativeSessionStream = (options = {}) => {
    return {
      runId: 'native-run-interactive-prompt',
      writeInput() {},
      abort() {},
      done: new Promise((resolve) => {
        setTimeout(() => {
          options.onEvent({
            type: 'interactive-prompt',
            prompt: {
              kind: 'plan-choice',
              promptId: 'codex-plan-active',
              question: 'Implement this plan?',
              options: [
                { value: '1', title: 'Yes, implement this plan' },
                { value: '2', title: 'No, stay in Plan mode' }
              ]
            }
          });
          resolve({ content: '', sessionId: 'codex-session-id' });
        }, 0);
      })
    };
  };

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'codex',
      accountRef: ACCOUNT_REFS.codexOne,
      sessionId: 'codex-session-id',
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: '继续',
      stream: true,
      messages: [{ role: 'user', content: '继续' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    await waitForStreamEnd(res);

    assert.equal(handled, true);
    assert.match(res.body, /"type":"interactive-prompt"/);
    assert.match(res.body, /"promptId":"codex-plan-active"/);
    assert.match(res.body, /"runId":"native-run-interactive-prompt"/);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui chat run input preserves raw terminal keys like space and enter', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  const writes = [];
  nativeSessionChat.spawnNativeSessionStream = () => {
    return createAbortablePendingNativeStream({
      runId: 'native-run-raw-keys',
      writeInput(input, options = {}) {
        writes.push({ input, options });
      }
    });
  };

  try {
    const streamReq = new EventEmitter();
    streamReq.headers = {};
    const streamRes = createStreamResCapture();
    const chatPayload = {
      provider: 'codex',
      accountRef: ACCOUNT_REFS.codexOne,
      sessionId: 'codex-session-id',
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: '/clear',
      stream: true,
      messages: [{ role: 'user', content: '/clear' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req: streamReq,
      res: streamRes,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify(chatPayload), 'utf8')
      }
    });

    assert.equal(handled, true);
    assert.match(streamRes.body, /"runId":"native-run-raw-keys"/);

    for (const payload of [
      { input: ' ', appendNewline: false },
      { input: '\r', appendNewline: false }
    ]) {
      const inputRes = createStreamResCapture();
      const inputHandled = await handleWebUIRequest({
        method: 'POST',
        pathname: '/v0/webui/chat/runs/native-run-raw-keys/input',
        url: new URL('http://localhost/v0/webui/chat/runs/native-run-raw-keys/input'),
        req: { headers: {} },
        res: inputRes,
        options: {},
        state: {},
        deps: {
          ...createBaseDeps(),
          readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
        }
      });

      assert.equal(inputHandled, true);
      assert.equal(inputRes.statusCode, 200);
    }

    assert.deepEqual(writes, [
      { input: ' ', options: { appendNewline: false } },
      { input: '\r', options: { appendNewline: false } }
    ]);
    streamReq.emit('close');
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui chat run resize updates active native stream pty size', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  const resizeCalls = [];
  nativeSessionChat.spawnNativeSessionStream = () => {
    return createAbortablePendingNativeStream({
      runId: 'native-run-resize',
      writeInput() {},
      resize(cols, rows) {
        resizeCalls.push({ cols, rows });
      }
    });
  };

  try {
    const streamReq = new EventEmitter();
    streamReq.headers = {};
    const streamRes = createStreamResCapture();
    const chatPayload = {
      provider: 'gemini',
      accountRef: ACCOUNT_REFS.geminiOne,
      sessionId: 'gem-session-id',
      projectDirName: 'ai-home',
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: '继续',
      stream: true,
      messages: [{ role: 'user', content: '继续' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req: streamReq,
      res: streamRes,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify(chatPayload), 'utf8')
      }
    });

    assert.equal(handled, true);
    assert.match(streamRes.body, /"runId":"native-run-resize"/);

    const resizeRes = createStreamResCapture();
    const resizeHandled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat/runs/native-run-resize/resize',
      url: new URL('http://localhost/v0/webui/chat/runs/native-run-resize/resize'),
      req: { headers: {} },
      res: resizeRes,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify({ cols: 120, rows: 32 }), 'utf8')
      }
    });

    assert.equal(resizeHandled, true);
    assert.equal(resizeRes.statusCode, 200);
    assert.deepEqual(resizeCalls, [{ cols: 120, rows: 32 }]);
    streamReq.emit('close');
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui chat persists pasted images and appends file paths into native prompt', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  const fse = require('fs-extra');
  const attachmentHome = fse.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-attachment-home-'));
  let seenPrompt = '';
  nativeSessionChat.spawnNativeSessionStream = (options = {}) => {
    seenPrompt = String(options.prompt || '');
    return {
      runId: 'native-run-images',
      abort() {},
      done: Promise.resolve({ content: 'ok', sessionId: 'sess-1' })
    };
  };

  // 本用例用真实 fs-extra 落盘图片,故 nativeAccountHasCredentials 也走真实磁盘校验 —— 需在
  // profile 目录(/tmp/profile)放一个 .aih_env.json 让账号视为已配置；图片则必须落到 host provider 目录，
  // 否则前置校验判"未配置"→400、spawn 不跑、seenPrompt 为空。
  const credEnvPath = '/tmp/profile/.aih_env.json';
  fse.ensureDirSync('/tmp/profile');
  fse.writeFileSync(credEnvPath, '{}');

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'gemini',
      accountRef: ACCOUNT_REFS.geminiOne,
      sessionId: 'gem-session-id',
      projectDirName: 'ai-home',
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: '分析一下图片内容',
      stream: true,
      images: [
        'data:image/png;base64,' + Buffer.from('fake-image').toString('base64')
      ],
      messages: [{ role: 'user', content: '分析一下图片内容' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        fs: require('fs-extra'),
        hostHomeDir: attachmentHome,
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    assert.equal(handled, true);
    assert.match(seenPrompt, /Attached image files:/);
    assert.match(seenPrompt, /Please inspect these local image files directly/);
    assert.match(
      seenPrompt.replace(/\\/g, '/'),
      new RegExp(`${attachmentHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.gemini/tmp/model/images/clipboard-`)
    );
    assert.equal(seenPrompt.includes('.ai_home'), false);
    assert.match(seenPrompt, /分析一下图片内容/);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
    try { fse.removeSync(credEnvPath); } catch (_error) { /* best-effort */ }
    fse.removeSync(attachmentHome);
  }
});

test('web ui chat attachment endpoint serves persisted chat images', async () => {
  const rootDir = path.join(os.tmpdir(), 'aih-web-chat-images');
  const batchDir = path.join(rootDir, `test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  const filePath = path.join(batchDir, 'image-1.png');
  fs.mkdirSync(batchDir, { recursive: true });
  fs.writeFileSync(filePath, Buffer.from('89504e470d0a1a0a', 'hex'));

  try {
    const res = createStreamResCapture();
    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/chat/attachments',
      url: new URL(`http://localhost/v0/webui/chat/attachments?path=${encodeURIComponent(filePath)}`),
      req: { headers: {} },
      res,
      options: {},
      state: {},
      deps: createBaseDeps()
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'image/png');
    assert.equal(res.body, Buffer.from('89504e470d0a1a0a', 'hex').toString());
  } finally {
    fs.rmSync(batchDir, { recursive: true, force: true });
  }
});

test('web ui chat attachment endpoint resolves provider-native aliases and rejects non-images', async (t) => {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-native-alias-'));
  const aiHomeDir = path.join(hostHomeDir, '.ai_home');
  const sessionId = '287e94b0-5944-4d05-a614-d906797222dc';
  const nativeDir = path.join(hostHomeDir, '.gemini', 'antigravity-cli', 'brain', sessionId);
  const nativeImagePath = path.join(nativeDir, 'phoenix_concert_1.jpg');
  const nativeMarkdownPath = path.join(nativeDir, 'phoenix_legend_concert.md');
  const legacyImagePath = path.join(
    aiHomeDir,
    'profiles',
    'agy',
    '1',
    '.gemini',
    'antigravity-cli',
    'brain',
    sessionId,
    'phoenix_concert_1.jpg'
  );
  const currentImagePath = path.join(
    aiHomeDir,
    'run',
    'auth-projections',
    'agy',
    ACCOUNT_REFS.agyTwo,
    '.gemini',
    'antigravity-cli',
    'brain',
    sessionId,
    'phoenix_concert_1.jpg'
  );
  const imageBytes = Buffer.from('ffd8ffe000104a4649460001', 'hex');
  t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.writeFileSync(nativeImagePath, imageBytes);
  fs.writeFileSync(nativeMarkdownPath, '# concert\n', 'utf8');

  const deps = createBaseDeps({ aiHomeDir, hostHomeDir });
  for (const aliasPath of [legacyImagePath, currentImagePath, nativeImagePath]) {
    const res = createStreamResCapture();
    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/chat/attachments',
      url: new URL(`http://localhost/v0/webui/chat/attachments?path=${encodeURIComponent(aliasPath)}`),
      req: { headers: {} },
      res,
      options: {},
      state: {},
      deps
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200, aliasPath);
    assert.equal(res.headers['Content-Type'], 'image/jpeg', aliasPath);
    assert.equal(res.body, imageBytes.toString(), aliasPath);
  }

  const markdownRes = createStreamResCapture();
  const markdownHandled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/chat/attachments',
    url: new URL(`http://localhost/v0/webui/chat/attachments?path=${encodeURIComponent(nativeMarkdownPath)}`),
    req: { headers: {} },
    res: markdownRes,
    options: {},
    state: {},
    deps
  });
  assert.equal(markdownHandled, true);
  assert.equal(markdownRes.statusCode, 415);
  assert.equal(JSON.parse(markdownRes.body).error, 'unsupported_chat_attachment_type');
});

test('web ui chat accepts source-backed claude slash command and forwards it to native session', async (t) => {
  const commandsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-commands-'));
  t.after(() => {
    fs.rmSync(commandsDir, { recursive: true, force: true });
    delete process.env.AIH_CLAUDE_CODE_COMMANDS_DIR;
    nativeSlashCommands.clearNativeSlashCommandCache();
  });
  fs.mkdirSync(path.join(commandsDir, 'compact'), { recursive: true });
  fs.writeFileSync(
    path.join(commandsDir, 'compact', 'index.ts'),
    [
      'const compact = {',
      "  type: 'local',",
      "  name: 'compact',",
      "  description: 'compact current context',",
      '  supportsNonInteractive: true,',
      "  argumentHint: '<instructions>',",
      '};'
    ].join('\n')
  );
  process.env.AIH_CLAUDE_CODE_COMMANDS_DIR = commandsDir;
  nativeSlashCommands.clearNativeSlashCommandCache();

  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  let seenOptions = null;
  nativeSessionChat.spawnNativeSessionStream = (options = {}) => {
    seenOptions = { ...options };
    return {
      runId: 'native-run-slash',
      abort() {},
      done: Promise.resolve({ content: 'compacted', sessionId: 'claude-session-id' })
    };
  };

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'claude',
      accountRef: ACCOUNT_REFS.claudeOne,
      sessionId: 'claude-session-id',
      projectDirName: 'ai-home',
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: '/compact keep latest decisions',
      stream: true,
      messages: [{ role: 'user', content: '/compact keep latest decisions' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(handled, true);
    assert.equal(String(seenOptions && seenOptions.prompt || ''), '');
    assert.equal(String(seenOptions && seenOptions.initialInput || ''), '/compact keep latest decisions');
    assert.equal(Boolean(seenOptions && seenOptions.interactiveCli), true);
    assert.equal(Boolean(seenOptions && seenOptions.completeOnTranscriptUpdate), false);
    assert.match(res.body, /"interactionMode":"terminal"/);
    assert.match(res.body, /"type":"ready"/);
    assert.match(res.body, /"type":"done"/);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui chat routes claude slash command to native session even for api-key accounts', async (t) => {
  // slash command 是真实 CLI 能力，与 auth 类型无关：api-key 账号也必须走 native（不被甩去代理）。
  const commandsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-commands-apikey-'));
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-apikey-slash-'));
  const profileDir = path.join(profileRoot, 'profile');
  const configDir = path.join(profileRoot, 'config');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  // 带 API key 的 claude 账号 → detectApiKeyMode 为 true。
  fs.writeFileSync(
    path.join(profileDir, '.aih_env.json'),
    JSON.stringify({ ANTHROPIC_API_KEY: 'test-key' }, null, 2)
  );
  t.after(() => {
    fs.rmSync(commandsDir, { recursive: true, force: true });
    fs.rmSync(profileRoot, { recursive: true, force: true });
    delete process.env.AIH_CLAUDE_CODE_COMMANDS_DIR;
    nativeSlashCommands.clearNativeSlashCommandCache();
  });
  fs.mkdirSync(path.join(commandsDir, 'compact'), { recursive: true });
  fs.writeFileSync(
    path.join(commandsDir, 'compact', 'index.ts'),
    [
      'const compact = {',
      "  type: 'local',",
      "  name: 'compact',",
      "  description: 'compact current context',",
      '  supportsNonInteractive: true,',
      "  argumentHint: '<instructions>',",
      '};'
    ].join('\n')
  );
  process.env.AIH_CLAUDE_CODE_COMMANDS_DIR = commandsDir;
  nativeSlashCommands.clearNativeSlashCommandCache();

  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  let seenOptions = null;
  nativeSessionChat.spawnNativeSessionStream = (options = {}) => {
    seenOptions = { ...options };
    return {
      runId: 'native-run-slash-apikey',
      abort() {},
      done: Promise.resolve({ content: 'compacted', sessionId: 'claude-session-id' })
    };
  };

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'claude',
      accountRef: ACCOUNT_REFS.claudeThree,
      sessionId: 'claude-session-id',
      projectDirName: 'ai-home',
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: '/compact keep latest decisions',
      stream: true,
      messages: [{ role: 'user', content: '/compact keep latest decisions' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8'),
        getProfileDir: () => profileDir,
        getToolConfigDir: () => configDir,
        fs: require('fs-extra')
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(handled, true);
    // 关键断言：api-key 账号的 slash 走了 native（spawn 被调用、initialInput 透传），而非 api-proxy。
    assert.equal(String(seenOptions && seenOptions.initialInput || ''), '/compact keep latest decisions');
    assert.equal(Boolean(seenOptions && seenOptions.interactiveCli), true);
    assert.match(res.body, /"mode":"native-session"/);
    assert.match(res.body, /"interactionMode":"terminal"/);
    assert.doesNotMatch(res.body, /"mode":"api-proxy"/);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui chat routes claude api-key anthropic-compatible accounts through native session (not api-proxy adapter)', async () => {
  // 行为变更(commit f6a5c73 "feat(native): apikey→native sessions"):apikey codex/claude 一律走
  // 【native 真会话】(sessionId/持久/隔离/续接),claude 用账号 .aih_env.json 的 ANTHROPIC token/base_url。
  // 故 claude api-key(含 anthropic-compatible 第三方端点如 dashscope)带 prompt 的普通对话
  // 【不再】走无状态 api-proxy 的 anthropic messages 适配器,而是 spawnNativeSessionStream。
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  const originalFetchWithTimeout = httpUtils.fetchWithTimeout;
  let spawnedOptions = null;
  let apiProxyFetchUrl = '';
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-anthropic-'));
  const profileDir = path.join(profileRoot, 'profile');
  const configDir = path.join(profileRoot, 'config');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, '.aih_env.json'),
    JSON.stringify({
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_BASE_URL: 'https://dashscope.aliyuncs.com/apps/anthropic'
    }, null, 2)
  );

  nativeSessionChat.spawnNativeSessionStream = (options = {}) => {
    spawnedOptions = options;
    return {
      runId: 'native-claude-apikey',
      abort() {},
      done: Promise.resolve({ content: '你好，我在。', sessionId: 'sess-claude-1' })
    };
  };
  // 若(错误地)走 api-proxy,会打到 /v1/messages —— 记录以便断言【没走】。
  httpUtils.fetchWithTimeout = async (url) => {
    apiProxyFetchUrl = String(url || '');
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'via-api-proxy' }] }) };
  };

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'claude',
      accountRef: ACCOUNT_REFS.claudeThree,
      createSession: true,
      projectPath: '/tmp/project',
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: '你好' }],
      prompt: '你好',
      stream: true
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8'),
        getProfileDir: () => profileDir,
        getToolConfigDir: () => configDir,
        fs: require('fs-extra')
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(handled, true);
    // 走了 native(spawn 被调用),没走 api-proxy 的 /v1/messages 适配器。
    assert.ok(spawnedOptions, 'expected native session to be spawned for claude api-key account');
    assert.equal(spawnedOptions.provider, 'claude');
    assert.equal(apiProxyFetchUrl, '');
    assert.match(res.body, /"type":"ready"/);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
    httpUtils.fetchWithTimeout = originalFetchWithTimeout;
    fs.rmSync(profileRoot, { recursive: true, force: true });
  }
});

test('web ui chat passes unknown slash commands through to the provider CLI', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  let seenOptions = null;
  nativeSessionChat.spawnNativeSessionStream = (options = {}) => {
    seenOptions = options;
    return {
      runId: 'native-run-claude-passthrough',
      abort() {},
      done: Promise.resolve({ content: '', sessionId: 'claude-session-id' })
    };
  };

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'claude',
      accountRef: ACCOUNT_REFS.claudeOne,
      sessionId: 'claude-session-id',
      projectDirName: 'ai-home',
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: '/plugin-command',
      stream: true,
      messages: [{ role: 'user', content: '/plugin-command' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    await waitForStreamEnd(res);
    assert.equal(handled, true);
    assert.equal(seenOptions.initialInput, '/plugin-command');
    assert.equal(seenOptions.interactiveCli, true);
    assert.match(res.body, /"interactionMode":"terminal"/);
    assert.match(res.body, /"type":"done"/);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui slash commands endpoint returns provider commands from source-backed registry', async (t) => {
  const commandsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-commands-'));
  t.after(() => {
    fs.rmSync(commandsDir, { recursive: true, force: true });
    delete process.env.AIH_CLAUDE_CODE_COMMANDS_DIR;
    nativeSlashCommands.clearNativeSlashCommandCache();
  });
  fs.writeFileSync(path.join(commandsDir, 'project-audit.md'), '# Project audit\n', 'utf8');
  process.env.AIH_CLAUDE_CODE_COMMANDS_DIR = commandsDir;
  nativeSlashCommands.clearNativeSlashCommandCache();

  const res = createStreamResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/slash-commands',
    url: new URL('http://localhost/v0/webui/slash-commands?provider=claude'),
    req: { headers: {} },
    res,
    options: {},
    state: {},
    deps: createBaseDeps()
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /"command":"\/project-audit"/);
  assert.match(res.body, /"source":"claude-user"/);
  assert.match(res.body, /"command":"\/context","description":"查看上下文用量分布"/);
});

test('web ui slash commands endpoint returns built-in gemini commands', async () => {
  const res = createStreamResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/slash-commands',
    url: new URL('http://localhost/v0/webui/slash-commands?provider=gemini'),
    req: { headers: {} },
    res,
    options: {},
    state: {},
    deps: createBaseDeps()
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /"command":"\/compress"/);
  assert.match(res.body, /"command":"\/memory"/);
});

test('web ui chat accepts built-in gemini slash command', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  let seenOptions = null;
  nativeSessionChat.spawnNativeSessionStream = (options = {}) => {
    seenOptions = { ...options };
    return {
      runId: 'native-run-gemini-slash',
      abort() {},
      done: Promise.resolve({ content: 'compressed', sessionId: 'gem-session-id' })
    };
  };

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'gemini',
      accountRef: ACCOUNT_REFS.geminiOne,
      sessionId: 'gem-session-id',
      projectDirName: 'ai-home',
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: '/compress',
      stream: true,
      messages: [{ role: 'user', content: '/compress' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(handled, true);
    assert.equal(String(seenOptions && seenOptions.prompt || ''), '');
    assert.equal(String(seenOptions && seenOptions.initialInput || ''), '/compress');
    assert.equal(Boolean(seenOptions && seenOptions.interactiveCli), true);
    assert.equal(Boolean(seenOptions && seenOptions.completeOnTranscriptUpdate), false);
    assert.match(res.body, /"interactionMode":"terminal"/);
    assert.match(res.body, /"type":"done"/);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui chat rejects slash command mixed with normal text', async () => {
  const req = { headers: {} };
  const res = createStreamResCapture();
  const payload = {
    provider: 'gemini',
    accountRef: ACCOUNT_REFS.geminiOne,
    sessionId: 'gem-session-id',
    projectDirName: 'ai-home',
    projectPath: '/Users/model/projects/feature/ai_home',
    prompt: '你好呀 /stats',
    stream: true,
    messages: [{ role: 'user', content: '你好呀 /stats' }]
  };

  const handled = await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/chat',
    url: new URL('http://localhost/v0/webui/chat'),
    req,
    res,
    options: {},
    state: {},
    deps: {
      ...createBaseDeps(),
      readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /native_slash_command_must_be_standalone/);
  assert.match(res.body, /\/stats/);
});

test('web ui chat accepts built-in codex slash command', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  let seenOptions = null;
  nativeSessionChat.spawnNativeSessionStream = (options = {}) => {
    seenOptions = { ...options };
    return {
      runId: 'native-run-codex-slash',
      abort() {},
      done: Promise.resolve({ content: '', sessionId: 'codex-session-id' })
    };
  };

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'codex',
      accountRef: ACCOUNT_REFS.codexOne,
      sessionId: 'codex-session-id',
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: '/clear',
      stream: true,
      messages: [{ role: 'user', content: '/clear' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(handled, true);
    assert.equal(String(seenOptions && seenOptions.prompt || ''), '');
    assert.equal(String(seenOptions && seenOptions.initialInput || ''), '/clear');
    assert.equal(Boolean(seenOptions && seenOptions.interactiveCli), true);
    assert.equal(Boolean(seenOptions && seenOptions.completeOnTranscriptUpdate), false);
    assert.match(res.body, /"interactionMode":"terminal"/);
    assert.match(res.body, /"type":"done"/);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui chat passes codex existing session prompt through headless resume path', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  let seenOptions = null;
  nativeSessionChat.spawnNativeSessionStream = (options = {}) => {
    seenOptions = { ...options };
    return {
      runId: 'native-run-codex-input',
      abort() {},
      done: Promise.resolve({ content: '已完成', sessionId: 'codex-session-id' })
    };
  };

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'codex',
      accountRef: ACCOUNT_REFS.codexOne,
      sessionId: 'codex-session-id',
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: '帮我检查这个文件',
      stream: true,
      messages: [{ role: 'user', content: '帮我检查这个文件' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(handled, true);
    assert.equal(String(seenOptions && seenOptions.prompt || ''), '帮我检查这个文件');
    assert.equal(String(seenOptions && seenOptions.initialInput || ''), '');
    assert.equal(Boolean(seenOptions && seenOptions.interactiveCli), false);
    assert.equal(Boolean(seenOptions && seenOptions.completeOnTranscriptUpdate), false);
    assert.equal(Boolean(seenOptions && seenOptions.emitTerminalOutput), false);
    assert.match(res.body, /"type":"ready"/);
    assert.match(res.body, /"type":"done"/);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui chat routes claude normal session prompt through headless stream mode', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  let seenOptions = null;
  nativeSessionChat.spawnNativeSessionStream = (options = {}) => {
    seenOptions = { ...options };
    return {
      runId: 'native-run-claude-headless',
      abort() {},
      done: new Promise((resolve) => {
        setTimeout(() => {
          options.onEvent({ type: 'delta', delta: '继续处理。' });
          resolve({ content: '继续处理。', sessionId: options.sessionId });
        }, 0);
      })
    };
  };

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'claude',
      accountRef: ACCOUNT_REFS.claudeFour,
      sessionId: '108604fa-b65d-44d2-b72e-cc282905df6e',
      projectDirName: '-Users-model-projects-mac-ip',
      projectPath: '/Users/model/projects/mac/ip',
      prompt: '如何了',
      model: 'claude-opus-4-8',
      stream: true,
      messages: [{ role: 'user', content: '如何了' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    await waitForStreamEnd(res);

    assert.equal(handled, true);
    assert.equal(String(seenOptions && seenOptions.prompt || ''), '如何了');
    assert.equal(String(seenOptions && seenOptions.initialInput || ''), '');
    assert.equal(Boolean(seenOptions && seenOptions.interactiveCli), false);
    assert.equal(Boolean(seenOptions && seenOptions.completeOnTranscriptUpdate), false);
    assert.equal(String(seenOptions && seenOptions.accountRef || ''), ACCOUNT_REFS.claudeFour);
    assert.match(res.body, /"interactionMode":"default"/);
    assert.match(res.body, /"type":"delta","delta":"继续处理。"/);
    assert.match(res.body, /"type":"done"/);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui chat registers codex project path into host config before native session start', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-codex-host-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = hostHomeDir;

  nativeSessionChat.spawnNativeSessionStream = () => ({
    runId: 'native-run-codex-project-register',
    abort() {},
    done: Promise.resolve({ content: '已完成', sessionId: 'codex-session-id' })
  });

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'codex',
      accountRef: ACCOUNT_REFS.codexOne,
      createSession: true,
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: '新建一个会话',
      stream: true,
      messages: [{ role: 'user', content: '新建一个会话' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(handled, true);
    const hostConfigPath = path.join(hostHomeDir, '.codex', 'config.toml');
    assert.equal(fs.existsSync(hostConfigPath), true);
    assert.match(
      fs.readFileSync(hostConfigPath, 'utf8'),
      /\[projects\."\/Users\/model\/projects\/feature\/ai_home"\]\ntrust_level = "trusted"/
    );
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('web ui chat refreshes persisted projects snapshot after native codex transcript becomes readable', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-chat-persist-host-'));
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-chat-persist-aihome-'));
  const projectPath = path.join(hostHomeDir, 'persisted-project');
  const sessionId = '019d7bae-4dd5-73f2-b2bd-8125899885cb';
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = hostHomeDir;
  fs.mkdirSync(projectPath, { recursive: true });
  registerChatAccount(aiHomeDir, 'codexOne');

  nativeSessionChat.spawnNativeSessionStream = (options = {}) => {
    return {
      runId: 'native-run-codex-persist',
      abort() {},
      done: new Promise((resolve) => {
        setTimeout(() => {
          options.onEvent({
            type: 'session-created',
            sessionId
          });
          resolve({ content: '已完成', sessionId });
        }, 0);

        setTimeout(() => {
          const sessionDir = path.join(hostHomeDir, '.codex', 'sessions', '2026', '04', '13');
          fs.mkdirSync(sessionDir, { recursive: true });
          fs.writeFileSync(
            path.join(hostHomeDir, '.codex', 'session_index.jsonl'),
            JSON.stringify({
              id: sessionId,
              thread_name: '来自 Web 的会话',
              updated_at: '2026-04-13T12:00:00.000Z'
            }) + '\n',
            'utf8'
          );
          fs.writeFileSync(
            path.join(sessionDir, `rollout-2026-04-13T12-00-00-${sessionId}.jsonl`),
            [
              JSON.stringify({
                timestamp: '2026-04-13T12:00:00.000Z',
                type: 'session_meta',
                payload: {
                  id: sessionId,
                  cwd: projectPath
                }
              }),
              JSON.stringify({
                timestamp: '2026-04-13T12:00:01.000Z',
                type: 'response_item',
                payload: {
                  type: 'message',
                  role: 'user',
                  content: [
                    { type: 'input_text', text: '把这个需求记下来' }
                  ]
                }
              }),
              JSON.stringify({
                timestamp: '2026-04-13T12:00:02.000Z',
                type: 'response_item',
                payload: {
                  role: 'assistant',
                  content: [
                    { type: 'output_text', text: '已经记下。' }
                  ]
                }
              })
            ].join('\n') + '\n',
            'utf8'
          );
        }, 150);
      })
    };
  };

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'codex',
      accountRef: ACCOUNT_REFS.codexOne,
      createSession: true,
      projectPath,
      prompt: '把这个需求记下来',
      stream: true,
      messages: [{ role: 'user', content: '把这个需求记下来' }]
    };
    const state = {};

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: {},
      state,
      deps: {
        ...createBaseDeps(),
        fs: require('fs-extra'),
        aiHomeDir,
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    await waitForStreamEnd(res);

    assert.equal(handled, true);
    assert.match(res.body, /"type":"done"/);
    assert.match(res.body, new RegExp(`"sessionId":"${sessionId}"`));

    const listRes = createStreamResCapture();
    const listHandled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects',
      url: new URL('http://localhost/v0/webui/projects'),
      req: { headers: {} },
      res: listRes,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        fs: require('fs-extra'),
        aiHomeDir
      }
    });

    assert.equal(listHandled, true);
    assert.equal(listRes.statusCode, 200);
    const body = JSON.parse(listRes.body);
    const project = body.projects.find((item) => item.path === projectPath);
    assert.ok(project);
    assert.equal(project.sessions.some((item) => item.id === sessionId), true);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('web ui chat keeps claude created session after reload for manually added project', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-chat-claude-persist-host-'));
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-chat-claude-persist-aihome-'));
  const projectPath = path.join(hostHomeDir, 'my-real-project');
  const sessionId = 'claude-session-created-1';
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = hostHomeDir;
  fs.mkdirSync(projectPath, { recursive: true });
  registerChatAccount(aiHomeDir, 'claudeOne');
  addOpenedProject({ path: projectPath, name: 'my-real-project' }, { fs, aiHomeDir });

  nativeSessionChat.spawnNativeSessionStream = (options = {}) => {
    return {
      runId: 'native-run-claude-persist',
      abort() {},
      done: new Promise((resolve) => {
        setTimeout(() => {
          options.onEvent({
            type: 'session-created',
            sessionId
          });
          resolve({ content: '已完成', sessionId });
        }, 0);

        setTimeout(() => {
          const projectDirName = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
          const sessionDir = path.join(hostHomeDir, '.claude', 'projects', projectDirName);
          fs.mkdirSync(sessionDir, { recursive: true });
          fs.writeFileSync(
            path.join(sessionDir, `${sessionId}.jsonl`),
            [
              JSON.stringify({
                type: 'user',
                message: {
                  content: '请记住这个 Claude 会话'
                }
              }),
              JSON.stringify({
                type: 'assistant',
                message: {
                  content: [
                    {
                      type: 'text',
                      text: '已经记住。'
                    }
                  ]
                }
              })
            ].join('\n') + '\n',
            'utf8'
          );
        }, 150);
      })
    };
  };

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'claude',
      accountRef: ACCOUNT_REFS.claudeOne,
      createSession: true,
      projectPath,
      prompt: '请记住这个 Claude 会话',
      stream: true,
      messages: [{ role: 'user', content: '请记住这个 Claude 会话' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        fs: require('fs-extra'),
        aiHomeDir,
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    await waitForStreamEnd(res);

    assert.equal(handled, true);
    assert.match(res.body, /"type":"done"/);
    assert.match(res.body, new RegExp(`"sessionId":"${sessionId}"`));

    const listRes = createStreamResCapture();
    const listHandled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects',
      url: new URL('http://localhost/v0/webui/projects'),
      req: { headers: {} },
      res: listRes,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        fs: require('fs-extra'),
        aiHomeDir
      }
    });

    assert.equal(listHandled, true);
    assert.equal(listRes.statusCode, 200);
    const body = JSON.parse(listRes.body);
    const project = body.projects.find((item) => item.path === projectPath);
    assert.ok(project);
    assert.equal(project.sessions.some((item) => item.id === sessionId), true);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('web ui chat keeps claude created session after reload even when done is the first event carrying session id', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-chat-claude-done-session-host-'));
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-chat-claude-done-session-aihome-'));
  const projectPath = path.join(hostHomeDir, 'my-real-project');
  const sessionId = 'claude-session-created-done-only';
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = hostHomeDir;
  fs.mkdirSync(projectPath, { recursive: true });
  registerChatAccount(aiHomeDir, 'claudeOne');
  addOpenedProject({ path: projectPath, name: 'my-real-project' }, { fs, aiHomeDir });

  nativeSessionChat.spawnNativeSessionStream = () => {
    return {
      runId: 'native-run-claude-done-only',
      abort() {},
      done: new Promise((resolve) => {
        setTimeout(() => {
          const projectDirName = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
          const sessionDir = path.join(hostHomeDir, '.claude', 'projects', projectDirName);
          fs.mkdirSync(sessionDir, { recursive: true });
          fs.writeFileSync(
            path.join(sessionDir, `${sessionId}.jsonl`),
            [
              JSON.stringify({
                type: 'user',
                message: {
                  content: '请持久化这个 Claude 会话'
                }
              }),
              JSON.stringify({
                type: 'assistant',
                message: {
                  content: [
                    {
                      type: 'text',
                      text: '已经持久化。'
                    }
                  ]
                }
              })
            ].join('\n') + '\n',
            'utf8'
          );
          resolve({ content: '已经持久化。', sessionId });
        }, 150);
      })
    };
  };

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'claude',
      accountRef: ACCOUNT_REFS.claudeOne,
      createSession: true,
      projectPath,
      prompt: '请持久化这个 Claude 会话',
      stream: true,
      messages: [{ role: 'user', content: '请持久化这个 Claude 会话' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        fs: require('fs-extra'),
        aiHomeDir,
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    await waitForStreamEnd(res);

    assert.equal(handled, true);
    assert.match(res.body, /"type":"done"/);
    assert.match(res.body, new RegExp(`"sessionId":"${sessionId}"`));

    const listRes = createStreamResCapture();
    const listHandled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects',
      url: new URL('http://localhost/v0/webui/projects'),
      req: { headers: {} },
      res: listRes,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(),
        fs: require('fs-extra'),
        aiHomeDir
      }
    });

    assert.equal(listHandled, true);
    assert.equal(listRes.statusCode, 200);
    const body = JSON.parse(listRes.body);
    const project = body.projects.find((item) => item.path === projectPath);
    assert.ok(project);
    assert.equal(project.sessions.some((item) => item.id === sessionId), true);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('web ui chat routes codex api key sessions through native session using DB credentials', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  let seenOptions = null;
  let syncedAccountRef = '';

  nativeSessionChat.spawnNativeSessionStream = (options = {}) => {
    seenOptions = options;
    return {
      runId: 'native-run-codex-api-key',
      abort() {},
      done: new Promise((resolve) => {
        setTimeout(() => {
          options.onEvent({ type: 'delta', delta: '图片已收到' });
          resolve({ content: '图片已收到', sessionId: 'codex-api-key-session' });
        }, 0);
      })
    };
  };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-chat-'));
  const aiHomeDir = path.join(root, 'aih-home');
  const projectionDir = path.join(root, 'runtime', 'codex', ACCOUNT_REFS.codexTenThousand);
  try {
    registerChatAccount(aiHomeDir, 'codexTenThousand', {
      OPENAI_API_KEY: 'sk-test-runtime',
      OPENAI_BASE_URL: 'https://sub.devbin.de'
    });

    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'codex',
      accountRef: ACCOUNT_REFS.codexTenThousand,
      createSession: true,
      projectPath: '/Users/model',
      prompt: '这个图片讲了什么',
      model: 'gpt-5.4',
      stream: true,
      images: ['data:image/png;base64,' + Buffer.from('fake-image').toString('base64')],
      messages: [{ role: 'user', content: '这个图片讲了什么' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: { port: 8317 },
      state: {},
      deps: {
        ...createBaseDeps({ aiHomeDir }),
        fs: require('fs-extra'),
        getProfileDir: () => projectionDir,
        syncGlobalConfigToHost(_provider, accountRef) {
          syncedAccountRef = accountRef;
        },
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    await waitForStreamEnd(res);
    assert.equal(handled, true);
    assert.equal(seenOptions.provider, 'codex');
    assert.equal(seenOptions.accountRef, ACCOUNT_REFS.codexTenThousand);
    assert.equal(seenOptions.interactiveCli, false);
    assert.equal(syncedAccountRef, ACCOUNT_REFS.codexTenThousand);
    assert.equal(seenOptions.imagePaths.length, 1);
    assert.match(res.body, /"type":"ready","mode":"native-session"/);
    assert.match(res.body, /"type":"delta","delta":"图片已收到"/);
    assert.match(res.body, /"type":"done","mode":"native-session"/);
    req.emit('close');
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('web ui chat routes agy access-token accounts through api proxy stream', async () => {
  const originalFetchWithTimeout = httpUtils.fetchWithTimeout;
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  let nativeSpawned = false;
  let seenRequest = null;
  httpUtils.fetchWithTimeout = async (_url, init) => {
    seenRequest = {
      headers: init && init.headers,
      body: JSON.parse(String(init && init.body || '{}'))
    };
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from(
            'data: {"choices":[{"delta":{"content":"AGY"}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":" OK"},"finish_reason":"stop"}]}\n\n' +
            'data: [DONE]\n\n'
          ));
          controller.close();
        }
      }),
      headers: new Headers()
    };
  };
  nativeSessionChat.spawnNativeSessionStream = () => {
    nativeSpawned = true;
    throw new Error('agy access-token chat should use api proxy');
  };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-chat-agy-'));
  try {
    registerChatAccount(root, 'agyTwo', {
      AGY_ACCESS_TOKEN: 'agy-token'
    });

    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'agy',
      accountRef: ACCOUNT_REFS.agyTwo,
      createSession: true,
      projectPath: '/Users/model',
      prompt: 'hi',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: { port: 8317 },
      state: {
        accounts: {
          agy: [{
            accountRef: ACCOUNT_REFS.agyTwo,
            availableModels: ['dynamic-agy-model']
          }]
        },
        webUiModelsCache: {
          byProvider: {
            agy: ['dynamic-agy-model']
          }
        }
      },
      deps: {
        ...createBaseDeps({ aiHomeDir: root }),
        fs: require('fs-extra'),
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    assert.equal(handled, true);
    assert.equal(nativeSpawned, false);
    assert.equal(seenRequest.headers['X-Provider'], 'agy');
    assert.equal(seenRequest.headers['X-Account-Ref'], ACCOUNT_REFS.agyTwo);
    assert.equal(seenRequest.body.model, 'dynamic-agy-model');
    assert.match(res.body, /"type":"ready","mode":"api-proxy"/);
    assert.match(res.body, /"type":"done","mode":"api-proxy","content":"AGY OK"/);
    req.emit('close');
  } finally {
    httpUtils.fetchWithTimeout = originalFetchWithTimeout;
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('web ui chat streams OpenCode through the native headless runner', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  let seenOptions = null;
  nativeSessionChat.spawnNativeSessionStream = (options = {}) => {
    seenOptions = options;
    return {
      runId: 'native-run-opencode-stream',
      abort() {},
      done: new Promise((resolve) => {
        setTimeout(() => {
          options.onEvent({ type: 'session-created', sessionId: 'ses_native_opencode' });
          options.onEvent({ type: 'delta', delta: 'OK' });
          resolve({ content: 'OK', sessionId: 'ses_native_opencode' });
        }, 0);
      })
    };
  };

  const req = new EventEmitter();
  req.headers = {};
  const res = createStreamResCapture();
  const payload = {
    provider: 'opencode',
    accountRef: ACCOUNT_REFS.opencodeOne,
    createSession: true,
    projectPath: '/Users/model',
    prompt: 'hi',
    model: 'opencode-go/glm-5.2',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }]
  };

  try {
    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: { port: 8317 },
      state: {},
      deps: {
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    await waitForStreamEnd(res);
    assert.equal(handled, true);
    assert.equal(seenOptions.provider, 'opencode');
    assert.equal(seenOptions.accountRef, ACCOUNT_REFS.opencodeOne);
    assert.equal(seenOptions.model, 'opencode-go/glm-5.2');
    assert.equal(seenOptions.interactiveCli, false);
    assert.match(res.body, /"type":"ready","mode":"native-session"/);
    assert.match(res.body, /"type":"session-created","sessionId":"ses_native_opencode"/);
    assert.match(res.body, /"type":"delta","delta":"OK"/);
    assert.match(res.body, /"type":"done","mode":"native-session"/);
    assert.match(res.body, /"sessionId":"ses_native_opencode"/);
    req.emit('close');
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui chat returns the native OpenCode session id for non-stream requests', async () => {
  const originalRun = nativeSessionChat.runNativeSessionPrompt;
  let seenOptions = null;
  const projectedResource = path.join(
    sharedAiHomeDir,
    'run',
    'auth-projections',
    'opencode',
    ACCOUNT_REFS.opencodeOne,
    '.local',
    'share',
    'aih-opencode-runtime',
    'opencode',
    'storage',
    'message.json'
  );
  const nativeResource = path.join(
    sandboxRealHome,
    '.local',
    'share',
    'opencode',
    'storage',
    'message.json'
  );
  nativeSessionChat.runNativeSessionPrompt = async (options = {}) => {
    seenOptions = options;
    return {
      content: `JSON OK ${projectedResource}`,
      sessionId: 'ses_native_opencode_json'
    };
  };

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'opencode',
      accountRef: ACCOUNT_REFS.opencodeOne,
      createSession: true,
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: 'json hi',
      model: 'opencode-go/glm-5.2',
      stream: false,
      messages: [{ role: 'user', content: 'json hi' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: { port: 8317 },
      state: {},
      deps: {
        ...createBaseDeps({ hostHomeDir: sandboxRealHome }),
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    assert.equal(handled, true);
    assert.equal(seenOptions.provider, 'opencode');
    assert.equal(seenOptions.accountRef, ACCOUNT_REFS.opencodeOne);
    assert.equal(seenOptions.model, 'opencode-go/glm-5.2');

    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'native-session');
    assert.equal(body.content, `JSON OK ${nativeResource}`);
    assert.equal(body.sessionId, 'ses_native_opencode_json');
  } finally {
    nativeSessionChat.runNativeSessionPrompt = originalRun;
  }
});

test('web ui chat routes oauth agy createSession through native antigravity session', async () => {
  // agy 现在是原生会话 provider：oauth 账号（无 AGY_ACCESS_TOKEN）走真实 antigravity CLI，
  // 不再走 api 代理。验证 spawnNativeSessionStream 被调用、走 native-session 模式。
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  let seenOptions = null;
  nativeSessionChat.spawnNativeSessionStream = (options = {}) => {
    seenOptions = { ...options };
    return {
      runId: 'native-run-agy',
      abort() {},
      done: Promise.resolve({ content: 'pong', sessionId: 'agy-conv-1' })
    };
  };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-chat-agy-native-'));
  try {
    const profileDir = path.join(root, 'profiles', 'agy', '3');
    const configDir = path.join(profileDir, '.gemini', 'antigravity-cli');
    fs.mkdirSync(configDir, { recursive: true });
    // 空 .aih_env.json → detectApiKeyMode('agy') 为 false → 走 native。

    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'agy',
      accountRef: ACCOUNT_REFS.agyThree,
      createSession: true,
      projectPath: '/Users/model/projects/feature/ai_home',
      prompt: 'ping',
      model: 'gemini-3-flash',
      stream: true,
      messages: [{ role: 'user', content: 'ping' }]
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: { port: 8317 },
      state: {},
      deps: {
        ...createBaseDeps(),
        fs: require('fs-extra'),
        getProfileDir: () => profileDir,
        getToolConfigDir: () => configDir,
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(handled, true);
    assert.ok(seenOptions, 'native spawn should be called for agy');
    assert.equal(seenOptions.provider, 'agy');
    assert.equal(String(seenOptions.prompt || ''), 'ping');
    assert.equal(Boolean(seenOptions.interactiveCli), true);
    assert.equal(Boolean(seenOptions.completeOnTranscriptUpdate), false);
    assert.match(res.body, /"mode":"native-session"/);
    assert.doesNotMatch(res.body, /"mode":"api-proxy"/);
    req.emit('close');
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('web ui chat emits thinking events for codex reasoning deltas in api proxy stream', async () => {
  const originalFetchWithTimeout = httpUtils.fetchWithTimeout;
  httpUtils.fetchWithTimeout = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(
          'data: {"choices":[{"delta":{"reasoning_content":"先分析问题"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"给出答案"},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n'
        ));
        controller.close();
      }
    }),
    headers: new Headers()
  });

  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-chat-thinking-'));
  try {
    registerChatAccount(aiHomeDir, 'codexOne', {
      OPENAI_API_KEY: 'sk-test-thinking'
    });
    const req = new EventEmitter();
    req.headers = {};

    const res = createStreamResCapture();
    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/chat',
      url: new URL('http://localhost/v0/webui/chat'),
      req,
      res,
      options: { port: 8317, clientKey: 'dummy' },
      state: {},
      deps: {
        ...createBaseDeps({ aiHomeDir }),
        fs: require('fs-extra'),
        readRequestBody: async () => Buffer.from(JSON.stringify({
          provider: 'codex',
          accountRef: ACCOUNT_REFS.codexOne,
          model: 'gpt-5.4',
          stream: true,
          messages: [{ role: 'user', content: '你好' }]
        }), 'utf8')
      }
    });

    assert.equal(handled, true);
    assert.match(res.body, /"type":"thinking","thinking":"先分析问题"/);
    assert.match(res.body, /"type":"delta","delta":"给出答案"/);
    req.emit('close');
  } finally {
    httpUtils.fetchWithTimeout = originalFetchWithTimeout;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});
