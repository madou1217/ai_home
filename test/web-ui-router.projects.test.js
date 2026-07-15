const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const originalRealHome = process.env.REAL_HOME;
const isolatedRealHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-projects-test-home-'));
process.env.REAL_HOME = isolatedRealHome;
test.after(() => {
  if (originalRealHome === undefined) delete process.env.REAL_HOME;
  else process.env.REAL_HOME = originalRealHome;
  fs.rmSync(isolatedRealHome, { recursive: true, force: true });
});

const { handleWebUIRequest } = require('../lib/server/web-ui-router');
const { writeJsonValue } = require('../lib/server/app-state-store');
const { getWebUiModelsCache } = require('../lib/server/webui-model-cache');
const { buildProjectsSnapshot } = require('../lib/server/webui-project-cache');

const WEBUI_CODEX_REF_1 = 'acct_0123456789abcdefabcd';
const WEBUI_CODEX_REF_2 = 'acct_abcdefabcdefabcdefab';
const WEBUI_CODEX_REF_3 = 'acct_11111111111111111111';
const WEBUI_GEMINI_REF_1 = 'acct_22222222222222222222';
const WEBUI_GEMINI_REF_2 = 'acct_33333333333333333333';
const WEBUI_CLAUDE_REF_1 = 'acct_44444444444444444444';
const WEBUI_AGY_REF_1 = 'acct_55555555555555555555';
const WEBUI_AGY_REF_2 = 'acct_66666666666666666666';

function createResCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers = {}) {
      this.statusCode = code;
      this.headers = { ...this.headers, ...headers };
    },
    end(chunk = '') {
      this.body = String(chunk);
    }
  };
}

function createStreamResCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
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
    }
  };
}

function createBaseDeps(aiHomeDir) {
  return {
    fs,
    aiHomeDir,
    hostHomeDir: aiHomeDir,
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
    getToolConfigDir() { return '/tmp/config'; },
    getProfileDir() { return '/tmp/profile'; },
    loadServerRuntimeAccounts() { return { codex: [], gemini: [], claude: [] }; },
    applyReloadState() {},
    fetchModelsForAccount: async () => [],
    checkStatus() { return { configured: false, accountName: 'Unknown' }; },
    ensureSessionStoreLinks() {},
    collectPersistentSessionRunKeys() { return new Set(); },
    pickProjectDirectory() { return null; }
  };
}

function assertPublicAccountRef(value) {
  assert.match(String(value || ''), /^acct_[a-f0-9]{20}$/);
  assert.equal(String(value).includes('oauth:'), false);
  assert.equal(String(value).includes('@'), false);
}

function assertNoInternalAccountKeys(payload) {
  const text = JSON.stringify(payload);
  assert.equal(text.includes('accountUniqueKey'), false);
  assert.equal(text.includes('oauth:'), false);
}

function writeModelsDevFixture(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirpSync(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
}

test('web ui static assets do not fall back to index html when chunk is missing', async () => {
  const res = createResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/ui/assets/Accounts-missing-old-hash.js',
    url: new URL('http://localhost/ui/assets/Accounts-missing-old-hash.js'),
    req: { headers: {} },
    res,
    options: {},
    state: {},
    deps: createBaseDeps()
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 404);
  assert.equal(res.headers['Content-Type'], 'text/plain; charset=utf-8');
  assert.equal(res.body, 'Static asset not found');
});

test('web ui project picker returns chosen directory from host dialog', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-picker-'));
  const pickedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-picked-project-'));

  try {
    const res = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/projects/pick',
      url: new URL('http://localhost/v0/webui/projects/pick'),
      req: { headers: {} },
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(aiHomeDir),
        pickProjectDirectory() {
          return {
            path: pickedDir,
            name: 'picked-project'
          };
        }
      }
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
      ok: true,
      cancelled: false,
      project: {
        path: pickedDir,
        name: 'picked-project'
      }
    });
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(pickedDir, { recursive: true, force: true });
  }
});

