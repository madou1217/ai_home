const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const { handleWebUIRequest } = require('../lib/server/web-ui-router');
const {
  createSessionLifecycleComposition
} = require('../lib/server/session-lifecycle/composition');

function createResCapture() {
  return {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code;
    },
    end(chunk = '') {
      this.body = String(chunk);
    }
  };
}

function createBaseDeps(aiHomeDir) {
  const hostHomeDir = process.env.REAL_HOME;
  return {
    fs,
    aiHomeDir,
    hostHomeDir,
    sessionLifecycleService: createSessionLifecycleComposition({
      fs,
      aiHomeDir,
      hostHomeDir,
      runtimeResolver: {
        resolve: async () => ({ provider: 'codex', executablePath: '/tmp/codex', fingerprint: 'test-codex' })
      },
      codexClientFactory: async () => createFakeCodexNativeClient(hostHomeDir),
      deleteJsonValue: () => false
    }),
    refreshProjectsSnapshot: async () => ({}),
    notifyWebUiProjectWatchers: async () => false,
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    },
    readRequestBody: async () => null,
    accountStateIndex: {
      getAccountState() { return null; },
      upsertAccountState() {},
      removeAccount() {}
    },
    getToolAccountIds() { return []; },
    getToolConfigDir() { return '/tmp/config'; },
    getProfileDir() { return '/tmp/profile'; },
    loadServerRuntimeAccounts() { return { codex: [], gemini: [], claude: [] }; },
    applyReloadState() {},
    fetchModelsForAccount: async () => [],
    checkStatus() { return { configured: false, accountName: 'Unknown' }; },
    ensureSessionStoreLinks() {},
    pickProjectDirectory() { return null; }
  };
}

function createFakeCodexNativeClient(hostHomeDir) {
  return {
    async request(method, params = {}) {
      const sessionId = String(params.threadId || '').trim();
      if (method === 'thread/list') {
        return {
          data: listFakeArchivedThreads(hostHomeDir).slice(0, Number(params.limit) || undefined),
          nextCursor: null
        };
      }
      if (sessionId === '00000000-0000-4000-8000-000000000000') {
        const error = new Error('thread not found');
        error.rpcCode = -32602;
        throw error;
      }
      if (method === 'thread/archive') {
        const source = findSessionFile(path.join(hostHomeDir, '.codex', 'sessions'), sessionId);
        if (!source) throw new Error('thread not found');
        const archivedDir = path.join(hostHomeDir, '.codex', 'archived_sessions');
        fs.ensureDirSync(archivedDir);
        fs.renameSync(source, path.join(archivedDir, path.basename(source)));
        return {};
      }
      if (method === 'thread/unarchive') {
        const archivedDir = path.join(hostHomeDir, '.codex', 'archived_sessions');
        const fileName = fs.readdirSync(archivedDir).find((entry) => entry.includes(sessionId));
        if (!fileName) throw new Error('archived thread not found');
        const date = fileName.match(/rollout-(\d{4})-(\d{2})-(\d{2})/);
        const destinationDir = date
          ? path.join(hostHomeDir, '.codex', 'sessions', date[1], date[2], date[3])
          : path.join(hostHomeDir, '.codex', 'sessions');
        fs.ensureDirSync(destinationDir);
        fs.renameSync(path.join(archivedDir, fileName), path.join(destinationDir, fileName));
        return {};
      }
      return {};
    },
    close() {}
  };
}

function listFakeArchivedThreads(hostHomeDir) {
  const archivedDir = path.join(hostHomeDir, '.codex', 'archived_sessions');
  if (!fs.existsSync(archivedDir)) return [];
  return fs.readdirSync(archivedDir)
    .filter((fileName) => fileName.endsWith('.jsonl'))
    .map((fileName) => {
      const id = (fileName.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i) || [])[1];
      if (!id) return null;
      const filePath = path.join(archivedDir, fileName);
      let cwd = '';
      try {
        const first = fs.readFileSync(filePath, 'utf8').split('\n').find(Boolean);
        const record = first ? JSON.parse(first) : null;
        cwd = String(record && record.payload && record.payload.cwd || '');
      } catch (_error) {}
      return {
        id,
        name: null,
        preview: '',
        cwd,
        updatedAt: Math.floor(fs.statSync(filePath).mtimeMs / 1000)
      };
    })
    .filter(Boolean);
}

function findSessionFile(rootDir, sessionId) {
  if (!fs.existsSync(rootDir)) return '';
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
        return fullPath;
      }
    }
  }
  return '';
}

