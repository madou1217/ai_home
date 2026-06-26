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
const opencodeSessionStore = require('../lib/sessions/opencode-session-store');
const originalRealHome = process.env.REAL_HOME;
const sandboxRealHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-chat-real-home-'));
process.env.REAL_HOME = sandboxRealHome;
test.after(() => {
  if (originalRealHome === undefined) delete process.env.REAL_HOME;
  else process.env.REAL_HOME = originalRealHome;
  fs.rmSync(sandboxRealHome, { recursive: true, force: true });
});

function createStreamResCapture() {
  const response = new EventEmitter();
  Object.assign(response, {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(code, headers = {}) {
      this.statusCode = code;
      this.headers = { ...this.headers, ...headers };
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
    fs: {
      existsSync: () => false
    },
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
      accountId: '1',
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
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'text/event-stream; charset=utf-8');
    assert.match(res.body, /"type":"ready"/);
    assert.match(res.body, /"type":"delta","delta":"你好"/);
    assert.match(res.body, /"type":"done"/);
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
    const deps = createBaseDeps({ sessionEventBus });
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

    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'gemini',
      accountId: '1',
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
      accountId: '1',
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
    attempts.push(String(options.accountId || ''));
    if (String(options.accountId) === '1') {
      return {
        runId: `native-run-${options.accountId}`,
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
      runId: `native-run-${options.accountId}`,
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
      accountId: '1',
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
              { id: '1', cooldownUntil: 0, authInvalidUntil: 0 },
              { id: '2', cooldownUntil: 0, authInvalidUntil: 0 }
            ]
          };
        },
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(handled, true);
    assert.deepEqual(attempts, ['1', '2']);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /"type":"ready"/);
    assert.match(res.body, /"type":"session-created","sessionId":"ok-session"/);
    assert.match(res.body, /"type":"delta","delta":"你好"/);
    assert.match(res.body, /"type":"done"/);
    assert.match(res.body, /"accountId":"2"/);
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

test('web ui chat aborts native stream when response closes', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  let aborted = false;
  nativeSessionChat.spawnNativeSessionStream = () => {
    return createAbortablePendingNativeStream({
      onAbort() {
        aborted = true;
      }
    });
  };

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'claude',
      accountId: '2',
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
    assert.equal(aborted, true);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui projects watch shares one runtime scanner across multiple watchers', async () => {
  const originalReadAllProjectsFromHost = sessionReader.readAllProjectsFromHost;
  const originalGetSessionFileCursor = sessionReader.getSessionFileCursor;
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
      deps: createBaseDeps()
    });

    await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects/watch',
      url: new URL('http://localhost/v0/webui/projects/watch'),
      req: reqB,
      res: resB,
      options: {},
      state,
      deps: createBaseDeps()
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
  t.after(() => {
    sessionEventBus.close();
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
        ...createBaseDeps(),
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
      accountId: '1',
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
      accountId: '1',
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
      accountId: '1',
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
      accountId: '1',
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
      accountId: '1',
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
  let seenPrompt = '';
  nativeSessionChat.spawnNativeSessionStream = (options = {}) => {
    seenPrompt = String(options.prompt || '');
    return {
      runId: 'native-run-images',
      abort() {},
      done: Promise.resolve({ content: 'ok', sessionId: 'sess-1' })
    };
  };

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'gemini',
      accountId: '1',
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
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    assert.equal(handled, true);
    assert.match(seenPrompt, /Attached image files:/);
    assert.match(seenPrompt, /Please inspect these local image files directly/);
    assert.match(seenPrompt.replace(/\\/g, '/'), /\/tmp\/profile\/\.gemini\/tmp\/model\/images\/clipboard-/);
    assert.match(seenPrompt, /分析一下图片内容/);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
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
      accountId: '1',
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
      accountId: '3',
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

test('web ui chat uses anthropic messages adapter for claude api-key accounts with anthropic-compatible base url', async () => {
  const originalFetchWithTimeout = httpUtils.fetchWithTimeout;
  let seenUrl = '';
  let seenHeaders = null;
  let seenBody = null;
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

  httpUtils.fetchWithTimeout = async (url, init) => {
    seenUrl = String(url || '');
    seenHeaders = init && init.headers;
    seenBody = JSON.parse(String(init && init.body || '{}'));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [
          { type: 'text', text: '你好，我在。' }
        ]
      })
    };
  };

  try {
    const req = { headers: {} };
    const res = createStreamResCapture();
    const payload = {
      provider: 'claude',
      accountId: '3',
      createSession: true,
      projectPath: '/tmp/project',
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: '你好' }],
      prompt: '你好',
      stream: false
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

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.content, '你好，我在。');
    assert.equal(seenUrl, 'https://dashscope.aliyuncs.com/apps/anthropic/v1/messages');
    assert.equal(seenHeaders['x-api-key'], 'test-key');
    assert.equal(seenHeaders['anthropic-version'], '2023-06-01');
    assert.equal(seenBody.model, 'qwen3.6-plus');
    assert.equal(seenBody.messages[0].role, 'user');
  } finally {
    httpUtils.fetchWithTimeout = originalFetchWithTimeout;
    fs.rmSync(profileRoot, { recursive: true, force: true });
  }
});