test('web ui projects watch streams snapshots and accepts explicit snapshot requests', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-projects-watch-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-projects-watch-project-'));

  try {
    writeJsonValue(fs, aiHomeDir, 'webui-projects', {
      projects: [{
        path: projectDir,
        name: 'watch-project',
        addedAt: 1000
      }],
      hiddenPaths: []
    });

    const req = new EventEmitter();
    req.headers = {};
    const streamRes = createStreamResCapture();
    const state = {};
    const watchHandled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects/watch',
      url: new URL('http://localhost/v0/webui/projects/watch'),
      req,
      res: streamRes,
      options: {},
      state,
      deps: {
        ...createBaseDeps(aiHomeDir),
        readAllProjectsFromHost: () => []
      }
    });

    assert.equal(watchHandled, true);
    assert.equal(streamRes.statusCode, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(streamRes.body, /"type":"connected"/);
    assert.match(streamRes.body, /"type":"snapshot"/);
    assert.match(streamRes.body, /"name":"watch-project"/);

    const bodyBeforeSnapshotRequest = streamRes.body;
    const snapshotRes = createResCapture();
    const snapshotHandled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/projects/watch/snapshot',
      url: new URL('http://localhost/v0/webui/projects/watch/snapshot'),
      req: { headers: {} },
      res: snapshotRes,
      options: {},
      state,
      deps: {
        ...createBaseDeps(aiHomeDir),
        readAllProjectsFromHost: () => []
      }
    });

    assert.equal(snapshotHandled, true);
    assert.equal(snapshotRes.statusCode, 202);
    assert.equal(JSON.parse(snapshotRes.body).broadcasted, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(streamRes.body.length > bodyBeforeSnapshotRequest.length);
    req.emit('close');
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('web ui file media preview serves authorized project images', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-media-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-media-project-'));
  const imagePath = path.join(projectDir, 'preview.png');
  const imageBytes = Buffer.from('89504e470d0a1a0a', 'hex');

  try {
    fs.writeFileSync(imagePath, imageBytes);
    const res = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/fs/media',
      url: new URL(`http://localhost/v0/webui/fs/media?path=${encodeURIComponent(imagePath)}&projectPath=${encodeURIComponent(projectDir)}`),
      req: { headers: {} },
      res,
      options: {},
      state: {},
      deps: createBaseDeps(aiHomeDir)
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'image/png');
    assert.equal(res.body, imageBytes.toString());
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('web ui file preview resolves memory citations from codex memory home', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-memory-read-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-memory-project-'));
  try {
    const memoryDir = path.join(aiHomeDir, '.codex', 'memories');
    fs.ensureDirSync(memoryDir);
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), 'codex memory root', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'MEMORY.md'), 'project memory shadow', 'utf8');

    const res = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/fs/read',
      url: new URL(`http://localhost/v0/webui/fs/read?source=codex-memory&path=MEMORY.md&projectPath=${encodeURIComponent(projectDir)}`),
      req: { headers: {} },
      res,
      options: {},
      state: {},
      deps: createBaseDeps(aiHomeDir)
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.content, 'codex memory root');
    assert.equal(body.path, path.join(memoryDir, 'MEMORY.md'));
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('web ui file preview rejects memory citation path traversal', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-memory-traversal-'));
  try {
    const memoryDir = path.join(aiHomeDir, '.codex', 'memories');
    fs.ensureDirSync(memoryDir);

    const res = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/fs/read',
      url: new URL('http://localhost/v0/webui/fs/read?source=codex-memory&path=../MEMORY.md'),
      req: { headers: {} },
      res,
      options: {},
      state: {},
      deps: createBaseDeps(aiHomeDir)
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'outside_memory_root');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui open project stores manual project and returns it in projects list', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-projects-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opened-project-'));
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opened-project-host-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = hostHomeDir;

  try {
    const openRes = createResCapture();
    const openPayload = {
      projectPath: projectDir,
      name: '测试项目'
    };

    const openHandled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/projects/open',
      url: new URL('http://localhost/v0/webui/projects/open'),
      req: { headers: {} },
      res: openRes,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(aiHomeDir),
        readRequestBody: async () => Buffer.from(JSON.stringify(openPayload), 'utf8')
      }
    });

    assert.equal(openHandled, true);
    assert.equal(openRes.statusCode, 200);

    const listRes = createResCapture();
    const listHandled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects',
      url: new URL('http://localhost/v0/webui/projects'),
      req: { headers: {} },
      res: listRes,
      options: {},
      state: {},
      deps: createBaseDeps(aiHomeDir)
    });

    assert.equal(listHandled, true);
    assert.equal(listRes.statusCode, 200);
    const body = JSON.parse(listRes.body);
    const project = body.projects.find((item) => item.path === projectDir);
    assert.ok(project);
    assert.equal(project.name, '测试项目');
    assert.deepEqual(project.sessions, []);

    const hostConfigPath = path.join(hostHomeDir, '.codex', 'config.toml');
    assert.equal(fs.existsSync(hostConfigPath), true);
    assert.equal(
      fs.readFileSync(hostConfigPath, 'utf8').includes(`[projects.${JSON.stringify(projectDir)}]`),
      true
    );
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('web ui remove project deletes manual project from stored list', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-projects-remove-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remove-project-'));

  try {
    const openPayload = {
      projectPath: projectDir,
      name: '待移除项目'
    };

    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/projects/open',
      url: new URL('http://localhost/v0/webui/projects/open'),
      req: { headers: {} },
      res: createResCapture(),
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(aiHomeDir),
        readRequestBody: async () => Buffer.from(JSON.stringify(openPayload), 'utf8')
      }
    });

    const removeRes = createResCapture();
    const removeHandled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/projects/remove',
      url: new URL('http://localhost/v0/webui/projects/remove'),
      req: { headers: {} },
      res: removeRes,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(aiHomeDir),
        readRequestBody: async () => Buffer.from(JSON.stringify({ projectPath: projectDir }), 'utf8')
      }
    });

    assert.equal(removeHandled, true);
    assert.equal(removeRes.statusCode, 200);

    const listRes = createResCapture();
    await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects',
      url: new URL('http://localhost/v0/webui/projects'),
      req: { headers: {} },
      res: listRes,
      options: {},
      state: {},
      deps: createBaseDeps(aiHomeDir)
    });

    const body = JSON.parse(listRes.body);
    const project = body.projects.find((item) => item.path === projectDir);
    assert.equal(project, undefined);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('web ui remove project hides provider-discovered project even when it has real sessions', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-projects-remove-discovered-'));
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-projects-remove-discovered-host-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = hostHomeDir;

  try {
    const projectDir = path.join(hostHomeDir, 'provider-project');
    fs.ensureDirSync(projectDir);
    fs.ensureDirSync(path.join(hostHomeDir, '.codex', 'sessions', '2026', '04', '13'));

    const sessionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    fs.writeFileSync(
      path.join(hostHomeDir, '.codex', 'session_index.jsonl'),
      JSON.stringify({
        id: sessionId,
        thread_name: 'provider-session',
        updated_at: '2026-04-13T12:00:00.000Z'
      }) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(hostHomeDir, '.codex', 'sessions', '2026', '04', '13', `rollout-2026-04-13T12-00-00-${sessionId}.jsonl`),
      JSON.stringify({
        timestamp: '2026-04-13T12:00:00.000Z',
        type: 'session_meta',
        payload: { id: sessionId, cwd: projectDir }
      }) + '\n',
      'utf8'
    );

    const removeRes = createResCapture();
    const removeHandled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/projects/remove',
      url: new URL('http://localhost/v0/webui/projects/remove'),
      req: { headers: {} },
      res: removeRes,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(aiHomeDir),
        readRequestBody: async () => Buffer.from(JSON.stringify({ projectPath: projectDir }), 'utf8')
      }
    });

    assert.equal(removeHandled, true);
    assert.equal(removeRes.statusCode, 200);

    const listRes = createResCapture();
    const listHandled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects',
      url: new URL('http://localhost/v0/webui/projects?refresh=1'),
      req: { headers: {} },
      res: listRes,
      options: {},
      state: {},
      deps: createBaseDeps(aiHomeDir)
    });

    assert.equal(listHandled, true);
    assert.equal(listRes.statusCode, 200);
    const body = JSON.parse(listRes.body);
    const project = body.projects.find((item) => item.path === projectDir);
    assert.equal(project, undefined);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('web ui projects never returns hidden project from stale cached snapshot', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-projects-hidden-cache-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-hidden-project-'));

  try {
    writeJsonValue(fs, aiHomeDir, 'webui-projects', {
      projects: [],
      hiddenPaths: [projectDir]
    });
    writeJsonValue(fs, aiHomeDir, 'cache:webui-projects-snapshot.json', {
      revision: 1,
      updatedAt: Date.now(),
      projects: [
        {
          id: 'gemini-hidden-project',
          name: 'hidden-project',
          path: projectDir,
          providers: ['gemini'],
          sessions: [
            {
              id: 'session-1',
              title: 'stale session',
              updatedAt: Date.now(),
              provider: 'gemini',
              projectPath: projectDir
            }
          ]
        }
      ]
    });

    const res = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects',
      url: new URL('http://localhost/v0/webui/projects'),
      req: { headers: {} },
      res,
      options: {},
      state: {},
      deps: createBaseDeps(aiHomeDir)
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.projects.some((project) => project.path === projectDir), false);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('web ui projects never returns missing project path from stale cached snapshot', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-projects-missing-cache-'));
  const missingProjectPath = path.join(aiHomeDir, 'missing-project');

  try {
    writeJsonValue(fs, aiHomeDir, 'cache:webui-projects-snapshot.json', {
      revision: 1,
      updatedAt: Date.now(),
      projects: [
        {
          id: 'claude-missing-project',
          name: 'missing-project',
          path: missingProjectPath,
          providers: ['claude'],
          sessions: [
            {
              id: 'session-1',
              title: 'stale session',
              updatedAt: Date.now(),
              provider: 'claude',
              projectDirName: 'missing-project',
              projectPath: missingProjectPath
            }
          ]
        }
      ]
    });

    const res = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects',
      url: new URL('http://localhost/v0/webui/projects'),
      req: { headers: {} },
      res,
      options: {},
      state: {},
      deps: createBaseDeps(aiHomeDir)
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.projects.some((project) => project.path === missingProjectPath), false);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui projects are sorted by last session update time and sessions are sorted descending', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-projects-sorted-'));
  const oldProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-sorted-old-'));
  const newProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-sorted-new-'));

  try {
    const state = {};
    const deps = createBaseDeps(aiHomeDir);
    const originalLoad = require.cache[require.resolve('../lib/sessions/session-reader')];
    const sessionReader = require('../lib/sessions/session-reader');
    const originalReadAllProjectsFromHost = sessionReader.readAllProjectsFromHost;
    sessionReader.readAllProjectsFromHost = () => ([
      {
        id: 'p-old',
        name: 'old-project',
        path: oldProjectDir,
        provider: 'codex',
        sessions: [
          { id: 's-1', title: 'older', updatedAt: 100, provider: 'codex' },
          { id: 's-2', title: 'newer', updatedAt: 300, provider: 'codex' }
        ]
      },
      {
        id: 'p-new',
        name: 'new-project',
        path: newProjectDir,
        provider: 'gemini',
        sessions: [
          { id: 's-3', title: 'latest', updatedAt: 500, provider: 'gemini', projectDirName: 'new-project' }
        ]
      }
    ]);

    try {
      const res = createResCapture();
      const handled = await handleWebUIRequest({
        method: 'GET',
        pathname: '/v0/webui/projects',
        url: new URL('http://localhost/v0/webui/projects?refresh=1'),
        req: { headers: {} },
        res,
        options: {},
        state,
        deps
      });

      assert.equal(handled, true);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.projects[0].path, newProjectDir);
      assert.equal(body.projects[1].path, oldProjectDir);
      assert.deepEqual(
        body.projects[1].sessions.map((item) => item.id),
        ['s-2', 's-1']
      );
    } finally {
      sessionReader.readAllProjectsFromHost = originalReadAllProjectsFromHost;
      if (originalLoad) {
        require.cache[require.resolve('../lib/sessions/session-reader')] = originalLoad;
      }
    }
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(oldProjectDir, { recursive: true, force: true });
    fs.rmSync(newProjectDir, { recursive: true, force: true });
  }
});

