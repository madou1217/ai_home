const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const fs = require('fs-extra');

const { handleWebUIRequest } = require('../lib/server/web-ui-router');
const { handleAccountsWatchUpgrade } = require('../lib/server/webui-account-live');
const { upsertAccountRef } = require('../lib/server/account-ref-store');

function createResCapture() {
  return {
    statusCode: 0,
    body: '',
    headers: {},
    writeHead(code, headers = {}) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(chunk = '') {
      this.body = String(chunk);
    }
  };
}

function createStreamResCapture() {
  return {
    statusCode: 0,
    body: '',
    headers: {},
    writeHead(code, headers = {}) {
      this.statusCode = code;
      this.headers = headers;
    },
    write(chunk = '') {
      this.body += String(chunk || '');
    },
    end(chunk = '') {
      this.body += String(chunk || '');
    }
  };
}

function parseSseJsonEvents(body) {
  return String(body || '')
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .flatMap((block) => {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n');
      if (!data) return [];
      try {
        return [JSON.parse(data)];
      } catch (_error) {
        return [];
      }
    });
}

function waitForServerListen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function waitForWebSocketEvent(events, predicate, label) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const match = events.find(predicate);
      if (match) {
        clearInterval(timer);
        resolve(match);
        return;
      }
      if (Date.now() - startedAt > 2000) {
        clearInterval(timer);
        reject(new Error(`websocket event not received: ${label}`));
      }
    }, 5);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function createDeps(aiHomeDir) {
  const profilesRoot = path.join(aiHomeDir, 'profiles');
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
    getToolAccountIds(provider) {
      const providerRoot = path.join(profilesRoot, provider);
      if (!fs.existsSync(providerRoot)) return [];
      return fs.readdirSync(providerRoot).filter((item) => /^\d+$/.test(item));
    },
    getToolConfigDir(provider, id) {
      if (provider === 'codex') return path.join(profilesRoot, provider, String(id), '.codex');
      if (provider === 'claude') return path.join(profilesRoot, provider, String(id), '.claude');
      if (provider === 'agy') return path.join(profilesRoot, provider, String(id), '.gemini', 'antigravity-cli');
      return path.join(profilesRoot, provider, String(id), '.gemini');
    },
    getProfileDir(provider, id) {
      return path.join(profilesRoot, provider, String(id));
    },
    loadServerRuntimeAccounts() {
      return { codex: [], gemini: [], claude: [], agy: [] };
    },
    applyReloadState() {},
    checkStatus() {
      return { configured: true, accountName: 'Imported User' };
    },
    ensureSessionStoreLinks() {}
  };
}

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

function stringifyJson(value) {
  return JSON.stringify(value);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  (entries || []).forEach((entry) => {
    const name = Buffer.from(String(entry.name || '').replace(/\\/g, '/'), 'utf8');
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content || ''), 'utf8');
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + content.length;
  });

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function makeSub2ApiCodexOauthBundle({ email, refreshToken, accountId }) {
  return {
    type: 'sub2api-data',
    version: 1,
    exported_at: '2026-06-09T00:00:00Z',
    proxies: [],
    accounts: [{
      name: email,
      platform: 'openai',
      type: 'oauth',
      credentials: {
        email,
        refresh_token: refreshToken,
        chatgpt_account_id: accountId
      }
    }]
  };
}

async function readCompletedImportBody(importRes, deps) {
  assert.equal(importRes.statusCode, 202);
  const accepted = JSON.parse(importRes.body);
  assert.equal(accepted.ok, true);
  assert.ok(accepted.jobId);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const jobRes = createResCapture();
    await handleWebUIRequest({
      method: 'GET',
      pathname: `/v0/webui/accounts/import/jobs/${accepted.jobId}`,
      url: new URL(`http://localhost/v0/webui/accounts/import/jobs/${accepted.jobId}`),
      req: { headers: {} },
      res: jobRes,
      options: {},
      state: {},
      deps
    });
    assert.equal(jobRes.statusCode, 200);
    const jobBody = JSON.parse(jobRes.body);
    const job = jobBody.job || {};
    if (job.status === 'succeeded') {
      return {
        ok: true,
        imported: Number(job.summary && job.summary.imported || 0),
        summary: job.summary,
        result: job.result,
        job
      };
    }
    if (job.status === 'failed') {
      throw new Error(job.error || 'import job failed');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('import job did not finish');
}

async function waitForImportJobSseStatus(res, jobId, status) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const event = parseSseJsonEvents(res.body)
      .find((item) => (
        item.type === 'import-job'
        && item.job
        && item.job.id === jobId
        && item.job.status === status
      ));
    if (event) return event.job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`import job SSE status not received: ${status}`);
}

