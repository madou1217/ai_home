const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const { handleWebUIRequest } = require('../lib/server/web-ui-router');
const { createSessionEventBus } = require('../lib/server/session-event-bus');
const {
  createProviderSessionCorrelationRegistry
} = require('../lib/server/provider-session-correlation-registry');

function createStreamResCapture() {
  return {
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
  };
}

function createBaseDeps(overrides = {}) {
  return {
    fs,
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    },
    readRequestBody: async () => null,
    accountStateIndex: {
      upsertAccountState() {},
      removeAccount() {},
      getAccountState() { return null; }
    },
    getToolAccountIds() { return []; },
    getToolConfigDir() { return '/tmp/config'; },
    getProfileDir() { return '/tmp/profile'; },
    loadServerRuntimeAccounts() { return { codex: [], gemini: [], claude: [] }; },
    applyReloadState() {},
    checkStatus() { return { configured: true, accountName: 'watch@test.dev' }; },
    ensureSessionStoreLinks() {},
    pickProjectDirectory() { return null; },
    ...overrides
  };
}

test('web ui sessions watch streams codex session file updates', async (t) => {
  const realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-watch-home-'));
  const sessionEventBus = createSessionEventBus({ fs });
  process.env.REAL_HOME = realHome;
  t.after(() => {
    sessionEventBus.close();
    delete process.env.REAL_HOME;
    fs.rmSync(realHome, { recursive: true, force: true });
  });

  const sessionId = '12345678-1234-1234-1234-123456789abc';
  const sessionDir = path.join(realHome, '.codex', 'sessions', '2026', '04', '11');
  fs.ensureDirSync(sessionDir);
  const sessionPath = path.join(sessionDir, `rollout-2026-04-11T00-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(sessionPath, '{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}\n');

  const req = new EventEmitter();
  req.headers = {};
  const res = createStreamResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/sessions/watch',
    url: new URL(`http://localhost/v0/webui/sessions/watch?provider=codex&sessionId=${sessionId}`),
    req,
    res,
    options: {},
    state: {},
    deps: createBaseDeps({ sessionEventBus })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /"type":"connected"/);

  fs.appendFileSync(sessionPath, '{"type":"event_msg","payload":{"type":"user_message","message":"world"}}\n');
  await new Promise((resolve) => setTimeout(resolve, 1700));

  assert.match(res.body, /"type":"update"/);
  req.emit('close');
});

test('web ui sessions watch reuses one file watcher per session', async (t) => {
  const realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-watch-home-shared-'));
  const sessionEventBus = createSessionEventBus({ fs });
  process.env.REAL_HOME = realHome;
  t.after(() => {
    sessionEventBus.close();
    delete process.env.REAL_HOME;
    fs.rmSync(realHome, { recursive: true, force: true });
  });

  const sessionId = '12345678-1234-1234-1234-123456789abd';
  const sessionDir = path.join(realHome, '.codex', 'sessions', '2026', '04', '11');
  fs.ensureDirSync(sessionDir);
  const sessionPath = path.join(sessionDir, `rollout-2026-04-11T00-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(sessionPath, '{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}\n');

  const deps = createBaseDeps({ sessionEventBus });
  const requests = [new EventEmitter(), new EventEmitter()];
  const responses = [createStreamResCapture(), createStreamResCapture()];

  for (let index = 0; index < requests.length; index += 1) {
    requests[index].headers = {};
    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/sessions/watch',
      url: new URL(`http://localhost/v0/webui/sessions/watch?provider=codex&sessionId=${sessionId}`),
      req: requests[index],
      res: responses[index],
      options: {},
      state: {},
      deps
    });
    assert.equal(handled, true);
  }

  assert.deepEqual(sessionEventBus.getStats(), {
    sessions: 1,
    subscribers: 2,
    watchedFiles: 1
  });

  fs.appendFileSync(sessionPath, '{"type":"event_msg","payload":{"type":"user_message","message":"world"}}\n');
  await new Promise((resolve) => setTimeout(resolve, 1700));

  assert.match(responses[0].body, /"type":"update"/);
  assert.match(responses[1].body, /"type":"update"/);

  requests[0].emit('close');
  assert.deepEqual(sessionEventBus.getStats(), {
    sessions: 1,
    subscribers: 1,
    watchedFiles: 1
  });

  requests[1].emit('close');
  assert.deepEqual(sessionEventBus.getStats(), {
    sessions: 0,
    subscribers: 0,
    watchedFiles: 0
  });
});

