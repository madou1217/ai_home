'use strict';

// Provider 描述符加载器 —— 动态扫描 + 兼容旧额度插件形状，失败一律**可观察**。
//
// 扫描目录（先注册者生效，内置优先于外部）：
//   1. 内置 `lib/providers/defs/`（每个 provider 一个文件）
//   2. `AIH_PROVIDER_EXTENSION_DIRS` 的 `defs` 字段（冒号分隔，可多个）
//   3. `<AIH_HOME_DIR>/provider-defs`
//   4. 兼容：`lib/usage/quota/plugins/` + `AIH_PROVIDER_EXTENSION_DIRS` 的 `quota` 字段 + `<AIH_HOME_DIR>/quota-plugins`
//      —— 旧形状（{ id, providers[], snapshotKind, source, shape, createProbe }）会被转成
//      描述符的 quota 能力，第三方已有的文件不用改。
//
// 单个文件失败（语法错误、契约不合法、provider 冲突）不影响其它文件，也不中断调用方：
// 失败进注册表的加载错误列表，由 `formatProviderLines()` / `aih server status` 暴露。

const nodePath = require('node:path');
const nodeFs = require('node:fs');

const { readProviderExtensionField } = require('./extension-dirs');

const BUILTIN_DEFS_DIR = nodePath.join(__dirname, 'defs');
const EXTERNAL_DEFS_DIR_NAME = 'provider-defs';
const LEGACY_EXTERNAL_DIR_NAME = 'quota-plugins';
const DEFINITION_FILE_PATTERN = /\.(?:cjs|js)$/iu;

function normalizeDir(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function splitDirs(value) {
  return normalizeDir(value)
    .split(nodePath.delimiter)
    .map((entry) => normalizeText(entry))
    .filter(Boolean);
}

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function listDefinitionFiles(dir, fs) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => DEFINITION_FILE_PATTERN.test(name))
      .sort()
      .map((name) => nodePath.join(dir, name));
  } catch (_error) {
    return [];
  }
}

function resolveDefinitionDirs(options = {}) {
  const env = options.env || {};
  const aiHomeDir = normalizeDir(options.aiHomeDir);
  const dirs = [{ dir: options.builtinDir || BUILTIN_DEFS_DIR, origin: 'builtin' }];
  for (const dir of splitDirs(readProviderExtensionField(env, 'defs'))) dirs.push({ dir, origin: 'external' });
  if (aiHomeDir) dirs.push({ dir: nodePath.join(aiHomeDir, EXTERNAL_DEFS_DIR_NAME), origin: 'external' });
  return dirs;
}

function resolveLegacyPluginDirs(options = {}) {
  const env = options.env || {};
  const aiHomeDir = normalizeDir(options.aiHomeDir);
  const dirs = [];
  for (const dir of splitDirs(readProviderExtensionField(env, 'quota'))) dirs.push({ dir, origin: 'external' });
  if (aiHomeDir) dirs.push({ dir: nodePath.join(aiHomeDir, LEGACY_EXTERNAL_DIR_NAME), origin: 'external' });
  return dirs;
}

function resolveDefinitionModule(loadedModule) {
  if (loadedModule && typeof loadedModule === 'object' && loadedModule.capabilities) return loadedModule;
  if (loadedModule && typeof loadedModule === 'object' && loadedModule.default) return loadedModule.default;
  return loadedModule;
}

/**
 * 旧额度插件形状 → 描述符（一个插件可以覆盖多个 provider）。
 * 只做形状搬运，不改变语义；契约校验仍由描述符校验器统一负责。
 */
function legacyPluginToDescriptors(plugin) {
  const providers = Array.isArray(plugin && plugin.providers) ? plugin.providers : [];
  return providers.map((provider) => ({
    contractVersion: 1,
    id: String(provider).trim().toLowerCase(),
    capabilities: {
      quota: {
        supported: true,
        kind: plugin.snapshotKind,
        source: plugin.source,
        shape: plugin.shape,
        entryShape: plugin.entryShape || 'window',
        strategies: [{
          id: `${plugin.id}-http`,
          transport: 'http',
          clientDependent: false,
          probe: plugin.createProbe,
          description: normalizeText(plugin.description)
        }]
      }
    }
  }));
}