test('web ui account routes do not start project cache watchers', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-no-project-watch-'));
  const watchedPaths = [];
  const fsWithWatch = Object.create(fs);
  fsWithWatch.watch = (targetPath) => {
    watchedPaths.push(String(targetPath));
    return {
      close() {},
      unref() {},
      on() {}
    };
  };

  try {
    const deps = {
      ...createDeps(aiHomeDir),
      fs: fsWithWatch
    };
    const res = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/accounts/export',
      url: new URL('http://localhost/v0/webui/accounts/export'),
      req: { headers: {} },
      res,
      options: {},
      state: {},
      deps
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(watchedPaths, []);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import streams job state through accounts watch', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-import-sse-'));
  try {
    const deps = createDeps(aiHomeDir);
    const state = {};
    const watchReq = new EventEmitter();
    watchReq.headers = {};
    const watchRes = createStreamResCapture();
    const watchHandled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/accounts/watch',
      url: new URL('http://localhost/v0/webui/accounts/watch'),
      req: watchReq,
      res: watchRes,
      options: {},
      state,
      deps
    });
    assert.equal(watchHandled, true);
    assert.equal(watchRes.statusCode, 200);
    assert.equal(watchRes.headers['Content-Type'], 'text/event-stream');

    const importRes = createResCapture();
    const accessToken = makeJwt({
      'https://api.openai.com/profile': {
        email: 'import-sse@example.com'
      }
    });
    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state,
      deps: {
        ...deps,
        readRequestBody: async () => Buffer.from(JSON.stringify({
          content: JSON.stringify({
            access_token: accessToken,
            refresh_token: 'rt_import_sse',
            chatgpt_account_id: 'acc_import_sse'
          })
        }), 'utf8')
      }
    });

    assert.equal(importRes.statusCode, 202);
    const accepted = JSON.parse(importRes.body);
    const finishedJob = await waitForImportJobSseStatus(watchRes, accepted.jobId, 'succeeded');
    assert.equal(finishedJob.summary.imported, 1);
    assert.equal(finishedJob.summary.failed, 0);
    assert.equal(finishedJob.summary.invalid, 0);
    watchReq.emit('close');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import streams job state through accounts websocket watch', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-import-ws-'));
  const deps = createDeps(aiHomeDir);
  const state = {};
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/v0/webui/accounts/watch') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    handleAccountsWatchUpgrade({
      req,
      socket,
      head,
      options: {},
      state,
      ...deps,
      deps
    });
  });

  let client = null;
  try {
    const port = await waitForServerListen(server);
    const events = [];
    client = new WebSocket(`ws://127.0.0.1:${port}/v0/webui/accounts/watch`);
    client.on('message', (data) => {
      events.push(JSON.parse(String(data || '{}')));
    });
    await waitForWebSocketEvent(events, (event) => event.type === 'snapshot', 'snapshot');

    const importRes = createResCapture();
    const accessToken = makeJwt({
      'https://api.openai.com/profile': {
        email: 'import-ws@example.com'
      }
    });
    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state,
      deps: {
        ...deps,
        readRequestBody: async () => Buffer.from(JSON.stringify({
          content: JSON.stringify({
            access_token: accessToken,
            refresh_token: 'rt_import_ws',
            chatgpt_account_id: 'acc_import_ws'
          })
        }), 'utf8')
      }
    });

    assert.equal(importRes.statusCode, 202);
    const accepted = JSON.parse(importRes.body);
    const finished = await waitForWebSocketEvent(
      events,
      (event) => (
        event.type === 'import-job'
        && event.job
        && event.job.id === accepted.jobId
        && event.job.status === 'succeeded'
      ),
      'import-job:succeeded'
    );
    assert.equal(finished.job.summary.imported, 1);
    assert.equal(finished.job.summary.failed, 0);
    assert.equal(finished.job.summary.invalid, 0);
  } finally {
    if (client) client.close();
    await closeServer(server);
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import accepts flat codex oauth json and export returns metadata', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-'));
  try {
    const deps = createDeps(aiHomeDir);
    const importRes = createResCapture();
    const accessToken = makeJwt({
      client_id: 'app_test',
      exp: 1776600282,
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'team',
        chatgpt_account_id: 'acc_123',
        chatgpt_user_id: 'user_chatgpt_123',
        user_id: 'user_123',
        organizations: [{ id: 'org_123', is_default: true }]
      },
      'https://api.openai.com/profile': {
        email: 'imported@example.com'
      }
    });

    const payload = {
      content: JSON.stringify({
        access_token: accessToken,
        refresh_token: 'rt_test',
        id_token: '',
        chatgpt_account_id: 'acc_123',
        plan_type: 'team'
      })
    };

    const importHandled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...deps,
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    assert.equal(importHandled, true);
    const importBody = await readCompletedImportBody(importRes, deps);
    assert.equal(importBody.imported, 1);

    const exportRes = createResCapture();
    const exportHandled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/accounts/export',
      url: new URL('http://localhost/v0/webui/accounts/export'),
      req: { headers: {} },
      res: exportRes,
      options: {},
      state: {},
      deps
    });

    assert.equal(exportHandled, true);
    assert.equal(exportRes.statusCode, 200);
    assert.equal(exportRes.headers['Content-Disposition'], 'attachment; filename="sub2api-data.json"');
    const exportBody = JSON.parse(exportRes.body);
    assert.equal(exportBody.type, 'sub2api-data');
    assert.equal(exportBody.accounts.length, 1);
    assert.equal(exportBody.accounts[0].platform, 'openai');
    assert.equal(exportBody.accounts[0].type, 'oauth');
    assert.equal(exportBody.accounts[0].credentials.email, 'imported@example.com');
    assert.equal(exportBody.accounts[0].credentials.refresh_token, 'rt_test');
    assert.equal(exportBody.accounts[0].credentials.chatgpt_account_id, 'acc_123');
    assert.equal(stringifyJson(exportBody).includes('profileDir'), false);
    assert.equal(stringifyJson(exportBody).includes('configDir'), false);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import accepts its own exported bundle content', async () => {
  const sourceAiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-source-'));
  const targetAiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-target-'));
  try {
    const sourceDeps = createDeps(sourceAiHomeDir);
    const sourceConfigDir = sourceDeps.getToolConfigDir('codex', '7');
    const sourceProfileDir = sourceDeps.getProfileDir('codex', '7');
    fs.ensureDirSync(sourceConfigDir);
    fs.ensureDirSync(sourceProfileDir);
    const accessToken = makeJwt({
      client_id: 'app_bundle',
      exp: 1776600282,
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'team',
        chatgpt_account_id: 'acc_bundle'
      },
      'https://api.openai.com/profile': {
        email: 'bundle@example.com'
      }
    });
    fs.writeFileSync(path.join(sourceConfigDir, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        access_token: accessToken,
        refresh_token: 'rt_bundle',
        id_token: '',
        account_id: 'acc_bundle'
      },
      last_refresh: '2026-05-22T00:00:00.000Z'
    }, null, 2));

    const exportRes = createResCapture();
    await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/accounts/export',
      url: new URL('http://localhost/v0/webui/accounts/export?format=aih'),
      req: { headers: {} },
      res: exportRes,
      options: {},
      state: {},
      deps: sourceDeps
    });
    assert.equal(exportRes.statusCode, 200);
    assert.equal(exportRes.headers['Content-Disposition'], 'attachment; filename="sub2api-data.json"');
    const exportedPayload = JSON.parse(exportRes.body);
    assert.equal(exportedPayload.type, 'sub2api-data');
    assert.equal(exportedPayload.kind, undefined);
    assert.equal(exportedPayload.accounts.length, 1);
    assert.equal(exportedPayload.accounts[0].accountId, undefined);
    assert.equal(exportedPayload.accounts[0].credentials.chatgpt_account_id, 'acc_bundle');

    const targetDeps = createDeps(targetAiHomeDir);
    const importRes = createResCapture();
    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...targetDeps,
        readRequestBody: async () => Buffer.from(JSON.stringify({
          content: exportRes.body
        }), 'utf8')
      }
    });

    const importBody = await readCompletedImportBody(importRes, targetDeps);
    assert.equal(importBody.imported, 1);
    assert.equal(importBody.summary.created, 1);
    assert.deepEqual(targetDeps.getToolAccountIds('codex'), ['1']);
    const importedAuth = JSON.parse(fs.readFileSync(path.join(targetDeps.getToolConfigDir('codex', '1'), 'auth.json'), 'utf8'));
    assert.equal(importedAuth.tokens.account_id, 'acc_bundle');
  } finally {
    fs.rmSync(sourceAiHomeDir, { recursive: true, force: true });
    fs.rmSync(targetAiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import accepts exported api key account bundle', async () => {
  const sourceAiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-api-key-source-'));
  const targetAiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-api-key-target-'));
  try {
    const sourceDeps = createDeps(sourceAiHomeDir);
    const sourceConfigDir = sourceDeps.getToolConfigDir('codex', '1');
    const sourceProfileDir = sourceDeps.getProfileDir('codex', '1');
    fs.ensureDirSync(sourceConfigDir);
    fs.ensureDirSync(sourceProfileDir);
    fs.writeFileSync(path.join(sourceConfigDir, 'auth.json'), JSON.stringify({
      OPENAI_API_KEY: 'sk-test-api-key'
    }, null, 2));
    fs.writeFileSync(path.join(sourceProfileDir, '.aih_env.json'), JSON.stringify({
      OPENAI_API_KEY: 'sk-test-api-key',
      OPENAI_BASE_URL: 'https://api.openai.com/v1'
    }, null, 2));

    const exportRes = createResCapture();
    await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/accounts/export',
      url: new URL('http://localhost/v0/webui/accounts/export?format=aih'),
      req: { headers: {} },
      res: exportRes,
      options: {},
      state: {},
      deps: sourceDeps
    });
    assert.equal(exportRes.statusCode, 200);
    const exportedPayload = JSON.parse(exportRes.body);
    assert.equal(exportedPayload.type, 'sub2api-data');
    assert.equal(exportedPayload.kind, undefined);
    assert.equal(exportedPayload.accounts.length, 1);
    assert.equal(exportedPayload.accounts[0].accountId, undefined);

    const targetDeps = createDeps(targetAiHomeDir);
    const importRes = createResCapture();
    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...targetDeps,
        readRequestBody: async () => Buffer.from(JSON.stringify({
          content: exportRes.body
        }), 'utf8')
      }
    });

    const importBody = await readCompletedImportBody(importRes, targetDeps);
    assert.equal(importBody.imported, 1);
    assert.equal(importBody.summary.created, 1);
    assert.deepEqual(targetDeps.getToolAccountIds('codex'), ['1']);
    const importedAuth = JSON.parse(fs.readFileSync(path.join(targetDeps.getToolConfigDir('codex', '1'), 'auth.json'), 'utf8'));
    const importedEnv = JSON.parse(fs.readFileSync(path.join(targetDeps.getProfileDir('codex', '1'), '.aih_env.json'), 'utf8'));
    assert.equal(importedAuth.OPENAI_API_KEY, 'sk-test-api-key');
    assert.equal(importedEnv.OPENAI_BASE_URL, 'https://api.openai.com/v1');
  } finally {
    fs.rmSync(sourceAiHomeDir, { recursive: true, force: true });
    fs.rmSync(targetAiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import ignores legacy AIH local accountId fields', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-legacy-id-'));
  try {
    const deps = createDeps(aiHomeDir);
    const accessToken = makeJwt({
      'https://api.openai.com/profile': {
        email: 'legacy-local-id@example.com'
      }
    });
    const importRes = createResCapture();

    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...deps,
        readRequestBody: async () => Buffer.from(JSON.stringify({
          content: JSON.stringify({
            kind: 'ai-home-accounts',
            version: 2,
            accounts: [{
              provider: 'codex',
              accountId: '9',
              auth: {
                tokens: {
                  access_token: accessToken,
                  refresh_token: 'rt_legacy_local_id',
                  id_token: '',
                  account_id: 'provider-account-id'
                }
              }
            }]
          })
        }), 'utf8')
      }
    });

    const importBody = await readCompletedImportBody(importRes, deps);
    assert.equal(importBody.imported, 1);
    assert.deepEqual(deps.getToolAccountIds('codex'), ['1']);
    assert.equal(fs.existsSync(path.join(aiHomeDir, 'profiles', 'codex', '9')), false);
    const importedAuth = JSON.parse(fs.readFileSync(path.join(deps.getToolConfigDir('codex', '1'), 'auth.json'), 'utf8'));
    assert.equal(importedAuth.tokens.account_id, 'provider-account-id');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import stores sub2api metadata from manual JSON content', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-sub2api-meta-'));
  try {
    const deps = createDeps(aiHomeDir);
    const payload = {
      content: JSON.stringify({
        type: 'sub2api-data',
        version: 1,
        proxies: [{
          proxy_key: 'web-proxy',
          name: 'Web proxy',
          protocol: 'http',
          host: 'web-proxy.local',
          port: 8080,
          status: 'active',
          fallback_mode: false,
          expiry_warn_days: 0
        }],
        accounts: [{
          name: 'web codex key',
          notes: 'manual content',
          platform: 'openai',
          type: 'apikey',
          credentials: {
            api_key: 'sk-web-sub2api',
            base_url: 'https://web-sub2api.example.com/v1/'
          },
          extra: {
            owner: 'web'
          },
          proxy_key: 'web-proxy',
          concurrency: 0,
          priority: 6,
          auto_pause_on_expired: false
        }]
      })
    };
    const importRes = createResCapture();

    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...deps,
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    const importBody = await readCompletedImportBody(importRes, deps);
    assert.equal(importBody.imported, 1);
    const metadata = JSON.parse(fs.readFileSync(path.join(deps.getProfileDir('codex', '1'), '.aih_transfer.json'), 'utf8')).formats.sub2api;
    assert.equal(metadata.name, 'web codex key');
    assert.equal(metadata.notes, 'manual content');
    assert.deepEqual(metadata.extra, { owner: 'web' });
    assert.equal(metadata.proxy_key, 'web-proxy');
    assert.equal(metadata.concurrency, 0);
    assert.equal(metadata.priority, 6);
    assert.equal(metadata.auto_pause_on_expired, false);
    assert.equal(metadata.proxies[0].fallback_mode, false);
    assert.equal(metadata.proxies[0].expiry_warn_days, 0);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account export skips credentialless account directories', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-skip-empty-'));
  try {
    const deps = createDeps(aiHomeDir);
    const emptyProfileDir = deps.getProfileDir('claude', '2');
    const apiKeyProfileDir = deps.getProfileDir('claude', '3');
    fs.ensureDirSync(emptyProfileDir);
    fs.ensureDirSync(apiKeyProfileDir);
    fs.writeFileSync(path.join(emptyProfileDir, '.aih_env.json'), JSON.stringify({
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com'
    }, null, 2));
    fs.writeFileSync(path.join(apiKeyProfileDir, '.aih_env.json'), JSON.stringify({
      ANTHROPIC_API_KEY: 'sk-ant-transfer',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com'
    }, null, 2));

    const exportRes = createResCapture();
    await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/accounts/export',
      url: new URL('http://localhost/v0/webui/accounts/export?format=aih'),
      req: { headers: {} },
      res: exportRes,
      options: {},
      state: {},
      deps
    });

    assert.equal(exportRes.statusCode, 200);
    const body = JSON.parse(exportRes.body);
    assert.equal(body.type, 'sub2api-data');
    assert.deepEqual(body.accounts.map((account) => `${account.platform}/${account.type}`), ['anthropic/apikey']);
    assert.equal(body.accounts[0].accountId, undefined);
    assert.equal(body.accounts[0].credentials.api_key, 'sk-ant-transfer');
    assert.equal(stringifyJson(body).includes('profileDir'), false);
    assert.equal(stringifyJson(body).includes('configDir'), false);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account export and import preserves agy oauth token account', async () => {
  const sourceAiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-agy-source-'));
  const targetAiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-agy-target-'));
  try {
    const sourceDeps = createDeps(sourceAiHomeDir);
    const sourceConfigDir = sourceDeps.getToolConfigDir('agy', '4');
    fs.ensureDirSync(sourceConfigDir);
    fs.writeFileSync(path.join(sourceConfigDir, 'antigravity-oauth-token'), JSON.stringify({
      auth_method: 'oauth',
      token: {
        access_token: 'agy-access-token',
        refresh_token: 'agy-refresh-token',
        expiry: '2030-01-01T00:00:00.000Z'
      }
    }, null, 2));
    fs.writeFileSync(path.join(sourceConfigDir, 'email.cache'), 'agy@example.com', 'utf8');

    const exportRes = createResCapture();
    await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/accounts/export',
      url: new URL('http://localhost/v0/webui/accounts/export?format=aih'),
      req: { headers: {} },
      res: exportRes,
      options: {},
      state: {},
      deps: sourceDeps
    });

    assert.equal(exportRes.statusCode, 200);
    const exportBody = JSON.parse(exportRes.body);
    assert.equal(exportBody.accounts.length, 1);
    assert.equal(exportBody.type, 'sub2api-data');
    assert.equal(exportBody.accounts[0].platform, 'antigravity');
    assert.equal(exportBody.accounts[0].accountId, undefined);
    assert.equal(exportBody.accounts[0].credentials.email, 'agy@example.com');
    assert.equal(exportBody.accounts[0].credentials.refresh_token, 'agy-refresh-token');

    const targetDeps = createDeps(targetAiHomeDir);
    const importRes = createResCapture();
    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...targetDeps,
        readRequestBody: async () => Buffer.from(JSON.stringify({ content: exportRes.body }), 'utf8')
      }
    });

    const importBody = await readCompletedImportBody(importRes, targetDeps);
    assert.equal(importBody.imported, 1);
    assert.deepEqual(targetDeps.getToolAccountIds('agy'), ['1']);
    const importedAuth = JSON.parse(fs.readFileSync(path.join(targetDeps.getToolConfigDir('agy', '1'), 'antigravity-oauth-token'), 'utf8'));
    assert.equal(importedAuth.token.access_token, 'agy-access-token');
    assert.equal(importedAuth.token.refresh_token, 'agy-refresh-token');
    assert.equal(
      fs.readFileSync(path.join(targetDeps.getToolConfigDir('agy', '1'), 'email.cache'), 'utf8'),
      'agy@example.com'
    );
  } finally {
    fs.rmSync(sourceAiHomeDir, { recursive: true, force: true });
    fs.rmSync(targetAiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account export supports Antigravity Manager formats', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-agy-formats-'));
  try {
    const deps = createDeps(aiHomeDir);
    const configDir = deps.getToolConfigDir('agy', '1');
    fs.ensureDirSync(configDir);
    fs.writeFileSync(path.join(configDir, 'antigravity-oauth-token'), JSON.stringify({
      auth_method: 'oauth',
      token: {
        refresh_token: 'agy-refresh-export'
      }
    }, null, 2));
    fs.writeFileSync(path.join(configDir, 'email.cache'), 'agy-export@example.com', 'utf8');

    const uiRes = createResCapture();
    await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/accounts/export',
      url: new URL('http://localhost/v0/webui/accounts/export?format=antigravity'),
      req: { headers: {} },
      res: uiRes,
      options: {},
      state: {},
      deps
    });

    assert.equal(uiRes.statusCode, 200);
    assert.equal(uiRes.headers['Content-Disposition'], 'attachment; filename="antigravity-accounts.json"');
    assert.deepEqual(JSON.parse(uiRes.body), {
      accounts: [{
        email: 'agy-export@example.com',
        refresh_token: 'agy-refresh-export'
      }]
    });

    const removedFormatRes = createResCapture();
    await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/accounts/export',
      url: new URL('http://localhost/v0/webui/accounts/export?format=antigravity-plugin'),
      req: { headers: {} },
      res: removedFormatRes,
      options: {},
      state: {},
      deps
    });

    assert.equal(removedFormatRes.statusCode, 400);
    assert.deepEqual(JSON.parse(removedFormatRes.body), {
      ok: false,
      error: 'unsupported_export_format'
    });
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account export returns CLIProxyAPI data without syncing host config', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-cliproxyapi-'));
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-cliproxyapi-home-'));
  try {
    const deps = createDeps(aiHomeDir);
    const profileDir = deps.getProfileDir('codex', '1');
    const configDir = deps.getToolConfigDir('codex', '1');
    fs.ensureDirSync(profileDir);
    fs.ensureDirSync(configDir);
    fs.writeFileSync(path.join(profileDir, '.aih_env.json'), JSON.stringify({
      OPENAI_API_KEY: 'sk-web-cliproxy',
      OPENAI_BASE_URL: 'https://cliproxy-web.example.com/v1/'
    }, null, 2));
    fs.writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify({
      OPENAI_API_KEY: 'sk-web-cliproxy'
    }, null, 2));

    const res = createResCapture();
    await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/accounts/export',
      url: new URL('http://localhost/v0/webui/accounts/export?format=cliproxyapi'),
      req: { headers: {} },
      res,
      options: {},
      state: {},
      deps: {
        ...deps,
        hostHomeDir
      }
    });

    assert.equal(res.statusCode, 200);
    const contentDisposition = res.headers['Content-Disposition'] || res.headers['content-disposition'];
    assert.match(contentDisposition, /filename="cliproxyapi-data\.json"/);
    const body = JSON.parse(res.body);
    assert.equal(body.type, 'cliproxyapi-data');
    assert.equal(body.accounts.length, 1);
    assert.equal(body.accounts[0].provider, 'codex');
    assert.equal(body.accounts[0].type, 'api-key');
    assert.equal(body.accounts[0].config.apiKey, 'sk-web-cliproxy');
    assert.equal(fs.existsSync(path.join(hostHomeDir, '.cli-proxy-api', 'config.yaml')), false);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import does not use provider account_id as local profile id', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-flat-'));
  try {
    const deps = createDeps(aiHomeDir);
    const accessToken = makeJwt({
      client_id: 'app_flat',
      exp: 1776600282,
      'https://api.openai.com/profile': {
        email: 'flat@example.com'
      }
    });
    const importRes = createResCapture();
    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...deps,
        readRequestBody: async () => Buffer.from(JSON.stringify({
          content: JSON.stringify({
            type: 'codex',
            email: 'flat@example.com',
            access_token: accessToken,
            refresh_token: 'rt_flat',
            account_id: 'acc_external'
          })
        }), 'utf8')
      }
    });

    const importBody = await readCompletedImportBody(importRes, deps);
    assert.equal(importBody.imported, 1);
    assert.deepEqual(deps.getToolAccountIds('codex'), ['1']);
    assert.equal(fs.existsSync(path.join(aiHomeDir, 'profiles', 'codex', 'acc_external')), false);
    const importedAuth = JSON.parse(fs.readFileSync(path.join(deps.getToolConfigDir('codex', '1'), 'auth.json'), 'utf8'));
    assert.equal(importedAuth.tokens.account_id, 'acc_external');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import skips same-provider duplicate oauth accounts by email only', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-dedupe-oauth-'));
  try {
    const deps = createDeps(aiHomeDir);
    const firstToken = makeJwt({
      'https://api.openai.com/profile': { email: 'same@example.com' }
    });
    const secondToken = makeJwt({
      'https://api.openai.com/profile': { email: 'SAME@example.com' }
    });
    const importRes = createResCapture();
    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...deps,
        readRequestBody: async () => Buffer.from(JSON.stringify({
          accounts: [
            {
              provider: 'codex',
              access_token: firstToken,
              refresh_token: 'rt_same_first',
              account_id: 'provider-account-a'
            },
            {
              provider: 'codex',
              access_token: secondToken,
              refresh_token: 'rt_same_second',
              account_id: 'provider-account-b'
            }
          ]
        }), 'utf8')
      }
    });

    const importBody = await readCompletedImportBody(importRes, deps);
    assert.equal(importBody.imported, 1);
    assert.equal(importBody.summary.created, 1);
    assert.equal(importBody.summary.updated, 0);
    assert.equal(importBody.summary.skipped, 1);
    assert.deepEqual(deps.getToolAccountIds('codex'), ['1']);
    const importedAuth = JSON.parse(fs.readFileSync(path.join(deps.getToolConfigDir('codex', '1'), 'auth.json'), 'utf8'));
    assert.equal(importedAuth.tokens.account_id, 'provider-account-a');
    assert.equal(importedAuth.email, 'same@example.com');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import rejects same-provider oauth without email', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-invalid-oauth-'));
  try {
    const deps = createDeps(aiHomeDir);
    const importRes = createResCapture();
    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...deps,
        readRequestBody: async () => Buffer.from(JSON.stringify({
          accounts: [
            {
              provider: 'codex',
              refresh_token: 'rt_missing_email',
              account_id: 'provider-account-only'
            }
          ]
        }), 'utf8')
      }
    });

    const importBody = await readCompletedImportBody(importRes, deps);
    assert.equal(importBody.imported, 0);
    assert.equal(importBody.summary.invalid, 1);
    assert.deepEqual(deps.getToolAccountIds('codex'), []);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import keeps same email separate across oauth providers', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-provider-scope-'));
  try {
    const deps = createDeps(aiHomeDir);
    const codexToken = makeJwt({
      'https://api.openai.com/profile': { email: 'shared@example.com' }
    });
    const geminiToken = makeJwt({
      email: 'shared@example.com'
    });
    const importRes = createResCapture();
    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...deps,
        readRequestBody: async () => Buffer.from(JSON.stringify({
          accounts: [
            {
              provider: 'codex',
              access_token: codexToken,
              refresh_token: 'rt_shared'
            },
            {
              provider: 'gemini',
              auth: {
                access_token: geminiToken
              }
            }
          ]
        }), 'utf8')
      }
    });

    const importBody = await readCompletedImportBody(importRes, deps);
    assert.equal(importBody.imported, 2);
    assert.equal(importBody.summary.created, 2);
    assert.deepEqual(deps.getToolAccountIds('codex'), ['1']);
    assert.deepEqual(deps.getToolAccountIds('gemini'), ['1']);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import dedupes api key accounts by provider url and key', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-api-key-dedupe-'));
  try {
    const deps = createDeps(aiHomeDir);
    const importRes = createResCapture();
    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...deps,
        readRequestBody: async () => Buffer.from(JSON.stringify({
          accounts: [
            {
              provider: 'codex',
              config: {
                OPENAI_API_KEY: 'sk-same',
                OPENAI_BASE_URL: 'https://api.example.com/v1/'
              }
            },
            {
              provider: 'codex',
              config: {
                OPENAI_API_KEY: 'sk-same',
                OPENAI_BASE_URL: 'https://api.example.com/v1'
              }
            },
            {
              provider: 'codex',
              config: {
                OPENAI_API_KEY: 'sk-same',
                OPENAI_BASE_URL: 'https://other.example.com/v1'
              }
            }
          ]
        }), 'utf8')
      }
    });

    const importBody = await readCompletedImportBody(importRes, deps);
    assert.equal(importBody.imported, 2);
    assert.equal(importBody.summary.created, 2);
    assert.equal(importBody.summary.updated, 0);
    assert.equal(importBody.summary.skipped, 1);
    assert.deepEqual(deps.getToolAccountIds('codex'), ['1', '2']);
    const firstEnv = JSON.parse(fs.readFileSync(path.join(deps.getProfileDir('codex', '1'), '.aih_env.json'), 'utf8'));
    const secondEnv = JSON.parse(fs.readFileSync(path.join(deps.getProfileDir('codex', '2'), '.aih_env.json'), 'utf8'));
    assert.equal(firstEnv.OPENAI_BASE_URL, 'https://api.example.com/v1');
    assert.equal(secondEnv.OPENAI_BASE_URL, 'https://other.example.com/v1');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import path supports standard JSON files and auth hooks', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-json-path-'));
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-json-source-'));
  try {
    const deps = createDeps(aiHomeDir);
    const sourceFile = path.join(sourceDir, 'sub2api-current.json');
    fs.writeFileSync(sourceFile, JSON.stringify({
      exported_at: '2026-06-08T00:00:00Z',
      proxies: [],
      accounts: [
        {
          name: 'codex path key',
          platform: 'openai',
          type: 'apikey',
          credentials: {
            api_key: 'sk-web-path',
            base_url: 'https://web-path.example.com/v1/'
          },
          concurrency: 0,
          priority: 0
        }
      ]
    }));
    const hookEvents = [];
    const importRes = createResCapture();

    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...deps,
        accountArtifactHooks: {
          snapshotAccountAuthArtifacts: (provider, accountId) => ({ provider, accountId, before: true }),
          notifyDefaultAccountAuthUpdatedIfChanged: (event) => hookEvents.push(event)
        },
        readRequestBody: async () => Buffer.from(JSON.stringify({
          mode: 'path',
          path: sourceFile
        }), 'utf8')
      }
    });

    const importBody = await readCompletedImportBody(importRes, deps);
    assert.equal(importBody.imported, 1);
    assert.equal(importBody.summary.imported, 1);
    assert.deepEqual(importBody.summary.providers, ['codex']);
    assert.deepEqual(deps.getToolAccountIds('codex'), ['1']);
    const importedEnv = JSON.parse(fs.readFileSync(path.join(deps.getProfileDir('codex', '1'), '.aih_env.json'), 'utf8'));
    assert.deepEqual(importedEnv, {
      OPENAI_API_KEY: 'sk-web-path',
      OPENAI_BASE_URL: 'https://web-path.example.com/v1'
    });
    assert.equal(hookEvents.length, 1);
    assert.equal(hookEvents[0].provider, 'codex');
    assert.equal(hookEvents[0].source, 'unified_json_import');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('web ui account import accepts uploaded standard JSON files', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-upload-json-'));
  try {
    const deps = createDeps(aiHomeDir);
    const uploadPayload = {
      mode: 'upload',
      uploadKind: 'file',
      files: [
        {
          name: 'sub2api-data.json',
          content: JSON.stringify({
            type: 'sub2api-data',
            version: 1,
            proxies: [],
            accounts: [{
              name: 'uploaded codex key',
              platform: 'openai',
              type: 'apikey',
              credentials: {
                api_key: 'sk-upload-json',
                base_url: 'https://upload-json.example.com/v1/'
              }
            }]
          })
        }
      ]
    };
    const importRes = createResCapture();

    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...deps,
        readRequestBody: async () => Buffer.from(JSON.stringify(uploadPayload), 'utf8')
      }
    });

    const importBody = await readCompletedImportBody(importRes, deps);
    assert.equal(importBody.imported, 1);
    assert.equal(importBody.summary.created, 1);
    assert.deepEqual(importBody.summary.providers, ['codex']);
    const importedEnv = JSON.parse(fs.readFileSync(path.join(deps.getProfileDir('codex', '1'), '.aih_env.json'), 'utf8'));
    assert.equal(importedEnv.OPENAI_API_KEY, 'sk-upload-json');
    assert.equal(importedEnv.OPENAI_BASE_URL, 'https://upload-json.example.com/v1');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import uses large request body limit for batched uploads', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-upload-limit-'));
  try {
    const deps = createDeps(aiHomeDir);
    let observedMaxBytes = 0;
    const importRes = createResCapture();

    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...deps,
        readRequestBody: async (_req, optionsArg = {}) => {
          observedMaxBytes = Number(optionsArg.maxBytes || 0);
          return Buffer.from(JSON.stringify({
            mode: 'upload',
            uploadKind: 'file',
            files: [{
              name: 'limit.json',
              content: JSON.stringify({
                type: 'sub2api-data',
                version: 1,
                proxies: [],
                accounts: [{
                  name: 'upload limit codex key',
                  platform: 'openai',
                  type: 'apikey',
                  credentials: {
                    api_key: 'sk-upload-limit'
                  }
                }]
              })
            }]
          }), 'utf8');
        }
      }
    });

    await readCompletedImportBody(importRes, deps);
    assert.ok(observedMaxBytes >= 80 * 1024 * 1024);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import accepts uploaded sub2api TXT files', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-upload-txt-'));
  try {
    const deps = createDeps(aiHomeDir);
    const uploadPayload = {
      mode: 'upload',
      uploadKind: 'file',
      files: [
        {
          name: 'sub2api-account.txt',
          content: JSON.stringify({
            type: 'sub2api-data',
            version: 1,
            proxies: [],
            accounts: [{
              name: 'uploaded txt codex oauth',
              platform: 'openai',
              type: 'oauth',
              credentials: {
                email: 'upload-txt@example.com',
                refresh_token: 'rt_upload_txt',
                chatgpt_account_id: 'acc_upload_txt'
              }
            }]
          })
        }
      ]
    };
    const importRes = createResCapture();

    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...deps,
        readRequestBody: async () => Buffer.from(JSON.stringify(uploadPayload), 'utf8')
      }
    });

    const importBody = await readCompletedImportBody(importRes, deps);
    assert.equal(importBody.imported, 1);
    assert.equal(importBody.summary.created, 1);
    assert.deepEqual(importBody.summary.providers, ['codex']);
    const importedAuth = JSON.parse(fs.readFileSync(path.join(deps.getToolConfigDir('codex', '1'), 'auth.json'), 'utf8'));
    assert.equal(importedAuth.email, 'upload-txt@example.com');
    assert.equal(importedAuth.tokens.refresh_token, 'rt_upload_txt');
    assert.equal(importedAuth.tokens.account_id, 'acc_upload_txt');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import accepts uploaded credential folders', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-upload-folder-'));
  try {
    const deps = createDeps(aiHomeDir);
    const authJson = {
      auth_mode: 'chatgpt',
      email: 'folder@example.com',
      tokens: {
        access_token: makeJwt({
          'https://api.openai.com/profile': {
            email: 'folder@example.com'
          }
        }),
        refresh_token: 'rt_folder_upload',
        id_token: '',
        account_id: 'acc_folder_upload'
      }
    };
    const importRes = createResCapture();

    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...deps,
        readRequestBody: async () => Buffer.from(JSON.stringify({
          mode: 'upload',
          uploadKind: 'folder',
          files: [{
            name: 'auth.json',
            relativePath: 'accounts/codex/7/.codex/auth.json',
            contentBase64: Buffer.from(JSON.stringify(authJson), 'utf8').toString('base64'),
            encoding: 'base64'
          }]
        }), 'utf8')
      }
    });

    const importBody = await readCompletedImportBody(importRes, deps);
    assert.equal(importBody.imported, 1);
    assert.deepEqual(deps.getToolAccountIds('codex'), ['1']);
    const importedAuth = JSON.parse(fs.readFileSync(path.join(deps.getToolConfigDir('codex', '1'), 'auth.json'), 'utf8'));
    assert.equal(importedAuth.tokens.refresh_token, 'rt_folder_upload');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import accepts uploaded zip archives', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-upload-zip-'));
  try {
    const deps = createDeps(aiHomeDir);
    const authJson = {
      auth_mode: 'chatgpt',
      email: 'zip@example.com',
      tokens: {
        access_token: makeJwt({
          'https://api.openai.com/profile': {
            email: 'zip@example.com'
          }
        }),
        refresh_token: 'rt_zip_upload',
        id_token: '',
        account_id: 'acc_zip_upload'
      }
    };
    const zipPayload = makeStoredZip([{
      name: 'accounts/codex/8/.codex/auth.json',
      content: JSON.stringify(authJson)
    }]);
    const importRes = createResCapture();

    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...deps,
        readRequestBody: async () => Buffer.from(JSON.stringify({
          mode: 'upload',
          uploadKind: 'file',
          files: [{
            name: 'accounts.zip',
            contentBase64: zipPayload.toString('base64'),
            encoding: 'base64'
          }]
        }), 'utf8')
      }
    });

    const importBody = await readCompletedImportBody(importRes, deps);
    assert.equal(importBody.imported, 1);
    assert.deepEqual(deps.getToolAccountIds('codex'), ['1']);
    const importedAuth = JSON.parse(fs.readFileSync(path.join(deps.getToolConfigDir('codex', '1'), 'auth.json'), 'utf8'));
    assert.equal(importedAuth.tokens.refresh_token, 'rt_zip_upload');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import accepts uploaded cpa zip archives with flat codex token JSON files', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-upload-cpa-zip-'));
  try {
    const deps = createDeps(aiHomeDir);
    const accessToken = makeJwt({
      'https://api.openai.com/profile': {
        email: 'cpa-zip@example.com'
      }
    });
    const zipPayload = makeStoredZip([{
      name: 'cpa/token_worker.json',
      content: JSON.stringify({
        type: 'codex',
        email: 'cpa-zip@example.com',
        access_token: accessToken,
        refresh_token: 'rt_cpa_zip_upload',
        account_id: 'acc_cpa_zip_upload'
      })
    }]);
    const importRes = createResCapture();

    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...deps,
        readRequestBody: async () => Buffer.from(JSON.stringify({
          mode: 'upload',
          uploadKind: 'file',
          files: [{
            name: 'cpa.zip',
            contentBase64: zipPayload.toString('base64'),
            encoding: 'base64'
          }]
        }), 'utf8')
      }
    });

    const importBody = await readCompletedImportBody(importRes, deps);
    assert.equal(importBody.imported, 1);
    assert.deepEqual(importBody.summary.providers, ['codex']);
    assert.deepEqual(deps.getToolAccountIds('codex'), ['1']);
    const importedAuth = JSON.parse(fs.readFileSync(path.join(deps.getToolConfigDir('codex', '1'), 'auth.json'), 'utf8'));
    assert.equal(importedAuth.email, 'cpa-zip@example.com');
    assert.equal(importedAuth.tokens.refresh_token, 'rt_cpa_zip_upload');
    assert.equal(importedAuth.tokens.account_id, 'acc_cpa_zip_upload');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import accepts multiple uploaded zip archives with flat sub2api codex bundle JSON files', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-upload-multi-sub2api-zip-'));
  try {
    const deps = createDeps(aiHomeDir);
    const firstZipPayload = makeStoredZip([{
      name: 'multi-one@example.com.json',
      content: JSON.stringify(makeSub2ApiCodexOauthBundle({
        email: 'multi-one@example.com',
        refreshToken: 'rt_multi_one',
        accountId: 'acc_multi_one'
      }))
    }]);
    const secondZipPayload = makeStoredZip([{
      name: 'multi-two@example.com.json',
      content: JSON.stringify(makeSub2ApiCodexOauthBundle({
        email: 'multi-two@example.com',
        refreshToken: 'rt_multi_two',
        accountId: 'acc_multi_two'
      }))
    }]);
    const importRes = createResCapture();

    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...deps,
        readRequestBody: async () => Buffer.from(JSON.stringify({
          mode: 'upload',
          uploadKind: 'file',
          files: [
            {
              name: 'codex_tokens_part_01.zip',
              contentBase64: firstZipPayload.toString('base64'),
              encoding: 'base64'
            },
            {
              name: 'codex_tokens_part_02.zip',
              contentBase64: secondZipPayload.toString('base64'),
              encoding: 'base64'
            }
          ]
        }), 'utf8')
      }
    });

    const importBody = await readCompletedImportBody(importRes, deps);
    assert.equal(importBody.imported, 2);
    assert.deepEqual(importBody.summary.providers, ['codex']);
    assert.deepEqual(deps.getToolAccountIds('codex'), ['1', '2']);
    const importedAuths = deps.getToolAccountIds('codex')
      .map((id) => JSON.parse(fs.readFileSync(path.join(deps.getToolConfigDir('codex', id), 'auth.json'), 'utf8')));
    const refreshByEmail = Object.fromEntries(importedAuths.map((auth) => [auth.email, auth.tokens.refresh_token]));
    assert.deepEqual(refreshByEmail, {
      'multi-one@example.com': 'rt_multi_one',
      'multi-two@example.com': 'rt_multi_two'
    });
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import accepts uploaded cliproxy zip roots with nested codex token JSON files', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-upload-cliproxy-root-zip-'));
  try {
    const deps = createDeps(aiHomeDir);
    const accessToken = makeJwt({
      'https://api.openai.com/profile': {
        email: 'cliproxy-root@example.com'
      }
    });
    const zipPayload = makeStoredZip([{
      name: 'cliproxy-export/cpa/token_nested.json',
      content: JSON.stringify({
        type: 'codex',
        email: 'cliproxy-root@example.com',
        access_token: accessToken,
        refresh_token: 'rt_cliproxy_root_upload',
        account_id: 'acc_cliproxy_root_upload'
      })
    }]);
    const importRes = createResCapture();

    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...deps,
        readRequestBody: async () => Buffer.from(JSON.stringify({
          mode: 'upload',
          uploadKind: 'file',
          files: [{
            name: 'cliproxy-export.zip',
            contentBase64: zipPayload.toString('base64'),
            encoding: 'base64'
          }]
        }), 'utf8')
      }
    });

    const importBody = await readCompletedImportBody(importRes, deps);
    assert.equal(importBody.imported, 1);
    assert.deepEqual(importBody.summary.providers, ['codex']);
    assert.deepEqual(deps.getToolAccountIds('codex'), ['1']);
    const importedAuth = JSON.parse(fs.readFileSync(path.join(deps.getToolConfigDir('codex', '1'), 'auth.json'), 'utf8'));
    assert.equal(importedAuth.email, 'cliproxy-root@example.com');
    assert.equal(importedAuth.tokens.refresh_token, 'rt_cliproxy_root_upload');
    assert.equal(importedAuth.tokens.account_id, 'acc_cliproxy_root_upload');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import can sync CLIProxyAPI config', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-import-cliproxyapi-'));
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-import-cliproxyapi-home-'));
  try {
    const deps = createDeps(aiHomeDir);
    const configDir = path.join(hostHomeDir, '.cli-proxy-api');
    fs.ensureDirSync(configDir);
    fs.writeFileSync(path.join(configDir, 'config.yaml'), [
      'auth-dir: "~/.cli-proxy-api"',
      '',
      'codex-api-key:',
      '  - api-key: "sk-import-cliproxy"',
      '    base-url: "https://import-cliproxy.example.com/v1"',
      ''
    ].join('\n'), 'utf8');
    const importRes = createResCapture();

    await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...deps,
        hostHomeDir,
        readRequestBody: async () => Buffer.from(JSON.stringify({
          mode: 'cliproxyapi'
        }), 'utf8')
      }
    });

    const importBody = await readCompletedImportBody(importRes, deps);
    assert.equal(importBody.imported, 1);
    assert.deepEqual(importBody.summary.providers, ['codex']);
    const importedEnv = JSON.parse(fs.readFileSync(path.join(deps.getProfileDir('codex', '1'), '.aih_env.json'), 'utf8'));
    assert.equal(importedEnv.OPENAI_API_KEY, 'sk-import-cliproxy');
    assert.equal(importedEnv.OPENAI_BASE_URL, 'https://import-cliproxy.example.com/v1');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('web ui account import works when fs only exposes ensureDirSync instead of mkdirpSync', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-transfer-fs-'));
  try {
    const baseDeps = createDeps(aiHomeDir);
    const compatFs = {
      ...fs,
      mkdirpSync: undefined,
      ensureDirSync: fs.ensureDirSync.bind(fs)
    };
    const importRes = createResCapture();
    const accessToken = makeJwt({
      client_id: 'app_test',
      exp: 1776600282,
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'team',
        chatgpt_account_id: 'acc_456'
      },
      'https://api.openai.com/profile': {
        email: 'compat@example.com'
      }
    });

    const payload = {
      content: JSON.stringify({
        access_token: accessToken,
        refresh_token: 'rt_test_compat',
        chatgpt_account_id: 'acc_456',
        plan_type: 'team'
      })
    };

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/import',
      url: new URL('http://localhost/v0/webui/accounts/import'),
      req: { headers: {} },
      res: importRes,
      options: {},
      state: {},
      deps: {
        ...baseDeps,
        fs: compatFs,
        readRequestBody: async () => Buffer.from(JSON.stringify(payload), 'utf8')
      }
    });

    assert.equal(handled, true);
    const importBody = await readCompletedImportBody(importRes, baseDeps);
    assert.equal(importBody.imported, 1);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui accounts list does not expose internal oauth identifiers', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-list-'));
  try {
    const deps = createDeps(aiHomeDir);
    const configDir = deps.getToolConfigDir('codex', '1');
    const profileDir = deps.getProfileDir('codex', '1');
    fs.ensureDirSync(configDir);
    fs.ensureDirSync(profileDir);

    const accessToken = makeJwt({
      client_id: 'app_hidden',
      exp: 1776600282,
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'team',
        chatgpt_account_id: 'acc_hidden',
        chatgpt_user_id: 'user_hidden',
        user_id: 'user_internal'
      },
      'https://api.openai.com/profile': {
        email: 'hidden@example.com'
      }
    });

    fs.writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: accessToken,
        refresh_token: 'rt_hidden',
        id_token: '',
        account_id: 'acc_hidden'
      },
      organization_id: 'org_hidden'
    }, null, 2));
    upsertAccountRef(fs, aiHomeDir, {
      provider: 'codex',
      accountId: '1',
      uniqueKey: 'oauth:codex:hidden@example.com'
    });

    const res = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/accounts',
      url: new URL('http://localhost/v0/webui/accounts'),
      req: { headers: {} },
      res,
      options: {},
      state: {},
      deps
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const account = JSON.parse(res.body).accounts[0];
    assert.equal(account.email, 'hidden@example.com');
    assert.equal(account.planType, 'team');
    assert.match(account.accountRef, /^acct_[a-f0-9]{20}$/);
    assert.equal('uniqueKey' in account, false);
    assert.equal('clientId' in account, false);
    assert.equal('chatgptAccountId' in account, false);
    assert.equal('chatgptUserId' in account, false);
    assert.equal('userId' in account, false);
    assert.equal('organizationId' in account, false);
    assert.equal('tokenExpiresAt' in account, false);
    assert.equal(res.body.includes('oauth:codex:hidden@example.com'), false);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});
