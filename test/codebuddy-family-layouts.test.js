'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('node:path');
const {
  AUTH_FILE_NAMES,
  DESKTOP_APP_NAMES,
  DESKTOP_USER_DATA_ENV_KEYS,
  FAMILY_PROVIDERS,
  codebuddyDesktopUserDataDirs,
  codebuddyDesktopUserDataRoots,
  familyAuthPaths,
  familyAuthRelativeSegments,
  familyProjectionAuthPath,
  familyVendorElectronCandidates,
  isCodebuddyFamilyProvider,
  normalizeFamilyProvider,
  resolveFamilyAuthPath,
  resolveFamilyExtensionDataRoot,
  resolveFamilyPlatform,
  resolveFamilyPublicAuthDir,
  resolveFamilyUserDataParent
} = require('../lib/runtime/codebuddy-family-layouts');
const {
  CODEBUDDY_AI_SHARED_AUTH_PATH,
  CODEBUDDY_CN_SHARED_AUTH_PATH,
  CODEBUDDY_EXTENSION_AUTH_DIR,
  CODEBUDDY_INTL_SHARED_AUTH_PATH
} = require('../lib/runtime/provider-storage-policy');
const { getProviderCLIConfig } = require('../lib/provider-catalog');

const HOME = '/home/u';
const posix = nodePath.posix;

// 三平台「用户数据根」的父目录。这是整套布局唯一的平台差异，其余全部同构。
const EXPECTED_PARENT = Object.freeze({
  darwin: 'Library/Application Support',
  win32: 'AppData/Local',
  linux: '.local/share'
});

test('the family layout is one formula with exactly one per-platform difference', () => {
  assert.deepEqual([...FAMILY_PROVIDERS], ['codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn']);
  for (const [platform, parent] of Object.entries(EXPECTED_PARENT)) {
    assert.equal(resolveFamilyUserDataParent(HOME, { platform, path: posix }), posix.join(HOME, parent));
    assert.equal(
      resolveFamilyExtensionDataRoot(HOME, { platform, path: posix }),
      posix.join(HOME, parent, 'CodeBuddyExtension', 'Data')
    );
    assert.equal(
      resolveFamilyPublicAuthDir(HOME, { platform, path: posix }),
      posix.join(HOME, parent, 'CodeBuddyExtension', 'Data', 'Public', 'auth')
    );
  }
});

test('platform aliases resolve to the same layout as their Node names', () => {
  for (const [alias, canonical] of [['macos', 'darwin'], ['windows', 'win32'], ['linux', 'linux'], ['win', 'win32']]) {
    assert.equal(resolveFamilyPlatform(alias), canonical);
    assert.deepEqual(
      familyAuthRelativeSegments('codebuddy', { platform: alias }),
      familyAuthRelativeSegments('codebuddy', { platform: canonical })
    );
  }
  // 未知平台必须明确返回 ''，让调用方走"该平台无已知布局"，而不是猜一个默认值。
  assert.equal(resolveFamilyPlatform('plan9'), '');
  assert.deepEqual(familyAuthPaths(HOME, 'codebuddy', { platform: 'plan9' }), []);
  assert.equal(resolveFamilyExtensionDataRoot(HOME, { platform: 'plan9' }), '');
});

test('a caller-injected path implementation wins over the platform default', () => {
  // 平台决定**布局段**，注入的 path 决定**拼接方式**。lib/sessions/codebuddy-ide-store.js
  // 的调用约定依赖这一点：它传 posix path + 目标平台，期望得到 posix 分隔的路径。
  const root = resolveFamilyExtensionDataRoot(HOME, { platform: 'win32', path: posix });
  assert.equal(root, posix.join(HOME, 'AppData', 'Local', 'CodeBuddyExtension', 'Data'));
  assert.ok(!root.includes('\\'), 'an injected posix path must not emit win32 separators');
  // 未注入时按平台取规范实现。
  assert.equal(
    resolveFamilyExtensionDataRoot(HOME, { platform: 'win32' }),
    nodePath.win32.join(HOME, 'AppData', 'Local', 'CodeBuddyExtension', 'Data')
  );
});