test('web ui chat injects project context for claude anthropic-compatible api proxy sessions', async () => {
  const originalFetchWithTimeout = httpUtils.fetchWithTimeout;
  let seenBody = null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-project-context-'));
  const profileDir = path.join(root, 'profile');
  const configDir = path.join(root, 'config');
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, '.aih_env.json'),
    JSON.stringify({
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_BASE_URL: 'https://dashscope.aliyuncs.com/apps/anthropic'
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify({
      name: 'demo-project',
      description: '用于测试项目上下文注入',
      scripts: {
        dev: 'node server.js',
        test: 'node --test'
      }
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(projectDir, 'README.md'),
    '# Demo Project\n\n这是一个用于验证项目上下文注入的测试仓库。\n',
    'utf8'
  );

  httpUtils.fetchWithTimeout = async (_url, init) => {
    seenBody = JSON.parse(String(init && init.body || '{}'));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [
          { type: 'text', text: '这是一个测试项目。' }
        ]
      })
    };
  };

  try {
    const req = { headers: {} };
    const res = createStreamResCapture();
    const payload = {
      provider: 'claude',
      accountId: '3',
      createSession: true,
      projectPath: projectDir,
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: '这个项目是什么' }],
      prompt: '这个项目是什么',
      stream: false
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

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(seenBody.model, 'qwen3.6-plus');
    assert.equal(Array.isArray(seenBody.messages), true);
    assert.equal(seenBody.messages[0].role, 'user');
    assert.match(String(seenBody.system || ''), /当前工作项目上下文/);
    assert.match(String(seenBody.system || ''), /demo-project/);
    assert.match(String(seenBody.system || ''), /用于测试项目上下文注入/);
    assert.match(String(seenBody.system || ''), /README.md/);
  } finally {
    httpUtils.fetchWithTimeout = originalFetchWithTimeout;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('web ui chat rejects unsupported slash command for provider', async (t) => {
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
      '};'
    ].join('\n')
  );
  process.env.AIH_CLAUDE_CODE_COMMANDS_DIR = commandsDir;
  nativeSlashCommands.clearNativeSlashCommandCache();

  const req = { headers: {} };
  const res = createStreamResCapture();
  const payload = {
    provider: 'claude',
    accountId: '1',
    sessionId: 'claude-session-id',
    projectDirName: 'ai-home',
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

  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /native_slash_command_unsupported/);
  assert.match(res.body, /\/compact/);
});

