'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  getOauthArtifactPath,
  hasOauthCompletionArtifacts,
  readOauthArtifactSignature
} = require('../lib/server/web-account-auth-oauth-tokens');
const { createAuthJobManager } = require('../lib/server/web-account-auth');
const { listAccountCredentialRecords, readAccountNativeAuth } = require('../lib/server/account-credential-store');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-web-auth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  return {
    root,
    job: { provider: 'kiro', runtimeDir, configDir: path.join(runtimeDir, '.kiro') }
  };
}

function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE IF NOT EXISTS auth_kv(key TEXT PRIMARY KEY, value TEXT)');
  return db;
}

function writeToken(db, access = 'access-one', refresh = 'refresh-one') {
  db.prepare('INSERT OR REPLACE INTO auth_kv(key, value) VALUES(?, ?)').run(
    'kirocli:odic:token',
    JSON.stringify({ access_token: access, refresh_token: refresh, region: 'us-east-1' })
  );
}

test('Kiro OAuth reads the account database at the runtime root, separate from KIRO_HOME', t => {
  const { job } = fixture(t);
  assert.equal(getOauthArtifactPath(job), path.join(job.runtimeDir, 'data.sqlite3'));
  const db = openDatabase(path.join(job.runtimeDir, 'data.sqlite3'));
  writeToken(db);
  db.close();
  assert.equal(hasOauthCompletionArtifacts(job, fs), true);
});

test('Kiro OAuth rejects empty, corrupt, and refresh-only databases', t => {
  const { job } = fixture(t);
  const file = path.join(job.runtimeDir, 'data.sqlite3');
  let db = openDatabase(file);
  db.close();
  assert.equal(hasOauthCompletionArtifacts(job, fs), false);
  db = openDatabase(file);
  writeToken(db, '', 'refresh-only');
  db.close();
  assert.equal(hasOauthCompletionArtifacts(job, fs), false);
  fs.writeFileSync(file, 'not a SQLite database');
  assert.equal(hasOauthCompletionArtifacts(job, fs), false);
});

test('Kiro OAuth freshness tracks the logical token, including committed WAL updates', t => {
  const { job } = fixture(t);
  const file = path.join(job.runtimeDir, 'data.sqlite3');
  const db = openDatabase(file);
  t.after(() => db.close());
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
  writeToken(db);
  job._requireFreshOauthArtifacts = true;
  job._oauthArtifactSignatureAtStart = readOauthArtifactSignature(job, fs);
  assert.ok(job._oauthArtifactSignatureAtStart);
  assert.equal(hasOauthCompletionArtifacts(job, fs), false);

  db.exec('CREATE TABLE settings(key TEXT, value TEXT); INSERT INTO settings VALUES(\'theme\', \'dark\')');
  assert.equal(readOauthArtifactSignature(job, fs), job._oauthArtifactSignatureAtStart);
  assert.equal(hasOauthCompletionArtifacts(job, fs), false, 'settings are not a new authorization');
  writeToken(db, 'access-two', 'refresh-two');
  assert.equal(fs.existsSync(`${file}-wal`), true);
  assert.equal(hasOauthCompletionArtifacts(job, fs), true);
});

