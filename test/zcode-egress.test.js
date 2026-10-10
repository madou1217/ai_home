'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  EGRESS_MODES,
  EGRESS_MODE_SYSTEM,
  EGRESS_MODE_TUN,
  EGRESS_MODE_URL,
  buildEgressBindingKey,
  normalizeEgressBinding,
  readAccountEgressBinding,
  writeAccountEgressBinding
} = require('../lib/account/zcode-egress-binding-store');
const { writeJsonValue } = require('../lib/server/app-state-store');
const { listProviderIds } = require('../lib/provider-catalog');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const {
  SUPPORTED_PLATFORM,
  normalizeProxyUrl
} = require('../lib/server/zcode-egress-resolver');
const {
  DEFAULT_NO_PROXY
} = require('../lib/server/zcode-native-proxy-values');
const {
  applyStoredAccountEgress,
  describeEgressWarning,
  getAccountEgressRuntimeStatus,
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
});

test('normalizeEgressBinding 只支持 system、tun、url 三种模式', () => {
  assert.deepEqual([...EGRESS_MODES].sort(), [EGRESS_MODE_SYSTEM, EGRESS_MODE_TUN, EGRESS_MODE_URL].sort());
  assert.deepEqual(normalizeEgressBinding({ mode: EGRESS_MODE_SYSTEM }), {
    mode: EGRESS_MODE_SYSTEM,
    proxyUrl: '',
    updatedAt: 0
  });
  assert.deepEqual(normalizeEgressBinding({ mode: EGRESS_MODE_TUN, updatedAt: 42 }), {
    mode: EGRESS_MODE_TUN,
    proxyUrl: '',
    updatedAt: 42
  });
  assert.deepEqual(normalizeEgressBinding({ mode: EGRESS_MODE_URL, proxyUrl: ' 127.0.0.1:10801 ' }), {
    mode: EGRESS_MODE_URL,
    proxyUrl: '127.0.0.1:10801',
    updatedAt: 0
  });
});

test('normalizeEgressBinding 把历史 node/group/pool 记录标记为已下线并保留原字段', () => {
  assert.deepEqual(normalizeEgressBinding({ mode: 'pool', nodeId: 'node-a', updatedAt: 7 }), {
    mode: 'pool',
    retired: true,
    proxyUrl: '',
    nodeId: 'node-a',
    groupId: '',
    updatedAt: 7
  });
  assert.equal(normalizeEgressBinding({ mode: 'group' }).retired, true, '缺目标的历史记录也按已下线处理，不能当成未绑定');
  const inferredNode = normalizeEgressBinding({ nodeId: 'node-a' });
  assert.equal(inferredNode.mode, 'node');
  assert.equal(inferredNode.retired, true);
  assert.equal(normalizeEgressBinding({ groupId: 'subscription:sub_a' }).mode, 'group');
});

test('normalizeEgressBinding 把半条或未知记录退化成 null', () => {
  assert.equal(normalizeEgressBinding({ mode: 'url' }), null, '声明 url 却没填 URL');
  assert.equal(
    normalizeEgressBinding({ mode: 'typo', proxyUrl: '127.0.0.1:10801' }),
    null,
    '只有 mode 缺失时才允许推断，显式未知模式属于损坏记录'
  );
  assert.equal(normalizeEgressBinding({}), null);
  assert.equal(normalizeEgressBinding(null), null);
  assert.equal(normalizeEgressBinding([]), null);
});

