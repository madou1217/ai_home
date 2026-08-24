'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  EGRESS_MODE_GROUP,
  EGRESS_MODE_NODE,
  EGRESS_MODE_POOL,
  EGRESS_MODE_SYSTEM,
  EGRESS_MODE_TUN,
  EGRESS_MODE_URL,
  buildEgressBindingKey,
  normalizeEgressBinding,
  readAccountEgressBinding,
  writeAccountEgressBinding
} = require('../lib/account/zcode-egress-binding-store');
const { writeJsonValue } = require('../lib/server/app-state-store');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const {
  SUPPORTED_PLATFORM,
  normalizeProxyUrl,
  resolveZcodeEgress
} = require('../lib/server/zcode-egress-resolver');
const {
  DEFAULT_NO_PROXY
} = require('../lib/server/zcode-native-proxy-values');
const {
  describeEgressWarning,
  isEgressSupportedProvider,
  launchAccountAppWithEgress,
  prepareAccountAppEgress,
  resolveAccountEgress
} = require('../lib/server/zcode-egress-service');
const { zcodeDesktopLaunchStrategy } = require('../lib/server/desktop-launch/zcode-strategy');
const {
  prepareZcodeNativeProxySettings,
  resolveZcodeNativeProxyPaths
} = require('../lib/server/zcode-native-proxy-settings');

// ── binding store ───────────────────────────────────────────────────────────

test('buildEgressBindingKey 只接受合法 accountRef', () => {
  assert.equal(buildEgressBindingKey('acct_91aa805bdd051b40fa47'), 'account:egress:acct_91aa805bdd051b40fa47');
  assert.equal(buildEgressBindingKey(''), '');
  assert.equal(buildEgressBindingKey('not-an-account-ref'), '');
});

test('normalizeEgressBinding 按有值的一侧推断 mode', () => {
  assert.equal(normalizeEgressBinding({ proxyUrl: '127.0.0.1:10801' }).mode, EGRESS_MODE_URL);
  assert.equal(normalizeEgressBinding({ nodeId: 'node-a' }).mode, EGRESS_MODE_NODE);
});

test('normalizeEgressBinding 支持 system、tun、url、node、group 五种正式模式', () => {
  assert.deepEqual(normalizeEgressBinding({ mode: EGRESS_MODE_SYSTEM }), {
    mode: EGRESS_MODE_SYSTEM,
    proxyUrl: '',
    nodeId: '',
    groupId: '',
    updatedAt: 0
  });
  assert.deepEqual(normalizeEgressBinding({ mode: EGRESS_MODE_TUN }), {
    mode: EGRESS_MODE_TUN,
    proxyUrl: '',
    nodeId: '',
    groupId: '',
    updatedAt: 0
  });
  assert.equal(normalizeEgressBinding({ mode: EGRESS_MODE_URL, proxyUrl: '127.0.0.1:10801' }).mode, EGRESS_MODE_URL);
  assert.equal(normalizeEgressBinding({ mode: EGRESS_MODE_NODE, nodeId: 'node-a' }).mode, EGRESS_MODE_NODE);
  assert.equal(normalizeEgressBinding({ mode: EGRESS_MODE_GROUP, groupId: 'group-a' }).mode, EGRESS_MODE_GROUP);
});

test('normalizeEgressBinding 把旧 pool 记录迁移成 node 模式并保留兼容常量', () => {
  const binding = normalizeEgressBinding({ mode: EGRESS_MODE_POOL, nodeId: 'node-a' });

  assert.equal(EGRESS_MODE_POOL, 'pool');
  assert.equal(binding.mode, EGRESS_MODE_NODE);
  assert.equal(binding.nodeId, 'node-a');
});

test('normalizeEgressBinding 把半条记录退化成未绑定', () => {
  assert.equal(normalizeEgressBinding({ mode: 'url' }), null, '声明 url 却没填 URL');
  assert.equal(normalizeEgressBinding({ mode: 'pool' }), null, '声明 pool 却没选节点');
  assert.equal(normalizeEgressBinding({ mode: 'node' }), null, '声明 node 却没选节点');
  assert.equal(normalizeEgressBinding({ mode: 'group' }), null, '声明 group 却没选分组');
  assert.equal(
    normalizeEgressBinding({ mode: 'typo', nodeId: 'node-a' }),
    null,
    '只有 mode 缺失时才允许推断，显式未知模式属于损坏记录'
  );
  assert.equal(normalizeEgressBinding(null), null);
  assert.equal(normalizeEgressBinding([]), null);
});

test('normalizeEgressBinding 保留另一侧的值，便于 UI 切换时不丢输入', () => {
  const binding = normalizeEgressBinding({
    mode: 'node',
    nodeId: 'node-a',
    groupId: 'group-a',
    proxyUrl: '1.2.3.4:8080'
  });
  assert.equal(binding.mode, EGRESS_MODE_NODE);
  assert.equal(binding.proxyUrl, '1.2.3.4:8080');
  assert.equal(binding.groupId, 'group-a');
});