test('web ui project sessions returns the complete project while the projects snapshot stays capped', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-sessions-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-sessions-project-'));
  const state = {};
  let hostReads = 0;

  try {
    const sessions = Array.from({ length: 45 }, (_, index) => ({
      id: `session-${index}`,
      title: `session ${index}`,
      updatedAt: index + 1
    }));
    const deps = {
      ...createBaseDeps(aiHomeDir),
      readAllProjectsFromHost() {
        hostReads += 1;
        return [{
          id: 'project-complete',
          name: 'complete-project',
          path: projectDir,
          provider: 'codex',
          sessions
        }];
      }
    };

    const listRes = createResCapture();
    const listHandled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects',
      url: new URL('http://localhost/v0/webui/projects?refresh=1'),
      req: { headers: {} },
      res: listRes,
      options: {},
      state,
      deps
    });

    assert.equal(listHandled, true);
    assert.equal(listRes.statusCode, 200);
    const listBody = JSON.parse(listRes.body);
    assert.equal(listBody.projects[0].sessionTotal, 45);
    assert.equal(listBody.projects[0].sessions.length, 40);
    assert.deepEqual(
      listBody.projects[0].sessions.map((session) => session.id),
      Array.from({ length: 40 }, (_, index) => `session-${44 - index}`)
    );

    const sessionsUrl = new URL('http://localhost/v0/webui/projects/sessions');
    sessionsUrl.searchParams.set('projectPath', `${projectDir}/`);
    const sessionsRes = createResCapture();
    const sessionsHandled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects/sessions',
      url: sessionsUrl,
      req: { headers: {} },
      res: sessionsRes,
      options: {},
      state,
      deps
    });

    assert.equal(sessionsHandled, true);
    assert.equal(sessionsRes.statusCode, 200);
    const sessionsBody = JSON.parse(sessionsRes.body);
    assert.equal(sessionsBody.project.path, projectDir);
    assert.equal(sessionsBody.project.sessionTotal, 45);
    assert.equal(sessionsBody.project.sessions.length, 45);
    assert.deepEqual(
      sessionsBody.project.sessions.map((session) => session.id),
      Array.from({ length: 45 }, (_, index) => `session-${44 - index}`)
    );
    assert.equal(hostReads, 1);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('complete project projection never iterates sessions from unrelated projects', () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-projection-'));
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-target-'));
  const unrelatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-unrelated-'));
  const unrelatedSessions = new Proxy([], {
    get(target, property, receiver) {
      if (property === Symbol.iterator) {
        throw new Error('unrelated sessions must not be iterated');
      }
      return Reflect.get(target, property, receiver);
    }
  });

  try {
    const projects = buildProjectsSnapshot([
      {
        id: 'target',
        name: 'target',
        path: targetDir,
        provider: 'codex',
        sessions: [{ id: 'target-session', updatedAt: 1 }]
      },
      {
        id: 'unrelated',
        name: 'unrelated',
        path: unrelatedDir,
        provider: 'codex',
        sessions: unrelatedSessions
      }
    ], { fs, aiHomeDir }, {
      includeAllSessions: true,
      projectPath: targetDir
    });

    assert.equal(projects.length, 1);
    assert.equal(projects[0].path, targetDir);
    assert.deepEqual(projects[0].sessions.map((session) => session.id), ['target-session']);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.rmSync(unrelatedDir, { recursive: true, force: true });
  }
});

test('web ui project sessions requires projectPath', async () => {
  const res = createResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/projects/sessions',
    url: new URL('http://localhost/v0/webui/projects/sessions?projectPath=%20%20'),
    req: { headers: {} },
    res,
    options: {},
    state: {},
    deps: createBaseDeps()
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body), {
    ok: false,
    error: 'missing_projectPath',
    message: '缺少项目路径'
  });
});

test('web ui project sessions returns not found for a project outside the visible index', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-sessions-missing-'));
  const indexedProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-sessions-indexed-'));
  const missingProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-sessions-outside-'));

  try {
    const url = new URL('http://localhost/v0/webui/projects/sessions');
    url.searchParams.set('projectPath', missingProjectDir);
    const res = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects/sessions',
      url,
      req: { headers: {} },
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(aiHomeDir),
        readAllProjectsFromHost() {
          return [{
            id: 'indexed-project',
            name: 'indexed-project',
            path: indexedProjectDir,
            provider: 'codex',
            sessions: []
          }];
        }
      }
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(JSON.parse(res.body), {
      ok: false,
      error: 'project_not_found',
      message: '未找到项目'
    });
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(indexedProjectDir, { recursive: true, force: true });
    fs.rmSync(missingProjectDir, { recursive: true, force: true });
  }
});

