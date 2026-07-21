const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCodexBulkImportService } = require('../lib/cli/services/ai-cli/codex-bulk-import');
const {
  readAccountCredentials,
  readAccountNativeAuth,
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { normalizeIdentitySeed } = require('../lib/account/account-identity');
const { buildApiKeyIdentity } = require('../lib/account/transfer-core');
const { resolveAccountRefByCliId } = require('../lib/server/account-ref-store');

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

function makeService(root, overrides = {}) {
  const aiHomeDir = path.join(root, '.ai_home');
  const profilesDir = path.join(aiHomeDir, 'profiles');
  const service = createCodexBulkImportService({
    path,
    fs,
    aiHomeDir,
    getDefaultParallelism: () => 4,
    accountArtifactHooks: overrides.accountArtifactHooks
  });
  return { aiHomeDir, service, profilesDir };
}

function resolveTestAccountRef(aiHomeDir, cliAccountId) {
  const record = resolveAccountRefByCliId(fs, aiHomeDir, 'codex', cliAccountId);
  assert.ok(record, `missing codex CLI account ${cliAccountId}`);
  return record.accountRef;
}

function registerOAuthAccount(aiHomeDir, cliAccountId, email) {
  return registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId,
    identitySeed: `oauth:codex:${email}`
  }).accountRef;
}

function registerApiKeyAccount(aiHomeDir, cliAccountId, env) {
  return registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId,
    identitySeed: normalizeIdentitySeed(buildApiKeyIdentity('codex', env))
  }).accountRef;
}