test('readAccountEgressBinding 区分未绑定与损坏的持久化记录', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-egress-corrupt-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: '1',
    identitySeed: 'oauth:zcode:corrupt-binding@example.com'
  });

  assert.equal(readAccountEgressBinding(fs, aiHomeDir, accountRef), null);
  writeJsonValue(fs, aiHomeDir, buildEgressBindingKey(accountRef), {
    mode: EGRESS_MODE_URL,
    proxyUrl: ''
  });

  assert.throws(
    () => readAccountEgressBinding(fs, aiHomeDir, accountRef),
    /invalid_account_egress_binding_record/
  );
});

test('writeAccountEgressBinding 拒绝非空非法绑定且不删除已有记录', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-egress-invalid-write-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: '1',
    identitySeed: 'oauth:zcode:invalid-write@example.com'
  });
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_URL,
    proxyUrl: '127.0.0.1:10801'
  });

  assert.throws(
    () => writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
      mode: 'typo',
      nodeId: 'node-a'
    }),
    /invalid_account_egress_binding/
  );
  assert.equal(
    readAccountEgressBinding(fs, aiHomeDir, accountRef).proxyUrl,
    '127.0.0.1:10801'
  );
});

test('writeAccountEgressBinding 只允许真实 ZCode 账号写入绑定', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-egress-provider-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '1',
    identitySeed: 'oauth:codex:zcode-egress-provider@example.com'
  });

  assert.throws(
    () => writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
      mode: EGRESS_MODE_URL,
      proxyUrl: '127.0.0.1:10801'
    }),
    /invalid_zcode_egress_account/
  );
  assert.equal(readAccountEgressBinding(fs, aiHomeDir, accountRef), null);
});

// ── ZCode 原生 setting.json ────────────────────────────────────────────────

test('ZCode 出口实现提供独立的原生设置适配器', () => {
  assert.equal(typeof prepareZcodeNativeProxySettings, 'function');
  assert.equal(typeof resolveZcodeNativeProxyPaths, 'function');
});

test('原生设置适配器安全合并代理字段并保留 ZCode 其它设置', (t) => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-native-proxy-'));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const paths = resolveZcodeNativeProxyPaths(profileDir, path);
  fs.mkdirSync(path.dirname(paths.settingsPath), { recursive: true });
  fs.writeFileSync(paths.settingsPath, `${JSON.stringify({
    locale: 'zh-CN',
    httpProxy: 'http://manual.invalid:9000',
    httpProxyNoProxy: 'manual.local',
    httpProxyCaCertPath: '/keep/custom-ca.pem'
  }, null, 2)}\n`);

  const result = prepareZcodeNativeProxySettings({
    fs,
    path,
    profileDir,
    proxyServer: '127.0.0.1:10801',
    noProxy: DEFAULT_NO_PROXY
  });

  assert.equal(result.ready, true);
  assert.equal(result.status, 'managed');
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8')), {
    locale: 'zh-CN',
    httpProxy: 'http://127.0.0.1:10801',
    httpProxyNoProxy: DEFAULT_NO_PROXY,
    httpProxyCaCertPath: '/keep/custom-ca.pem'
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.markerPath, 'utf8')), {
    version: 1,
    httpProxy: 'http://127.0.0.1:10801',
    httpProxyNoProxy: DEFAULT_NO_PROXY,
    restore: {
      httpProxy: 'http://manual.invalid:9000',
      httpProxyNoProxy: 'manual.local'
    }
  });
});

test('解除 AIH 绑定时恢复绑定前已有的 ZCode 手工代理设置', (t) => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-native-restore-manual-'));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const paths = resolveZcodeNativeProxyPaths(profileDir, path);
  const originalSettings = {
    locale: 'zh-CN',
    httpProxy: 'http://manual.example:8080',
    httpProxyNoProxy: 'manual.local',
    httpProxyCaCertPath: '/keep/custom-ca.pem'
  };
  fs.mkdirSync(path.dirname(paths.settingsPath), { recursive: true });
  fs.writeFileSync(paths.settingsPath, `${JSON.stringify(originalSettings, null, 2)}\n`);

  prepareZcodeNativeProxySettings({
    fs,
    path,
    profileDir,
    proxyServer: '127.0.0.1:10801',
    noProxy: DEFAULT_NO_PROXY
  });
  prepareZcodeNativeProxySettings({ fs, path, profileDir, proxyServer: '' });

  assert.deepEqual(
    JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8')),
    originalSettings,
    'AIH 的临时账号出口不能吞掉用户原来在 ZCode 内维护的代理值'
  );
  assert.equal(fs.existsSync(paths.markerPath), false);
});

test('原生设置适配器缺省使用统一的回环绕过规则', (t) => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-native-default-no-proxy-'));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const paths = resolveZcodeNativeProxyPaths(profileDir, path);

  prepareZcodeNativeProxySettings({
    fs,
    path,
    profileDir,
    proxyServer: '127.0.0.1:10801'
  });

  const settings = JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8'));
  assert.equal(settings.httpProxyNoProxy, DEFAULT_NO_PROXY);
});

