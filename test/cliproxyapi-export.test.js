const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCliproxyapiExportService } = require('../lib/cli/services/backup/cliproxyapi-export');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

test('exportCliproxyapiCodexAuths flattens codex auths into CLIProxyAPI auth-dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cliproxyapi-export-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const hostHomeDir = path.join(root, 'home');
    const configDir = path.join(hostHomeDir, '.cli-proxy-api');
    const authDir = path.join(hostHomeDir, '.clip-auths');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.yaml'), 'port: 8317\nauth-dir: "~/.clip-auths"\n');

    const idToken = makeJwt({ email: 'worker@example.com', exp: 1773000000 });
    const accessToken = makeJwt({
      exp: 1774000000,
      'https://api.openai.com/profile': { email: 'worker@example.com' }
    });

    writeJson(path.join(aiHomeDir, 'profiles', 'codex', '101', '.codex', 'auth.json'), {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: idToken,
        access_token: accessToken,
        refresh_token: 'rt_valid_token',
        account_id: 'acct-101'
      },
      last_refresh: '2026-03-08T10:00:00.000Z'
    });
    writeJson(path.join(aiHomeDir, 'profiles', 'codex', '102', '.codex', 'auth.json'), {
      tokens: {
        refresh_token: 'invalid_refresh'
      }
    });
    fs.mkdirSync(path.join(aiHomeDir, 'profiles', 'codex', '103'), { recursive: true });

    const service = createCliproxyapiExportService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir,
      BufferImpl: Buffer
    });

    const progress = [];
    const result = service.exportCliproxyapiCodexAuths({
      onProgress: (event) => progress.push({
        scanned: event.scanned,
        status: event.status,
        email: event.email || ''
      })
    });
    assert.equal(result.scanned, 3);
    assert.equal(result.exported, 1);
    assert.equal(result.skippedInvalid, 1);
    assert.equal(result.skippedMissing, 1);
    assert.equal(result.dedupedSource, 0);
    assert.equal(result.dedupedTarget, 0);
    assert.equal(result.authDir, authDir);
    assert.deepEqual(progress.map((item) => item.status), ['start', 'invalid', 'missing', 'apply_start', 'exported', 'done']);

    const exportedPath = path.join(authDir, 'worker@example.com.json');
    assert.equal(fs.existsSync(exportedPath), true);
    const exported = JSON.parse(fs.readFileSync(exportedPath, 'utf8'));
    assert.deepEqual(exported, {
      type: 'codex',
      email: 'worker@example.com',
      id_token: idToken,
      access_token: accessToken,
      refresh_token: 'rt_valid_token',
      account_id: 'acct-101',
      last_refresh: '2026-03-08T10:00:00.000Z',
      expired: new Date(1774000000 * 1000).toISOString()
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exportCliproxyapiCodexAuths falls back to default ~/.cli-proxy-api auth-dir when config is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cliproxyapi-export-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const hostHomeDir = path.join(root, 'home');
    writeJson(path.join(aiHomeDir, 'profiles', 'codex', '201', '.codex', 'auth.json'), {
      tokens: {
        id_token: makeJwt({ email: 'fallback@example.com' }),
        access_token: makeJwt({ exp: 1775000000 }),
        refresh_token: 'rt_fallback',
        account_id: 'acct-201'
      },
      last_refresh: '2026-03-08T11:00:00.000Z'
    });

    const service = createCliproxyapiExportService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir,
      BufferImpl: Buffer
    });
    const result = service.exportCliproxyapiCodexAuths();

    assert.equal(result.configPath, '');
    assert.equal(result.authDir, path.join(hostHomeDir, '.cli-proxy-api'));
    assert.equal(fs.existsSync(path.join(result.authDir, 'fallback@example.com.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exportCliproxyapiCodexAuths dedupes by account identity across source and target files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cliproxyapi-export-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const hostHomeDir = path.join(root, 'home');
    const authDir = path.join(hostHomeDir, '.cli-proxy-api');
    fs.mkdirSync(authDir, { recursive: true });

    const idToken = makeJwt({ email: 'same@example.com' });
    const accessToken = makeJwt({ exp: 1776000000 });
    const payload = {
      tokens: {
        id_token: idToken,
        access_token: accessToken,
        refresh_token: 'rt_same',
        account_id: 'acct-same'
      },
      last_refresh: '2026-03-08T12:00:00.000Z'
    };
    writeJson(path.join(aiHomeDir, 'profiles', 'codex', '301', '.codex', 'auth.json'), payload);
    writeJson(path.join(aiHomeDir, 'profiles', 'codex', '302', '.codex', 'auth.json'), payload);

    writeJson(path.join(authDir, 'existing-user-file.json'), {
      type: 'codex',
      email: 'same@example.com',
      refresh_token: 'rt_old',
      account_id: 'acct-same'
    });
    writeJson(path.join(authDir, 'codex-aih-999.json'), {
      type: 'codex',
      email: 'same@example.com',
      refresh_token: 'rt_old2',
      account_id: 'acct-same'
    });

    const service = createCliproxyapiExportService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir,
      BufferImpl: Buffer
    });
    const result = service.exportCliproxyapiCodexAuths();

    assert.equal(result.exported, 1);
    assert.equal(result.dedupedSource, 1);
    assert.equal(result.dedupedTarget, 2);
    assert.equal(fs.existsSync(path.join(authDir, 'same@example.com.json')), true);
    assert.equal(fs.existsSync(path.join(authDir, 'existing-user-file.json')), false);
    assert.equal(fs.existsSync(path.join(authDir, 'codex-aih-999.json')), false);

    const exported = JSON.parse(fs.readFileSync(path.join(authDir, 'same@example.com.json'), 'utf8'));
    assert.equal(exported.account_id, 'acct-same');
    assert.equal(exported.refresh_token, 'rt_same');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exportCliproxyapiCodexAuths dedupes by email first and keeps the later-expiring credential', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cliproxyapi-export-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const hostHomeDir = path.join(root, 'home');
    const authDir = path.join(hostHomeDir, '.cli-proxy-api');
    fs.mkdirSync(authDir, { recursive: true });

    writeJson(path.join(aiHomeDir, 'profiles', 'codex', '401', '.codex', 'auth.json'), {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: makeJwt({ email: 'same@example.com', exp: 1772000000 }),
        access_token: makeJwt({ exp: 1772500000 }),
        refresh_token: 'rt_source_old',
        account_id: 'acct-source-old'
      },
      last_refresh: '2026-03-08T09:00:00.000Z'
    });

    writeJson(path.join(aiHomeDir, 'profiles', 'codex', '402', '.codex', 'auth.json'), {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: makeJwt({ email: 'same@example.com', exp: 1775000000 }),
        access_token: makeJwt({ exp: 1775500000 }),
        refresh_token: 'rt_source_new',
        account_id: 'acct-source-new'
      },
      last_refresh: '2026-03-08T12:00:00.000Z'
    });

    writeJson(path.join(authDir, 'same@example.com.json'), {
      type: 'codex',
      email: 'same@example.com',
      id_token: makeJwt({ email: 'same@example.com', exp: 1773000000 }),
      access_token: makeJwt({ exp: 1773500000 }),
      refresh_token: 'rt_target_mid',
      account_id: 'acct-target-mid',
      last_refresh: '2026-03-08T10:00:00.000Z',
      expired: new Date(1773500000 * 1000).toISOString()
    });

    const service = createCliproxyapiExportService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir,
      BufferImpl: Buffer
    });
    const result = service.exportCliproxyapiCodexAuths();

    assert.equal(result.exported, 1);
    assert.equal(result.dedupedSource, 1);
    const exported = JSON.parse(fs.readFileSync(path.join(authDir, 'same@example.com.json'), 'utf8'));
    assert.equal(exported.refresh_token, 'rt_source_new');
    assert.equal(exported.account_id, 'acct-source-new');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exportCliproxyapiCodexAuths skips non-OAuth or email-missing accounts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cliproxyapi-export-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const hostHomeDir = path.join(root, 'home');
    writeJson(path.join(aiHomeDir, 'profiles', 'codex', '401', '.codex', 'auth.json'), {
      auth_mode: 'api_key',
      OPENAI_API_KEY: 'sk-test',
      tokens: {}
    });
    writeJson(path.join(aiHomeDir, 'profiles', 'codex', '402', '.codex', 'auth.json'), {
      tokens: {
        id_token: makeJwt({ sub: 'no-email' }),
        access_token: makeJwt({ exp: 1777000000 }),
        refresh_token: 'rt_missing_email',
        account_id: 'acct-402'
      }
    });

    const service = createCliproxyapiExportService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir,
      BufferImpl: Buffer
    });
    const result = service.exportCliproxyapiCodexAuths();

    assert.equal(result.exported, 0);
    assert.equal(result.skippedInvalid, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importCliproxyapiCodexAuths imports codex oauth auth files from local CLIProxyAPI auth-dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cliproxyapi-import-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const hostHomeDir = path.join(root, 'home');
    const authDir = path.join(hostHomeDir, '.cli-proxy-api');
    fs.mkdirSync(authDir, { recursive: true });

    writeJson(path.join(authDir, 'worker@example.com.json'), {
      type: 'codex',
      email: 'worker@example.com',
      id_token: makeJwt({ email: 'worker@example.com', exp: 1773000000 }),
      access_token: makeJwt({ exp: 1774000000 }),
      refresh_token: 'rt_worker',
      account_id: 'acct-worker',
      last_refresh: '2026-03-08T08:00:00.000Z'
    });
    writeJson(path.join(authDir, 'dupe@example.com.json'), {
      type: 'codex',
      email: 'dupe@example.com',
      id_token: makeJwt({ email: 'dupe@example.com', exp: 1773000001 }),
      access_token: makeJwt({ exp: 1774000001 }),
      refresh_token: 'rt_dupe',
      account_id: 'acct-dupe',
      last_refresh: '2026-03-08T08:00:01.000Z'
    });
    writeJson(path.join(aiHomeDir, 'profiles', 'codex', '1', '.codex', 'auth.json'), {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: makeJwt({ email: 'dupe@example.com', exp: 1773000001 }),
        access_token: makeJwt({ exp: 1774000001 }),
        refresh_token: 'rt_dupe',
        account_id: 'acct-dupe'
      },
      last_refresh: '2026-03-08T08:00:01.000Z'
    });

    const service = createCliproxyapiExportService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir,
      BufferImpl: Buffer
    });
    const result = service.importCliproxyapiCodexAuths();

    assert.equal(result.scanned, 2);
    assert.equal(result.imported, 1);
    assert.equal(result.duplicates, 1);
    assert.equal(result.invalid, 0);
    assert.equal(fs.existsSync(path.join(aiHomeDir, 'profiles', 'codex', '2', '.codex', 'auth.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importCliproxyapiCodexAuths updates same-email account when incoming credential expires later', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cliproxyapi-import-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const hostHomeDir = path.join(root, 'home');
    const authDir = path.join(hostHomeDir, '.cli-proxy-api');
    fs.mkdirSync(authDir, { recursive: true });

    writeJson(path.join(authDir, 'worker@example.com.json'), {
      type: 'codex',
      email: 'worker@example.com',
      id_token: makeJwt({ email: 'worker@example.com', exp: 1775000000 }),
      access_token: makeJwt({ exp: 1775500000 }),
      refresh_token: 'rt_worker_new',
      account_id: 'acct-worker-new',
      last_refresh: '2026-03-08T12:00:00.000Z',
      expired: new Date(1775500000 * 1000).toISOString()
    });

    writeJson(path.join(aiHomeDir, 'profiles', 'codex', '1', '.codex', 'auth.json'), {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: makeJwt({ email: 'worker@example.com', exp: 1772000000 }),
        access_token: makeJwt({ exp: 1772500000 }),
        refresh_token: 'rt_worker_old',
        account_id: 'acct-worker-old'
      },
      last_refresh: '2026-03-08T09:00:00.000Z'
    });

    const service = createCliproxyapiExportService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir,
      BufferImpl: Buffer
    });
    const result = service.importCliproxyapiCodexAuths();

    assert.equal(result.imported, 1);
    assert.equal(result.duplicates, 0);
    assert.deepEqual(result.importedIds, ['1']);
    assert.equal(fs.existsSync(path.join(aiHomeDir, 'profiles', 'codex', '2')), false);
    const updated = JSON.parse(fs.readFileSync(path.join(aiHomeDir, 'profiles', 'codex', '1', '.codex', 'auth.json'), 'utf8'));
    assert.equal(updated.tokens.refresh_token, 'rt_worker_new');
    assert.equal(updated.tokens.account_id, 'acct-worker-new');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importCliproxyapiCodexAuths creates aih provider root on first import', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cliproxyapi-import-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const hostHomeDir = path.join(root, 'home');
    const authDir = path.join(hostHomeDir, '.cli-proxy-api');
    fs.mkdirSync(authDir, { recursive: true });

    writeJson(path.join(authDir, 'worker@example.com.json'), {
      type: 'codex',
      email: 'worker@example.com',
      id_token: makeJwt({ email: 'worker@example.com' }),
      access_token: makeJwt({ exp: 1778000000 }),
      refresh_token: 'rt_worker_token',
      account_id: 'acct-worker',
      last_refresh: '2026-03-08T12:00:00.000Z'
    });

    const service = createCliproxyapiExportService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir,
      BufferImpl: Buffer
    });

    const result = service.importCliproxyapiCodexAuths();
    assert.equal(result.imported, 1);
    assert.equal(result.failed, 0);
    assert.equal(fs.existsSync(path.join(aiHomeDir, 'profiles', 'codex', '1', '.codex', 'auth.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
