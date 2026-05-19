const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCodexBulkImportService } = require('../lib/cli/services/ai-cli/codex-bulk-import');

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

function makeService(root) {
  const profilesDir = path.join(root, '.ai_home', 'profiles');
  const service = createCodexBulkImportService({
    path,
    fs,
    crypto,
    profilesDir,
    getDefaultParallelism: () => 4,
    getToolAccountIds: (cliName) => {
      const providerDir = path.join(profilesDir, cliName);
      try {
        return fs.readdirSync(providerDir).filter((name) => /^\d+$/.test(name));
      } catch (_error) {
        return [];
      }
    },
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    getToolConfigDir: (cliName, id) => path.join(profilesDir, cliName, String(id), `.${cliName}`)
  });
  return { service, profilesDir };
}

test('importCodexTokensFromOutput creates provider root on first import', async () => {
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

    const { service, profilesDir } = makeService(root);
    const result = await service.importCodexTokensFromOutput({
      sourceDir,
      parallel: 8,
      limit: 0,
      dryRun: false
    });

    assert.equal(result.imported, 1);
    assert.equal(result.failed, 0);
    assert.equal(fs.existsSync(path.join(profilesDir, 'codex', '1', '.codex', 'auth.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importCodexTokensFromOutput dedupes by email identity and upgrades existing account when incoming token expires later', async () => {
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

    const { service, profilesDir } = makeService(root);
    fs.mkdirSync(path.join(profilesDir, 'codex', '1', '.codex'), { recursive: true });
    fs.writeFileSync(path.join(profilesDir, 'codex', '1', '.codex', 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: makeJwt({ email: 'worker@example.com', exp: 1772000000 }),
        access_token: makeJwt({ exp: 1772500000 }),
        refresh_token: 'rt_worker_old',
        account_id: 'acct-worker'
      },
      last_refresh: '2026-03-08T10:00:00.000Z'
    }));

    const result = await service.importCodexTokensFromOutput({
      sourceDir,
      parallel: 4,
      limit: 0,
      dryRun: false
    });

    assert.equal(result.imported, 1);
    assert.equal(result.duplicates, 0);
    assert.equal(fs.existsSync(path.join(profilesDir, 'codex', '2')), false);
    const updated = JSON.parse(fs.readFileSync(path.join(profilesDir, 'codex', '1', '.codex', 'auth.json'), 'utf8'));
    assert.equal(updated.tokens.refresh_token, 'rt_worker_new');
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

    const { service, profilesDir } = makeService(root);
    const result = await service.importCodexTokensFromOutput({
      sourceDir,
      parallel: 4,
      limit: 0,
      dryRun: false
    });

    assert.equal(result.imported, 1);
    assert.equal(result.duplicates, 1);
    const imported = JSON.parse(fs.readFileSync(path.join(profilesDir, 'codex', '1', '.codex', 'auth.json'), 'utf8'));
    assert.equal(imported.tokens.refresh_token, 'rt_worker_new');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