test('解绑或出口解析失败时只清除 marker 精确认领的原生代理字段', (t) => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-native-release-'));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const paths = resolveZcodeNativeProxyPaths(profileDir, path);
  fs.mkdirSync(path.dirname(paths.settingsPath), { recursive: true });
  fs.writeFileSync(paths.settingsPath, `${JSON.stringify({ locale: 'zh-CN' }, null, 2)}\n`);
  prepareZcodeNativeProxySettings({
    fs,
    path,
    profileDir,
    proxyServer: '127.0.0.1:10801',
    noProxy: DEFAULT_NO_PROXY
  });

  const result = prepareZcodeNativeProxySettings({ fs, path, profileDir, proxyServer: '' });

  assert.equal(result.ready, true);
  assert.equal(result.status, 'released');
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8')), { locale: 'zh-CN' });
  assert.equal(fs.existsSync(paths.markerPath), false);
});

test('未被 AIH marker 认领的用户代理设置不会因无绑定而被改写', (t) => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-native-user-'));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const paths = resolveZcodeNativeProxyPaths(profileDir, path);
  const manualSettings = {
    locale: 'zh-CN',
    httpProxy: 'http://manual.example:8080',
    httpProxyNoProxy: 'manual.local'
  };
  fs.mkdirSync(path.dirname(paths.settingsPath), { recursive: true });
  fs.writeFileSync(paths.settingsPath, `${JSON.stringify(manualSettings, null, 2)}\n`);

  const result = prepareZcodeNativeProxySettings({ fs, path, profileDir, proxyServer: '' });

  assert.equal(result.status, 'unchanged');
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8')), manualSettings);
});

test('用户手动改过 AIH 托管值后，解绑不会覆盖用户的新值', (t) => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-native-edited-'));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const paths = resolveZcodeNativeProxyPaths(profileDir, path);
  prepareZcodeNativeProxySettings({
    fs,
    path,
    profileDir,
    proxyServer: '127.0.0.1:10801',
    noProxy: DEFAULT_NO_PROXY
  });
  const edited = JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8'));
  edited.httpProxy = 'http://manual.example:8080';
  fs.writeFileSync(paths.settingsPath, `${JSON.stringify(edited, null, 2)}\n`);

  prepareZcodeNativeProxySettings({ fs, path, profileDir, proxyServer: '' });

  assert.deepEqual(JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8')), {
    httpProxy: 'http://manual.example:8080'
  });
  assert.equal(fs.existsSync(paths.markerPath), false);
});

test('切换托管出口时按字段保留用户手改值并恢复另一字段的绑定前值', (t) => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-native-partial-edit-'));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const paths = resolveZcodeNativeProxyPaths(profileDir, path);
  const originalSettings = {
    httpProxy: 'http://manual-old.example:8080',
    httpProxyNoProxy: 'manual.local'
  };
  fs.mkdirSync(path.dirname(paths.settingsPath), { recursive: true });
  fs.writeFileSync(paths.settingsPath, `${JSON.stringify(originalSettings, null, 2)}\n`);

  prepareZcodeNativeProxySettings({
    fs,
    path,
    profileDir,
    proxyServer: '127.0.0.1:10801',
    noProxy: DEFAULT_NO_PROXY
  });
  const partiallyEdited = JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8'));
  partiallyEdited.httpProxy = 'http://manual-new.example:8080';
  fs.writeFileSync(paths.settingsPath, `${JSON.stringify(partiallyEdited, null, 2)}\n`);

  prepareZcodeNativeProxySettings({
    fs,
    path,
    profileDir,
    proxyServer: '127.0.0.1:10802',
    noProxy: DEFAULT_NO_PROXY
  });
  prepareZcodeNativeProxySettings({ fs, path, profileDir, proxyServer: '' });

  assert.deepEqual(JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8')), {
    httpProxy: 'http://manual-new.example:8080',
    httpProxyNoProxy: 'manual.local'
  });
});

test('未知版本 marker 保留用户原生设置并阻止启动', (t) => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-native-marker-version-'));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const paths = resolveZcodeNativeProxyPaths(profileDir, path);
  const manualSettings = {
    httpProxy: 'http://manual.example:8080',
    httpProxyNoProxy: 'manual.local'
  };
  fs.mkdirSync(path.dirname(paths.settingsPath), { recursive: true });
  fs.writeFileSync(paths.settingsPath, `${JSON.stringify(manualSettings, null, 2)}\n`);
  fs.writeFileSync(paths.markerPath, `${JSON.stringify({
    version: 999,
    httpProxy: manualSettings.httpProxy,
    httpProxyNoProxy: manualSettings.httpProxyNoProxy
  }, null, 2)}\n`);

  const result = prepareZcodeNativeProxySettings({ fs, path, profileDir, proxyServer: '' });

  assert.equal(result.ready, false);
  assert.equal(result.status, 'preserved_unrecognized_marker');
  assert.equal(result.error, 'zcode_native_proxy_marker_unrecognized');
  assert.match(result.reason, /无法识别.*保留.*未应用/);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8')), manualSettings);
  assert.equal(fs.existsSync(paths.markerPath), true, '当前版本不能删除自己无法解释的所有权记录');
});

