const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const { handleWebUIRequest } = require('../lib/server/web-ui-router');

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
  return {
    fs,
    aiHomeDir,
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

test('web ui open project stores manual project and returns it in projects list', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-projects-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opened-project-'));

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
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
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

test('web ui projects are sorted by last session update time and sessions are sorted descending', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-projects-sorted-'));

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
        path: '/tmp/old-project',
        provider: 'codex',
        sessions: [
          { id: 's-1', title: 'older', updatedAt: 100, provider: 'codex' },
          { id: 's-2', title: 'newer', updatedAt: 300, provider: 'codex' }
        ]
      },
      {
        id: 'p-new',
        name: 'new-project',
        path: '/tmp/new-project',
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
      assert.equal(body.projects[0].path, '/tmp/new-project');
      assert.equal(body.projects[1].path, '/tmp/old-project');
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
  }
});

test('web ui models uses cache until provider/account signature changes', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-models-'));

  try {
    const state = {
      accounts: {
        codex: [],
        gemini: [{ id: 'g1', provider: 'gemini', accessToken: 'token-g1' }],
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
        updatedAt: 0,
        byProvider: {},
        signature: '',
        source: 'empty'
      }
    };
    let fetchCalls = 0;
    const deps = {
      ...createBaseDeps(aiHomeDir),
      fetchModelsForAccount: async (_options, account) => {
        fetchCalls += 1;
        return account.id === 'g1'
          ? ['gemini-2.5-pro']
          : ['claude-sonnet-4'];
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
    assert.equal(firstBody.cached, false);
    assert.deepEqual(firstBody.models, {
      codex: ['gpt-5.4'],
      gemini: ['gemini-2.5-pro'],
      claude: []
    });
    assert.equal(fetchCalls, 1);

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
    assert.equal(fetchCalls, 1);

    state.accounts.claude = [{ id: 'c1', provider: 'claude', accessToken: 'token-c1' }];

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
    assert.equal(thirdBody.cached, false);
    assert.deepEqual(thirdBody.models, {
      codex: ['gpt-5.4'],
      gemini: ['gemini-2.5-pro'],
      claude: ['claude-sonnet-4']
    });
    assert.equal(fetchCalls, 3);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});