test('storage policy constants stay the darwin projection of this layout', () => {
  // provider-storage-policy 的四条常量是 darwin 下的 HOME 相对段；它们必须与布局层
  // 完全同源，否则跨平台解析与按段裁剪会悄悄分叉。
  assert.deepEqual([...CODEBUDDY_EXTENSION_AUTH_DIR],
    familyAuthRelativeSegments('codebuddycn', { platform: 'darwin' }).slice(0, -1));
  for (const [provider, constant] of [
    ['codebuddy', CODEBUDDY_INTL_SHARED_AUTH_PATH],
    ['codebuddycn', CODEBUDDY_CN_SHARED_AUTH_PATH],
    ['workbuddy', CODEBUDDY_AI_SHARED_AUTH_PATH],
    ['workbuddycn', CODEBUDDY_CN_SHARED_AUTH_PATH]
  ]) {
    assert.deepEqual([...constant], familyAuthRelativeSegments(provider, { platform: 'darwin' }), provider);
  }
});

test('auth file names are the single source of truth and match the storage policy', () => {
  // 国内站两支共用一个 host id → 同一个文件；国际站两支各一份。
  assert.equal(AUTH_FILE_NAMES.codebuddycn, AUTH_FILE_NAMES.workbuddycn);
  assert.notEqual(AUTH_FILE_NAMES.workbuddy, AUTH_FILE_NAMES.workbuddycn);
  assert.equal(CODEBUDDY_CN_SHARED_AUTH_PATH.at(-1), AUTH_FILE_NAMES.codebuddycn);
  assert.equal(CODEBUDDY_AI_SHARED_AUTH_PATH.at(-1), AUTH_FILE_NAMES.workbuddy);
  assert.equal(CODEBUDDY_INTL_SHARED_AUTH_PATH.at(-1), AUTH_FILE_NAMES.codebuddy);
});

test('ordered credential candidates: primary first, the international CLI file as the CN fallback', () => {
  const linux = familyAuthPaths(HOME, 'codebuddycn', { platform: 'linux' });
  assert.deepEqual(linux, [
    resolveFamilyAuthPath(HOME, 'codebuddycn', { platform: 'linux' }),
    resolveFamilyAuthPath(HOME, 'codebuddy', { platform: 'linux' })
  ]);
  // 国际站 Provider 没有次选：它自己的文件就是唯一的站点归因来源。
  assert.deepEqual(familyAuthPaths(HOME, 'workbuddy', { platform: 'darwin' }),
    [resolveFamilyAuthPath(HOME, 'workbuddy', { platform: 'darwin' })]);
  // 位置必须随平台移动，且绝不串到别的平台。
  assert.ok(linux[0].startsWith(posix.join(HOME, '.local', 'share')));
  assert.ok(!linux[0].includes('Library'));
  assert.equal(familyAuthPaths('', 'codebuddy', { platform: 'linux' }).length, 0);
  assert.equal(familyAuthPaths(HOME, 'not-a-provider', { platform: 'linux' }).length, 0);
});

test('a sandbox projection writes its own file, never another provider host id', () => {
  // WorkBuddy 两支的 host id 与独立 CLI 不同，必须忽略传入的 hostId 写自己的文件。
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.equal(
      familyProjectionAuthPath(HOME, 'workbuddy', 'Tencent-Cloud.coding-copilot', { platform, path: posix }),
      resolveFamilyAuthPath(HOME, 'workbuddy', { platform, path: posix })
    );
  }
  // 其余 Provider 按 hostId 定位；hostId 落在候选集合之外时回退到主候选。
  assert.equal(
    familyProjectionAuthPath(HOME, 'codebuddycn', 'Tencent-Cloud.coding-copilot', { platform: 'linux' }),
    resolveFamilyAuthPath(HOME, 'codebuddy', { platform: 'linux' })
  );
  assert.equal(
    familyProjectionAuthPath(HOME, 'codebuddycn', 'unknown-host', { platform: 'linux' }),
    resolveFamilyAuthPath(HOME, 'codebuddycn', { platform: 'linux' })
  );
});