test('未知版本 marker 也不允许重新绑定时覆盖其设置所有权', (t) => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-native-marker-rebind-'));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const paths = resolveZcodeNativeProxyPaths(profileDir, path);
  const manualSettings = {
    locale: 'zh-CN',
    httpProxy: 'http://manual.example:8080',
    httpProxyNoProxy: 'manual.local'
  };
  const unknownMarker = {
    version: 999,
    httpProxy: manualSettings.httpProxy,
    httpProxyNoProxy: manualSettings.httpProxyNoProxy,
    futureOwnership: 'must-not-be-discarded'
  };
  fs.mkdirSync(path.dirname(paths.settingsPath), { recursive: true });
  fs.writeFileSync(paths.settingsPath, `${JSON.stringify(manualSettings, null, 2)}\n`);
  fs.writeFileSync(paths.markerPath, `${JSON.stringify(unknownMarker, null, 2)}\n`);

  const result = prepareZcodeNativeProxySettings({
    fs,
    path,
    profileDir,
    proxyServer: '127.0.0.1:10801'
  });

  assert.equal(result.status, 'preserved_unrecognized_marker');
  assert.equal(result.ready, false);
  assert.equal(result.error, 'zcode_native_proxy_marker_unrecognized');
  assert.equal(result.egressApplied, false);
  assert.match(result.egressWarning, /无法识别.*保留.*未应用/);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8')), manualSettings);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.markerPath, 'utf8')), unknownMarker);
});

test('原生设置写入失败时 marker 先落盘，后续解绑仍能安全收敛', (t) => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-native-partial-write-'));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const paths = resolveZcodeNativeProxyPaths(profileDir, path);
  const manualSettings = {
    httpProxy: 'http://manual.example:8080',
    httpProxyNoProxy: 'manual.local'
  };
  fs.mkdirSync(path.dirname(paths.settingsPath), { recursive: true });
  fs.writeFileSync(paths.settingsPath, `${JSON.stringify(manualSettings, null, 2)}\n`);
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync') {
        return (source, destination) => {
          if (String(destination) === paths.settingsPath) {
            const error = new Error('settings rename denied');
            error.code = 'EACCES';
            throw error;
          }
          return target.renameSync(source, destination);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  assert.throws(
    () => prepareZcodeNativeProxySettings({
      fs: failingFs,
      path,
      profileDir,
      proxyServer: '127.0.0.1:10801'
    }),
    /settings rename denied/
  );
  assert.equal(fs.existsSync(paths.markerPath), true, 'marker 必须先于设置文件落盘');
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8')), manualSettings);

  prepareZcodeNativeProxySettings({ fs, path, profileDir, proxyServer: '' });
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8')), manualSettings);
  assert.equal(fs.existsSync(paths.markerPath), false);
});

