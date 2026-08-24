'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readAccountEgressBinding,
  writeAccountEgressBinding
} = require('../lib/account/zcode-egress-binding-store');
const {
  buildProviderRuntimeEnv
} = require('../lib/cli/services/ai-cli/provider-runtime-env');
const {
  listProviderDefinitions,
  listProviderIds
} = require('../lib/provider-catalog');
const {
  PROXY_ENV_KEYS,
  decorateAccountEgressChromiumPlan
} = require('../lib/runtime/account-egress-proxy');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const {
  isEgressSupportedProvider,
  resolveAccountEgressRequestOptions
} = require('../lib/server/zcode-egress-service');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const LOOPBACK_PROXY_SERVER = '127.0.0.1:23109';
const LOOPBACK_PROXY_URL = `http://${LOOPBACK_PROXY_SERVER}`;

function inheritedProxyEnv() {
  return Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, 'http://host-proxy.example:7890']));
}

function assertNoProxyEnv(env, provider) {
  for (const key of PROXY_ENV_KEYS) {
    assert.equal(env[key], undefined, `${provider}:${key}`);
  }
}

function assertLoopbackProxyEnv(env, provider) {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    assert.equal(env[key], LOOPBACK_PROXY_URL, `${provider}:${key}`);
  }
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1', `${provider}:NO_PROXY`);
  assert.equal(env.no_proxy, env.NO_PROXY, `${provider}:no_proxy`);
}

test('账号出口支持范围动态跟随 Provider manifest，默认绑定可写入、读取并解除', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-egress-provider-matrix-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const providerIds = listProviderIds();
  assert.ok(providerIds.length > 0);
  for (const [index, provider] of providerIds.entries()) {
    assert.equal(isEgressSupportedProvider(provider), true, provider);
    const accountRef = upsertAccountRef(fs, aiHomeDir, {
      provider,
      cliAccountId: String(index + 1),
      identitySeed: `oauth:${provider}:egress-provider-matrix@example.com`
    });
    assert.ok(accountRef, provider);
    assert.equal(readAccountEgressBinding(fs, aiHomeDir, accountRef), null, provider);

    writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
      mode: 'url',
      proxyUrl: 'socks5://proxy.example:1080'
    }, 1234);
    assert.deepEqual(readAccountEgressBinding(fs, aiHomeDir, accountRef), {
      mode: 'url',
      proxyUrl: 'socks5://proxy.example:1080',
      nodeId: '',
      groupId: '',
      updatedAt: 1234
    }, provider);

    writeAccountEgressBinding(fs, aiHomeDir, accountRef, null);
    assert.equal(readAccountEgressBinding(fs, aiHomeDir, accountRef), null, provider);
  }
  assert.equal(isEgressSupportedProvider('unknown-provider'), false);
});

test('所有 CLI Provider 默认清除继承代理，绑定后只注入账号固定回环代理', () => {
  const cliProviders = listProviderDefinitions()
    .filter((definition) => definition.clients.cli)
    .map((definition) => definition.id);
  assert.ok(cliProviders.length > 0);

  for (const provider of cliProviders) {
    const profileDir = `/tmp/aih-account-egress/${provider}/${ACCOUNT_REF}`;
    const baseEnv = {
      HOME: '/Users/tester',
      PATH: '/usr/bin',
      ...inheritedProxyEnv()
    };
    const commonOptions = {
      fs,
      path,
      platform: 'darwin',
      accountRef: ACCOUNT_REF,
      accountEnv: {},
      launchKind: 'cli'
    };

    const unbound = buildProviderRuntimeEnv(provider, profileDir, baseEnv, {
      ...commonOptions,
      accountEgress: null
    });
    assertNoProxyEnv(unbound, provider);

    const bound = buildProviderRuntimeEnv(provider, profileDir, baseEnv, {
      ...commonOptions,
      accountEgress: { ok: true, proxyServer: LOOPBACK_PROXY_SERVER }
    });
    assertLoopbackProxyEnv(bound, provider);
  }
});