test('importCodexTokensFromOutput stores the first account without creating a profile directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-bulk-import-'));
  try {
    const sourceDir = path.join(root, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'worker.json'), JSON.stringify({
      email: 'worker@example.com',
      refresh_token: 'rt_worker_token',
      access_token: 'at_worker_token',
      id_token: 'id_worker_token',
      account_id: 'acct-worker'
    }));

    const { aiHomeDir, service, profilesDir } = makeService(root);
    const result = await service.importCodexTokensFromOutput({
      sourceDir,
      parallel: 8,
      limit: 0,
      dryRun: false
    });

    assert.equal(result.imported, 1);
    assert.equal(result.failed, 0);
    const accountRef = resolveTestAccountRef(aiHomeDir, '1');
    assert.equal(readAccountNativeAuth(fs, aiHomeDir, accountRef).auth.tokens.refresh_token, 'rt_worker_token');
    assert.equal(fs.existsSync(path.join(profilesDir, 'codex', '1')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importCodexTokensFromOutput rejects oauth records without email even when account_id exists', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-bulk-import-'));
  try {
    const sourceDir = path.join(root, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'account-only.json'), JSON.stringify({
      refresh_token: 'rt_account_only',
      account_id: 'acct-without-email'
    }));

    const { service, profilesDir } = makeService(root);
    const result = await service.importCodexTokensFromOutput({
      sourceDir,
      parallel: 1,
      limit: 0,
      dryRun: false
    });

    assert.equal(result.imported, 0);
    assert.equal(result.invalid, 1);
    assert.equal(fs.existsSync(path.join(profilesDir, 'codex', '1')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importCodexTokensFromOutput skips existing oauth identity without overwriting old account', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-bulk-import-'));
  try {
    const sourceDir = path.join(root, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'worker-new.json'), JSON.stringify({
      email: 'worker@example.com',
      refresh_token: 'rt_worker_new',
      access_token: makeJwt({ exp: 1774000000 }),
      id_token: makeJwt({ email: 'worker@example.com', exp: 1773000000 }),
      account_id: 'acct-worker',
      last_refresh: '2026-03-08T12:00:00.000Z'
    }));

    const { aiHomeDir, service, profilesDir } = makeService(root);
    const existingAccountRef = registerOAuthAccount(aiHomeDir, '1', 'worker@example.com');
    writeAccountNativeAuth(fs, aiHomeDir, existingAccountRef, { auth: {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: makeJwt({ email: 'worker@example.com', exp: 1772000000 }),
        access_token: makeJwt({ exp: 1772500000 }),
        refresh_token: 'rt_worker_old',
        account_id: 'acct-worker'
      },
      last_refresh: '2026-03-08T10:00:00.000Z'
    } });

    const result = await service.importCodexTokensFromOutput({
      sourceDir,
      parallel: 4,
      limit: 0,
      dryRun: false
    });

    assert.equal(result.imported, 0);
    assert.equal(result.duplicates, 1);
    assert.equal(fs.existsSync(path.join(profilesDir, 'codex', '2')), false);
    const updated = readAccountNativeAuth(fs, aiHomeDir, existingAccountRef).auth;
    assert.equal(updated.tokens.refresh_token, 'rt_worker_old');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importCodexTokensFromOutput keeps only the best source credential for the same email identity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-bulk-import-'));
  try {
    const sourceDir = path.join(root, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'worker-old.json'), JSON.stringify({
      email: 'worker@example.com',
      refresh_token: 'rt_worker_old',
      access_token: makeJwt({ exp: 1772500000 }),
      id_token: makeJwt({ email: 'worker@example.com', exp: 1772000000 }),
      account_id: 'acct-worker',
      last_refresh: '2026-03-08T10:00:00.000Z'
    }));
    fs.writeFileSync(path.join(sourceDir, 'worker-new.json'), JSON.stringify({
      email: 'worker@example.com',
      refresh_token: 'rt_worker_new',
      access_token: makeJwt({ exp: 1774500000 }),
      id_token: makeJwt({ email: 'worker@example.com', exp: 1773500000 }),
      account_id: 'acct-worker',
      last_refresh: '2026-03-08T12:00:00.000Z'
    }));

    const { aiHomeDir, service } = makeService(root);
    const result = await service.importCodexTokensFromOutput({
      sourceDir,
      parallel: 4,
      limit: 0,
      dryRun: false
    });

    assert.equal(result.imported, 1);
    assert.equal(result.duplicates, 1);
    const accountRef = resolveTestAccountRef(aiHomeDir, '1');
    const imported = readAccountNativeAuth(fs, aiHomeDir, accountRef).auth;
    assert.equal(imported.tokens.refresh_token, 'rt_worker_new');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importCodexTokensFromOutput imports codex api-key records into DB env credentials', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-bulk-import-'));
  try {
    const sourceDir = path.join(root, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'api-key.json'), JSON.stringify({
      provider: 'codex',
      config: {
        OPENAI_API_KEY: 'sk-imported',
        OPENAI_BASE_URL: 'https://api.example.com/v1/'
      }
    }));

    const hookEvents = [];
    const { aiHomeDir, service, profilesDir } = makeService(root, {
      accountArtifactHooks: {
        snapshotAccountAuthArtifacts: (provider, accountRef) => ({ provider, accountRef, before: true }),
        notifyDefaultAccountAuthUpdatedIfChanged: (event) => hookEvents.push(event)
      }
    });
    const result = await service.importCodexTokensFromOutput({
      sourceDir,
      parallel: 1,
      limit: 0,
      dryRun: false
    });

    assert.equal(result.imported, 1);
    assert.equal(result.duplicates, 0);
    const accountRef = resolveTestAccountRef(aiHomeDir, '1');
    const env = readAccountCredentials(fs, aiHomeDir, accountRef);
    assert.deepEqual(env, {
      OPENAI_API_KEY: 'sk-imported',
      OPENAI_BASE_URL: 'https://api.example.com/v1'
    });
    assert.deepEqual(readAccountNativeAuth(fs, aiHomeDir, accountRef), {});
    assert.equal(fs.existsSync(path.join(profilesDir, 'codex', '1')), false);
    assert.equal(hookEvents.length, 1);
    assert.equal(hookEvents[0].provider, 'codex');
    assert.equal(hookEvents[0].accountRef, accountRef);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importCodexTokensFromOutput skips duplicate api-key identity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-bulk-import-'));
  try {
    const sourceDir = path.join(root, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'api-key.json'), JSON.stringify({
      provider: 'codex',
      api_key: 'sk-same',
      base_url: 'https://api.example.com/v1/'
    }));

    const { aiHomeDir, service, profilesDir } = makeService(root);
    const existingEnv = {
      OPENAI_API_KEY: 'sk-same',
      OPENAI_BASE_URL: 'https://api.example.com/v1'
    };
    const existingAccountRef = registerApiKeyAccount(aiHomeDir, '1', existingEnv);
    writeAccountCredentials(fs, aiHomeDir, existingAccountRef, existingEnv);

    const result = await service.importCodexTokensFromOutput({
      sourceDir,
      parallel: 1,
      limit: 0,
      dryRun: false
    });

    assert.equal(result.imported, 0);
    assert.equal(result.duplicates, 1);
    assert.equal(fs.existsSync(path.join(profilesDir, 'codex', '2')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importCodexTokensFromOutput imports sub2api codex oauth and api-key bundle records', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-bulk-import-'));
  try {
    const sourceDir = path.join(root, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'sub2api.json'), JSON.stringify({
      type: 'sub2api-data',
      version: 1,
      accounts: [
        {
          name: 'oauth',
          platform: 'openai',
          type: 'oauth',
          credentials: {
            email: 'sub2api-oauth@example.com',
            access_token: makeJwt({ 'https://api.openai.com/profile': { email: 'sub2api-oauth@example.com' } }),
            refresh_token: 'rt_sub2api_oauth',
            chatgpt_account_id: 'acct-sub2api'
          }
        },
        {
          name: 'key',
          platform: 'openai',
          type: 'api-key',
          credentials: {
            api_key: 'sk-sub2api',
            base_url: 'https://sub2api.example.com/v1/'
          }
        }
      ]
    }));

    const { aiHomeDir, service } = makeService(root);
    const result = await service.importCodexTokensFromOutput({
      sourceDir,
      parallel: 2,
      limit: 0,
      dryRun: false
    });

    assert.equal(result.imported, 2);
    assert.equal(result.invalid, 0);
    const firstRef = resolveTestAccountRef(aiHomeDir, '1');
    const secondRef = resolveTestAccountRef(aiHomeDir, '2');
    const firstAuth = readAccountNativeAuth(fs, aiHomeDir, firstRef).auth;
    const secondAuth = readAccountNativeAuth(fs, aiHomeDir, secondRef).auth;
    const oauth = firstAuth.tokens ? firstAuth : secondAuth;
    const env = firstAuth.tokens
      ? readAccountCredentials(fs, aiHomeDir, secondRef)
      : readAccountCredentials(fs, aiHomeDir, firstRef);
    assert.equal(oauth.tokens.refresh_token, 'rt_sub2api_oauth');
    assert.equal(oauth.tokens.account_id, 'acct-sub2api');
    assert.equal(env.OPENAI_API_KEY, 'sk-sub2api');
    assert.equal(env.OPENAI_BASE_URL, 'https://sub2api.example.com/v1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