test('切换托管出口时设置写入失败，marker 仍保留旧托管值用于解绑', (t) => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-native-switch-failure-'));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const paths = resolveZcodeNativeProxyPaths(profileDir, path);
  prepareZcodeNativeProxySettings({
    fs,
    path,
    profileDir,
    proxyServer: '127.0.0.1:10801'
  });
  const firstSettings = JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8'));
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync') {
        return (source, destination) => {
          if (String(destination) === paths.settingsPath) {
            const error = new Error('settings update denied');
            error.code = 'EACCES';
            throw error;
          }
          return target.renameSync(source, destination);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  assert.throws(
    () => prepareZcodeNativeProxySettings({
      fs: failingFs,
      path,
      profileDir,
      proxyServer: '127.0.0.1:10802'
    }),
    /settings update denied/
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8')), firstSettings);

  prepareZcodeNativeProxySettings({ fs, path, profileDir, proxyServer: '' });
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8')), {});
  assert.equal(fs.existsSync(paths.markerPath), false);
});

// ── proxy url 校验 ──────────────────────────────────────────────────────────

test('normalizeProxyUrl 接受 host:port 简写与受支持的 scheme', () => {
  assert.equal(normalizeProxyUrl('127.0.0.1:10801'), '127.0.0.1:10801');
  assert.equal(normalizeProxyUrl('socks5://1.2.3.4:1080'), 'socks5://1.2.3.4:1080');
  assert.equal(normalizeProxyUrl('http://proxy.local:3128'), 'http://proxy.local:3128');
});

test('normalizeProxyUrl 拒绝不合法输入', () => {
  assert.equal(normalizeProxyUrl('ftp://1.2.3.4:21'), '', '不支持的 scheme');
  assert.equal(normalizeProxyUrl('1.2.3.4'), '', '缺端口');
  assert.equal(normalizeProxyUrl('1.2.3.4:99999'), '', '端口越界');
  assert.equal(normalizeProxyUrl('http://1.2.3.4:0'), '', '完整 URL 也不能使用 0 端口');
  assert.equal(normalizeProxyUrl('http://user:secret@1.2.3.4:8080'), '', '凭据不得进入持久化与诊断边界');
  assert.equal(normalizeProxyUrl('http://1.2.3.4:8080/proxy'), '', '代理地址不接受 path');
  assert.equal(normalizeProxyUrl('http://1.2.3.4:8080?mode=x'), '', '代理地址不接受 query');
  assert.equal(normalizeProxyUrl(''), '');
});

// ── resolver ────────────────────────────────────────────────────────────────

test('resolveZcodeEgress 未绑定时回 not_bound 而非报错', async () => {
  const result = await resolveZcodeEgress({ binding: null, platform: 'darwin' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_bound');
});

test('resolveZcodeEgress 在 macOS 上解析显式 URL', async () => {
  const result = await resolveZcodeEgress({
    binding: { mode: EGRESS_MODE_URL, proxyUrl: 'socks5://1.2.3.4:1080', nodeId: '' },
    platform: 'darwin'
  });
  assert.deepEqual(result, { ok: true, proxyServer: 'socks5://1.2.3.4:1080', source: EGRESS_MODE_URL });
});

test('resolveZcodeEgress 探测到代理出口不可用时返回结构化失败', async () => {
  const calls = [];
  const result = await resolveZcodeEgress({
    binding: { mode: EGRESS_MODE_URL, proxyUrl: '127.0.0.1:10801', nodeId: '' },
    platform: 'darwin',
    probeProxyServer: async (proxyServer) => {
      calls.push(proxyServer);
      return { ok: false, error: 'proxy_probe_failed', reason: 'curl_exit_7' };
    }
  });

  assert.deepEqual(calls, ['127.0.0.1:10801']);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'proxy_unreachable');
  assert.equal(result.reason, 'curl_exit_7');
});

test('resolveZcodeEgress 在非 macOS 平台返回结构化 not_supported，不静默放行', async () => {
  for (const [platform, expected] of [['win32', 'windows'], ['linux', 'linux']]) {
    const result = await resolveZcodeEgress({
      binding: { mode: EGRESS_MODE_URL, proxyUrl: '127.0.0.1:10801', nodeId: '' },
      platform
    });
    assert.equal(result.ok, false, `${platform} 当前不支持`);
    assert.equal(result.error, 'not_supported');
    assert.equal(result.platform, expected);
    assert.equal(result.proxyServer, '', '不得回退成某个出口');
  }
  assert.equal(SUPPORTED_PLATFORM, 'macos');
});

// ── 启动策略接线 ────────────────────────────────────────────────────────────

function fakeSpawnCtx(egress) {
  return { userDataDir: '/tmp/sandbox/electron-user-data', egress };
}

test('zcode 策略只交付原生设置，不重复追加 --proxy-server', () => {
  const plan = zcodeDesktopLaunchStrategy.resolveSpawnPlan(
    { executablePath: '/Applications/ZCode.app/Contents/MacOS/ZCode' },
    fakeSpawnCtx({ ok: true, proxyServer: '127.0.0.1:10802' })
  );
  assert.equal(plan.file, '/Applications/ZCode.app/Contents/MacOS/ZCode');
  assert.deepEqual(plan.args, ['--user-data-dir=/tmp/sandbox/electron-user-data']);
});

test('zcode 策略对未绑定或解析失败同样不追加启动代理参数', () => {
  for (const egress of [null, undefined, { ok: false, proxyServer: '' }, { ok: false, error: 'not_supported' }]) {
    const plan = zcodeDesktopLaunchStrategy.resolveSpawnPlan(
      { executablePath: '/Applications/ZCode.app/Contents/MacOS/ZCode' },
      fakeSpawnCtx(egress)
    );
    assert.deepEqual(plan.args, ['--user-data-dir=/tmp/sandbox/electron-user-data']);
  }
});

// ── service ─────────────────────────────────────────────────────────────────

function createStableSidecarDeps(overrides = {}) {
  return {
    leaseStore: {
      getByOwner: () => null,
      listActive: () => [],
      getLastSelectedNodeId: () => '',
      acquire: (input) => input,
      attachProcess: (ownerId, pid) => ({ ownerId, pid }),
      release: () => true,
      releaseByAccount: () => 0
    },
    zcodeSingBoxRuntime: {
      ensureAccountEndpoint: async () => ({
        ok: true,
        action: 'started',
        port: 23100,
        proxyServer: '127.0.0.1:23100'
      }),
      releaseAccount: async () => ({ ok: true, action: 'stopped' })
    },
    ...overrides
  };
}

test('isEgressSupportedProvider 目前只认 zcode', () => {
  assert.equal(isEgressSupportedProvider('zcode'), true);
  assert.equal(isEgressSupportedProvider('ZCODE'), true);
  assert.equal(isEgressSupportedProvider('codex'), false);
});

test('resolveAccountEgress 对不支持的 provider 直接回 null', async () => {
  const result = await resolveAccountEgress({
    fs: {}, aiHomeDir: '/tmp/aih', provider: 'codex', accountRef: 'acct_91aa805bdd051b40fa47'
  });
  assert.equal(result, null);
});

test('resolveAccountEgress 的显式 URL 模式不初始化节点仓或 Mihomo 数据面', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-egress-service-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: '1',
    identitySeed: 'oauth:zcode:egress-service@example.com'
  });
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_URL,
    proxyUrl: '127.0.0.1:10801'
  });
  let nodeStoreCalls = 0;
  const sidecarTargets = [];

  const result = await resolveAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' },
    deps: createStableSidecarDeps({
      probeProxyServer: async () => ({ ok: true }),
      getProxyNodeStore() {
        nodeStoreCalls += 1;
        throw new Error('URL mode must not initialize node store');
      },
      zcodeSingBoxRuntime: {
        async ensureAccountEndpoint(input) {
          sidecarTargets.push(input.resolvedTarget.target);
          return {
            ok: true,
            action: 'started',
            port: 23100,
            proxyServer: '127.0.0.1:23100'
          };
        },
        releaseAccount: async () => ({ ok: true, action: 'stopped' })
      }
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.proxyServer, '127.0.0.1:23100');
  assert.deepEqual(sidecarTargets, [{ kind: 'proxy-url', proxyUrl: '127.0.0.1:10801' }]);
  assert.equal(nodeStoreCalls, 0);
});

