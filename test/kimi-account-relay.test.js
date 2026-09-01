'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildKimiAccountRelayEnv,
  kimiRelayProfile,
  shouldRelayKimiAccount
} = require('../lib/cli/services/ai-cli/relay/kimi-relay-profile');
const { getCliRelayProfile } = require('../lib/cli/services/ai-cli/relay/cli-relay-profile');
const {
  DEFAULT_KIMI_CONFIG,
  DEFAULT_KIMI_RELAY_BASE_URL,
  buildKimiRelayConfig,
  prepareKimiConfig
} = require('../lib/cli/services/ai-cli/launch-profile/kimi-config');
const {
  resolveProviderRuntimeScope
} = require('../lib/cli/services/ai-cli/provider-runtime-env');

const ACCOUNT_REF = 'acct_1234567890abcdef1234';

test('CliRelayProfile registry dispatches per provider without name branches', () => {
  assert.equal(getCliRelayProfile('kimi'), kimiRelayProfile);
  assert.equal(getCliRelayProfile(' KIMI '), kimiRelayProfile);
  assert.equal(getCliRelayProfile('claude').provider, 'claude');
  assert.equal(getCliRelayProfile('codex').provider, 'codex');
  assert.equal(getCliRelayProfile('opencode').provider, 'opencode');
  assert.equal(getCliRelayProfile('gemini'), null);
  assert.equal(getCliRelayProfile(''), null);
});

test('Kimi native OAuth accounts relay through the gateway by accountRef', () => {
  assert.equal(shouldRelayKimiAccount({
    provider: 'kimi',
    accountRef: ACCOUNT_REF,
    accountEnv: {}
  }), true);

  assert.deepEqual(buildKimiAccountRelayEnv({
    KIMI_API_KEY: 'gateway-key',
    KIMI_BASE_URL: 'http://127.0.0.1:9527/v1'
  }, ACCOUNT_REF), {
    KIMI_API_KEY: 'gateway-key',
    KIMI_BASE_URL: 'http://127.0.0.1:9527/v1',
    KIMI_CODE_CUSTOM_HEADERS: `x-account-ref: ${ACCOUNT_REF}`
  });
});

test('Kimi relay is disabled for gateway, login, and direct API key modes', () => {
  const base = { provider: 'kimi', accountRef: ACCOUNT_REF, accountEnv: {} };
  assert.equal(shouldRelayKimiAccount({ ...base, gateway: true }), false);
  assert.equal(shouldRelayKimiAccount({ ...base, isLogin: true }), false);
  assert.equal(shouldRelayKimiAccount({
    ...base,
    accountEnv: { MOONSHOT_API_KEY: 'direct-key' }
  }), false);
  assert.equal(shouldRelayKimiAccount({ ...base, provider: 'claude' }), false);
});

test('Kimi relay rejects mutable CLI ids and appends to existing custom headers', () => {
  assert.equal(shouldRelayKimiAccount({
    provider: 'kimi',
    accountRef: '9',
    accountEnv: {}
  }), false);
  assert.throws(
    () => buildKimiAccountRelayEnv({}, '9'),
    /invalid_kimi_relay_account_ref/
  );

  const env = buildKimiAccountRelayEnv({
    KIMI_CODE_CUSTOM_HEADERS: 'X-Trace: abc'
  }, ACCOUNT_REF);
  assert.equal(
    env.KIMI_CODE_CUSTOM_HEADERS,
    `X-Trace: abc\nx-account-ref: ${ACCOUNT_REF}`
  );
});

test('Kimi relay config template drops the oauth block and pins the gateway base url', () => {
  const content = buildKimiRelayConfig('http://127.0.0.1:8317/v1');
  assert.ok(content.includes('type = "kimi"'));
  assert.ok(content.includes('base_url = "http://127.0.0.1:8317/v1"'));
  assert.ok(content.includes('api_key = ""'));
  assert.ok(!content.includes('.oauth]'), 'relay template must not declare oauth');
  // 缺省与非法输入回落默认网关地址，且不允许 TOML 注入。
  assert.ok(buildKimiRelayConfig('').includes(`base_url = "${DEFAULT_KIMI_RELAY_BASE_URL}"`));
  assert.ok(buildKimiRelayConfig('http://x/v1"\n[evil').includes('base_url = "http://x/v1[evil"'));
});

function prepareInSandbox(root, options = {}) {
  const hostHomeDir = path.join(root, 'host');
  const sandboxDir = path.join(root, 'sandbox');
  fs.mkdirSync(hostHomeDir, { recursive: true });
  return {
    sandboxDir,
    configPath: path.join(sandboxDir, '.kimi-code', 'config.toml'),
    result: prepareKimiConfig({
      fs,
      path,
      sandboxDir,
      hostHomeDir,
      baseEnv: options.baseEnv || {},
      authRelayed: options.authRelayed === true,
      gateway: options.gateway === true
    })
  };
}

