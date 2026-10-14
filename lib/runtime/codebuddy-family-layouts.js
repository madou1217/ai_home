'use strict';

const nodePath = require('node:path');
const { toNodePlatform } = require('./client-platform');

/**
 * CodeBuddy 家族（`codebuddy` / `codebuddycn` / `workbuddy` / `workbuddycn`）四支
 * 客户端的磁盘布局在三个平台上**完全同构**，只有「用户数据根」的父目录随平台变化：
 *
 *   macOS   ~/Library/Application Support
 *   Windows %LOCALAPPDATA%    （即 ~/AppData/Local）
 *   Linux   ~/.local/share    （XDG_DATA_HOME 的默认值）
 *
 * 官方内核（CodeBuddyIDE / CodeBuddyExtension 的 FilePathServiceImpl.getBasePath）
 * 就是这条公式，WorkBuddy 桌面端复用同一内核，因此与 IDE 共享同一个 Data 根。
 * 本模块是该布局的**唯一真值来源**：provider-storage-policy、凭据发现、桌面端凭据
 * 读取、IDE 会话发现都从这里取路径，不再各自硬编码 macOS 路径段。
 *
 * 两层派生：
 *   1) 扩展数据根   `<userDataParent>/CodeBuddyExtension/Data`
 *   2) 共享凭据目录 `<扩展数据根>/Public/auth/<host>.info`
 *
 * 关于凭据文件名：文件名只用于**定位**，站点真值是 token 的 realm（`iss`）。
 * 国内站两支客户端共用同一个 host id（`workbuddy-desktop`），因此共用同一个文件；
 * 国际站两支各一份（WorkBuddy AI 的 `-ai` 后缀由该构建在运行时拼出）。
 *
 * 关于「安装包里直接打开」：`.info` 由 bundle 内嵌的扩展/CLI 写出，路径只依赖平台与
 * HOME，因此与 App 从哪里启动无关；而 Electron 的 `state.vscdb` 落在
 * `<userDataParent>/<App 名>/` 下，**App 名不确定**。所以桌面端凭据除了按已知 App 名
 * 定位外，还要能按扩展 ID 特征扫描整个用户数据根——见
 * `codebuddyDesktopUserDataRoots` 与 lib/account/codebuddy-desktop-credential.js。
 */

const FAMILY_PROVIDERS = Object.freeze(['codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn']);

// Provider → 共享 .info 文件名。改这里必须同步 lib/account/codebuddy-credential-source.js
// 的 ISSUERS 校验：文件名的归属最终由 realm 判定，不由文件名判定。
const AUTH_FILE_NAMES = Object.freeze({
  codebuddy: 'Tencent-Cloud.coding-copilot.info',
  codebuddycn: 'workbuddy-desktop.info',
  workbuddy: 'workbuddy-desktop-ai.info',
  workbuddycn: 'workbuddy-desktop.info'
});

// 国内站的两支客户端历史上也读国际站独立分发 CLI（`@tencent-ai/codebuddy-code`）写下的
// 那一个文件，因此把国际站文件作为**次选**候选（顺序即优先级：本 Provider 的文件优先）。
const CROSS_SITE_FALLBACK = Object.freeze({
  codebuddycn: 'codebuddy',
  workbuddycn: 'codebuddy'
});

// 桌面端 App 的 Electron userData 目录名（= 契约里的 desktopClient.<platform>.clientName）。
// WorkBuddy 与 WorkBuddy AI 是两个不同构建，目录名因此不同。
const DESKTOP_APP_NAMES = Object.freeze({
  codebuddy: 'CodeBuddy',
  codebuddycn: 'CodeBuddy CN',
  workbuddy: 'WorkBuddy AI',
  workbuddycn: 'WorkBuddy'
});

