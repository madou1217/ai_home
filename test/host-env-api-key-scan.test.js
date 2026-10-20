'use strict';

// 宿主 API Key **环境变量**扫描回归。
//
// 守的缺口：grok / kimi / zcode 等 CLI 的 API Key 只存在于环境变量（不写宿主文件），
// 宿主文件扫描（hostApiKeySlots）天然覆盖不到。这里钉住：覆盖面来自合同（不维护名单）、
// 入库与手工添加同源（不重复）、aih 自己注入的 client key 不被扫回来、删除墓碑生效、
// 后台 Server 看得到登录 shell 里 export 的 key。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detectHostAccounts } = require('../lib/account/host-account-detectors');
const { createGenericHostAccountSync } = require('../lib/account/host-account-sync/generic-host-account-sync');
const { listEnvApiKeyProviders, readLoginShellEnv } = require('../lib/account/host-api-key-env-scan');
const { deleteAccountRef } = require('../lib/server/account-ref-store');
const store = require('../lib/server/account-credential-store');

const CLIENT_KEY = 'aih-client-key-0123456789';

function fixture(t, processEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-env-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, 'aih');
  const hostHomeDir = path.join(root, 'home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.mkdirSync(hostHomeDir, { recursive: true });
  const readServerConfig = () => ({ host: '127.0.0.1', port: 9527, apiKey: CLIENT_KEY });
  const env = { ...processEnv };
  // loginShell:false：测试不起真实 shell，环境完全由 processEnv 决定。
  const detect = () => detectHostAccounts({ fs, aiHomeDir, hostHomeDir, readServerConfig, processEnv: env, loginShell: false });
  const records = (provider) => store.listAccountCredentialRecords(fs, aiHomeDir, provider);
  return { aiHomeDir, hostHomeDir, env, detect, records, readServerConfig };
}

test('覆盖面来自合同：只存在于环境变量的 grok / kimi / zcode 都在扫描范围内', () => {
  const providers = listEnvApiKeyProviders();
  for (const provider of ['grok', 'kimi', 'zcode']) {
    assert.ok(providers.includes(provider), `${provider} 应被环境变量扫描覆盖`);
  }
  // 没有 api-key 认证方式的 provider 不进来（kiro / agy 只有 OAuth）。
  assert.equal(providers.includes('kiro'), false);
  assert.equal(providers.includes('agy'), false);
});

test('环境变量里的 API Key 入库成 API Key 账号，凭据变量与手工添加一致', (t) => {
  const f = fixture(t, {
    XAI_API_KEY: 'xai-env-key-1',
    MOONSHOT_API_KEY: 'sk-env-kimi-1',
    KIMI_BASE_URL: 'https://api.moonshot.cn/v1',
    ZCODE_API_KEY: 'zcode-env-key-1'
  });
  const result = f.detect();
  assert.equal(result.ok, true);
  assert.deepEqual(store.readAccountCredentials(fs, f.aiHomeDir, f.records('grok')[0].accountRef),
    { XAI_API_KEY: 'xai-env-key-1' });
  assert.deepEqual(store.readAccountCredentials(fs, f.aiHomeDir, f.records('kimi')[0].accountRef),
    { MOONSHOT_API_KEY: 'sk-env-kimi-1', KIMI_BASE_URL: 'https://api.moonshot.cn/v1' });
  assert.deepEqual(store.readAccountCredentials(fs, f.aiHomeDir, f.records('zcode')[0].accountRef),
    { ZCODE_API_KEY: 'zcode-env-key-1' });
  // 再扫一次不出第二个账号。
  f.detect();
  assert.equal(f.records('grok').length, 1);
  assert.equal(f.records('kimi').length, 1);
  assert.equal(f.records('zcode').length, 1);
});

test('先手工添加、后被环境变量扫到：同一把 key 不会出第二个账号', (t) => {
  const { configureApiKeyAccount } = require('../lib/server/web-account-auth-account-config');
  const f = fixture(t, { XAI_API_KEY: 'xai-shared-key' });
  configureApiKeyAccount({ fs, provider: 'grok', config: { apiKey: 'xai-shared-key' }, aiHomeDir: f.aiHomeDir });
  assert.equal(f.records('grok').length, 1);
  const result = f.detect();
  assert.equal(f.records('grok').length, 1);
  assert.equal(result.registered.filter((item) => item.provider === 'grok').length, 0);
});

test('覆盖面上的每个 provider 都真的能入库（不留「声明了却算不出身份」的半截）', (t) => {
  const { listEnvApiKeySpecs } = require('../lib/account/host-api-key-env-scan');
  for (const spec of listEnvApiKeySpecs()) {
    const f = fixture(t, { [spec.apiKeys[0]]: `probe-key-${spec.provider}-0123456789` });
    const result = f.detect();
    const reasons = result.skipped.filter((item) => item.provider === spec.provider).map((item) => item.reason);
    assert.equal(f.records(spec.provider).length, 1, `${spec.provider} 应入库，实际跳过原因：${reasons.join(',')}`);
  }
});