test('Kiro 设备码登录（WebUI 添加账号）**不 spawn 任何 CLI**，直接产出已验证的账号', async t => {
  const { root } = fixture(t);
  let spawnCount = 0;
  const requests = [];
  const replies = [];
  const fetchImpl = async (url) => {
    const target = String(url);
    requests.push(target);
    if (target.includes('/client/register')) {
      return { status: 200, json: async () => ({ clientId: 'cid', clientSecret: 'secret' }) };
    }
    if (target.includes('/device_authorization')) {
      return { status: 200, json: async () => ({ deviceCode: 'device-code', userCode: 'ABCD-EFGH',
        verificationUri: 'https://view.awsapps.com/start/#/device',
        verificationUriComplete: 'https://view.awsapps.com/start/#/device?user_code=ABCD-EFGH',
        interval: 1, expiresIn: 600 }) };
    }
    if (target.includes('/token')) {
      return { status: 200, json: async () => ({ accessToken: 'aoa-native', refreshToken: 'aor-native', expiresIn: 3600 }) };
    }
    // 身份核验走 GetUsageLimits，必须是真 Response（按 body 流读取）。
    return new Response(JSON.stringify({
      userInfo: { userId: 'verified-builder-user' },
      subscriptionInfo: { type: 'Q_DEVELOPER_STANDALONE_FREE', subscriptionTitle: 'KIRO FREE' },
      usageBreakdownList: [{ resourceType: 'CREDIT', usageLimit: 50, currentUsageWithPrecision: 0.13,
        usageLimitWithPrecision: 50 }]
    }), { status: 200 });
  };
  const manager = createAuthJobManager({
    fs,
    aiHomeDir: path.join(root, 'aih'),
    processObj: {
      env: { HOME: root, USERPROFILE: root, AIH_HOST_HOME: root, PATH: '' },
      platform: process.platform,
      cwd: () => root,
      kill() {}
    },
    // 这两条是本次需求的硬约束：设备码路径既不该解析 CLI，也不该 spawn PTY。
    resolveCliPathImpl: () => { throw new Error('must_not_resolve_cli'); },
    ptyImpl: { spawn() { spawnCount += 1; throw new Error('must_not_spawn_pty'); } },
    fetchImpl,
    onOauthJobFinished: job => replies.push(job.accountRef)
  });

  const started = manager.startOauthJob('kiro', 'oauth-device');
  const job = manager.getJob(started.jobId);
  assert.equal(job.authMode, 'oauth-device');
  assert.equal(spawnCount, 0, '原生登录不得 spawn 任何 CLI/PTY');

  const waitFor = async (predicate, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  };

  assert.equal(await waitFor(() => job.userCode === 'ABCD-EFGH'), true, '设备码必须透出给 UI');
  assert.equal(job.verificationUriComplete, 'https://view.awsapps.com/start/#/device?user_code=ABCD-EFGH');
  assert.equal(Number.isFinite(job.expiresAt), true);
  assert.equal(Number.isFinite(job.pollIntervalMs), true);
  assert.match(job.logs, /ABCD-EFGH/);

  assert.equal(await waitFor(() => job.status === 'succeeded'), true, `job 未成功: ${job.error}`);
  assert.equal(job.authProgressState, 'completed');
  assert.equal(readAccountNativeAuth(fs, path.join(root, 'aih'), job.accountRef).auth.access_token, 'aoa-native');
  assert.deepEqual(replies, [job.accountRef]);
  // 全程只碰 AWS 的 OIDC 与 CodeWhisperer 端点，没有任何 CLI 二进制。
  assert.equal(requests.some(url => url.includes('/client/register')), true);
  assert.equal(requests.some(url => url.includes('/device_authorization')), true);
  assert.equal(requests.some(url => url.includes('codewhisperer.')), true);
});

test('Kiro refresh_token 认证方式（WebUI）：粘贴 token 即导入账号，同样不 spawn CLI', async t => {
  const { root } = fixture(t);
  let spawnCount = 0;
  const replies = [];
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.includes('auth.desktop.kiro.dev/refreshToken')) {
      return { status: 200, json: async () => ({ accessToken: 'aoa-desktop', refreshToken: 'aor-desktop',
        expiresIn: 3600, profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/social' }) };
    }
    return new Response(JSON.stringify({
      userInfo: { userId: 'desktop-user' },
      usageBreakdownList: [{ resourceType: 'CREDIT', usageLimit: 50, currentUsageWithPrecision: 1,
        usageLimitWithPrecision: 50 }]
    }), { status: 200 });
  };
  const manager = createAuthJobManager({
    fs,
    aiHomeDir: path.join(root, 'aih'),
    processObj: {
      env: { HOME: root, USERPROFILE: root, AIH_HOST_HOME: root, PATH: '' },
      platform: process.platform,
      cwd: () => root,
      kill() {}
    },
    resolveCliPathImpl: () => { throw new Error('must_not_resolve_cli'); },
    ptyImpl: { spawn() { spawnCount += 1; throw new Error('must_not_spawn_pty'); } },
    fetchImpl,
    onOauthJobFinished: job => replies.push(job.accountRef)
  });

  const started = manager.startOauthJob('kiro', 'oauth-refresh-token');
  const job = manager.getJob(started.jobId);
  assert.equal(job.authMode, 'oauth-refresh-token');
  // 等用户粘贴：任务处于「等待输入」态，且没有设备码（不渲染设备码卡片）。
  assert.equal(job.authProgressState, 'awaiting_code');
  assert.equal(job.userCode, '');
  assert.equal(spawnCount, 0);

  const result = await manager.completeBrowserOauthCallback(started.jobId, 'aor-from-kiro-ide');
  assert.equal(result.ok, true);
  assert.equal(job.status, 'succeeded', job.error);
  assert.equal(job.authProgressState, 'completed');
  const nativeAuth = readAccountNativeAuth(fs, path.join(root, 'aih'), job.accountRef);
  assert.equal(nativeAuth.auth.access_token, 'aoa-desktop');
  assert.equal(nativeAuth.auth.profileArn, 'arn:aws:codewhisperer:us-east-1:1:profile/social');
  assert.deepEqual(replies, [job.accountRef]);

  // 判型为 desktop（social 账号没有 device-registration），下次刷新走 Kiro Desktop 口径。
  const { resolveKiroTokenFlavour, KIRO_TOKEN_FLAVOURS } = require('../lib/account/kiro-token-flavour');
  assert.equal(resolveKiroTokenFlavour(nativeAuth).flavour, KIRO_TOKEN_FLAVOURS.DESKTOP);
  assert.equal(require('../lib/account/kiro-device-registration').resolveKiroDeviceRegistration(nativeAuth).error,
    'kiro_registration_missing');
});