test('web ui slash commands endpoint returns provider commands from source-backed registry', async (t) => {
  const commandsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-commands-'));
  t.after(() => {
    fs.rmSync(commandsDir, { recursive: true, force: true });
    delete process.env.AIH_CLAUDE_CODE_COMMANDS_DIR;
    nativeSlashCommands.clearNativeSlashCommandCache();
  });
  fs.mkdirSync(path.join(commandsDir, 'context'), { recursive: true });
  fs.writeFileSync(
    path.join(commandsDir, 'context', 'index.ts'),
    [
      'export const context = {',
      "  type: 'local-jsx',",
      "  name: 'context',",
      "  description: 'visualize context grid',",
      '};',
      'export const contextNonInteractive = {',
      "  type: 'local',",
      "  name: 'context',",
      "  description: 'show current context usage',",
      '  supportsNonInteractive: true,',
      '};'
    ].join('\n')
  );
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
  assert.match(res.body, /"command":"\/context"/);
  assert.match(res.body, /show current context usage/);
  assert.doesNotMatch(res.body, /visualize context grid/);
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
      accountId: '1',
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
    accountId: '1',
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
      accountId: '1',
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

test('web ui chat passes codex existing session prompt through official resume command path', async () => {
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
      accountId: '1',
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
    assert.equal(Boolean(seenOptions && seenOptions.interactiveCli), true);
    assert.equal(Boolean(seenOptions && seenOptions.completeOnTranscriptUpdate), true);
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
      accountId: '4',
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
    assert.equal(String(seenOptions && seenOptions.accountId || ''), '4');
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
      accountId: '1',
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
      accountId: '1',
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
  fs.writeFileSync(
    path.join(aiHomeDir, 'webui-projects.json'),
    JSON.stringify({
      projects: [
        {
          path: projectPath,
          name: 'my-real-project',
          addedAt: Date.now()
        }
      ],
      hiddenPaths: []
    }, null, 2),
    'utf8'
  );

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
      accountId: '1',
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
  fs.writeFileSync(
    path.join(aiHomeDir, 'webui-projects.json'),
    JSON.stringify({
      projects: [
        {
          path: projectPath,
          name: 'my-real-project',
          addedAt: Date.now()
        }
      ],
      hiddenPaths: []
    }, null, 2),
    'utf8'
  );

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
      accountId: '1',
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

test('web ui chat routes codex api key sessions through api proxy stream instead of native session', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  const originalFetchWithTimeout = httpUtils.fetchWithTimeout;
  let nativeSpawned = false;

  nativeSessionChat.spawnNativeSessionStream = () => {
    nativeSpawned = true;
    return {
      abort() {},
      done: Promise.resolve({ content: 'should-not-run', sessionId: 'native' })
    };
  };

  httpUtils.fetchWithTimeout = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(
          'data: {"choices":[{"delta":{"content":"图片"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"已收到"},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n'
        ));
        controller.close();
      }
    }),
    headers: new Headers()
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-chat-'));
  try {
    const profileDir = path.join(root, 'profiles', 'codex', '10000');
    const configDir = path.join(profileDir, '.codex');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, '.aih_env.json'), JSON.stringify({
      OPENAI_API_KEY: 'sk-test-runtime',
      OPENAI_BASE_URL: 'https://sub.devbin.de'
    }, null, 2));
    fs.writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify({
      OPENAI_API_KEY: 'sk-test-runtime'
    }, null, 2));
    fs.writeFileSync(path.join(configDir, 'config.toml'), 'model = "gpt-5.4"\n');

    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'codex',
      accountId: '10000',
      createSession: true,
      projectPath: '/Users/model',
      prompt: '这个图片讲了什么',
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
        ...createBaseDeps(),
        fs: require('fs-extra'),
        getProfileDir: (_provider, _id) => profileDir,
        getToolConfigDir: (_provider, _id) => configDir,
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    assert.equal(handled, true);
    assert.equal(nativeSpawned, false);
    assert.match(res.body, /"type":"ready","mode":"api-proxy"/);
    assert.match(res.body, /"type":"delta","delta":"图片"/);
    assert.match(res.body, /"type":"done","mode":"api-proxy","content":"图片已收到"/);
    req.emit('close');
  } finally {
    httpUtils.fetchWithTimeout = originalFetchWithTimeout;
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
    const profileDir = path.join(root, 'profiles', 'agy', '2');
    const configDir = path.join(profileDir, '.gemini', 'antigravity-cli');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, '.aih_env.json'), JSON.stringify({
      AGY_ACCESS_TOKEN: 'agy-token'
    }, null, 2));

    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'agy',
      accountId: '2',
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
            id: '2',
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
        ...createBaseDeps(),
        fs: require('fs-extra'),
        getProfileDir: () => profileDir,
        getToolConfigDir: () => configDir,
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    assert.equal(handled, true);
    assert.equal(nativeSpawned, false);
    assert.equal(seenRequest.headers['X-Provider'], 'agy');
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