test('web ui project sessions returns an empty list for a visible project without sessions', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-sessions-empty-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-project-sessions-empty-project-'));

  try {
    const url = new URL('http://localhost/v0/webui/projects/sessions');
    url.searchParams.set('projectPath', projectDir);
    const res = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects/sessions',
      url,
      req: { headers: {} },
      res,
      options: {},
      state: {},
      deps: {
        ...createBaseDeps(aiHomeDir),
        readAllProjectsFromHost() {
          return [{
            id: 'empty-project',
            name: 'empty-project',
            path: projectDir,
            provider: 'codex',
            sessions: []
          }];
        }
      }
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.project.sessionTotal, 0);
    assert.deepEqual(body.project.sessions, []);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('web ui projects keeps codex projects discovered from real sessions even when host config is incomplete', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-projects-codex-sync-'));
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-projects-codex-host-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = hostHomeDir;

  try {
    const registeredProject = path.join(hostHomeDir, 'registered-project');
    const unregisteredProject = path.join(hostHomeDir, 'unregistered-project');
    fs.ensureDirSync(registeredProject);
    fs.ensureDirSync(unregisteredProject);
    fs.ensureDirSync(path.join(hostHomeDir, '.codex', 'sessions', '2026', '04', '13'));

    fs.writeFileSync(
      path.join(hostHomeDir, '.codex', 'config.toml'),
      `[projects."${registeredProject}"]\ntrust_level = "trusted"\n`,
      'utf8'
    );

    const registeredSessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const unregisteredSessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    fs.writeFileSync(
      path.join(hostHomeDir, '.codex', 'session_index.jsonl'),
      [
        JSON.stringify({ id: registeredSessionId, thread_name: '已注册项目', updated_at: '2026-04-13T10:00:00.000Z' }),
        JSON.stringify({ id: unregisteredSessionId, thread_name: '未注册项目', updated_at: '2026-04-13T11:00:00.000Z' })
      ].join('\n') + '\n',
      'utf8'
    );

    const sessionDir = path.join(hostHomeDir, '.codex', 'sessions', '2026', '04', '13');
    fs.writeFileSync(
      path.join(sessionDir, `rollout-2026-04-13T10-00-00-${registeredSessionId}.jsonl`),
      JSON.stringify({
        timestamp: '2026-04-13T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: registeredSessionId, cwd: registeredProject }
      }) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(sessionDir, `rollout-2026-04-13T11-00-00-${unregisteredSessionId}.jsonl`),
      JSON.stringify({
        timestamp: '2026-04-13T11:00:00.000Z',
        type: 'session_meta',
        payload: { id: unregisteredSessionId, cwd: unregisteredProject }
      }) + '\n',
      'utf8'
    );

    const res = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects',
      url: new URL('http://localhost/v0/webui/projects?refresh=1'),
      req: { headers: {} },
      res,
      options: {},
      state: {},
      deps: createBaseDeps(aiHomeDir)
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.projects.some((project) => project.path === registeredProject), true);
    assert.equal(body.projects.some((project) => project.path === unregisteredProject), true);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('web ui projects lets hidden paths suppress provider-discovered projects with real sessions', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-projects-hidden-host-'));
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-projects-hidden-host-home-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = hostHomeDir;

  try {
    const hiddenButRealProject = path.join(hostHomeDir, 'hidden-but-real-project');
    fs.ensureDirSync(hiddenButRealProject);
    fs.ensureDirSync(path.join(hostHomeDir, '.codex', 'sessions', '2026', '04', '13'));
    writeJsonValue(fs, aiHomeDir, 'webui-projects', {
      projects: [],
      hiddenPaths: [hiddenButRealProject]
    });

    const sessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    fs.writeFileSync(
      path.join(hostHomeDir, '.codex', 'session_index.jsonl'),
      JSON.stringify({
        id: sessionId,
        thread_name: '真实项目仍应显示',
        updated_at: '2026-04-13T12:00:00.000Z'
      }) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(hostHomeDir, '.codex', 'sessions', '2026', '04', '13', `rollout-2026-04-13T12-00-00-${sessionId}.jsonl`),
      JSON.stringify({
        timestamp: '2026-04-13T12:00:00.000Z',
        type: 'session_meta',
        payload: { id: sessionId, cwd: hiddenButRealProject }
      }) + '\n',
      'utf8'
    );

    const res = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects',
      url: new URL('http://localhost/v0/webui/projects?refresh=1'),
      req: { headers: {} },
      res,
      options: {},
      state: {},
      deps: createBaseDeps(aiHomeDir)
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const project = body.projects.find((item) => item.path === hiddenButRealProject);
    assert.equal(project, undefined);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('web ui projects includes codex app workspace roots even without session files', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-projects-workspace-roots-'));
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-projects-workspace-host-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = hostHomeDir;

  try {
    const projectFromConfig = path.join(hostHomeDir, 'config-project');
    const projectFromGlobalState = path.join(hostHomeDir, 'global-state-project');
    fs.ensureDirSync(projectFromConfig);
    fs.ensureDirSync(projectFromGlobalState);
    fs.ensureDirSync(path.join(hostHomeDir, '.codex'));
    fs.writeFileSync(
      path.join(hostHomeDir, '.codex', 'config.toml'),
      `[projects."${projectFromConfig}"]\ntrust_level = "trusted"\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(hostHomeDir, '.codex', '.codex-global-state.json'),
      JSON.stringify({
        'project-order': [projectFromGlobalState]
      }),
      'utf8'
    );

    const res = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/projects',
      url: new URL('http://localhost/v0/webui/projects?refresh=1'),
      req: { headers: {} },
      res,
      options: {},
      state: {},
      deps: createBaseDeps(aiHomeDir)
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.projects.some((item) => item.path === projectFromConfig), true);
    assert.equal(body.projects.some((item) => item.path === projectFromGlobalState), true);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('web ui models reads cache without synchronous provider probes', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-models-'));

  try {
    const state = {
      accounts: {
        codex: [],
        gemini: [{
          id: 'g1',
          accountRef: WEBUI_GEMINI_REF_1,
          provider: 'gemini',
          accessToken: 'token-g1',
          availableModels: ['gemini-2.5-pro']
        }],
        claude: []
      },
      modelRegistry: {
        providers: {
          codex: new Set(['gpt-5.4']),
          gemini: new Set(),
          claude: new Set()
        }
      },
      webUiModelsCache: {
        updatedAt: Date.now(),
        byProvider: {
          codex: ['gpt-5.4'],
          gemini: ['gemini-2.5-flash', 'gemini-3.1-pro-preview']
        },
        byAccount: {
          [WEBUI_GEMINI_REF_1]: ['gemini-2.5-flash', 'gemini-3.1-pro-preview']
        },
        errorsByAccount: {},
        signature: '',
        source: 'remote',
        sourceCount: 1,
        scannedAccounts: 1
      }
    };
    let fetchCalls = 0;
    const deps = {
      ...createBaseDeps(aiHomeDir),
      fetchModelsForAccount: async () => {
        fetchCalls += 1;
        throw new Error('route must not probe synchronously');
      }
    };

    const firstRes = createResCapture();
    await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/models',
      url: new URL('http://localhost/v0/webui/models'),
      req: { headers: {} },
      res: firstRes,
      options: {},
      state,
      deps
    });
    const firstBody = JSON.parse(firstRes.body);
    assert.equal(firstRes.statusCode, 200);
    assert.equal(firstBody.cached, true);
    assert.deepEqual(firstBody.models, {
      codex: ['gpt-5.4'],
      gemini: ['gemini-2.5-flash', 'gemini-3.1-pro-preview']
    });
    assert.equal(firstBody.source, 'remote');
    assert.equal(firstBody.scannedAccounts, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(firstBody, 'byAccount'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(firstBody, 'errorsByAccount'), false);
    const accountRef = Object.keys(firstBody.byAccountRef || {})[0];
    assertPublicAccountRef(accountRef);
    assert.deepEqual(firstBody.byAccountRef[accountRef], ['gemini-2.5-flash', 'gemini-3.1-pro-preview']);
    assert.deepEqual(firstBody.errorsByAccountRef, {});
    assertNoInternalAccountKeys(firstBody);
    assert.equal(fetchCalls, 0);

    const secondRes = createResCapture();
    await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/models',
      url: new URL('http://localhost/v0/webui/models'),
      req: { headers: {} },
      res: secondRes,
      options: {},
      state,
      deps
    });
    const secondBody = JSON.parse(secondRes.body);
    assert.equal(secondBody.cached, true);
    assert.equal(fetchCalls, 0);

    state.accounts.claude = [{ id: 'c1', accountRef: WEBUI_CLAUDE_REF_1, provider: 'claude', accessToken: 'token-c1' }];

    const thirdRes = createResCapture();
    await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/models',
      url: new URL('http://localhost/v0/webui/models'),
      req: { headers: {} },
      res: thirdRes,
      options: {},
      state,
      deps
    });
    const thirdBody = JSON.parse(thirdRes.body);
    assert.equal(thirdBody.cached, true);
    assert.deepEqual(thirdBody.models, {
      codex: ['gpt-5.4'],
      gemini: ['gemini-2.5-flash', 'gemini-3.1-pro-preview']
    });
    assert.equal(fetchCalls, 0);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui models scopes cached account projection by public accountRef', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-models-scoped-'));

  try {
    const geminiRef = WEBUI_GEMINI_REF_1;
    const codexRef = WEBUI_CODEX_REF_1;
    const state = {
      accounts: {
        codex: [{ id: 'c1', accountRef: codexRef, provider: 'codex', accessToken: 'token-c1' }],
        gemini: [{ id: 'g1', accountRef: geminiRef, provider: 'gemini', accessToken: 'token-g1' }]
      },
      modelRegistry: { providers: { codex: new Set(), gemini: new Set() } },
      webUiModelsCache: {
        updatedAt: Date.now(),
        byProvider: {
          codex: ['gpt-5.4'],
          gemini: ['gemini-2.5-pro']
        },
        byAccount: {
          [codexRef]: ['gpt-5.4'],
          [geminiRef]: ['gemini-2.5-pro']
        },
        errorsByAccount: {},
        signature: '',
        source: 'remote',
        sourceCount: 2,
        scannedAccounts: 2
      }
    };

    const res = createResCapture();
    await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/models',
      url: new URL(`http://localhost/v0/webui/models?accountRef=${geminiRef}`),
      req: { headers: {} },
      res,
      options: {},
      state,
      deps: createBaseDeps(aiHomeDir)
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.accountScope, { accountRef: geminiRef });
    assert.deepEqual(Object.keys(body.byAccountRef), [geminiRef]);
    assert.deepEqual(body.byAccountRef[geminiRef], ['gemini-2.5-pro']);
    assert.equal(Object.values(body.byAccountRef).flat().includes('gpt-5.4'), false);
    assertNoInternalAccountKeys(body);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui models returns selectable and default account model projections', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-models-default-'));

  try {
    const accountRef = WEBUI_CODEX_REF_1;
    const state = {
      accounts: {
        codex: [{ id: 'c1', accountRef, provider: 'codex', accessToken: 'token-c1' }],
        gemini: [],
        claude: [],
        agy: [],
        opencode: []
      },
      webUiModelsCache: {
        updatedAt: Date.now(),
        byProvider: { codex: ['a', 'b', 'c'] },
        byAccount: { [accountRef]: ['a', 'b', 'c'] },
        errorsByAccount: {},
        signature: '',
        source: 'remote',
        sourceCount: 1,
        scannedAccounts: 1
      }
    };
    const deps = {
      ...createBaseDeps(aiHomeDir),
      loadModelCatalogSettings: async () => ({
        version: 5,
        accountModels: [
          { id: 'b', provider: 'codex', accountRef, enabled: true, defaultModel: true },
          { id: 'c', provider: 'codex', accountRef, enabled: false },
          { id: 'm', provider: 'codex', accountRef, enabled: true, manual: true }
        ]
      })
    };

    const res = createResCapture();
    await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/models',
      url: new URL(`http://localhost/v0/webui/models?accountRef=${accountRef}`),
      req: { headers: {} },
      res,
      options: {},
      state,
      deps
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.byAccountRef[accountRef], ['a', 'b', 'c']);
    assert.deepEqual(body.selectableByAccountRef[accountRef], ['a', 'b', 'm']);
    assert.deepEqual(body.defaultByAccountRef, { [accountRef]: 'b' });
    assertNoInternalAccountKeys(body);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui models returns empty cache without remote discovery', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-models-fail-'));

  try {
    const state = {
      accounts: {
        codex: [],
        gemini: [{ id: 'g1', accountRef: WEBUI_GEMINI_REF_1, provider: 'gemini', accessToken: 'token-g1' }],
        claude: []
      },
      modelRegistry: {
        providers: {
          codex: new Set(),
          gemini: new Set(),
          claude: new Set()
        }
      },
      webUiModelsCache: {
        updatedAt: 0,
        byProvider: {},
        signature: '',
        source: 'empty'
      }
    };
    let fetchCalls = 0;
    const deps = {
      ...createBaseDeps(aiHomeDir),
      fetchModelsForAccount: async () => {
        fetchCalls += 1;
        throw new Error('quota endpoint down');
      }
    };

    const res = createResCapture();
    await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/models',
      url: new URL('http://localhost/v0/webui/models'),
      req: { headers: {} },
      res,
      options: {},
      state,
      deps
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.source, 'empty');
    assert.equal(body.scannedAccounts, 0);
    assert.equal(body.firstError, '');
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'byAccount'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'errorsByAccount'), false);
    assert.deepEqual(body.byAccountRef, {});
    assert.deepEqual(body.errorsByAccountRef, {});
    assert.deepEqual(body.models, {});
    assert.equal(fetchCalls, 0);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('webui model cache keeps scanning provider accounts after the first catalog probe fails', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-models-multi-account-'));

  try {
    const state = {
      accounts: {
        codex: [{ id: 'c1', accountRef: WEBUI_CODEX_REF_1, provider: 'codex', availableModels: ['gpt-5.5'] }],
        gemini: [],
        claude: [],
        agy: [
          { id: 'a1', accountRef: WEBUI_AGY_REF_1, provider: 'agy', accessToken: 'token-a1' },
          { id: 'a2', accountRef: WEBUI_AGY_REF_2, provider: 'agy', accessToken: 'token-a2' }
        ]
      },
      modelRegistry: {
        providers: {
          codex: new Set(['gpt-5.5']),
          gemini: new Set(),
          claude: new Set(),
          agy: new Set()
        }
      },
      webUiModelsCache: {
        updatedAt: 0,
        byProvider: {},
        signature: '',
        source: 'empty'
      }
    };
    const seenAccounts = [];
    const deps = {
      ...createBaseDeps(aiHomeDir),
      fetchModelsForAccount: async (_options, account) => {
        seenAccounts.push(account.id);
        if (account.id === 'a1') throw new Error('first account catalog failed');
        return ['gemini-3.5-flash-high'];
      }
    };

    const body = await getWebUiModelsCache(state, { provider: 'agy', modelsProbeAccounts: 2 }, {
      forceRefresh: true,
      fs,
      aiHomeDir,
      fetchModelsForAccount: deps.fetchModelsForAccount
    });

    assert.equal(body.source, 'remote');
    assert.equal(body.scannedAccounts, 2);
    assert.deepEqual(seenAccounts, ['a1', 'a2']);
    assert.deepEqual(body.models.agy, ['gemini-3.5-flash-high']);
    assert.deepEqual(body.byAccount[WEBUI_AGY_REF_1], []);
    assert.deepEqual(body.byAccount[WEBUI_AGY_REF_2], ['gemini-3.5-flash-high']);
    assert.match(body.errorsByAccount[WEBUI_AGY_REF_1], /first account catalog failed/);
    assert.match(body.firstError, /first account catalog failed/);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui openai models route exposes v1 models shape with account probe metadata', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-openai-models-'));

  try {
    const state = {
      accounts: {
        codex: [{ id: 'c1', accountRef: WEBUI_CODEX_REF_1, provider: 'codex', accessToken: 'token-c1', availableModels: ['gpt-5.5'] }],
        gemini: [{ id: 'g1', accountRef: WEBUI_GEMINI_REF_1, provider: 'gemini', accessToken: 'token-g1' }],
        claude: [],
        agy: []
      },
      modelRegistry: {
        providers: {
          codex: new Set(['gpt-5.5']),
          gemini: new Set(),
          claude: new Set(),
          agy: new Set()
        }
      },
      webUiModelsCache: {
        updatedAt: Date.now(),
        byProvider: { gemini: ['gemini-2.5-flash', 'gemini-2.5-pro'] },
        byAccount: {
          [WEBUI_GEMINI_REF_1]: ['gemini-2.5-flash', 'gemini-2.5-pro']
        },
        errorsByAccount: {},
        signature: '',
        source: 'remote',
        sourceCount: 1,
        scannedAccounts: 1
      }
    };
    const deps = {
      ...createBaseDeps(aiHomeDir),
      loadAliases: async () => ({
        aliases: [
          {
            id: 'alias-1',
            alias: 'gpt-fast',
            target: 'gpt-5.5',
            provider: 'all',
            targetProvider: 'codex',
            enabled: true
          }
        ]
      })
    };

    const res = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/openai-models',
      url: new URL('http://localhost/v0/webui/openai-models'),
      req: { headers: {} },
      res,
      options: {},
      state,
      deps
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.endpoint, '/v1/models');
    assert.deepEqual(body.data.map((item) => item.id), ['gemini-2.5-flash', 'gemini-2.5-pro', 'gpt-5.5', 'gpt-fast']);
    assert.deepEqual(body.data.map((item) => item.object), ['model', 'model', 'model', 'model']);
    assert.deepEqual(body.byProvider.codex, ['gpt-5.5', 'gpt-fast']);
    assert.deepEqual(body.byProvider.gemini, ['gemini-2.5-flash', 'gemini-2.5-pro']);
    const geminiAccount = body.accounts.find((account) => account.accountRef === WEBUI_GEMINI_REF_1);
    assertPublicAccountRef(geminiAccount.accountRef);
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'byAccount'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'errorsByAccount'), false);
    assert.deepEqual(body.byAccountRef[geminiAccount.accountRef], ['gemini-2.5-flash', 'gemini-2.5-pro']);
    assert.deepEqual(body.errorsByAccountRef, {});
    assertNoInternalAccountKeys(body);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui openai models route exposes inherited models.dev metadata', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-openai-models-metadata-'));
  const modelsDevDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-models-dev-route-'));

  try {
    writeModelsDevFixture(modelsDevDir, 'models/openai/gpt-5.toml', `
name = "GPT-5"
family = "gpt"
attachment = true
reasoning = true
temperature = false
tool_call = true
structured_output = true

[limit]
context = 400_000
output = 128_000

[modalities]
input = ["text", "image"]
output = ["text"]
`);
    writeModelsDevFixture(modelsDevDir, 'providers/openai/models/gpt-5.toml', `
base_model = "openai/gpt-5"

[cost]
input = 1.25
output = 10
cache_read = 0.125
`);

    const state = {
      accounts: {
        codex: [{ id: 'c1', accountRef: WEBUI_CODEX_REF_1, provider: 'codex', accessToken: 'token-c1', apiKeyMode: true, availableModels: ['gpt-5'] }],
        gemini: [],
        claude: [],
        agy: []
      },
      modelRegistry: {
        providers: {
          codex: new Set(),
          gemini: new Set(),
          claude: new Set(),
          agy: new Set()
        }
      },
      webUiModelsCache: {
        updatedAt: Date.now(),
        byProvider: { codex: ['gpt-5'] },
        byAccount: { [WEBUI_CODEX_REF_1]: ['gpt-5'] },
        errorsByAccount: {},
        signature: '',
        source: 'remote',
        sourceCount: 1,
        scannedAccounts: 1
      }
    };
    const deps = {
      ...createBaseDeps(aiHomeDir),
      modelsDevDir
    };

    const res = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/openai-models',
      url: new URL('http://localhost/v0/webui/openai-models'),
      req: { headers: {} },
      res,
      options: {},
      state,
      deps
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.metadata['gpt-5'].name, 'GPT-5');
    assert.equal(body.metadata['gpt-5'].providerId, 'openai');
    assert.equal(body.metadata['gpt-5'].limits.context, 400000);
    assert.equal(body.metadata['gpt-5'].cost.cacheRead, 0.125);
    assert.equal(body.managedData.find((item) => item.id === 'gpt-5').metadata.family, 'gpt');
    assertNoInternalAccountKeys(body);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(modelsDevDir, { recursive: true, force: true });
  }
});