test('normalizeEgressBinding 切到 system/tun 时保留 proxyUrl，便于 UI 切换时不丢输入', () => {
  const binding = normalizeEgressBinding({ mode: EGRESS_MODE_SYSTEM, proxyUrl: '1.2.3.4:8080' });
  assert.equal(binding.mode, EGRESS_MODE_SYSTEM);
  assert.equal(binding.proxyUrl, '1.2.3.4:8080');
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

test('writeAccountEgressBinding 允许所有真实 provider 账号写入绑定', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-egress-provider-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  for (const [index, provider] of listProviderIds().entries()) {
    const accountRef = upsertAccountRef(fs, aiHomeDir, {
      provider,
      cliAccountId: String(index + 1),
      identitySeed: `oauth:${provider}:account-egress-provider@example.com`
    });

    writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
      mode: EGRESS_MODE_URL,
      proxyUrl: '127.0.0.1:10801'
    });

    assert.equal(
      readAccountEgressBinding(fs, aiHomeDir, accountRef).proxyUrl,
      '127.0.0.1:10801',
      provider
    );
  }
});

test('历史节点/分组绑定可读出 retired 形状，但不能再写入', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-egress-retired-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: '1',
    identitySeed: 'oauth:zcode:retired-binding@example.com'
  });
  writeJsonValue(fs, aiHomeDir, buildEgressBindingKey(accountRef), {
    mode: 'group',
    groupId: 'subscription:sub_a',
    updatedAt: 5
  });

  assert.deepEqual(readAccountEgressBinding(fs, aiHomeDir, accountRef), {
    mode: 'group',
    retired: true,
    proxyUrl: '',
    nodeId: '',
    groupId: 'subscription:sub_a',
    updatedAt: 5
  });
  for (const binding of [
    { mode: 'node', nodeId: 'node-a' },
    { mode: 'group', groupId: 'group-a' },
    { mode: 'pool', nodeId: 'node-a' },
    { nodeId: 'node-a' }
  ]) {
    assert.throws(
      () => writeAccountEgressBinding(fs, aiHomeDir, accountRef, binding),
      /invalid_account_egress_binding/,
      JSON.stringify(binding)
    );
  }
  assert.equal(
    readAccountEgressBinding(fs, aiHomeDir, accountRef).groupId,
    'subscription:sub_a',
    '拒绝写入不会删除旧记录'
  );
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

test('normalizeProxyUrl 把 host:port 简写补成 http，并保留 https', () => {
  assert.equal(normalizeProxyUrl('127.0.0.1:10801'), 'http://127.0.0.1:10801');
  assert.equal(normalizeProxyUrl('http://proxy.local:3128'), 'http://proxy.local:3128');
  assert.equal(normalizeProxyUrl('https://proxy.local:8443'), 'https://proxy.local:8443');
});

test('normalizeProxyUrl 拒绝不合法输入与非 HTTP(S) 代理', () => {
  assert.equal(normalizeProxyUrl('socks5://1.2.3.4:1080'), '', 'socks 在网关请求路径上会被静默直连，必须拒绝');
  assert.equal(normalizeProxyUrl('ftp://1.2.3.4:21'), '', '不支持的 scheme');
  assert.equal(normalizeProxyUrl('1.2.3.4'), '', '缺端口');
  assert.equal(normalizeProxyUrl('1.2.3.4:99999'), '', '端口越界');
  assert.equal(normalizeProxyUrl('http://1.2.3.4:0'), '', '完整 URL 也不能使用 0 端口');
  assert.equal(normalizeProxyUrl('http://user:secret@1.2.3.4:8080'), '', '凭据不得进入持久化与诊断边界');
  assert.equal(normalizeProxyUrl('http://1.2.3.4:8080/proxy'), '', '代理地址不接受 path');
  assert.equal(normalizeProxyUrl('http://1.2.3.4:8080?mode=x'), '', '代理地址不接受 query');
  assert.equal(normalizeProxyUrl(''), '');
});

// ── 解析 + 探测 ────────────────────────────────────────────────────────────

function egressResolveInput(binding, overrides = {}) {
  return {
    fs: {},
    aiHomeDir: '/tmp/aih-egress-resolve',
    provider: 'zcode',
    accountRef: 'acct_91aa805bdd051b40fa47',
    binding,
    processObj: { platform: 'darwin' },
    ...overrides
  };
}