function registerDefinition(registry, definition, origin, target) {
  const descriptors = Array.isArray(definition) ? definition : [definition];
  const registered = [];
  for (const descriptor of descriptors) {
    const withAuthSources = withDefaultHostAuthSources(descriptor);
    registry.register(withAuthSources, { origin });
    registered.push(withAuthSources.id);
  }
  return registered;
}

/**
 * 默认认证来源注入：**有宿主凭据产物**、且认证方式里有 oauth-browser 的 provider，
 * 自动获得一个「从本机导入」来源（描述符显式声明 authSources 时不注入）。
 *
 * 这样新增 provider 只要它有宿主凭据（provider-storage-policy 的 authArtifacts）+ OAuth 登录流程，
 * 「从本机导入」就自动可用，不需要在描述符里再抄一遍声明；反过来，显式声明仍然优先。
 * 惰性 require + fail-open：注册表构建不应因为这一层而失败。
 */
function withDefaultHostAuthSources(descriptor) {
  try {
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) return descriptor;
    const capabilities = descriptor.capabilities;
    if (!capabilities || typeof capabilities !== 'object') return descriptor;
    if (capabilities.authSources !== undefined) return descriptor;
    const provider = String(descriptor.id || '').trim().toLowerCase();
    if (!provider) return descriptor;
    const { createHostAuthSources, hostAuthArtifacts } = require('../account/host-auth-import');
    if (hostAuthArtifacts(provider).length === 0) return descriptor;
    const { getProviderAuthOptions } = require('../provider-catalog');
    const modes = getProviderAuthOptions(provider).map((option) => option.value);
    // 来源挂在哪个认证方式上由**声明**决定：有 OAuth 流程就挂 OAuth（用户在那里点「从本机导入」），
    // 否则挂第一个声明的认证方式（例如只有 api-key 的 provider，本机登录态走直连注册而不是登录任务）。
    const authMode = modes.includes('oauth-browser') ? 'oauth-browser' : (modes[0] || '');
    if (!authMode) return descriptor;
    return {
      ...descriptor,
      capabilities: {
        ...capabilities,
        authSources: createHostAuthSources(provider, { app: 'cli', authMode })
      }
    };
  } catch (_error) {
    return descriptor;
  }
}

/**
 * 加载全部 provider 描述符（内置 defs + 外部目录 + 兼容的旧额度插件目录）。
 * @returns {{loaded: Array<object>, errors: Array<object>}}
 */
function loadProviderDefinitions(options = {}) {
  const registry = options.registry;
  if (!registry || typeof registry.register !== 'function') {
    throw new Error('provider_registry_required');
  }
  const fs = options.fs || nodeFs;
  const requireFn = typeof options.requireFn === 'function' ? options.requireFn : require;
  const loaded = [];
  const errors = [];

  const sources = [
    ...resolveDefinitionDirs(options).map((entry) => ({ ...entry, legacy: false })),
    ...(options.skipLegacy ? [] : resolveLegacyPluginDirs(options).map((entry) => ({ ...entry, legacy: true })))
  ];

  for (const source of sources) {
    for (const file of listDefinitionFiles(source.dir, fs)) {
      try {
        const moduleValue = resolveDefinitionModule(requireFn(file));
        const definition = source.legacy ? legacyPluginToDescriptors(moduleValue) : moduleValue;
        const ids = registerDefinition(registry, definition, source.origin, file);
        for (const id of ids) loaded.push(Object.freeze({ id, origin: source.origin, file, legacy: source.legacy }));
      } catch (error) {
        errors.push(registry.recordLoadError({
          code: error && error.code || 'provider_descriptor_load_failed',
          detail: error && error.detail,
          message: error && error.message,
          target: file
        }));
      }
    }
  }
  return { loaded, errors };
}

module.exports = {
  BUILTIN_DEFS_DIR,
  EXTERNAL_DEFS_DIR_NAME,
  LEGACY_EXTERNAL_DIR_NAME,
  resolveDefinitionDirs,
  resolveLegacyPluginDirs,
  listDefinitionFiles,
  legacyPluginToDescriptors,
  loadProviderDefinitions
};