// 契约 desktopClient.userDataEnvKey 声明的环境变量键。桌面端以 `--user-data-dir` 之外的
// 方式改道数据根时（便携构建、安装包内直接启动），只有这个键能指出真正的数据根。
// 与 contracts/providers/manifest.json 的一致性由 test/codebuddy-family-layouts.test.js 守卫。
const DESKTOP_USER_DATA_ENV_KEYS = Object.freeze({
  codebuddy: Object.freeze(['ELECTRON_USER_DATA_DIR']),
  codebuddycn: Object.freeze(['ELECTRON_USER_DATA_DIR']),
  workbuddy: Object.freeze(['WORKBUDDY_USER_DATA_DIR', 'ELECTRON_USER_DATA_DIR']),
  workbuddycn: Object.freeze(['WORKBUDDY_USER_DATA_DIR', 'ELECTRON_USER_DATA_DIR'])
});

// 各平台「用户数据根」的父目录（HOME 相对段）。
const USER_DATA_PARENT_SEGMENTS = Object.freeze({
  darwin: Object.freeze(['Library', 'Application Support']),
  win32: Object.freeze(['AppData', 'Local']),
  linux: Object.freeze(['.local', 'share'])
});

const EXTENSION_DATA_SEGMENTS = Object.freeze(['CodeBuddyExtension', 'Data']);
const PUBLIC_AUTH_SEGMENTS = Object.freeze(['Public', 'auth']);

// 契约的 desktopClient 键名与 Node 平台名不同，这里显式映射，避免调用方各自翻译。
const CONTRACT_PLATFORM_KEYS = Object.freeze({ darwin: 'macos', win32: 'windows', linux: 'linux' });

// 「安装路径模板」→ vendor Electron 可执行文件的相对位置。只有契约里真正声明了桌面安装
// 计划的平台才有条目（CodeBuddy 家族目前只有 macOS 有官方免交互安装源），其余平台刻意
// 缺席：读不到 vendor 运行时是**明确的能力缺席**，不能用猜的路径去试。
const DESKTOP_ELECTRON_RELATIVE_PATHS = Object.freeze({
  darwin: Object.freeze(['Contents', 'MacOS', 'Electron'])
});

// aih 自己的沙箱投影目录：桌面端以 `--user-data-dir=<profileDir>/electron-user-data`
// 启动，因此这个目录名与平台无关。
const PROJECTION_USER_DATA_DIR = 'electron-user-data';

function normalizeFamilyProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(AUTH_FILE_NAMES, value) ? value : '';
}

/** 该 Provider 是否属于 CodeBuddy 家族（四支客户端共享同一套凭据形状与布局）。 */
function isCodebuddyFamilyProvider(provider) {
  return normalizeFamilyProvider(provider) !== '';
}

/**
 * 归一化到 Node 平台名（'darwin' | 'win32' | 'linux'）。接受契约名（'macos'/'windows'）、
 * 别名与 Node 名；无法识别时返回 ''，调用方据此判断「该平台无已知布局」。
 */
function resolveFamilyPlatform(platform) {
  const explicit = String(platform == null ? '' : platform).trim();
  const nodePlatform = toNodePlatform(explicit || process.platform);
  return nodePlatform && USER_DATA_PARENT_SEGMENTS[nodePlatform] ? nodePlatform : '';
}

/**
 * 路径拼接实现的选择规则：**平台决定布局段，调用方注入的 `path` 决定拼接方式**。
 * 调用方显式传入 path 时原样尊重（测试与跨平台规划都依赖这一点，见
 * lib/sessions/codebuddy-ide-store.js 的调用约定）；未传时按平台取规范实现。
 */