test('web ui archived sessions list reflects native Codex archive across fresh service state', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-archived-'));
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-archived-host-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = hostHomeDir;

  try {
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const sessionDir = path.join(hostHomeDir, '.codex', 'sessions', '2026', '04', '13');
    const archivedDir = path.join(hostHomeDir, '.codex', 'archived_sessions');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-13T10-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(sessionFile, '{"type":"session_meta"}\n', 'utf8');

    const archiveRes = createResCapture();
    const archiveHandled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/sessions/archive',
      url: new URL('http://localhost/v0/webui/sessions/archive'),
      req: { headers: {} },
      res: archiveRes,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(aiHomeDir),
        readRequestBody: async () => Buffer.from(JSON.stringify({
          provider: 'codex',
          sessionId,
          title: '归档会话'
        }), 'utf8')
      }
    });

    assert.equal(archiveHandled, true);
    assert.equal(archiveRes.statusCode, 200);
    assert.equal(fs.existsSync(sessionFile), false);
    assert.equal(fs.existsSync(path.join(archivedDir, path.basename(sessionFile))), true);

    const listRes = createResCapture();
    const listHandled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/sessions/archived',
      url: new URL('http://localhost/v0/webui/sessions/archived'),
      req: { headers: {} },
      res: listRes,
      options: {},
      state: {},
      deps: createBaseDeps(aiHomeDir)
    });

    assert.equal(listHandled, true);
    assert.equal(listRes.statusCode, 200);
    const body = JSON.parse(listRes.body);
    const item = body.archived.find((entry) => entry.id === sessionId && entry.provider === 'codex');
    assert.ok(item);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('web ui archived sessions list keeps codex archived projectPath metadata', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-archived-project-path-'));
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-archived-project-path-host-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = hostHomeDir;

  try {
    const sessionId = 'abababab-abab-4aba-8aba-abababababab';
    const projectPath = path.join(hostHomeDir, 'project-from-codex-app');
    const archivedDir = path.join(hostHomeDir, '.codex', 'archived_sessions');
    const archivedFile = path.join(archivedDir, `rollout-2026-04-13T10-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(projectPath);
    fs.ensureDirSync(archivedDir);
    fs.writeFileSync(
      archivedFile,
      JSON.stringify({
        timestamp: '2026-04-13T10:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: sessionId,
          cwd: projectPath
        }
      }) + '\n',
      'utf8'
    );

    const listRes = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/sessions/archived',
      url: new URL('http://localhost/v0/webui/sessions/archived?refresh=1'),
      req: { headers: {} },
      res: listRes,
      options: {},
      state: {},
      deps: createBaseDeps(aiHomeDir)
    });

    assert.equal(handled, true);
    assert.equal(listRes.statusCode, 200);
    const body = JSON.parse(listRes.body);
    const item = body.archived.find((entry) => entry.id === sessionId && entry.provider === 'codex');
    assert.ok(item);
    assert.equal(item.projectPath, projectPath);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('web ui archived sessions list unescapes Windows codex projectPath metadata', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-archived-win-project-path-'));
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-archived-win-project-path-host-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = hostHomeDir;

  try {
    const sessionId = 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd';
    const projectPath = 'C:\\Users\\madou\\projects\\feature\\ai_home';
    const archivedDir = path.join(hostHomeDir, '.codex', 'archived_sessions');
    const archivedFile = path.join(archivedDir, `rollout-2026-04-13T10-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(archivedDir);
    fs.writeFileSync(
      archivedFile,
      JSON.stringify({
        timestamp: '2026-04-13T10:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: sessionId,
          cwd: projectPath
        }
      }) + '\n',
      'utf8'
    );

    const listRes = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/sessions/archived',
      url: new URL('http://localhost/v0/webui/sessions/archived?refresh=1'),
      req: { headers: {} },
      res: listRes,
      options: {},
      state: {},
      deps: createBaseDeps(aiHomeDir)
    });

    assert.equal(handled, true);
    assert.equal(listRes.statusCode, 200);
    const body = JSON.parse(listRes.body);
    const item = body.archived.find((entry) => entry.id === sessionId && entry.provider === 'codex');
    assert.ok(item);
    assert.equal(item.projectPath, projectPath);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('web ui archived sessions list reflects unarchive removal across fresh state', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-unarchived-'));
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-unarchived-host-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = hostHomeDir;

  try {
    const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const sessionDir = path.join(hostHomeDir, '.codex', 'sessions', '2026', '04', '13');
    const archivedDir = path.join(hostHomeDir, '.codex', 'archived_sessions');
    const sessionFile = path.join(sessionDir, `rollout-2026-04-13T10-00-00-${sessionId}.jsonl`);
    fs.ensureDirSync(sessionDir);
    fs.writeFileSync(sessionFile, '{"type":"session_meta"}\n', 'utf8');

    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/sessions/archive',
      url: new URL('http://localhost/v0/webui/sessions/archive'),
      req: { headers: {} },
      res: createResCapture(),
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(aiHomeDir),
        readRequestBody: async () => Buffer.from(JSON.stringify({
          provider: 'codex',
          sessionId,
          title: '稍后恢复'
        }), 'utf8')
      }
    });

    const unarchiveRes = createResCapture();
    const unarchiveHandled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/sessions/unarchive',
      url: new URL('http://localhost/v0/webui/sessions/unarchive'),
      req: { headers: {} },
      res: unarchiveRes,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(aiHomeDir),
        readRequestBody: async () => Buffer.from(JSON.stringify({
          provider: 'codex',
          sessionId
        }), 'utf8')
      }
    });

    assert.equal(unarchiveHandled, true);
    assert.equal(unarchiveRes.statusCode, 200);
    assert.equal(fs.existsSync(path.join(archivedDir, path.basename(sessionFile))), false);
    assert.ok(findSessionFile(path.join(hostHomeDir, '.codex', 'sessions'), sessionId));

    const listRes = createResCapture();
    await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/sessions/archived',
      url: new URL('http://localhost/v0/webui/sessions/archived'),
      req: { headers: {} },
      res: listRes,
      options: {},
      state: {},
      deps: createBaseDeps(aiHomeDir)
    });

    const body = JSON.parse(listRes.body);
    const item = body.archived.find((entry) => entry.id === sessionId && entry.provider === 'codex');
    assert.equal(item, undefined);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});
