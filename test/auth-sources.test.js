'use strict';

// 认证来源（authSources 能力 + 解析器 + Kiro IDE 本机导入）回归。
//
// 这一层的意义：同一个认证方式可能有多个来源（kiro 的 refresh_token 既能读本机 Kiro IDE 登录态、
// 也能让用户粘贴；设备码只有远程一条路）。界面与任务链路只消费解析结果，不自己判断环境。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveAuthSources, describeAuthMethodsWithSources, pickAuthSource } = require('../lib/account/auth-sources');
const { createHostCapabilities } = require('../lib/runtime/host-capabilities');
const { getProviderCapability, listProviderDescriptorLoadErrors } = require('../lib/providers');
const { getProviderAuthOptions } = require('../lib/provider-catalog');
const {
  readKiroIdeTokenFile,
  resolveKiroIdeTokenPath,
  importKiroIdeLogin
} = require('../lib/account/kiro-ide-import');

/** 注入替身宿主机能力：不碰真实进程扫描。 */
function hostWith({ desktopInstalled = false, cliInstalled = false, installable = false } = {}) {
  return createHostCapabilities({
    processObj: { platform: 'darwin', env: {} },
    env: {},
    appEntryDetector: { detect: () => ({ kiro: { desktop: desktopInstalled, cli: cliInstalled } }), invalidate() {} },
    getAppInstaller: () => (installable ? { resolveDesktopInstallPlans: () => [{ command: 'brew' }] } : null),
    getProviderDefinition: () => ({ clients: { cli: true, desktop: true } }),
    normalizePlatform: () => 'macos'
  });
}

test('描述符加载零错误：kiro 的 authSources 声明合法（能力未登记会被整条拒掉）', () => {
  assert.deepEqual(listProviderDescriptorLoadErrors(), []);
  const capability = getProviderCapability('kiro', 'authSources');
  assert.equal(capability.supported, true);
  // kiro 有两条设备流：Builder ID（AWS SSO OIDC）与 social（Google / GitHub，另一套协议）。
  assert.deepEqual(capability.sources.map((source) => source.id),
    ['kiro-ide-local', 'kiro-device-code', 'kiro-social-device-code', 'kiro-paste-token']);
});

test('每个认证来源的 authMode 必须存在于 Go 契约声明的认证方式里（跨语言防漂移）', () => {
  const capability = getProviderCapability('kiro', 'authSources');
  const declared = getProviderAuthOptions('kiro').map((option) => option.value);
  for (const source of capability.sources) {
    assert.ok(declared.includes(source.authMode),
      `来源 ${source.id} 的 authMode=${source.authMode} 不在契约 authOptions ${declared.join(',')} 里`);
  }
});

