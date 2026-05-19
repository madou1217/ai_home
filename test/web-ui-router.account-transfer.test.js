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
      return path.join(profilesRoot, provider, String(id), '.gemini');
    },
    getProfileDir(provider, id) {
      return path.join(profilesRoot, provider, String(id));
    },
    loadServerRuntimeAccounts() {
      return { codex: [], gemini: [], claude: [] };
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
    assert.equal(importRes.statusCode, 200);
    const importBody = JSON.parse(importRes.body);
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
    const exportBody = JSON.parse(exportRes.body);
    assert.equal(exportBody.accounts.length, 1);
    assert.equal(exportBody.accounts[0].provider, 'codex');
    assert.equal(exportBody.accounts[0].meta.planType, 'team');
    assert.equal(exportBody.accounts[0].meta.clientId, 'app_test');
    assert.equal(exportBody.accounts[0].meta.chatgptAccountId, 'acc_123');
    assert.equal(exportBody.accounts[0].meta.chatgptUserId, 'user_chatgpt_123');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
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
    assert.equal(importRes.statusCode, 200);
    assert.equal(JSON.parse(importRes.body).imported, 1);
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
    assert.equal('clientId' in account, false);
    assert.equal('chatgptAccountId' in account, false);
    assert.equal('chatgptUserId' in account, false);
    assert.equal('userId' in account, false);
    assert.equal('organizationId' in account, false);
    assert.equal('tokenExpiresAt' in account, false);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});