test('resolveAccountEgress 在非 macOS 上返回 not_supported 前不初始化节点仓或 sidecar', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-egress-platform-pool-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: '1',
    identitySeed: 'oauth:zcode:egress-platform-pool@example.com'
  });
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_POOL,
    nodeId: 'node-a'
  });
  const calls = [];

  const result = await resolveAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'win32' },
    deps: {
      getProxyNodeStore() {
        calls.push('node-store');
        throw new Error('unsupported platform must not initialize node store');
      },
      getZcodeEgressLeaseStore() {
        calls.push('lease-store');
        throw new Error('unsupported platform must not initialize lease store');
      },
      getZcodeSingBoxRuntime() {
        calls.push('sidecar');
        throw new Error('unsupported platform must not initialize sidecar');
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_supported');
  assert.equal(result.platform, 'windows');
  assert.deepEqual(calls, []);
});

test('resolveAccountEgress 默认探测真实代理出口，失败时返回结构化结果', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-egress-probe-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: '1',
    identitySeed: 'oauth:zcode:egress-probe@example.com'
  });
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_URL,
    proxyUrl: '127.0.0.1:10801'
  });
  const calls = [];

  const result = await resolveAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' },
    deps: createStableSidecarDeps({
      execFile(file, args, options, callback) {
        calls.push({ file, args, options });
        const error = new Error('curl failed');
        error.code = 7;
        callback(error, '', '');
      }
    })
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/usr/bin/curl');
  assert.equal(calls[0].args[0], '--disable', '探测不得受用户 ~/.curlrc 改写');
  assert.ok(calls[0].args.includes('--fail'), 'HTTP 4xx/5xx 必须让 curl 返回非零，不能误判为可用出口');
  assert.ok(calls[0].args.includes('--proxy'));
  assert.ok(calls[0].args.includes('http://127.0.0.1:23100'));
  assert.ok(calls[0].args.includes('https://www.gstatic.com/generate_204'));
  assert.equal(calls[0].args.some((arg) => /zcode/i.test(arg)), false, '不得调用或模拟 ZCode API');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'proxy_unreachable');
  assert.equal(result.reason, 'curl_exit_7');
});

test('describeEgressWarning 对成功与未绑定不产出噪音', () => {
  assert.equal(describeEgressWarning({ ok: true, proxyServer: 'x' }), '');
  assert.equal(describeEgressWarning(null), '');
});

test('prepareAccountAppEgress 在已绑定出口不可用时 fail-closed', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-egress-unavailable-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: '1',
    identitySeed: 'oauth:zcode:egress-unavailable@example.com'
  });
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_URL,
    proxyUrl: 'not-a-proxy-url'
  });

  const result = await prepareAccountAppEgress({
    action: 'open',
    kind: 'desktop',
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'zcode_egress_unavailable');
  assert.equal(result.egress, null);
  assert.equal(result.egressPrepared, false);
  assert.equal(result.egressError, 'invalid_proxy_url');
  assert.match(result.warning, /代理地址无效/);
  assert.match(result.warning, /阻止启动/);
});

test('prepareAccountAppEgress 在绑定状态未知时保留现有原生设置', async () => {
  const result = await prepareAccountAppEgress({
    action: 'open',
    kind: 'desktop',
    fs: {
      existsSync: () => true,
      mkdirSync() {
        throw new Error('app-state read denied');
      }
    },
    aiHomeDir: '/tmp/aih-zcode-egress-read-failure',
    provider: 'zcode',
    accountRef: 'acct_91aa805bdd051b40fa47',
    processObj: { platform: 'darwin' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'zcode_egress_binding_unavailable');
  assert.equal(result.egress, null);
  assert.equal(result.egressPrepared, false);
  assert.equal(result.egressError, 'egress_resolve_failed');
  assert.match(result.reason, /app-state read denied/);
  assert.match(result.warning, /保留现有 ZCode 原生设置/);
});

test('prepareAccountAppEgress 遇到损坏绑定时不得把它当成已确认未绑定', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-egress-corrupt-service-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: '1',
    identitySeed: 'oauth:zcode:corrupt-service@example.com'
  });
  writeJsonValue(fs, aiHomeDir, buildEgressBindingKey(accountRef), {
    mode: EGRESS_MODE_POOL,
    nodeId: ''
  });

  const result = await prepareAccountAppEgress({
    action: 'open',
    kind: 'desktop',
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'zcode_egress_binding_unavailable');
  assert.equal(result.egress, null);
  assert.equal(result.egressPrepared, false, '未知状态不能触发旧托管值释放');
  assert.equal(result.egressError, 'egress_resolve_failed');
  assert.match(result.reason, /invalid_account_egress_binding_record/);
  assert.match(result.warning, /保留现有 ZCode 原生设置/);
});