test('opencode：与手工添加一样写原生 auth.json 条目，且与手工添加互认同一账号', (t) => {
  const { configureApiKeyAccount } = require('../lib/server/web-account-auth-account-config');
  const f = fixture(t, { OPENCODE_API_KEY: 'oc-env-key-1' });
  f.detect();
  const records = f.records('opencode');
  assert.equal(records.length, 1);
  const native = store.readAccountNativeAuth(fs, f.aiHomeDir, records[0].accountRef);
  assert.equal(native.auth.opencode.type, 'api', 'opencode CLI 只认原生 auth.json，env key 启动时会被剥掉');
  assert.equal(native.auth.opencode.key, 'oc-env-key-1');

  // 手工添加同一把 key：身份同算法 → 同一个账号，不重复。
  configureApiKeyAccount({ fs, provider: 'opencode', config: { apiKey: 'oc-env-key-1' }, aiHomeDir: f.aiHomeDir });
  assert.equal(f.records('opencode').length, 1);
});

test('aih 自己的 client key / 指向本机网关的基础地址不会被扫成账号', (t) => {
  // 实机情况：shell 里的 ANTHROPIC_API_KEY 就是 aih 网关 client key（aih 注入给宿主 CLI 用的）。
  const f = fixture(t, {
    ANTHROPIC_API_KEY: CLIENT_KEY,
    OPENAI_API_KEY: 'sk-relay-through-gateway',
    OPENAI_BASE_URL: 'http://127.0.0.1:9527/v1'
  });
  const result = f.detect();
  assert.ok(result.skipped.some((item) => item.provider === 'claude' && item.reason === 'aih_client_key_host_config'));
  assert.ok(result.skipped.some((item) => item.provider === 'codex' && item.reason === 'aih_gateway_host_config'));
  assert.equal(f.records('claude').length, 0);
  assert.equal(f.records('codex').length, 0);
});

test('用户删掉的环境变量 key 账号不会被扫回来（墓碑）', (t) => {
  const f = fixture(t, { ZCODE_API_KEY: 'zcode-deleted-key' });
  f.detect();
  const accountRef = f.records('zcode')[0].accountRef;
  deleteAccountRef(fs, f.aiHomeDir, accountRef);
  store.deleteAccountCredentials(fs, f.aiHomeDir, accountRef);
  const result = f.detect();
  assert.ok(result.skipped.some((item) => item.provider === 'zcode' && item.reason === 'account_deleted_by_user'));
  assert.equal(f.records('zcode').length, 0);
});

test('后台 Server 看得到登录 shell 里 export 的 key（进程环境优先，登录 shell 补缺）', (t) => {
  const calls = [];
  const execFileSync = (shell, args) => {
    calls.push({ shell, args });
    return 'XAI_API_KEY=xai-from-login-shell\u0000MOONSHOT_API_KEY=\u0000NOT_DECLARED=leak\u0000';
  };
  const values = readLoginShellEnv(['MOONSHOT_API_KEY', 'XAI_API_KEY'], { execFileSync, shell: '/bin/zsh', platform: 'darwin' });
  assert.deepEqual(values, { XAI_API_KEY: 'xai-from-login-shell' }, '只收声明的变量名、丢弃空值');
  assert.equal(calls[0].shell, '/bin/zsh');
  assert.deepEqual(calls[0].args.slice(0, 2), ['-l', '-i']);

  // 端到端：进程环境里没有，登录 shell 里有 → 入库。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-env-scan-login-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, 'aih');
  const hostHomeDir = path.join(root, 'home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.mkdirSync(hostHomeDir, { recursive: true });
  detectHostAccounts({
    fs, aiHomeDir, hostHomeDir,
    readServerConfig: () => ({ port: 9527, apiKey: CLIENT_KEY }),
    processEnv: {},
    execFileSync,
    shell: '/bin/zsh',
    platform: 'darwin'
  });
  const records = store.listAccountCredentialRecords(fs, aiHomeDir, 'grok');
  assert.equal(records.length, 1);
  assert.equal(store.readAccountCredentials(fs, aiHomeDir, records[0].accountRef).XAI_API_KEY, 'xai-from-login-shell');
});

test('登录 shell 不可用（超时 / 缺失 / Windows）时降级为空，不影响其它来源', () => {
  const failing = () => { throw new Error('timeout'); };
  assert.deepEqual(readLoginShellEnv(['XAI_API_KEY'], { execFileSync: failing, platform: 'darwin' }), {});
  assert.deepEqual(readLoginShellEnv(['XAI_API_KEY'], { execFileSync: failing, platform: 'win32' }), {});
  assert.deepEqual(readLoginShellEnv([], { execFileSync: failing }), {});
});

test('后台观察者：环境变量来源限频，key 变化后在下一个窗口自动入库', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-env-scan-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, 'aih');
  const hostHomeDir = path.join(root, 'home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  fs.mkdirSync(hostHomeDir, { recursive: true });
  const processEnv = {};
  let clock = 1_000_000;
  const sync = createGenericHostAccountSync({
    fs, aiHomeDir, hostHomeDir,
    readServerConfig: () => ({ port: 9527, apiKey: CLIENT_KEY }),
    processEnv,
    loginShell: false,
    envScanIntervalMs: 60_000,
    now: () => clock
  });
  sync.scan({ gated: true });
  assert.equal(store.listAccountCredentialRecords(fs, aiHomeDir, 'kimi').length, 0);

  processEnv.MOONSHOT_API_KEY = 'sk-new-env-kimi';
  clock += 5_000;
  sync.scan({ gated: true });
  assert.equal(store.listAccountCredentialRecords(fs, aiHomeDir, 'kimi').length, 0, '限频窗口内不重读环境');

  clock += 60_000;
  const result = sync.scan({ gated: true });
  assert.equal(store.listAccountCredentialRecords(fs, aiHomeDir, 'kimi').length, 1);
  assert.ok(result.updated.some((event) => event.provider === 'kimi'));
});