test('web ui sessions watch streams direct session bus events', async (t) => {
  const sessionEventBus = createSessionEventBus({
    fs,
    resolveSessionFilePath() { return ''; }
  });
  t.after(() => {
    sessionEventBus.close();
  });

  const sessionId = 'bus-session-1';
  const req = new EventEmitter();
  req.headers = {};
  const res = createStreamResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/sessions/watch',
    url: new URL(`http://localhost/v0/webui/sessions/watch?provider=claude&sessionId=${sessionId}&projectDirName=project-a`),
    req,
    res,
    options: {},
    state: {},
    deps: createBaseDeps({ sessionEventBus })
  });

  assert.equal(handled, true);
  assert.equal(sessionEventBus.getStats().subscribers, 1);

  sessionEventBus.publish({
    provider: 'claude',
    sessionId,
    projectDirName: 'project-a'
  }, {
    type: 'session:turn-completed',
    source: 'official-hook',
    reason: 'Stop'
  });

  assert.match(res.body, /"type":"update"/);
  assert.match(res.body, /"source":"official-hook"/);
  assert.match(res.body, /"eventType":"session:turn-completed"/);
  req.emit('close');
});

test('web ui provider hook endpoint publishes session watch update', async (t) => {
  const sessionEventBus = createSessionEventBus({
    fs,
    resolveSessionFilePath() { return ''; }
  });
  t.after(() => {
    sessionEventBus.close();
  });

  const sessionId = 'hook-session-1';
  const req = new EventEmitter();
  req.headers = {};
  const res = createStreamResCapture();
  const deps = createBaseDeps({ sessionEventBus });
  const watchHandled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/sessions/watch',
    url: new URL(`http://localhost/v0/webui/sessions/watch?provider=agy&sessionId=${sessionId}&projectDirName=project-a`),
    req,
    res,
    options: {},
    state: {},
    deps
  });

  assert.equal(watchHandled, true);

  const hookReq = new EventEmitter();
  hookReq.headers = {};
  const hookRes = createStreamResCapture();
  const hookPayload = {
    provider: 'agy',
    payload: {
      conversationId: sessionId,
      workspacePaths: ['/repo'],
      transcriptPath: '/repo/.gemini/antigravity/transcript.jsonl',
      executionNum: 1,
      terminationReason: 'model_stop',
      error: '',
      fullyIdle: true
    }
  };
  const hookHandled = await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/session-events/provider-hook',
    url: new URL('http://localhost/v0/webui/session-events/provider-hook'),
    req: hookReq,
    res: hookRes,
    options: {},
    state: {},
    deps: {
      ...deps,
      readRequestBody: async () => Buffer.from(JSON.stringify(hookPayload), 'utf8')
    }
  });

  assert.equal(hookHandled, true);
  assert.equal(hookRes.statusCode, 200);
  const hookBody = JSON.parse(hookRes.body);
  assert.equal(hookBody.ok, true);
  assert.equal(hookBody.event.type, 'session:turn-completed');
  assert.equal(hookBody.event.provider, 'agy');
  assert.match(res.body, /"type":"update"/);
  assert.match(res.body, /"source":"official-hook"/);
  assert.match(res.body, /"eventType":"session:turn-completed"/);
  assert.match(res.body, /"reason":"Stop"/);
  assert.match(res.body, /"eventName":"Stop"/);
  assert.match(res.body, /"phase":"turn-completed"/);
  assert.match(res.body, /"projectPath":"\/repo"/);
  req.emit('close');
});

test('Claude CLI retry events resolve their exact hook session and stream immediately', async (t) => {
  const sessionEventBus = createSessionEventBus({ fs, resolveSessionFilePath() { return ''; } });
  const providerSessionCorrelationRegistry = createProviderSessionCorrelationRegistry();
  t.after(() => sessionEventBus.close());
  const sessionId = 'claude-cli-session-1';
  const watchReq = new EventEmitter();
  watchReq.headers = {};
  const watchRes = createStreamResCapture();
  const deps = createBaseDeps({ sessionEventBus, providerSessionCorrelationRegistry });

  await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/sessions/watch',
    url: new URL(`http://localhost/v0/webui/sessions/watch?provider=claude&sessionId=${sessionId}`),
    req: watchReq,
    res: watchRes,
    options: {},
    state: {},
    deps
  });

  async function postHook(payload) {
    const req = new EventEmitter();
    req.headers = {};
    const res = createStreamResCapture();
    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/session-events/provider-hook',
      url: new URL('http://localhost/v0/webui/session-events/provider-hook'),
      req,
      res,
      options: {},
      state: {},
      deps: {
        ...deps,
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });
    return res;
  }

  const startRes = await postHook({
    provider: 'claude',
    eventName: 'SessionStart',
    correlationId: 'pty-run-1',
    payload: { session_id: sessionId, cwd: '/repo' }
  });
  assert.equal(startRes.statusCode, 200);

  const retryRes = await postHook({
    provider: 'claude',
    eventName: 'AihRetryStatus',
    correlationId: 'pty-run-1',
    retryStatus: { attempt: 3, maxAttempts: 10, retryAfterMs: 3000, status: 429 }
  });
  assert.equal(retryRes.statusCode, 200);
  assert.match(watchRes.body, /"eventType":"session:retry-status"/);
  assert.match(watchRes.body, /"retryStatus":\{"type":"retry-status","phase":"scheduled","source":"provider-runtime","provider":"claude","attempt":3,"maxAttempts":10,"retryAfterMs":3000,"status":429\}/);
  watchReq.emit('close');
});