test('resolveAccountEgress 未绑定时回 null 而非报错', async () => {
  assert.equal(await resolveAccountEgress(egressResolveInput(null)), null);
});

test('resolveAccountEgress 直接探测外部代理，不经过任何本地端口', async () => {
  const probes = [];
  const result = await resolveAccountEgress(egressResolveInput(
    { mode: EGRESS_MODE_URL, proxyUrl: '127.0.0.1:6152' },
    {
      deps: {
        probeProxyServer: async (proxyServer) => {
          probes.push(proxyServer);
          return { ok: true };
        }
      }
    }
  ));
  assert.deepEqual(probes, ['http://127.0.0.1:6152']);
  assert.deepEqual(result, { ok: true, source: EGRESS_MODE_URL, proxyServer: 'http://127.0.0.1:6152' });
});

test('resolveAccountEgress 探测到代理出口不可用时返回结构化失败', async () => {
  const result = await resolveAccountEgress(egressResolveInput(
    { mode: EGRESS_MODE_URL, proxyUrl: '127.0.0.1:10801' },
    {
      deps: {
        probeProxyServer: async () => ({ ok: false, error: 'proxy_probe_failed', reason: 'curl_exit_7' })
      }
    }
  ));
  assert.deepEqual(result, {
    ok: false,
    proxyServer: '',
    source: '',
    error: 'proxy_unreachable',
    reason: 'curl_exit_7'
  });
});

test('resolveAccountEgress 在 TUN 激活时返回直连目标且不探测代理', async () => {
  const result = await resolveAccountEgress(egressResolveInput(
    { mode: EGRESS_MODE_TUN },
    {
      deps: {
        detectTun: () => ({ state: 'active', owner: 'clash-verge' }),
        probeProxyServer: async () => {
          throw new Error('TUN 模式没有代理地址可探测');
        }
      }
    }
  ));
  assert.deepEqual(result, { ok: true, source: EGRESS_MODE_TUN, proxyServer: '', direct: true });
});