test('web ui openai models scoped account does not fall back to global catalog', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-openai-models-scoped-empty-'));

  try {
    const accountRef = WEBUI_CODEX_REF_3;
    const account = {
      id: '3',
      accountRef,
      provider: 'codex',
      accessToken: 'token-c3',
      authType: 'oauth',
      email: 'codex@example.test'
    };
    const state = {
      accounts: {
        codex: [account],
        gemini: [],
        claude: [],
        agy: []
      },
      modelRegistry: {
        providers: {
          codex: new Set(['gpt-5.8-codex-oauth']),
          gemini: new Set(),
          claude: new Set(),
          agy: new Set()
        }
      },
      webUiModelsCache: {
        updatedAt: Date.now(),
        byProvider: { codex: ['gpt-global-should-not-leak'] },
        byAccount: {
          legacy_untrusted_cache_key: ['gpt-other-should-not-leak']
        },
        errorsByAccount: {},
        signature: '',
        source: 'remote',
        sourceCount: 1,
        scannedAccounts: 1
      }
    };

    const res = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/openai-models',
      url: new URL(`http://localhost/v0/webui/openai-models?accountRef=${accountRef}`),
      req: { headers: {} },
      res,
      options: {},
      state,
      deps: createBaseDeps(aiHomeDir)
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.accountScope, { accountRef });
    assert.deepEqual(body.data, []);
    assert.deepEqual(body.managedData, []);
    assert.deepEqual(body.byProvider.codex, []);
    assert.deepEqual(body.byAccountRef, {});
    assertNoInternalAccountKeys(body);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui openai models manages model visibility per account', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-openai-models-settings-'));

  try {
    const state = {
      accounts: {
        codex: [
          { id: '1', accountRef: WEBUI_CODEX_REF_1, provider: 'codex', accessToken: 'token-c1', apiKeyMode: true },
          { id: '2', accountRef: WEBUI_CODEX_REF_2, provider: 'codex', accessToken: 'token-c2', apiKeyMode: true },
          { id: '3', accountRef: WEBUI_CODEX_REF_3, provider: 'codex', accessToken: 'token-c3', apiKeyMode: true }
        ],
        gemini: [],
        claude: [],
        agy: []
      },
      modelRegistry: {
        providers: {
          codex: new Set(['gpt-5.8-codex-oauth']),
          gemini: new Set(),
          claude: new Set(),
          agy: new Set()
        }
      },
      webUiModelsCache: {
        updatedAt: Date.now(),
        byProvider: { codex: ['a', 'b', 'c', 'd', 'e', 'f'] },
        byAccount: {
          [WEBUI_CODEX_REF_1]: ['a', 'b', 'c', 'd'],
          [WEBUI_CODEX_REF_2]: ['a', 'c', 'e', 'f'],
          [WEBUI_CODEX_REF_3]: []
        },
        errorsByAccount: {},
        signature: '',
        source: 'remote',
        sourceCount: 2,
        scannedAccounts: 3
      }
    };
    const deps = {
      ...createBaseDeps(aiHomeDir)
    };
    const postSettings = async (method, payload) => {
      const res = createResCapture();
      await handleWebUIRequest({
        method,
        pathname: '/v0/webui/openai-models',
        url: new URL('http://localhost/v0/webui/openai-models'),
        req: { headers: {} },
        res,
        options: {},
        state,
        deps: {
          ...deps,
          readRequestBody: async () => Buffer.from(JSON.stringify(payload))
        }
      });
      assert.equal(res.statusCode, 200);
      return JSON.parse(res.body);
    };

    await postSettings('PATCH', { id: 'c', provider: 'codex', accountRef: WEBUI_CODEX_REF_1, enabled: false });
    await postSettings('PATCH', { id: 'd', provider: 'codex', accountRef: WEBUI_CODEX_REF_1, enabled: false });
    await postSettings('PATCH', { id: 'b', provider: 'codex', accountRef: WEBUI_CODEX_REF_1, defaultModel: true });
    await postSettings('PATCH', { id: 'c', provider: 'codex', accountRef: WEBUI_CODEX_REF_2, enabled: false });
    await postSettings('PATCH', { id: 'f', provider: 'codex', accountRef: WEBUI_CODEX_REF_2, enabled: false });
    await postSettings('POST', {
      id: 'g',
      provider: 'codex',
      accountRef: WEBUI_CODEX_REF_3,
      description: 'manual account model'
    });

    const res = createResCapture();
    await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/openai-models',
      url: new URL('http://localhost/v0/webui/openai-models'),
      req: { headers: {} },
      res,
      options: {},
      state,
      deps
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.data.map((item) => item.id), ['a', 'b', 'e', 'g']);
    assert.deepEqual(body.byProvider.codex, ['a', 'b', 'e', 'g']);
    const accountsByRef = new Map(body.accounts.map((account) => [account.accountRef, account]));
    assert.deepEqual(body.byAccountRef[accountsByRef.get(WEBUI_CODEX_REF_1).accountRef], ['a', 'b', 'c', 'd']);
    assert.deepEqual(body.byAccountRef[accountsByRef.get(WEBUI_CODEX_REF_2).accountRef], ['a', 'c', 'e', 'f']);
    assert.deepEqual(body.byAccountRef[accountsByRef.get(WEBUI_CODEX_REF_3).accountRef], []);
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'byAccount'), false);
    const managedByRef = new Map(body.managedData.map((item) => [`${item.accountRef}:${item.id}`, item]));
    assert.equal(managedByRef.get(`${WEBUI_CODEX_REF_1}:c`).enabled, false);
    assert.equal(managedByRef.get(`${WEBUI_CODEX_REF_1}:d`).enabled, false);
    assert.equal(managedByRef.get(`${WEBUI_CODEX_REF_2}:c`).enabled, false);
    assert.equal(managedByRef.get(`${WEBUI_CODEX_REF_2}:f`).enabled, false);
    assert.equal(managedByRef.get(`${WEBUI_CODEX_REF_1}:b`).enabled, true);
    assert.equal(managedByRef.get(`${WEBUI_CODEX_REF_1}:b`).defaultModel, true);
    assert.equal(managedByRef.get(`${WEBUI_CODEX_REF_1}:a`).defaultModel, false);
    assert.equal(managedByRef.get(`${WEBUI_CODEX_REF_2}:e`).enabled, true);
    assert.equal(managedByRef.get(`${WEBUI_CODEX_REF_3}:g`).manual, true);
    assert.equal(managedByRef.get(`${WEBUI_CODEX_REF_3}:g`).enabled, true);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui openai models rejects manual models for oauth accounts', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-openai-models-oauth-manual-'));

  try {
    const state = {
      accounts: {
        codex: [
          { id: 'oauth', accountRef: WEBUI_CODEX_REF_1, provider: 'codex', accessToken: 'token-oauth', apiKeyMode: false, authType: 'oauth' },
          { id: 'api', accountRef: WEBUI_CODEX_REF_2, provider: 'codex', accessToken: 'token-api', apiKeyMode: true, authType: 'api-key' }
        ],
        gemini: [],
        claude: [
          { id: 'auth-token', accountRef: WEBUI_CLAUDE_REF_1, provider: 'claude', accessToken: 'token-claude', apiKeyMode: false, authType: 'auth-token' }
        ],
        agy: []
      },
      modelRegistry: {
        providers: {
          codex: new Set(),
          gemini: new Set(),
          claude: new Set(),
          agy: new Set()
        }
      },
      webUiModelsCache: {
        updatedAt: 0,
        byProvider: {},
        byAccount: {},
        errorsByAccount: {},
        signature: '',
        source: 'empty'
      }
    };
    const deps = createBaseDeps(aiHomeDir);
    const postManualModel = async (payload) => {
      const res = createResCapture();
      await handleWebUIRequest({
        method: 'POST',
        pathname: '/v0/webui/openai-models',
        url: new URL('http://localhost/v0/webui/openai-models'),
        req: { headers: {} },
        res,
        options: {},
        state,
        deps: {
          ...deps,
          readRequestBody: async () => Buffer.from(JSON.stringify(payload))
        }
      });
      return {
        statusCode: res.statusCode,
        body: JSON.parse(res.body)
      };
    };

    const oauthResult = await postManualModel({
      id: 'custom-oauth-model',
      provider: 'codex',
      accountRef: WEBUI_CODEX_REF_1
    });
    assert.equal(oauthResult.statusCode, 403);
    assert.equal(oauthResult.body.error, 'manual_model_requires_api_key_account');

    const apiKeyResult = await postManualModel({
      id: 'custom-api-model',
      provider: 'codex',
      accountRef: WEBUI_CODEX_REF_2
    });
    assert.equal(apiKeyResult.statusCode, 200);
    assert.equal(apiKeyResult.body.model.accountRef, WEBUI_CODEX_REF_2);

    const authTokenResult = await postManualModel({
      id: 'custom-auth-token-model',
      provider: 'claude',
      accountRef: WEBUI_CLAUDE_REF_1
    });
    assert.equal(authTokenResult.statusCode, 200);
    assert.equal(authTokenResult.body.model.accountRef, WEBUI_CLAUDE_REF_1);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui openai models refresh starts async job and streams catalog result', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-openai-models-live-'));

  try {
    let releaseProbe;
    const state = {
      accounts: {
        codex: [],
        gemini: [{ id: 'g1', accountRef: WEBUI_GEMINI_REF_1, provider: 'gemini', accessToken: 'token-g1' }],
        claude: [],
        agy: []
      },
      modelRegistry: {
        providers: {
          codex: new Set(),
          gemini: new Set(),
          claude: new Set(),
          agy: new Set()
        }
      },
      webUiModelsCache: {
        updatedAt: 0,
        byProvider: {},
        byAccount: {},
        errorsByAccount: {},
        signature: '',
        source: 'empty'
      }
    };
    const req = new EventEmitter();
    req.headers = {};
    const streamRes = createStreamResCapture();
    const deps = {
      ...createBaseDeps(aiHomeDir),
      fetchModelsForAccount: async () => new Promise((resolve) => {
        releaseProbe = () => resolve(['gpt-5.7-live']);
      })
    };

    const watchHandled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/openai-models/watch',
      url: new URL('http://localhost/v0/webui/openai-models/watch'),
      req,
      res: streamRes,
      options: {},
      state,
      deps
    });

    assert.equal(watchHandled, true);
    assert.equal(streamRes.statusCode, 200);
    assert.match(streamRes.body, /model-catalog-snapshot/);

    const listRes = createResCapture();
    await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/openai-models',
      url: new URL('http://localhost/v0/webui/openai-models'),
      req: { headers: {} },
      res: listRes,
      options: {},
      state,
      deps
    });
    const accountRef = JSON.parse(listRes.body).accounts[0].accountRef;
    assertPublicAccountRef(accountRef);

    const postRes = createResCapture();
    const refreshHandled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/openai-models/refresh',
      url: new URL(`http://localhost/v0/webui/openai-models/refresh?accountRef=${accountRef}`),
      req: { headers: {} },
      res: postRes,
      options: {},
      state,
      deps
    });

    assert.equal(refreshHandled, true);
    assert.equal(postRes.statusCode, 202);
    const postBody = JSON.parse(postRes.body);
    assert.equal(postBody.ok, true);
    assert.equal(postBody.accepted, true);
    assert.equal(postBody.job.status, 'queued');
    assert.deepEqual(postBody.job.accountScope, { accountRef });
    assert.equal(Object.prototype.hasOwnProperty.call(postBody.job, 'accountLimit'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(postBody.job, 'catalog'), true);
    assertNoInternalAccountKeys(postBody);

    await new Promise((resolve) => setImmediate(resolve));
    assert.match(streamRes.body, /"status":"running"/);
    releaseProbe();
    for (let attempt = 0; attempt < 8 && !/"status":"succeeded"/.test(streamRes.body); attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.match(streamRes.body, /"type":"model-catalog-job"/);
    assert.match(streamRes.body, /"status":"succeeded"/);
    assert.match(streamRes.body, /gpt-5.7-live/);
    assert.match(streamRes.body, new RegExp(`"accountRef":"${accountRef}"`));
    assert.match(streamRes.body, /"byAccountRef"/);
    assert.doesNotMatch(streamRes.body, /accountUniqueKey/);
    req.emit('close');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui openai models refresh reloads runtime accounts for scoped accountRef', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-openai-models-reload-'));

  try {
    const accountRef = WEBUI_CODEX_REF_3;
    const runtimeAccount = {
      id: '3',
      accountRef,
      provider: 'codex',
      accessToken: 'token-c3',
      authType: 'oauth',
      email: 'codex@example.test'
    };
    const state = {
      accounts: {
        codex: [],
        gemini: [],
        claude: [],
        agy: []
      },
      modelRegistry: {
        providers: {
          codex: new Set(),
          gemini: new Set(),
          claude: new Set(),
          agy: new Set()
        }
      },
      webUiModelsCache: {
        updatedAt: 0,
        byProvider: {},
        byAccount: {},
        errorsByAccount: {},
        signature: '',
        source: 'empty'
      }
    };
    let reloadCount = 0;
    const probedAccounts = [];
    const req = new EventEmitter();
    req.headers = {};
    const streamRes = createStreamResCapture();
    const deps = {
      ...createBaseDeps(aiHomeDir),
      loadServerRuntimeAccounts() {
        reloadCount += 1;
        return { codex: [runtimeAccount], gemini: [], claude: [], agy: [] };
      },
      applyReloadState(targetState, runtimeAccounts) {
        targetState.accounts = runtimeAccounts;
      },
      fetchModelsForAccount: async (_options, account) => {
        probedAccounts.push(account);
        return ['gpt-5.6-codex'];
      }
    };

    await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/openai-models/watch',
      url: new URL('http://localhost/v0/webui/openai-models/watch'),
      req,
      res: streamRes,
      options: {},
      state,
      deps
    });

    const postRes = createResCapture();
    const refreshHandled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/openai-models/refresh',
      url: new URL(`http://localhost/v0/webui/openai-models/refresh?accountRef=${accountRef}`),
      req: { headers: {} },
      res: postRes,
      options: {},
      state,
      deps
    });

    assert.equal(refreshHandled, true);
    assert.equal(postRes.statusCode, 202);
    assert.equal(reloadCount, 1);
    const postBody = JSON.parse(postRes.body);
    assert.deepEqual(postBody.job.accountScope, { accountRef });
    assertNoInternalAccountKeys(postBody);

    for (let attempt = 0; attempt < 8 && !/"status":"succeeded"/.test(streamRes.body); attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.equal(probedAccounts.length, 1);
    assert.equal(probedAccounts[0].id, '3');
    assert.match(streamRes.body, /"status":"succeeded"/);
    assert.match(streamRes.body, new RegExp(`"accountRef":"${accountRef}"`));
    const job = Array.from(state.modelCatalogLive.jobs.values())[0];
    assert.deepEqual(Object.keys(job.catalog.byAccountRef), [accountRef]);
    assert.deepEqual(job.catalog.byAccountRef[accountRef], ['gpt-5.6-codex']);
    assert.deepEqual(job.catalog.data.map((item) => item.id), ['gpt-5.6-codex']);
    assert.equal(job.catalog.scannedAccounts, 1);
    assert.equal(job.catalog.firstError, '');
    assertNoInternalAccountKeys(job.catalog);
    req.emit('close');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui openai models keeps aggregator models and final owner groups', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-openai-owner-models-'));

  try {
    const state = {
      accounts: {
        codex: [],
        gemini: [],
        claude: [],
        agy: [{ id: 'a1', accountRef: WEBUI_AGY_REF_1, provider: 'agy', accessToken: 'token-a1' }]
      },
      modelRegistry: {
        providers: {
          codex: new Set(),
          gemini: new Set(),
          claude: new Set(),
          agy: new Set()
        }
      },
      webUiModelsCache: {
        updatedAt: Date.now(),
        byProvider: {
          agy: ['claude-sonnet-4-6', 'gemini-3-flash-agent', 'gpt-5.4']
        },
        byAccount: {
          [WEBUI_AGY_REF_1]: ['claude-sonnet-4-6', 'gemini-3-flash-agent', 'gpt-5.4']
        },
        errorsByAccount: {},
        signature: '',
        source: 'remote',
        sourceCount: 1,
        scannedAccounts: 1
      }
    };
    const deps = {
      ...createBaseDeps(aiHomeDir)
    };

    const res = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/openai-models',
      url: new URL('http://localhost/v0/webui/openai-models'),
      req: { headers: {} },
      res,
      options: {},
      state,
      deps
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    // WebUI 同时保留最终 /v1/models 归属和聚合 provider 真实可服务模型。
    assert.deepEqual(body.byProvider.codex, ['gpt-5.4']);
    assert.deepEqual(body.byProvider.gemini, ['gemini-3-flash-agent']);
    assert.deepEqual(body.byProvider.claude, ['claude-sonnet-4-6']);
    assert.deepEqual(body.byProvider.agy, ['claude-sonnet-4-6', 'gemini-3-flash-agent', 'gpt-5.4']);
    const accountRef = body.accounts.find((account) => account.accountRef === WEBUI_AGY_REF_1).accountRef;
    assertPublicAccountRef(accountRef);
    assert.deepEqual(body.byAccountRef[accountRef], ['claude-sonnet-4-6', 'gemini-3-flash-agent', 'gpt-5.4']);
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'byAccount'), false);
    assertNoInternalAccountKeys(body);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui project browse endpoint lists directory structures', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-projects-browse-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const tempProjectDir = path.join(aiHomeDir, 'target-project');
  fs.mkdirSync(path.join(tempProjectDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(tempProjectDir, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(tempProjectDir, '.ssh'), { recursive: true }); // 用于测试安全拦截
  fs.writeFileSync(path.join(tempProjectDir, 'README.md'), 'hello');   // 常规文件不应列出

  let requestBody = null;

  const baseDeps = {
    fs,
    aiHomeDir,
    hostHomeDir: aiHomeDir,
    readAllProjectsFromHost: () => [],
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    },
    readRequestBody: async () => {
      if (!requestBody) return Buffer.alloc(0);
      return Buffer.from(JSON.stringify(requestBody), 'utf8');
    },
    accountStateIndex: {
      getAccountState() { return null; },
      upsertAccountState() {},
      removeAccount() {}
    },
    getToolConfigDir() { return '/tmp/config'; },
    getProfileDir() { return '/tmp/profile'; },
    loadServerRuntimeAccounts() { return { codex: [], gemini: [], claude: [] }; },
    applyReloadState() {},
    checkStatus() { return { configured: false, accountName: 'Unknown' }; },
    ensureSessionStoreLinks() {}
  };

  // 1. 测试空 subDir 定位 (应默认定位到 HOME 目录或 process.cwd())
  {
    const res = createResCapture();
    requestBody = { subDir: '' };
    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/projects/browse',
      url: new URL('http://localhost/v0/webui/projects/browse'),
      req: {},
      res,
      options: {},
      state: {},
      deps: baseDeps
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
    assert.ok(data.currentDir);
    assert.ok(data.parentDir);
    assert.ok(Array.isArray(data.directories));
  }

  // 2. 测试指定路径浏览 (应只列出文件夹，排他 README.md 文件)
  {
    const res = createResCapture();
    requestBody = { subDir: tempProjectDir };
    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/projects/browse',
      url: new URL('http://localhost/v0/webui/projects/browse'),
      req: {},
      res,
      options: {},
      state: {},
      deps: baseDeps
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
    assert.equal(data.currentDir, tempProjectDir);
    assert.equal(data.parentDir, aiHomeDir);
    // 应只返回 .ssh、src 和 tests，README.md 被自动过滤
    assert.equal(data.directories.length, 3);
    assert.ok(data.directories.some(d => d.name === 'src'));
    assert.ok(data.directories.some(d => d.name === 'tests'));
    assert.ok(data.directories.some(d => d.name === '.ssh'));
  }

  // 3. 测试安全拦截 (浏览包含 .ssh 的绝对路径目录时应直接 403 阻断)
  {
    const res = createResCapture();
    requestBody = { subDir: path.join(tempProjectDir, '.ssh') };
    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/projects/browse',
      url: new URL('http://localhost/v0/webui/projects/browse'),
      req: {},
      res,
      options: {},
      state: {},
      deps: baseDeps
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 403);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, false);
    assert.equal(data.error, 'permission_denied');
  }
});