test('解析：本机登录态读得到时本机来源可用且排在最前（可用性看凭据不看二进制）', () => {
  // 规则（2026-10-15）：本机来源可用性 = 登录态文件读得到，与客户端装没装无关。
  // 因此夹具给出一个「读得到登录态」的临时家目录，而不是替身宿主能力里的 desktopInstalled。
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-auth-sources-'));
  try {
    const tokenPath = path.join(hostHomeDir, '.aws', 'sso', 'cache', 'kiro-auth-token.json');
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify({ refreshToken: 'aor-ide' }));
    const options = { hostCapabilitiesOptions: { hostHomeDir } };

    const resolved = resolveAuthSources('kiro', options);
    assert.equal(resolved.supported, true);
    assert.equal(resolved.sources[0].id, 'kiro-ide-local', '可用来源必须排最前');
    const ide = resolved.sources.find((source) => source.id === 'kiro-ide-local');
    assert.equal(ide.available, true);
    assert.equal(ide.installable, false);
    assert.equal(ide.reason, '');
    assert.equal(typeof ide.implementation, 'function', '可用来源必须给出实现');
    const methods = describeAuthMethodsWithSources('kiro', options);
    const refreshToken = methods.methods.find((method) => method.authMode === 'oauth-refresh-token');
    assert.equal(refreshToken.preferredSourceId, 'kiro-ide-local');
    assert.equal(refreshToken.localSourceAvailable, true);
  } finally {
    fs.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('解析：没装但可装 → 不可用但可安装；不可安装 → 给出原因', () => {
  const installable = resolveAuthSources('kiro', { hostCapabilities: hostWith({ installable: true }) });
  const ide = installable.sources.find((source) => source.id === 'kiro-ide-local');
  assert.equal(ide.available, false);
  assert.equal(ide.installable, true);
  assert.equal(ide.reason, 'client_not_installed');
  assert.equal(ide.implementation, null, '不可用来源不得给出实现');
  const methods = describeAuthMethodsWithSources('kiro', { hostCapabilities: hostWith({ installable: true }) });
  const refreshToken = methods.methods.find((method) => method.authMode === 'oauth-refresh-token');
  assert.equal(refreshToken.preferredSourceId, 'kiro-paste-token');
  assert.equal(refreshToken.installableSourceId, 'kiro-ide-local');
  assert.equal(refreshToken.localSourceAvailable, false);

  const unavailable = resolveAuthSources('kiro', { hostCapabilities: hostWith() });
  const ideUnavailable = unavailable.sources.find((source) => source.id === 'kiro-ide-local');
  assert.equal(ideUnavailable.installable, false);
  assert.equal(ideUnavailable.reason, 'client_unavailable');
  const device = unavailable.sources.find((source) => source.id === 'kiro-device-code');
  assert.equal(device.available, true);
  assert.equal(device.clientDependent, false);
});

test('解析：不支持的 provider 明确回答「不支持」，不伪装成空来源', () => {
  // 所有已登记 provider 现在都有 authSources（loader 会给有宿主凭据产物的 provider 默认注入）；
  // 该契约面向「未知/未登记 provider」的防御路径：必须显式回答 supported=false 而不是空 sources。
  const resolved = resolveAuthSources('no-such-provider', { hostCapabilities: hostWith() });
  assert.equal(resolved.supported, false);
  assert.deepEqual(resolved.sources, []);
  assert.equal(pickAuthSource(resolved, 'oauth-device'), null);
});

test('本机可观察 provider 必须登记扫描来源（探测器注册表 ↔ 认证来源表，单一真值来源）', () => {
  const { hostAccountDetectionProviders } = require('../lib/account/host-account-detectors');
  const providers = hostAccountDetectionProviders();
  assert.ok(providers.length > 0, '注册表不该为空');
  for (const provider of providers) {
    const capability = getProviderCapability(provider, 'authSources');
    assert.ok(capability && capability.supported, `${provider} 未声明 authSources`);
    assert.ok(capability.sources.some((source) => source.handler === 'host-account-scan'),
      `${provider} 有本机账号探测器，却没登记 host-account-scan 来源`);
  }
});

test('来源的 handler 必须在契约词汇表里（写错立刻被拒，而不是静默不生效）', () => {
  assert.deepEqual(listProviderDescriptorLoadErrors(), []);
  const { validateProviderDescriptor } = require('../lib/providers/contract');
  const base = {
    contractVersion: 1,
    id: 'demo',
    capabilities: {
      quota: { supported: false, reason: 'demo' },
      authSources: {
        supported: true,
        sources: [{ id: 'x', kind: 'remote', clientDependent: false, authMode: 'oauth-device', handler: 'bogus-handler' }]
      }
    }
  };
  assert.throws(() => validateProviderDescriptor(base), /auth_source_handler_invalid/);
});

test('Kiro IDE 本机导入：读 token 文件后真刷一次，缺文件/坏 JSON/缺 refreshToken 各有明确原因', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-ide-'));
  try {
    const tokenPath = resolveKiroIdeTokenPath({ hostHomeDir: root });
    assert.equal(tokenPath, path.join(root, '.aws', 'sso', 'cache', 'kiro-auth-token.json'));
    assert.equal(readKiroIdeTokenFile({ hostHomeDir: root, fs }).reason, 'ide_token_file_missing');

    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, '{ not json');
    assert.equal(readKiroIdeTokenFile({ hostHomeDir: root, fs }).reason, 'ide_token_file_invalid_json');

    fs.writeFileSync(tokenPath, JSON.stringify({ accessToken: 'a' }));
    assert.equal(readKiroIdeTokenFile({ hostHomeDir: root, fs }).reason, 'ide_token_missing_refresh_token');

    fs.writeFileSync(tokenPath, JSON.stringify({
      accessToken: 'aoa-ide', refreshToken: 'aor-ide', expiresAt: '2030-01-01T00:00:00Z',
      authMethod: 'social', provider: 'Google', profileArn: 'arn:profile/ide'
    }));
    const read = readKiroIdeTokenFile({ hostHomeDir: root, fs });
    assert.equal(read.ok, true);
    assert.equal(read.refreshToken, 'aor-ide');
    assert.equal(read.provider, 'Google');

    // 真刷一次（注入替身）：导入结果必须带上 social 标记与 profileArn，供下游判型/采集使用。
    const seen = [];
    const imported = await importKiroIdeLogin({
      hostHomeDir: root, fs,
      importKiroRefreshToken: async (input) => {
        seen.push(input);
        return { flavour: 'desktop', profileArn: input.profileArn,
          auth: { access_token: 'aoa-fresh', authMethod: 'social' } };
      }
    });
    assert.equal(imported.ok, true);
    assert.equal(imported.source, 'kiro-ide');
    assert.equal(seen[0].refreshToken, 'aor-ide');
    assert.equal(seen[0].profileArn, 'arn:profile/ide');
    assert.equal(imported.auth.access_token, 'aoa-fresh');

    // 刷新失败 → 带原因失败，不谎报成功
    const failed = await importKiroIdeLogin({
      hostHomeDir: root, fs,
      importKiroRefreshToken: async () => {
        const error = new Error('x');
        error.code = 'kiro_desktop_refresh_unauthorized';
        throw error;
      }
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, 'kiro_desktop_refresh_unauthorized');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