test('resolveAccountEgress 对 socks 地址、已下线模式与非 macOS 平台 fail-closed 且不探测', async () => {
  const deps = {
    probeProxyServer: async () => {
      throw new Error('fail-closed 前不得探测');
    }
  };
  const socks = await resolveAccountEgress(egressResolveInput(
    { mode: EGRESS_MODE_URL, proxyUrl: 'socks5://127.0.0.1:6153' },
    { deps }
  ));
  assert.equal(socks.ok, false);
  assert.equal(socks.error, 'proxy_scheme_unsupported');
  assert.equal(socks.proxyServer, '');

  const retired = await resolveAccountEgress(egressResolveInput(
    { mode: 'node', retired: true, nodeId: 'node-a', proxyUrl: '', groupId: '' },
    { deps }
  ));
  assert.equal(retired.ok, false);
  assert.equal(retired.error, 'account_egress_mode_retired');
  assert.equal(retired.mode, 'node');

  for (const [platform, expected] of [['win32', 'windows'], ['linux', 'linux']]) {
    const result = await resolveAccountEgress(egressResolveInput(
      { mode: EGRESS_MODE_URL, proxyUrl: '127.0.0.1:10801' },
      { deps, processObj: { platform } }
    ));
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

test('isEgressSupportedProvider 接受合同中所有 provider', () => {
  for (const provider of listProviderIds()) {
    assert.equal(isEgressSupportedProvider(provider), true, provider);
    assert.equal(isEgressSupportedProvider(provider.toUpperCase()), true, provider);
  }
  assert.equal(isEgressSupportedProvider('unknown-provider'), false);
});

test('resolveAccountEgress 对不支持的 provider 直接回 null', async () => {
  const result = await resolveAccountEgress({
    fs: {}, aiHomeDir: '/tmp/aih', provider: 'unknown-provider', accountRef: 'acct_91aa805bdd051b40fa47'
  });
  assert.equal(result, null);
});

test('resolveAccountEgress 从持久化绑定读取代理地址并归一化', async (t) => {
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
  const probes = [];

  const result = await resolveAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' },
    deps: {
      probeProxyServer: async (proxyServer) => {
        probes.push(proxyServer);
        return { ok: true };
      }
    }
  });

  assert.deepEqual(result, { ok: true, source: EGRESS_MODE_URL, proxyServer: 'http://127.0.0.1:10801' });
  assert.deepEqual(probes, ['http://127.0.0.1:10801']);
});

test('resolveAccountEgress 默认用 curl 经外部代理探测，失败时返回结构化结果', async (t) => {
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
    deps: {
      execFile(file, args, options, callback) {
        calls.push({ file, args, options });
        const error = new Error('curl failed');
        error.code = 7;
        callback(error, '', '');
      }
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/usr/bin/curl');
  assert.equal(calls[0].args[0], '--disable', '探测不得受用户 ~/.curlrc 改写');
  assert.ok(calls[0].args.includes('--fail'), 'HTTP 4xx/5xx 必须让 curl 返回非零，不能误判为可用出口');
  assert.ok(calls[0].args.includes('--proxy'));
  assert.ok(calls[0].args.includes('http://127.0.0.1:10801'), '直接探测外部代理');
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

test('非 ZCode provider 的出口失败返回账号级错误语义', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-egress-unavailable-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'claude',
    cliAccountId: '1',
    identitySeed: 'oauth:claude:egress-unavailable@example.com'
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
    provider: 'claude',
    accountRef,
    processObj: { platform: 'darwin' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'account_egress_unavailable');
  assert.equal(result.egressError, 'invalid_proxy_url');
  assert.doesNotMatch(result.warning, /ZCode/);
});

test('prepareAccountAppEgress 在绑定状态未知时保留现有原生设置', async () => {
  const result = await prepareAccountAppEgress({
    action: 'open',
    kind: 'desktop',
    fs: {
      existsSync: target => !target.endsWith('oauth-rekey.lock'),
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

test('非 ZCode provider 读取绑定失败时保留通用客户端设置语义', async () => {
  const result = await prepareAccountAppEgress({
    action: 'open',
    kind: 'desktop',
    fs: {
      existsSync: () => true,
      mkdirSync() {
        throw new Error('app-state read denied');
      }
    },
    aiHomeDir: '/tmp/aih-account-egress-read-failure',
    provider: 'claude',
    accountRef: 'acct_91aa805bdd051b40fa47',
    processObj: { platform: 'darwin' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'account_egress_binding_unavailable');
  assert.match(result.warning, /保留现有客户端设置/);
  assert.doesNotMatch(result.warning, /ZCode/);
});

test('历史节点/分组绑定阻止 Desktop 启动并提示改绑', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-egress-retired-launch-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: '1',
    identitySeed: 'oauth:zcode:retired-launch@example.com'
  });
  writeJsonValue(fs, aiHomeDir, buildEgressBindingKey(accountRef), {
    mode: 'group',
    groupId: 'subscription:sub_a'
  });

  const result = await prepareAccountAppEgress({
    action: 'open',
    kind: 'desktop',
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' },
    deps: {
      probeProxyServer: async () => {
        throw new Error('已下线模式不得探测');
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'zcode_egress_unavailable');
  assert.equal(result.egressPrepared, false);
  assert.equal(result.egressError, 'account_egress_mode_retired');
  assert.match(result.warning, /已下线.*改为代理地址、系统代理或外部 TUN/);
  assert.match(result.warning, /阻止启动/);
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
    mode: EGRESS_MODE_URL,
    proxyUrl: ''
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
      deps: {
        probeProxyServer: async () => ({
          ok: false,
          error: 'proxy_probe_failed',
          reason: 'curl_exit_7'
        })
      }
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
    mode: EGRESS_MODE_URL,
    proxyUrl: ''
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
      deps: {}
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
      deps: {}
    }
  });

  assert.equal(launch.result.status, 'launched');
  assert.equal(calls.length, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[1], 'egress'), true);
  assert.equal(calls[1].egress, null);
});

test('同步预检发现 ZCode 已运行时不探测出口，并提示去出口设置应用（会重启实例）', async () => {
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
  assert.match(launch.egressWarning, /ZCode 当前实例已运行.*出口设置中应用.*重启/);
});

test('非 ZCode Desktop 已运行时使用通用出口提示，不泄漏 ZCode 专属语义', async () => {
  const launch = await launchAccountAppWithEgress({
    launcher: {
      launchAccountApp() {
        return { ok: true, status: 'already_running', pids: [9124] };
      }
    },
    launchInput: {
      provider: 'claude',
      accountRef: 'acct_91aa805bdd051b40fa47',
      kind: 'desktop',
      action: 'open'
    }
  });

  assert.equal(launch.result.status, 'already_running');
  assert.match(launch.egressWarning, /客户端当前实例已运行.*出口设置中应用/);
  assert.doesNotMatch(launch.egressWarning, /ZCode/);
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
      deps: { probeProxyServer: async () => ({ ok: true }) }
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(launch.result.status, 'already_running');
  assert.match(launch.egressWarning, /已有实例抢先运行.*出口设置未被该实例加载.*重新应用/);
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
      deps: {
        probeProxyServer: async () => {
          probeCalls += 1;
          return probeResult;
        }
      }
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
  const egressDeps = {
    probeProxyServer: async () => {
      probeCalls += 1;
      return probeResult;
    }
  };
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
  assert.match(describeEgressWarning({ ok: false, error: 'proxy_scheme_unsupported' }), /只支持 HTTP\(S\).*阻止启动/);
  assert.match(describeEgressWarning({ ok: false, error: 'system_proxy_http_unavailable' }), /只配置了 SOCKS/);
  assert.match(describeEgressWarning({ ok: false, error: 'account_egress_mode_retired' }), /已下线.*阻止启动/);
  assert.match(
    describeEgressWarning({ ok: false, error: 'proxy_unreachable', reason: 'curl_exit_7' }),
    /连通性探测失败（curl_exit_7）/
  );
});

// ── 应用与运行态 ────────────────────────────────────────────────────────────

function createDesktopLauncher(running) {
  const calls = [];
  return {
    calls,
    launchAccountApp(input) {
      if (input.inspectDesktopRunning === true) {
        calls.push({ step: 'inspect' });
        return running
          ? { ok: true, status: 'already_running', pids: [4321] }
          : { ok: true, status: 'launch_ready' };
      }
      calls.push({ step: input.action, egress: input.egress });
      if (input.action === 'close') return { ok: true, status: 'closed' };
      return { ok: true, status: 'launched', pid: 5678 };
    }
  };
}

function createBoundZcodeAccount(t, binding) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-egress-apply-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: '1',
    identitySeed: 'oauth:zcode:egress-apply@example.com'
  });
  if (binding) writeAccountEgressBinding(fs, aiHomeDir, accountRef, binding);
  return { aiHomeDir, accountRef };
}

test('applyStoredAccountEgress 在 Desktop 运行时关闭并带新出口重启', async (t) => {
  const { aiHomeDir, accountRef } = createBoundZcodeAccount(t, { mode: EGRESS_MODE_URL, proxyUrl: '127.0.0.1:6152' });
  const launcher = createDesktopLauncher(true);

  const result = await applyStoredAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    launcher,
    processObj: { platform: 'darwin' },
    deps: { probeProxyServer: async () => ({ ok: true }) }
  });

  assert.deepEqual(result, {
    ok: true,
    applied: true,
    status: 'restarted',
    restarted: true,
    pid: 5678,
    previousPids: [4321],
    source: EGRESS_MODE_URL,
    proxyServer: 'http://127.0.0.1:6152'
  });
  assert.deepEqual(launcher.calls.map((call) => call.step), ['inspect', 'close', 'open']);
  assert.deepEqual(launcher.calls[2].egress, {
    ok: true,
    source: EGRESS_MODE_URL,
    proxyServer: 'http://127.0.0.1:6152'
  });
});

test('applyStoredAccountEgress 没有运行实例时只确认绑定可用', async (t) => {
  const { aiHomeDir, accountRef } = createBoundZcodeAccount(t, { mode: EGRESS_MODE_TUN });
  const launcher = createDesktopLauncher(false);

  const result = await applyStoredAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    launcher,
    processObj: { platform: 'darwin' },
    deps: { detectTun: () => ({ state: 'active' }) }
  });

  assert.deepEqual(result, {
    ok: true,
    applied: true,
    status: 'applied',
    source: EGRESS_MODE_TUN,
    proxyServer: '',
    direct: true
  });
  assert.deepEqual(launcher.calls.map((call) => call.step), ['inspect']);
});