test('所有 Desktop Provider 共用账号出口边界，ZCode 保持原生 setting.json 单一真相源', () => {
  const desktopProviders = listProviderDefinitions()
    .filter((definition) => definition.clients.desktop)
    .map((definition) => definition.id);
  assert.ok(desktopProviders.includes('zcode'));

  for (const provider of desktopProviders) {
    const profileDir = `/tmp/aih-account-egress/${provider}/${ACCOUNT_REF}`;
    const env = buildProviderRuntimeEnv(provider, profileDir, {
      HOME: '/Users/tester',
      PATH: '/usr/bin',
      ...inheritedProxyEnv()
    }, {
      fs,
      path,
      platform: 'darwin',
      accountRef: ACCOUNT_REF,
      accountEnv: {},
      launchKind: 'desktop',
      accountEgress: { ok: true, proxyServer: LOOPBACK_PROXY_SERVER }
    });
    const plan = decorateAccountEgressChromiumPlan({
      file: `/Applications/${provider}.app/Contents/MacOS/${provider}`,
      args: ['--user-data-dir=/tmp/aih-account-egress/electron-user-data']
    }, provider, {
      ok: true,
      proxyServer: LOOPBACK_PROXY_SERVER
    });

    if (provider === 'zcode') {
      assertNoProxyEnv(env, provider);
      assert.equal(plan.args.some((arg) => arg.startsWith('--proxy-server=')), false, provider);
      continue;
    }
    assertLoopbackProxyEnv(env, provider);
    assert.ok(plan.args.includes(`--proxy-server=${LOOPBACK_PROXY_URL}`), provider);
    assert.ok(plan.args.includes('--proxy-bypass-list=localhost;127.0.0.1;[::1]'), provider);
  }
});

test('所有 Provider 的 Gateway attempt 都支持绑定、默认未绑定与 fail-closed', async () => {
  const baseOptions = {
    proxyUrl: 'http://global-proxy.example:7890',
    noProxy: 'upstream.example'
  };

  for (const provider of listProviderIds()) {
    const bound = await resolveAccountEgressRequestOptions({
      fs: {},
      aiHomeDir: '/tmp/aih-account-egress-provider-matrix',
      provider,
      accountRef: ACCOUNT_REF,
      options: baseOptions,
      deps: {
        resolveAccountEgress: async () => ({
          ok: true,
          proxyServer: LOOPBACK_PROXY_SERVER,
          source: 'url'
        })
      }
    });
    assert.equal(bound.ok, true, provider);
    assert.equal(bound.bound, true, provider);
    assert.equal(bound.options.proxyUrl, LOOPBACK_PROXY_URL, provider);
    assert.equal(bound.options.noProxy, 'localhost,127.0.0.1,::1', provider);

    const unbound = await resolveAccountEgressRequestOptions({
      fs: {},
      aiHomeDir: '/tmp/aih-account-egress-provider-matrix',
      provider,
      accountRef: ACCOUNT_REF,
      options: baseOptions,
      deps: { resolveAccountEgress: async () => null }
    });
    assert.equal(unbound.ok, true, provider);
    assert.equal(unbound.bound, false, provider);
    assert.deepEqual(unbound.options, baseOptions, provider);

    const unavailable = await resolveAccountEgressRequestOptions({
      fs: {},
      aiHomeDir: '/tmp/aih-account-egress-provider-matrix',
      provider,
      accountRef: ACCOUNT_REF,
      options: baseOptions,
      deps: {
        resolveAccountEgress: async () => ({
          ok: false,
          error: 'proxy_unreachable',
          reason: 'connection refused'
        })
      }
    });
    assert.equal(unavailable.ok, false, provider);
    assert.equal(unavailable.bound, true, provider);
    assert.equal(unavailable.error, 'account_egress_unavailable', provider);
    assert.equal(unavailable.egressError, 'proxy_unreachable', provider);
    assert.equal(Object.prototype.hasOwnProperty.call(unavailable, 'options'), false, provider);
  }
});