test('已绑定代理不可达时只执行同步预检，不调用真实 launcher', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-egress-fail-closed-launch-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: '1',
    identitySeed: 'oauth:zcode:fail-closed-launch@example.com'
  });
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_URL,
    proxyUrl: '127.0.0.1:10801'
  });
  const calls = [];
  const launcher = {
    launchAccountApp(input) {
      calls.push(input);
      return input.deferDesktopSpawn === true
        ? { ok: true, status: 'launch_ready' }
        : { ok: true, status: 'launched', pid: 9988 };
    }
  };

  const launch = await launchAccountAppWithEgress({
    launcher,
    launchInput: {
      provider: 'zcode',
      accountRef,
      kind: 'desktop',
      action: 'open'
    },
    egressInput: {
      fs,
      aiHomeDir,
      processObj: { platform: 'darwin' },
      deps: createStableSidecarDeps({
        probeProxyServer: async () => ({
          ok: false,
          error: 'proxy_probe_failed',
          reason: 'curl_exit_7'
        })
      })
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].deferDesktopSpawn, true);
  assert.equal(launch.result.ok, false);
  assert.equal(launch.result.error, 'zcode_egress_unavailable');
  assert.equal(launch.result.egressError, 'proxy_unreachable');
  assert.match(launch.egressWarning, /阻止启动/);
});

test('损坏绑定记录时只执行同步预检，不允许直连启动', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-egress-corrupt-launch-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: '1',
    identitySeed: 'oauth:zcode:corrupt-launch@example.com'
  });
  writeJsonValue(fs, aiHomeDir, buildEgressBindingKey(accountRef), {
    mode: EGRESS_MODE_POOL,
    nodeId: ''
  });
  const calls = [];
  const launcher = {
    launchAccountApp(input) {
      calls.push(input);
      return input.deferDesktopSpawn === true
        ? { ok: true, status: 'launch_ready' }
        : { ok: true, status: 'launched', pid: 9989 };
    }
  };

  const launch = await launchAccountAppWithEgress({
    launcher,
    launchInput: {
      provider: 'zcode',
      accountRef,
      kind: 'desktop',
      action: 'open'
    },
    egressInput: {
      fs,
      aiHomeDir,
      processObj: { platform: 'darwin' },
      deps: createStableSidecarDeps()
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(launch.result.ok, false);
  assert.equal(launch.result.error, 'zcode_egress_binding_unavailable');
  assert.match(launch.result.reason, /invalid_account_egress_binding_record/);
});

test('未绑定出口时显式传入 egress:null，让 fresh launch 释放旧托管值', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-egress-unbound-launch-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: '1',
    identitySeed: 'oauth:zcode:unbound-launch@example.com'
  });
  const calls = [];
  const launcher = {
    launchAccountApp(input) {
      calls.push(input);
      return input.deferDesktopSpawn === true
        ? { ok: true, status: 'launch_ready' }
        : { ok: true, status: 'launched', pid: 9990 };
    }
  };

  const launch = await launchAccountAppWithEgress({
    launcher,
    launchInput: {
      provider: 'zcode',
      accountRef,
      kind: 'desktop',
      action: 'open'
    },
    egressInput: {
      fs,
      aiHomeDir,
      processObj: { platform: 'darwin' },
      deps: createStableSidecarDeps()
    }
  });

  assert.equal(launch.result.status, 'launched');
  assert.equal(calls.length, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[1], 'egress'), true);
  assert.equal(calls[1].egress, null);
});

test('同步预检发现 ZCode 已运行时不探测出口并提示可实时应用', async () => {
  let probeCalls = 0;
  const calls = [];
  const launcher = {
    launchAccountApp(input) {
      calls.push(input);
      return { ok: true, status: 'already_running', pids: [9122] };
    }
  };

  const launch = await launchAccountAppWithEgress({
    launcher,
    launchInput: {
      provider: 'zcode',
      accountRef: 'acct_91aa805bdd051b40fa47',
      kind: 'desktop',
      action: 'open'
    },
    egressInput: {
      deps: {
        probeProxyServer: async () => {
          probeCalls += 1;
          return { ok: true };
        }
      }
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(probeCalls, 0);
  assert.equal(launch.result.status, 'already_running');
  assert.match(launch.egressWarning, /当前实例已运行.*出口设置.*实时应用/);
});

test('异步出口预检后若已有实例抢先运行，必须明确告警本次出口未应用', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-egress-launch-race-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: '1',
    identitySeed: 'oauth:zcode:egress-launch-race@example.com'
  });
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_URL,
    proxyUrl: '127.0.0.1:10801'
  });
  const calls = [];
  const launcher = {
    launchAccountApp(input) {
      calls.push(input);
      if (input.deferDesktopSpawn === true) {
        return { ok: true, status: 'launch_ready' };
      }
      return { ok: true, status: 'already_running', pids: [9123] };
    }
  };

  const launch = await launchAccountAppWithEgress({
    launcher,
    launchInput: {
      provider: 'zcode',
      accountRef,
      kind: 'desktop',
      action: 'open'
    },
    egressInput: {
      fs,
      aiHomeDir,
      processObj: { platform: 'darwin' },
      deps: createStableSidecarDeps({ probeProxyServer: async () => ({ ok: true }) })
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(launch.result.status, 'already_running');
  assert.match(launch.egressWarning, /已有实例.*出口.*未被.*加载.*实时应用/);
});

test('同一 ZCode 账号的并发 Desktop 打开请求只执行一次出口探测和真实启动', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-egress-single-flight-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: '1',
    identitySeed: 'oauth:zcode:egress-single-flight@example.com'
  });
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_URL,
    proxyUrl: '127.0.0.1:10801'
  });
  let preflightCalls = 0;
  let launchCalls = 0;
  let probeCalls = 0;
  let releaseProbe;
  const probeResult = new Promise((resolve) => {
    releaseProbe = resolve;
  });
  const launcher = {
    launchAccountApp(input) {
      if (input.deferDesktopSpawn === true) {
        preflightCalls += 1;
        return { ok: true, status: 'launch_ready' };
      }
      launchCalls += 1;
      return { ok: true, status: 'launched', pid: 9345 };
    }
  };
  const input = {
    launcher,
    launchInput: {
      provider: 'zcode',
      accountRef,
      kind: 'desktop',
      action: 'open'
    },
    egressInput: {
      fs,
      aiHomeDir,
      processObj: { platform: 'darwin' },
      deps: createStableSidecarDeps({
        probeProxyServer: async () => {
          probeCalls += 1;
          return probeResult;
        }
      })
    }
  };

  const first = launchAccountAppWithEgress(input);
  while (probeCalls === 0) await Promise.resolve();
  const second = launchAccountAppWithEgress(input);
  await Promise.resolve();
  releaseProbe({ ok: true });
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(preflightCalls, 1);
  assert.equal(probeCalls, 1);
  assert.equal(launchCalls, 1);
  assert.equal(firstResult.result.status, 'launched');
  assert.equal(secondResult.result.status, 'launched');
});

