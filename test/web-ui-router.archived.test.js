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

test('web ui archived sessions list persists archive write-through across fresh state', async () => {
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