function resolveFamilyPathImpl(platform, preferredPath) {
  if (preferredPath) return preferredPath;
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

function contractPlatformKey(platform) {
  return CONTRACT_PLATFORM_KEYS[resolveFamilyPlatform(platform)] || '';
}

function userDataParentSegments(platform) {
  return USER_DATA_PARENT_SEGMENTS[resolveFamilyPlatform(platform)] || null;
}

/** `<home>/Library/Application Support` 等：各平台「用户数据根」的父目录。 */
function resolveFamilyUserDataParent(home, options = {}) {
  const platform = resolveFamilyPlatform(options.platform);
  const segments = platform ? USER_DATA_PARENT_SEGMENTS[platform] : null;
  if (!home || !segments) return '';
  return resolveFamilyPathImpl(platform, options.path).join(String(home), ...segments);
}

/** `<userDataParent>/CodeBuddyExtension/Data`：扩展（IDE / 桌面端内嵌 CLI）的数据根。 */
function resolveFamilyExtensionDataRoot(home, options = {}) {
  const parent = resolveFamilyUserDataParent(home, options);
  if (!parent) return '';
  return resolveFamilyPathImpl(resolveFamilyPlatform(options.platform), options.path)
    .join(parent, ...EXTENSION_DATA_SEGMENTS);
}

/** `<扩展数据根>/Public/auth`：共享 `.info` 凭据所在目录。 */
function resolveFamilyPublicAuthDir(home, options = {}) {
  const root = resolveFamilyExtensionDataRoot(home, options);
  if (!root) return '';
  return resolveFamilyPathImpl(resolveFamilyPlatform(options.platform), options.path)
    .join(root, ...PUBLIC_AUTH_SEGMENTS);
}

/** Provider 共享凭据文件的 HOME 相对路径段（供 storage policy 的 authArtifact 使用）。 */
function familyAuthRelativeSegments(provider, options = {}) {
  const normalized = normalizeFamilyProvider(provider);
  const platform = resolveFamilyPlatform(options.platform);
  if (!normalized || !platform) return [];
  return [...USER_DATA_PARENT_SEGMENTS[platform], ...EXTENSION_DATA_SEGMENTS, ...PUBLIC_AUTH_SEGMENTS,
    AUTH_FILE_NAMES[normalized]];
}

/** Provider 共享凭据文件的绝对路径（主候选）。 */
function resolveFamilyAuthPath(home, provider, options = {}) {
  const segments = familyAuthRelativeSegments(provider, options);
  if (!home || !segments.length) return '';
  return resolveFamilyPathImpl(resolveFamilyPlatform(options.platform), options.path).join(String(home), ...segments);
}

/**
 * Provider 的有序凭据候选：首选项是本 Provider 自己的文件；国内站额外把国际站文件
 * 作为次选。语义与既有的 `codebuddyCredentialPaths` 一致，只是平台可参数化。
 */
function familyAuthPaths(home, provider, options = {}) {
  const normalized = normalizeFamilyProvider(provider);
  if (!home || !normalized) return [];
  const primary = resolveFamilyAuthPath(home, normalized, options);
  if (!primary) return [];
  const files = [primary];
  const fallback = CROSS_SITE_FALLBACK[normalized];
  if (fallback) files.push(resolveFamilyAuthPath(home, fallback, options));
  return Array.from(new Set(files));
}

/**
 * 沙箱投影里应当写入哪个凭据文件：WorkBuddy 两支固定写自己的文件（它们的 host id 与
 * 独立 CLI 不同，不能借用 CLI 的 hostId），其余按 hostId 定位，落在候选集合之外时
 * 回退到主候选。
 */
function familyProjectionAuthPath(home, provider, hostId, options = {}) {
  const normalized = normalizeFamilyProvider(provider);
  const paths = familyAuthPaths(home, normalized, options);
  if (!paths.length) return '';
  const sourceId = normalized.startsWith('workbuddy')
    ? nodePath.basename(AUTH_FILE_NAMES[normalized], '.info')
    : String(hostId || '');
  if (!sourceId) return paths[0];
  const candidate = resolveFamilyPathImpl(resolveFamilyPlatform(options.platform), options.path)
    .join(resolveFamilyPublicAuthDir(home, options), `${sourceId}.info`);
  return paths.includes(candidate) ? candidate : paths[0];
}

/**
 * 桌面端 App 的 Electron userData 候选目录（有序）：
 *   1) 契约声明的环境变量（便携构建 / 安装包内直接启动的改道情形）
 *   2) aih 沙箱投影（`--user-data-dir=<profileDir>/electron-user-data`）
 *   3) 各平台官方 App 名对应的目录
 */
function codebuddyDesktopUserDataDirs(home, provider, options = {}) {
  const normalized = normalizeFamilyProvider(provider);
  const platform = resolveFamilyPlatform(options.platform);
  if (!normalized || !platform) return [];
  const pathImpl = resolveFamilyPathImpl(platform, options.path);
  const dirs = [];
  const env = options.env || {};
  for (const key of DESKTOP_USER_DATA_ENV_KEYS[normalized]) {
    const value = String(env[key] || '').trim();
    if (value) { dirs.push(value); break; }
  }
  if (home) dirs.push(pathImpl.join(String(home), PROJECTION_USER_DATA_DIR));
  if (home) dirs.push(pathImpl.join(String(home), ...USER_DATA_PARENT_SEGMENTS[platform], DESKTOP_APP_NAMES[normalized]));
  return Array.from(new Set(dirs));
}

/**
 * 需要**枚举子目录**的桌面端 userData 根。扫描而不是枚举已知 App 名，是为了覆盖
 * 「App 名未知 / 应用被改名 / 安装包内直接启动」的场景：归属只按扩展 ID 特征判定，
 * 不按目录名判定。`<home>/electron-user-data` 不在此列——它是**直接候选**
 * （见 `codebuddyDesktopUserDataDirs`），不是 App 目录的父目录。
 */
function codebuddyDesktopUserDataRoots(home, options = {}) {
  const platform = resolveFamilyPlatform(options.platform);
  if (!home || !platform) return [];
  return [resolveFamilyPathImpl(platform, options.path).join(String(home), ...USER_DATA_PARENT_SEGMENTS[platform])];
}

/** 契约 desktopClient 在该平台的安装路径模板（`{hostHomeDir}` 未展开）。 */
function familyDesktopInstallPathTemplates(provider, options = {}) {
  const normalized = normalizeFamilyProvider(provider);
  const key = contractPlatformKey(options.platform);
  if (!normalized || !key) return [];
  // 延迟 require：布局模块保持无副作用，且 provider-catalog 会读盘。
  const { getProviderCLIConfig } = require('../provider-catalog');
  const config = getProviderCLIConfig(normalized);
  const entries = config && config.desktopClient && config.desktopClient[key];
  const templates = entries && Array.isArray(entries.installPaths) ? entries.installPaths : [];
  return templates.filter(template => typeof template === 'string' && template.trim());
}

/**
 * 挂载卷里的 App bundle 根（DMG 直跑）。
 *
 * 契约的 `desktopClient.<platform>.installPaths` 只声明「安装」位置（/Applications 与
 * ~/Applications），但用户完全可能**直接从安装镜像里打开 App** —— 这正是「安装包内直接启动」
 * 的形态：官方 Electron 运行时、内嵌 CLI、at-rest 密钥都只在那个 bundle 里。
 * 传入卷根路径列表（由调用方读盘得到，布局层保持无副作用）；镜像没挂载时为空，
 * 调用方据此 fail-closed（报「运行时缺失」而不是去猜路径）。
 */
function familyVolumeAppRoots(provider, volumeRoots, options = {}) {
  const normalized = normalizeFamilyProvider(provider);
  const platform = resolveFamilyPlatform(options.platform);
  const name = DESKTOP_APP_NAMES[normalized];
  // 安装镜像（DMG 直跑）是 macOS 的概念：其他平台没有「挂载卷里的 App bundle」这回事。
  if (!normalized || platform !== 'darwin' || !name) return [];
  const pathImpl = resolveFamilyPathImpl(platform, options.path);
  return (Array.isArray(volumeRoots) ? volumeRoots : [])
    .filter((root) => typeof root === 'string' && root.trim())
    .map((root) => pathImpl.join(String(root).trim(), `${name}.app`));
}

/**
 * 桌面端 App bundle 的**全部**候选根：契约声明的安装位置 + 挂载卷里的镜像。
 * 运行时解析（内嵌 CLI、vendor Electron）都从这里取根，再各自拼自己的相对位置 ——
 * 「装在哪」这件事只有一份真值，不在调用方各写一遍。
 */
function familyDesktopAppRoots(provider, home, volumeRoots, options = {}) {
  const platform = resolveFamilyPlatform(options.platform);
  if (!platform) return [];
  const pathImpl = resolveFamilyPathImpl(platform, options.path);
  const declared = familyDesktopInstallPathTemplates(provider, { ...options, platform })
    .filter((template) => !template.includes('{hostHomeDir}') || home)
    .map((template) => pathImpl.join(String(template).replace('{hostHomeDir}', String(home || ''))));
  return Array.from(new Set([...declared, ...familyVolumeAppRoots(provider, volumeRoots, { ...options, platform })]));
}

/**
 * vendor Electron 可执行文件的候选绝对路径。空数组表示「该平台没有可用的 vendor 运行时」
 * ——这是明确的能力缺席（例如 CodeBuddy 家族在 Windows/Linux 没有官方免交互安装源，
 * 或者安装镜像没挂载），调用方应当据此报告不可用，而不是回退到猜测的路径。
 */
function familyVendorElectronCandidates(provider, home, options = {}) {
  const platform = resolveFamilyPlatform(options.platform);
  const relative = DESKTOP_ELECTRON_RELATIVE_PATHS[platform];
  if (!relative) return [];
  const pathImpl = resolveFamilyPathImpl(platform, options.path);
  return familyDesktopAppRoots(provider, home, options.volumeRoots, { ...options, platform })
    .map((root) => pathImpl.join(root, ...relative));
}

const VOLUME_ROOT = '/Volumes';

/**
 * 挂载卷根路径。布局层里唯一的 I/O 助手：只列一层目录、跳过启动卷与系统挂载点，
 * 最多 16 个（DMG 直跑的镜像卷就在其中）。平台不是 darwin、或读不到时返回空数组。
 */
function familyMountedVolumeRoots(fsImpl, options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return [];
  if (!fsImpl || typeof fsImpl.readdirSync !== 'function') return [];
  let entries;
  try { entries = fsImpl.readdirSync(VOLUME_ROOT, { withFileTypes: true }); } catch (_) { return []; }
  return entries
    .filter((entry) => entry && entry.isDirectory() && entry.name !== 'Macintosh HD' && !entry.name.startsWith('com.apple.'))
    .slice(0, 16)
    .map((entry) => `${VOLUME_ROOT}/${entry.name}`);
}

module.exports = {
  AUTH_FILE_NAMES,
  CROSS_SITE_FALLBACK,
  DESKTOP_APP_NAMES,
  DESKTOP_ELECTRON_RELATIVE_PATHS,
  DESKTOP_USER_DATA_ENV_KEYS,
  EXTENSION_DATA_SEGMENTS,
  FAMILY_PROVIDERS,
  PROJECTION_USER_DATA_DIR,
  PUBLIC_AUTH_SEGMENTS,
  USER_DATA_PARENT_SEGMENTS,
  codebuddyDesktopUserDataDirs,
  codebuddyDesktopUserDataRoots,
  contractPlatformKey,
  familyAuthPaths,
  familyAuthRelativeSegments,
  familyDesktopAppRoots,
  familyDesktopInstallPathTemplates,
  familyMountedVolumeRoots,
  familyProjectionAuthPath,
  familyVendorElectronCandidates,
  familyVolumeAppRoots,
  isCodebuddyFamilyProvider,
  normalizeFamilyProvider,
  resolveFamilyAuthPath,
  resolveFamilyExtensionDataRoot,
  resolveFamilyPathImpl,
  resolveFamilyPlatform,
  resolveFamilyPublicAuthDir,
  resolveFamilyUserDataParent,
  userDataParentSegments
};