test('同一 ZCode 账号在出口探测期间收到关闭请求时按调用顺序先启动再关闭', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-egress-open-close-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: '1',
    identitySeed: 'oauth:zcode:egress-open-close@example.com'
  });
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_URL,
    proxyUrl: '127.0.0.1:10801'
  });
  const calls = [];
  let running = false;
  let probeCalls = 0;
  let releaseProbe;
  const probeResult = new Promise((resolve) => {
    releaseProbe = resolve;
  });
  const launcher = {
    launchAccountApp(input) {
      if (input.deferDesktopSpawn === true) {
        calls.push('preflight');
        return { ok: true, status: 'launch_ready' };
      }
      if (input.action === 'close') {
        calls.push('close');
        const wasRunning = running;
        running = false;
        return { ok: true, status: wasRunning ? 'closed' : 'not_running' };
      }
      calls.push('open');
      running = true;
      return { ok: true, status: 'launched', pid: 9456 };
    }
  };
  const egressDeps = createStableSidecarDeps({
    probeProxyServer: async () => {
      probeCalls += 1;
      return probeResult;
    }
  });
  const openInput = {
    launcher,
    launchInput: {
      provider: 'zcode',
      accountRef,
      kind: 'desktop',
      action: 'open'
    },
    egressInput: {
      fs,
      aiHomeDir,
      processObj: { platform: 'darwin' },
      deps: egressDeps
    }
  };

  const open = launchAccountAppWithEgress(openInput);
  while (probeCalls === 0) await Promise.resolve();
  const close = launchAccountAppWithEgress({
    launcher,
    launchInput: {
      provider: 'zcode',
      accountRef,
      kind: 'desktop',
      action: 'close'
    },
    egressInput: {
      fs,
      aiHomeDir,
      processObj: { platform: 'darwin' },
      deps: egressDeps
    }
  });
  await Promise.resolve();

  assert.deepEqual(calls, ['preflight'], '关闭必须等待在途打开完成');
  releaseProbe({ ok: true });
  const [openResult, closeResult] = await Promise.all([open, close]);

  assert.equal(openResult.result.status, 'launched');
  assert.equal(closeResult.result.status, 'closed');
  assert.deepEqual(calls, ['preflight', 'open', 'close']);
  assert.equal(running, false);
});

// ── 禁止绕过原生设置直接注入代理环境变量 ──────────────────────────────────

test('zcode 策略不直接注入会被 Desktop host 清理的代理环境变量', () => {
  const env = {};
  const ctx = {
    sandboxDir: '/tmp/sandbox',
    profileDir: '/tmp/sandbox',
    accountRef: 'acct_91aa805bdd051b40fa47',
    applicationName: 'ZCode-0347bf7d',
    path: require('node:path'),
    getBaseEnv: () => ({}),
    egress: { ok: true, proxyServer: '127.0.0.1:10801' }
  };
  zcodeDesktopLaunchStrategy.decorateLaunchEnv(env, ctx);
  assert.equal(env.ZCODE_HTTP_PROXY, undefined);
  assert.equal(env.ZCODE_NO_PROXY, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.ALL_PROXY, undefined);
  assert.equal(env.NO_PROXY, undefined);
});

test('describeEgressWarning 说明平台限制与 fail-closed 事实', () => {
  assert.match(describeEgressWarning({ ok: false, error: 'not_supported', platform: 'windows' }), /仅支持 macOS/);
  assert.match(describeEgressWarning({ ok: false, error: 'sing_box_unavailable' }), /sing-box 不可用.*阻止启动/);
});
