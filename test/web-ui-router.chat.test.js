const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { handleWebUIRequest } = require('../lib/server/web-ui-router');
const nativeSessionChat = require('../lib/server/native-session-chat');
const nativeSlashCommands = require('../lib/server/native-slash-commands');
const httpUtils = require('../lib/server/http-utils');

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

function createBaseDeps() {
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
    ensureSessionStoreLinks() {}
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

test('web ui chat aborts native stream when client disconnects', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  let aborted = false;
  nativeSessionChat.spawnNativeSessionStream = () => {
    return {
      abort() {
        aborted = true;
      },
      done: new Promise(() => {})
    };
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

    req.emit('close');

    assert.equal(handled, true);
    assert.equal(aborted, true);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui chat run input writes to active native stream', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  const writes = [];
  nativeSessionChat.spawnNativeSessionStream = () => {
    return {
      runId: 'native-run-1',
      writeInput(input, options = {}) {
        writes.push({ input, options });
      },
      abort() {},
      done: new Promise(() => {})
    };
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
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui chat run input preserves raw terminal keys like space and enter', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  const writes = [];
  nativeSessionChat.spawnNativeSessionStream = () => {
    return {
      runId: 'native-run-raw-keys',
      writeInput(input, options = {}) {
        writes.push({ input, options });
      },
      abort() {},
      done: new Promise(() => {})
    };
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
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
  }
});

test('web ui chat run resize updates active native stream pty size', async () => {
  const originalSpawn = nativeSessionChat.spawnNativeSessionStream;
  const resizeCalls = [];
  nativeSessionChat.spawnNativeSessionStream = () => {
    return {
      runId: 'native-run-resize',
      writeInput() {},
      resize(cols, rows) {
        resizeCalls.push({ cols, rows });
      },
      abort() {},
      done: new Promise(() => {})
    };
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
    assert.match(seenPrompt, /\/tmp\/profile\/\.gemini\/tmp\/model\/images\/clipboard-/);
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
    assert.match(res.body, /"interactionMode":"terminal"/);
    assert.match(res.body, /"type":"ready"/);
    assert.match(res.body, /"type":"done"/);
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
    assert.match(res.body, /"interactionMode":"terminal"/);
    assert.match(res.body, /"type":"done"/);
  } finally {
    nativeSessionChat.spawnNativeSessionStream = originalSpawn;
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
  } finally {
    httpUtils.fetchWithTimeout = originalFetchWithTimeout;
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
      req: {
        headers: {},
        on() {}
      },
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
  } finally {
    httpUtils.fetchWithTimeout = originalFetchWithTimeout;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