test('desktop userData candidates: declared env key, sandbox projection, then the official App name', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const pathImpl = platform === 'win32' ? nodePath.win32 : posix;
    const home = platform === 'win32' ? 'C:\\Users\\u' : HOME;
    const dirs = codebuddyDesktopUserDataDirs(home, 'codebuddy', { platform, path: pathImpl });
    assert.deepEqual(dirs, [
      pathImpl.join(home, 'electron-user-data'),
      pathImpl.join(home, ...EXPECTED_PARENT[platform].split('/'), DESKTOP_APP_NAMES.codebuddy)
    ], platform);
  }
  // 契约声明的环境变量优先，用于便携构建 / 安装包内直接启动时被改道的数据根。
  const key = DESKTOP_USER_DATA_ENV_KEYS.workbuddy[0];
  assert.equal(key, 'WORKBUDDY_USER_DATA_DIR');
  const withEnv = codebuddyDesktopUserDataDirs(HOME, 'workbuddy', {
    platform: 'darwin', env: { [key]: '/portable/WorkBuddy' }
  });
  assert.equal(withEnv[0], '/portable/WorkBuddy');
  // 未声明该键的 Provider 不认它。
  assert.equal(codebuddyDesktopUserDataDirs(HOME, 'codebuddy', {
    platform: 'darwin', env: { [key]: '/portable/WorkBuddy' }
  })[0], posix.join(HOME, 'electron-user-data'));
});

test('the scan root is the user-data parent, not the projection directory', () => {
  // 扫描用于发现"App 名未知/被改名"的目录，所以根必须是 App 目录的**父目录**；
  // 沙箱投影是直接候选，不在扫描根里。
  assert.deepEqual(codebuddyDesktopUserDataRoots(HOME, { platform: 'darwin', path: posix }),
    [posix.join(HOME, 'Library', 'Application Support')]);
  assert.deepEqual(codebuddyDesktopUserDataRoots(HOME, { platform: 'linux', path: posix }),
    [posix.join(HOME, '.local', 'share')]);
});

test('vendor Electron resolution never invents a platform that has no declared install plan', () => {
  // 契约只给 CodeBuddy 家族声明了 macOS 的免交互安装源；其余平台是明确的能力缺席。
  assert.deepEqual(
    familyVendorElectronCandidates('codebuddy', HOME, { platform: 'darwin', path: posix }),
    [
      posix.join('/Applications/CodeBuddy.app', 'Contents', 'MacOS', 'Electron'),
      posix.join(HOME, 'Applications', 'CodeBuddy.app', 'Contents', 'MacOS', 'Electron')
    ]
  );
  for (const platform of ['win32', 'linux']) {
    assert.deepEqual(familyVendorElectronCandidates('codebuddy', HOME, { platform }), [], platform);
    assert.deepEqual(familyVendorElectronCandidates('workbuddy', HOME, { platform }), [], platform);
  }
});

test('provider membership and normalisation are total', () => {
  for (const provider of FAMILY_PROVIDERS) assert.equal(isCodebuddyFamilyProvider(provider), true);
  assert.equal(isCodebuddyFamilyProvider(' CodeBuddy '), true);
  assert.equal(isCodebuddyFamilyProvider('codex'), false);
  assert.equal(isCodebuddyFamilyProvider(''), false);
  assert.equal(normalizeFamilyProvider(undefined), '');
  assert.equal(normalizeFamilyProvider('workbuddycn'), 'workbuddycn');
});

test('the declared userData env keys and App names mirror the provider contract', () => {
  // 布局层是纯函数表；这里守卫它与 contracts/providers/manifest.json 不漂移。
  for (const provider of FAMILY_PROVIDERS) {
    const desktopClient = getProviderCLIConfig(provider).desktopClient;
    const declared = desktopClient.userDataEnvKey;
    const mapped = DESKTOP_USER_DATA_ENV_KEYS[provider];
    assert.equal(mapped.includes(declared || mapped[0]), true, `${provider} env key must be reachable`);
    if (!declared) continue;
    assert.equal(mapped[0], declared, `${provider} env key must match the contract`);
    assert.equal(desktopClient.macos.clientName, DESKTOP_APP_NAMES[provider],
      `${provider} macOS clientName must equal the declared desktop userData directory name`);
  }
});
