'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readAccountNativeAuth,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const {
  createKimiHostCredentialReconciler,
  readKimiHostCredentialRecord
} = require('../lib/account/kimi-host-credentials');

function makeJwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature'
  ].join('.');
}

function makeCredentials(userId, deviceId, expiresAt) {
  return {
    access_token: makeJwt({ user_id: userId, sub: userId, device_id: deviceId, exp: expiresAt }),
    refresh_token: makeJwt({ user_id: userId, sub: userId, device_id: deviceId, exp: expiresAt + 1000 }),
    expires_at: expiresAt,
    expires_in: 900,
    scope: 'kimi-code',
    token_type: 'Bearer'
  };
}

function createFixture(t, databaseCredentials) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kimi-host-credentials-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, 'ai-home');
  const hostHomeDir = path.join(root, 'host-home');
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'kimi',
    cliAccountId: '1',
    identitySeed: 'oauth:kimi:legacy-account'
  });
  writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, {
    credentials: databaseCredentials
  });
  return { aiHomeDir, hostHomeDir, accountRef: registration.accountRef };
}

function writeHostSnapshot(fixture, credentials, deviceId, mtimeMs = Date.now() + 5000) {
  const credentialsPath = path.join(fixture.hostHomeDir, '.kimi-code', 'credentials', 'kimi-code.json');
  const deviceIdPath = path.join(fixture.hostHomeDir, '.kimi-code', 'device_id');
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(credentialsPath, `${JSON.stringify(credentials)}\n`, 'utf8');
  fs.writeFileSync(deviceIdPath, `${deviceId}\n`, 'utf8');
  const mtimeSeconds = mtimeMs / 1000;
  fs.utimesSync(credentialsPath, mtimeSeconds, mtimeSeconds);
  fs.utimesSync(deviceIdPath, mtimeSeconds, mtimeSeconds);
}

test('Kimi reconciler adopts a newer non-AIH host token for the same user and device', (t) => {
  const databaseCredentials = makeCredentials('kimi-user-1', 'ai-h-device', 1000);
  const hostCredentials = makeCredentials('kimi-user-1', 'host-device', 2000);
  const fixture = createFixture(t, databaseCredentials);
  writeHostSnapshot(fixture, hostCredentials, 'host-device');

  const reconcile = createKimiHostCredentialReconciler({
    fs,
    path,
    aiHomeDir: fixture.aiHomeDir,
    hostHomeDir: fixture.hostHomeDir
  });
  const result = reconcile(fixture.accountRef);

  assert.equal(result.ok, true);
  assert.equal(result.adopted, true);
  assert.equal(result.reason, 'host_credentials_newer');
  assert.deepEqual(readAccountNativeAuth(fs, fixture.aiHomeDir, fixture.accountRef), {
    credentials: hostCredentials,
    deviceId: 'host-device'
  });
});

test('Kimi reconciler adopts over a refreshable legacy DB snapshot behind an empty canonical shell', (t) => {
  const databaseCredentials = makeCredentials('kimi-user-legacy', 'legacy-db-device', 1000);
  const hostCredentials = makeCredentials('kimi-user-legacy', 'legacy-host-device', 2000);
  const fixture = createFixture(t, databaseCredentials);
  writeAccountNativeAuth(fs, fixture.aiHomeDir, fixture.accountRef, {
    credentials: {},
    auth: databaseCredentials,
    deviceId: 'legacy-db-device'
  });
  writeHostSnapshot(fixture, hostCredentials, 'legacy-host-device');

  const reconcile = createKimiHostCredentialReconciler({
    fs,
    path,
    aiHomeDir: fixture.aiHomeDir,
    hostHomeDir: fixture.hostHomeDir
  });
  const result = reconcile(fixture.accountRef);

  assert.equal(result.ok, true);
  assert.equal(result.adopted, true);
  assert.equal(result.reason, 'host_credentials_newer');
  assert.deepEqual(readAccountNativeAuth(fs, fixture.aiHomeDir, fixture.accountRef), {
    credentials: hostCredentials,
    deviceId: 'legacy-host-device'
  });
});

test('Kimi reconciler rejects a host snapshot belonging to another user', (t) => {
  const databaseCredentials = makeCredentials('kimi-user-1', 'ai-h-device', 2000);
  const hostCredentials = makeCredentials('kimi-user-2', 'host-device', 3000);
  const fixture = createFixture(t, databaseCredentials);
  writeHostSnapshot(fixture, hostCredentials, 'host-device');

  const reconcile = createKimiHostCredentialReconciler({
    fs,
    path,
    aiHomeDir: fixture.aiHomeDir,
    hostHomeDir: fixture.hostHomeDir
  });
  const result = reconcile(fixture.accountRef);

  assert.equal(result.ok, true);
  assert.equal(result.adopted, false);
  assert.equal(result.reason, 'host_identity_mismatch');
  assert.deepEqual(readAccountNativeAuth(fs, fixture.aiHomeDir, fixture.accountRef), {
    credentials: databaseCredentials
  });
});

test('Kimi reconciler fails closed when host device_id disagrees with the token claim', (t) => {
  const databaseCredentials = makeCredentials('kimi-user-1', 'ai-h-device', 1000);
  const hostCredentials = makeCredentials('kimi-user-1', 'token-device', 2000);
  const fixture = createFixture(t, databaseCredentials);
  writeHostSnapshot(fixture, hostCredentials, 'file-device');

  const hostRecord = readKimiHostCredentialRecord(
    fs,
    fixture.hostHomeDir,
    path
  );
  assert.deepEqual(hostRecord, { ok: false, reason: 'host_device_id_mismatch' });

  const reconcile = createKimiHostCredentialReconciler({
    fs,
    path,
    aiHomeDir: fixture.aiHomeDir,
    hostHomeDir: fixture.hostHomeDir
  });
  const result = reconcile(fixture.accountRef);
  assert.deepEqual(result, { ok: false, reason: 'host_device_id_mismatch' });
  assert.deepEqual(readAccountNativeAuth(fs, fixture.aiHomeDir, fixture.accountRef), {
    credentials: databaseCredentials
  });
});

test('Kimi reconciler keeps an older host snapshot and does not overwrite the DB', (t) => {
  const databaseCredentials = makeCredentials('kimi-user-1', 'ai-h-device', 3000);
  const hostCredentials = makeCredentials('kimi-user-1', 'host-device', 2000);
  const fixture = createFixture(t, databaseCredentials);
  writeHostSnapshot(fixture, hostCredentials, 'host-device', Date.now() - 5000);

  const reconcile = createKimiHostCredentialReconciler({
    fs,
    path,
    aiHomeDir: fixture.aiHomeDir,
    hostHomeDir: fixture.hostHomeDir
  });
  const result = reconcile(fixture.accountRef);

  assert.equal(result.ok, true);
  assert.equal(result.adopted, false);
  assert.equal(result.reason, 'host_snapshot_not_newer');
  assert.deepEqual(readAccountNativeAuth(fs, fixture.aiHomeDir, fixture.accountRef), {
    credentials: databaseCredentials
  });
});