test('prepareKimiConfig selects the relay template for relayed accounts and gateway profile', () => {
  for (const relayCtx of [{ authRelayed: true }, { gateway: true }]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kimi-relay-config-'));
    try {
      const { result, configPath } = prepareInSandbox(root, {
        ...relayCtx,
        baseEnv: { KIMI_BASE_URL: 'http://127.0.0.1:8317/v1' }
      });
      assert.equal(result.prepared, true);
      assert.equal(result.created, true);
      const content = fs.readFileSync(configPath, 'utf8');
      assert.ok(content.includes('base_url = "http://127.0.0.1:8317/v1"'));
      assert.ok(!content.includes('.oauth]'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('prepareKimiConfig keeps the direct template for API key accounts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kimi-direct-config-'));
  try {
    const { configPath } = prepareInSandbox(root, {});
    assert.equal(fs.readFileSync(configPath, 'utf8'), DEFAULT_KIMI_CONFIG);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prepareKimiConfig upgrades a stale default direct config in relay mode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kimi-relay-upgrade-'));
  try {
    const hostHomeDir = path.join(root, 'host');
    const sandboxDir = path.join(root, 'sandbox');
    const configPath = path.join(sandboxDir, '.kimi-code', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, DEFAULT_KIMI_CONFIG, 'utf8');

    const result = prepareKimiConfig({
      fs,
      path,
      sandboxDir,
      hostHomeDir,
      baseEnv: {},
      authRelayed: true
    });
    assert.equal(result.source, 'relay-upgrade');
    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(!content.includes('.oauth]'));
    assert.ok(content.includes(`base_url = "${DEFAULT_KIMI_RELAY_BASE_URL}"`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Kimi relay keeps the account sandbox while skipping auth projection', () => {
  const hostHomeDir = path.join(os.tmpdir(), 'kimi-relay-host-home');
  const sandboxDir = path.join(os.tmpdir(), 'kimi-relay-sandbox');
  const scope = resolveProviderRuntimeScope('kimi', sandboxDir, { HOME: hostHomeDir }, {
    path,
    hostHomeDir,
    platform: 'darwin',
    accountEnv: {},
    authRelayed: true,
    relayKeepsAccountSandbox: true
  });
  assert.equal(scope.projectionRequired, false);
  assert.equal(scope.runtimeDir, sandboxDir);

  // claude relay 形态对照：不保留沙箱，回落宿主 HOME（行为不变）。
  const claudeScope = resolveProviderRuntimeScope('claude', sandboxDir, { HOME: hostHomeDir }, {
    path,
    hostHomeDir,
    platform: 'darwin',
    accountEnv: {},
    authRelayed: true
  });
  assert.equal(claudeScope.projectionRequired, false);
  assert.equal(claudeScope.runtimeDir, hostHomeDir);

  // 裸网关 profile（aih kimi 无账号）：同样留在隔离目录（网关 runtime 目录），
  // 不能回落宿主 HOME，否则 relay 模板会写进真实 ~/.kimi-code 或被其中的
  // oauth 块旁路。
  const gatewayDir = path.join(os.tmpdir(), 'kimi-relay-gateway');
  const gatewayScope = resolveProviderRuntimeScope('kimi', gatewayDir, { HOME: hostHomeDir }, {
    path,
    hostHomeDir,
    platform: 'darwin',
    accountEnv: { KIMI_API_KEY: 'dummy', KIMI_BASE_URL: 'http://127.0.0.1:9527/v1' },
    gateway: true,
    relayKeepsAccountSandbox: true
  });
  assert.equal(gatewayScope.projectionRequired, false);
  assert.equal(gatewayScope.runtimeDir, gatewayDir);

  // claude 网关 profile 对照：无保留沙箱标记，仍回落宿主 HOME（行为不变）。
  const claudeGatewayScope = resolveProviderRuntimeScope('claude', gatewayDir, { HOME: hostHomeDir }, {
    path,
    hostHomeDir,
    platform: 'darwin',
    accountEnv: {},
    gateway: true
  });
  assert.equal(claudeGatewayScope.projectionRequired, false);
  assert.equal(claudeGatewayScope.runtimeDir, hostHomeDir);
});

test('Kimi relay env survives host env stripping as account-scoped values', () => {
  const { buildProviderRuntimeEnv } = require('../lib/cli/services/ai-cli/provider-runtime-env');
  const hostHomeDir = path.join(os.tmpdir(), 'kimi-relay-env-host');
  const sandboxDir = path.join(os.tmpdir(), 'kimi-relay-env-sandbox');
  const relayEnv = buildKimiAccountRelayEnv({
    KIMI_API_KEY: 'dummy',
    KIMI_BASE_URL: 'http://127.0.0.1:9527/v1'
  }, ACCOUNT_REF);
  const env = buildProviderRuntimeEnv('kimi', sandboxDir, {
    HOME: hostHomeDir,
    MOONSHOT_API_KEY: 'host-secret',
    KIMI_API_KEY: 'host-key',
    KIMI_BASE_URL: 'https://api.kimi.com/coding/v1',
    KIMI_CODE_CUSTOM_HEADERS: 'X-Host: leak'
  }, {
    path,
    hostHomeDir,
    platform: 'darwin',
    accountEnv: relayEnv
  });

  assert.equal(env.MOONSHOT_API_KEY, undefined);
  assert.equal(env.KIMI_API_KEY, 'dummy');
  assert.equal(env.KIMI_BASE_URL, 'http://127.0.0.1:9527/v1');
  assert.equal(env.KIMI_CODE_CUSTOM_HEADERS, `x-account-ref: ${ACCOUNT_REF}`);
  assert.equal(env.KIMI_CODE_HOME, path.join(sandboxDir, '.kimi-code'));
});