test('applyStoredAccountEgress 解绑后返回 cleared，并让运行中的实例以无出口重启', async (t) => {
  const { aiHomeDir, accountRef } = createBoundZcodeAccount(t, null);
  const idle = await applyStoredAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    launcher: createDesktopLauncher(false),
    processObj: { platform: 'darwin' }
  });
  assert.deepEqual(idle, { ok: true, applied: true, status: 'cleared' });

  const launcher = createDesktopLauncher(true);
  const restarted = await applyStoredAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    launcher,
    processObj: { platform: 'darwin' }
  });
  assert.equal(restarted.status, 'restarted');
  assert.equal(launcher.calls[2].egress, null, 'fresh launch 用 egress:null 释放旧托管值');
});

test('applyStoredAccountEgress 出口不可用时不碰运行中的 Desktop', async (t) => {
  const { aiHomeDir, accountRef } = createBoundZcodeAccount(t, { mode: EGRESS_MODE_URL, proxyUrl: '127.0.0.1:1' });
  const launcher = createDesktopLauncher(true);

  const result = await applyStoredAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    launcher,
    processObj: { platform: 'darwin' },
    deps: { probeProxyServer: async () => ({ ok: false, reason: 'curl_exit_7' }) }
  });

  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.error, 'proxy_unreachable');
  assert.deepEqual(launcher.calls, []);
});

