const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  landOnAihServerDefault,
  readAihServerDefault,
  supportsAihServerDefault,
  writeAihServerDefaultSlot
} = require('../lib/account/host-default-landing');
const { AIH_SERVER_PROFILE_ID } = require('../lib/account/provider-profile-id');

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-host-default-landing-'));
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { aiHomeDir };
}

test('landing on the AIH Server default syncs the gateway profile and records the aih_server slot', (t) => {
  const fixture = createFixture(t);
  const syncCalls = [];
  const result = landOnAihServerDefault({
    fs,
    aiHomeDir: fixture.aiHomeDir,
    provider: 'codex',
    syncGlobalConfigToHost(...args) {
      syncCalls.push(args);
      return { ok: true, gateway: true };
    }
  });

  assert.deepEqual(syncCalls, [['codex', '', { gateway: true }]]);
  assert.equal(result.ok, true);
  assert.equal(result.landed, true);
  assert.equal(result.profile, AIH_SERVER_PROFILE_ID);
  assert.equal(result.alreadyLanded, false);
  assert.equal(readAihServerDefault(fs, fixture.aiHomeDir, 'codex'), AIH_SERVER_PROFILE_ID);
});

test('landing is idempotent and reports an already landed slot', (t) => {
  const fixture = createFixture(t);
  const sync = () => ({ ok: true, gateway: true });
  landOnAihServerDefault({ fs, aiHomeDir: fixture.aiHomeDir, provider: 'claude', syncGlobalConfigToHost: sync });
  const second = landOnAihServerDefault({
    fs,
    aiHomeDir: fixture.aiHomeDir,
    provider: 'claude',
    syncGlobalConfigToHost: sync
  });

  assert.equal(second.landed, true);
  assert.equal(second.alreadyLanded, true);
  assert.equal(readAihServerDefault(fs, fixture.aiHomeDir, 'claude'), AIH_SERVER_PROFILE_ID);
});

test('a provider without a gateway profile has no AIH Server default to land on', (t) => {
  const fixture = createFixture(t);
  const syncCalls = [];
  const result = landOnAihServerDefault({
    fs,
    aiHomeDir: fixture.aiHomeDir,
    provider: 'gemini',
    syncGlobalConfigToHost(...args) {
      syncCalls.push(args);
      return { ok: true };
    }
  });

  assert.equal(supportsAihServerDefault('gemini'), false);
  assert.equal(result.ok, true);
  assert.equal(result.landed, false);
  assert.equal(result.reason, 'gateway_profile_not_supported');
  assert.deepEqual(syncCalls, []);
  assert.equal(readAihServerDefault(fs, fixture.aiHomeDir, 'gemini'), '');
});

test('a failed host sync leaves the provider slot untouched', (t) => {
  const fixture = createFixture(t);
  const result = landOnAihServerDefault({
    fs,
    aiHomeDir: fixture.aiHomeDir,
    provider: 'codex',
    syncGlobalConfigToHost: () => ({ ok: false, reason: 'codex_gateway_config_sync_failed' })
  });

  assert.equal(result.ok, false);
  assert.equal(result.landed, false);
  assert.equal(result.reason, 'codex_gateway_config_sync_failed');
  assert.equal(readAihServerDefault(fs, fixture.aiHomeDir, 'codex'), '');
});

test('landing fails closed without a host syncer or an ai_home scope', (t) => {
  const fixture = createFixture(t);
  const noSyncer = landOnAihServerDefault({
    fs,
    aiHomeDir: fixture.aiHomeDir,
    provider: 'codex'
  });
  const noScope = landOnAihServerDefault({
    fs,
    aiHomeDir: '',
    provider: 'codex',
    syncGlobalConfigToHost: () => ({ ok: true })
  });

  assert.equal(noSyncer.ok, false);
  assert.equal(noSyncer.reason, 'host_sync_unavailable');
  assert.equal(noScope.ok, false);
  assert.equal(noScope.reason, 'host_scope_unavailable');
  assert.equal(readAihServerDefault(fs, fixture.aiHomeDir, 'codex'), '');
});

// 档位写入是「无默认 ⇒ AIH Server」的唯一实现处，revoke 与 WebUI 路由共用。
test('the aih_server slot writer only accepts gateway-profile providers', (t) => {
  const fixture = createFixture(t);

  assert.equal(writeAihServerDefaultSlot(fs, fixture.aiHomeDir, 'codex'), true);
  assert.equal(readAihServerDefault(fs, fixture.aiHomeDir, 'codex'), AIH_SERVER_PROFILE_ID);
  assert.equal(writeAihServerDefaultSlot(fs, fixture.aiHomeDir, 'gemini'), false);
  assert.equal(readAihServerDefault(fs, fixture.aiHomeDir, 'gemini'), '');
  assert.equal(writeAihServerDefaultSlot(fs, '', 'codex'), false);
});