test('web ui chat routes opencode api proxy stream with session id events', async () => {
  const originalFetchWithTimeout = httpUtils.fetchWithTimeout;
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  let nativeSpawned = false;
  let seenRequest = null;
  fs.mkdirSync(path.dirname(opencodeSessionStore.getOpenCodeDbPath(sandboxRealHome)), { recursive: true });
  opencodeSessionStore.ensureOpenCodeSessionTestSchema(sandboxRealHome);
  httpUtils.fetchWithTimeout = async (_url, init) => {
    seenRequest = {
      headers: init && init.headers,
      body: JSON.parse(String(init && init.body || '{}'))
    };
    const sessionId = String(seenRequest.body.session_id || '');
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from(
            `data: ${JSON.stringify({ session_id: sessionId, choices: [{ delta: { role: 'assistant' } }] })}\n\n` +
            `data: ${JSON.stringify({ session_id: sessionId, choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\n` +
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
    throw new Error('opencode chat should use api proxy');
  };

  const req = new EventEmitter();
  req.headers = {};
  const res = createStreamResCapture();
  const payload = {
    provider: 'opencode',
    accountId: '1',
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

    assert.equal(handled, true);
    assert.equal(nativeSpawned, false);
    assert.equal(seenRequest.headers['X-Provider'], 'opencode');
    assert.equal(seenRequest.body.model, 'opencode-go/glm-5.2');
    assert.match(seenRequest.body.session_id, /^ses_/);
    assert.match(res.body, /"type":"ready","mode":"api-proxy"/);
    assert.match(res.body, new RegExp(`"type":"session-created","sessionId":"${seenRequest.body.session_id}"`));
    assert.match(res.body, /"type":"delta","delta":"OK"/);
    assert.match(res.body, new RegExp(`"type":"done","mode":"api-proxy","content":"OK".*"sessionId":"${seenRequest.body.session_id}"`));
    const messages = sessionReader.readSessionMessages('opencode', { sessionId: seenRequest.body.session_id });
    assert.deepEqual(messages.map((message) => [message.role, message.content]), [
      ['user', 'hi'],
      ['assistant', 'OK']
    ]);
    const projects = sessionReader.readProjectsFromHostByProviders(['opencode']);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].path, '/Users/model');
    assert.equal(projects[0].sessions[0].id, seenRequest.body.session_id);
    req.emit('close');
  } finally {
    httpUtils.fetchWithTimeout = originalFetchWithTimeout;
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui chat returns native opencode session id for non-stream api proxy sessions', async () => {
  const originalFetchWithTimeout = httpUtils.fetchWithTimeout;
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  const originalRealHomeForTest = process.env.REAL_HOME;
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-json-home-'));
  let nativeSpawned = false;
  let seenRequest = null;

  process.env.REAL_HOME = hostHome;
  fs.mkdirSync(path.dirname(opencodeSessionStore.getOpenCodeDbPath(hostHome)), { recursive: true });
  opencodeSessionStore.ensureOpenCodeSessionTestSchema(hostHome);

  httpUtils.fetchWithTimeout = async (_url, init) => {
    seenRequest = {
      headers: init && init.headers,
      body: JSON.parse(String(init && init.body || '{}'))
    };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'upstream-chat-completion-id',
        session_id: 'upstream-session-id',
        model: 'opencode-go/glm-5.2',
        choices: [{
          message: { content: 'JSON OK' },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 2,
          completion_tokens: 3
        }
      }),
      headers: new Headers()
    };
  };
  nativeSessionChat.spawnNativeSessionStream = () => {
    nativeSpawned = true;
    throw new Error('opencode chat should use api proxy');
  };

  try {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    const payload = {
      provider: 'opencode',
      accountId: '1',
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
        ...createBaseDeps(),
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    assert.equal(handled, true);
    assert.equal(nativeSpawned, false);
    assert.equal(seenRequest.headers['X-Provider'], 'opencode');
    assert.match(seenRequest.body.session_id, /^ses_/);

    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.content, 'JSON OK');
    assert.equal(body.sessionId, seenRequest.body.session_id);
    assert.notEqual(body.sessionId, 'upstream-session-id');
    assert.notEqual(body.sessionId, 'upstream-chat-completion-id');

    const messages = sessionReader.readSessionMessages('opencode', { sessionId: body.sessionId });
    assert.deepEqual(messages.map((message) => [message.role, message.content]), [
      ['user', 'json hi'],
      ['assistant', 'JSON OK']
    ]);
  } finally {
    httpUtils.fetchWithTimeout = originalFetchWithTimeout;
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
    if (originalRealHomeForTest === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHomeForTest;
    fs.rmSync(hostHome, { recursive: true, force: true });
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
      accountId: '3',
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

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-chat-thinking-'));
  try {
    const req = new EventEmitter();
    req.headers = {};
    const profileDir = path.join(root, 'profiles', 'codex', '1');
    const configDir = path.join(profileDir, '.codex');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, '.aih_env.json'), JSON.stringify({
      OPENAI_API_KEY: 'sk-test-thinking'
    }, null, 2));
    fs.writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify({
      OPENAI_API_KEY: 'sk-test-thinking'
    }, null, 2));

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
        ...createBaseDeps(),
        fs: require('fs-extra'),
        readRequestBody: async () => Buffer.from(JSON.stringify({
          provider: 'codex',
          accountId: '1',
          stream: true,
          sessionId: 'existing-session',
          messages: [{ role: 'user', content: '你好' }]
        }), 'utf8'),
        getProfileDir: () => profileDir,
        getToolConfigDir: () => configDir
      }
    });

    assert.equal(handled, true);
    assert.match(res.body, /"type":"thinking","thinking":"先分析问题"/);
    assert.match(res.body, /"type":"delta","delta":"给出答案"/);
    req.emit('close');
  } finally {
    httpUtils.fetchWithTimeout = originalFetchWithTimeout;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