test('getAccountEgressRuntimeStatus 展示解析结果而不探测连通性，已下线绑定给出错误码', async (t) => {
  const { aiHomeDir, accountRef } = createBoundZcodeAccount(t, { mode: EGRESS_MODE_SYSTEM });
  const status = getAccountEgressRuntimeStatus({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    launcher: createDesktopLauncher(true),
    processObj: { platform: 'darwin' },
    deps: {
      detectSystemProxy: () => ({ enabled: true, httpProxy: 'http://127.0.0.1:6152' }),
      probeProxyServer: async () => {
        throw new Error('运行态展示不得探测');
      }
    }
  });
  assert.equal(status.ok, true);
  assert.equal(status.binding.mode, EGRESS_MODE_SYSTEM);
  assert.deepEqual(status.runtime, {
    resolved: { ok: true, source: EGRESS_MODE_SYSTEM, proxyServer: 'http://127.0.0.1:6152', direct: false },
    desktopRunning: true,
    desktopPid: 4321
  });

  writeJsonValue(fs, aiHomeDir, buildEgressBindingKey(accountRef), { mode: 'node', nodeId: 'node-a' });
  const retired = getAccountEgressRuntimeStatus({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' }
  });
  assert.equal(retired.binding.retired, true);
  assert.deepEqual(retired.runtime.resolved, { ok: false, error: 'account_egress_mode_retired' });
});
