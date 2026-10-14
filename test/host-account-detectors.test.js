'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  HOST_ACCOUNT_DETECTORS,
  detectHostAccounts,
  hostAccountDetectionProviders,
  isHostAccountDetectionSupported,
  runHostAccountDetectors
} = require('../lib/account/host-account-detectors');
const { CLINE_CREDENTIAL_PATH, clineAuth, providersDocument } = require('./helpers/cline-credential');

test('the detection capability list is the single source of truth for callers', () => {
  // WebUI 路由与 `aih <cli> detect` 都读这份列表，不再各自写死 provider 名。
  assert.deepEqual(hostAccountDetectionProviders(),
    ['codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn', 'cline']);
  for (const provider of ['codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn', 'cline']) {
    assert.equal(isHostAccountDetectionSupported(provider), true, `${provider} 必须可扫描`);
  }
  for (const provider of ['codex', 'claude', 'agy', 'gemini', '']) {
    assert.equal(isHostAccountDetectionSupported(provider), false, `${provider} 不该被声明为可扫描`);
  }
  assert.deepEqual(HOST_ACCOUNT_DETECTORS.map(detector => detector.id), ['codebuddy-family', 'cline']);
});

test('a host Cline login is discovered through the shared detection entry point', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-host-detect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, 'aih');
  const hostHomeDir = path.join(root, 'home');
  const hostFile = path.join(hostHomeDir, ...CLINE_CREDENTIAL_PATH);
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.mkdirSync(path.dirname(hostFile), { recursive: true });
  fs.writeFileSync(hostFile, JSON.stringify(providersDocument('cline-pass', clineAuth('cline-user-1', 1))));

  const result = detectHostAccounts({ fs, aiHomeDir, hostHomeDir });
  assert.equal(result.ok, true);
  assert.equal(result.updated, 1);
  assert.equal(result.accounts.cline, 1);
  // 家族检测器照常参与（本机没有家族凭据 → 计数 0），不是被 cline 挤掉。
  assert.equal(result.accounts.codebuddy, 0);
  assert.deepEqual(result.registered.map(item => item.created), [true]);
  // 第二次幂等：按钮可以放心连点。
  const second = detectHostAccounts({ fs, aiHomeDir, hostHomeDir });
  assert.equal(second.updated, 0);
  assert.equal(second.accounts.cline, 1);
});

test('detection fails closed when the scan cannot run at all', () => {
  const result = detectHostAccounts({});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'detect_host_accounts_unavailable');
  assert.equal(result.updated, 0);
});

test('one broken detector never hides the others, and its reason stays observable', () => {
  const detectors = [
    { id: 'broken', providers: ['p-broken'], detect: () => { throw new Error('boom'); } },
    { id: 'unavailable', providers: ['p-unavailable'], detect: () => ({ ok: false, error: 'detector_unavailable' }) },
    {
      id: 'healthy',
      providers: ['p-healthy'],
      detect: () => ({
        ok: true,
        scanned: 3,
        updated: 2,
        reloaded: true,
        registered: [{ accountRef: 'acct_a', cliAccountId: '1', created: true }],
        skipped: [{ reason: 'older_credential', provider: 'p-healthy', source: 'x' }],
        accounts: { 'p-healthy': 4, 'p-healthy-cn': 0 }
      })
    }
  ];
  const merged = runHostAccountDetectors(detectors, {});
  assert.equal(merged.ok, true);
  assert.equal(merged.scanned, 3);
  assert.equal(merged.updated, 2);
  assert.equal(merged.reloaded, true);
  assert.equal(merged.registered.length, 1);
  assert.deepEqual(merged.accounts, { 'p-healthy': 4, 'p-healthy-cn': 0 });
  assert.deepEqual(merged.skipped.map(item => item.reason),
    ['host_account_detector_failed', 'detector_unavailable', 'older_credential']);
  // 全部检测器都跑不起来时才整体失败（调用方要能报错，而不是「扫过了没发现」）。
  const allBroken = runHostAccountDetectors([
    { id: 'a', providers: ['p-a'], detect: () => { throw new Error('boom'); } }
  ], {});
  assert.equal(allBroken.ok, false);
  assert.equal(allBroken.error, 'detect_host_accounts_unavailable');
});
