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
      url: new URL('http://localhost/v0/webui/accounts/export'),
      req: { headers: {} },
      res: exportRes,
      options: {},
      state: {},
      deps: sourceDeps
    });
    assert.equal(exportRes.statusCode, 200);

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

    assert.equal(importRes.statusCode, 200);
    const importBody = JSON.parse(importRes.body);
    assert.equal(importBody.imported, 1);
    assert.equal(importBody.summary.created, 1);
    assert.deepEqual(targetDeps.getToolAccountIds('codex'), ['7']);
    const importedAuth = JSON.parse(fs.readFileSync(path.join(targetDeps.getToolConfigDir('codex', '7'), 'auth.json'), 'utf8'));
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
      url: new URL('http://localhost/v0/webui/accounts/export'),
      req: { headers: {} },
      res: exportRes,
      options: {},
      state: {},
      deps: sourceDeps
    });
    assert.equal(exportRes.statusCode, 200);

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

    assert.equal(importRes.statusCode, 200);
    const importBody = JSON.parse(importRes.body);
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

    assert.equal(importRes.statusCode, 200);
    const importBody = JSON.parse(importRes.body);
    assert.equal(importBody.imported, 1);
    assert.deepEqual(deps.getToolAccountIds('codex'), ['1']);
    assert.equal(fs.existsSync(path.join(aiHomeDir, 'profiles', 'codex', 'acc_external')), false);
    const importedAuth = JSON.parse(fs.readFileSync(path.join(deps.getToolConfigDir('codex', '1'), 'auth.json'), 'utf8'));
    assert.equal(importedAuth.tokens.account_id, 'acc_external');
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
