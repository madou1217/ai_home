'use strict';

// 额度插件加载器 —— 插件目录发现 + 加载 + 校验登记，失败一律**可观察**。
//
// 目录顺序（先注册者生效）：
//   1. 内置目录 `lib/usage/quota/plugins/`（随内核发布的插件，如 cline-pass）
//   2. 环境变量 `AIH_QUOTA_PLUGIN_DIR`（冒号分隔，可多个）
//   3. `<AIH_HOME>/quota-plugins`（运维/用户自装插件）
//
// 单个插件加载失败（语法错误、契约不合法、provider 已被 native 或别的插件认领）不会
// 影响其它插件，也不会中断调用方：失败被记进 registry 的加载错误列表，由
// `listQuotaPluginLoadErrors()` 暴露（AGENTS.md：兼容/降级必须显式可观察，不得静默跳过）。

const nodePath = require('node:path');
const nodeFs = require('node:fs');

const BUILTIN_PLUGIN_DIR = nodePath.join(__dirname, 'plugins');
const EXTERNAL_PLUGIN_DIR_NAME = 'quota-plugins';
const PLUGIN_FILE_PATTERN = /\.(?:cjs|js)$/iu;

function normalizeDir(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function resolveExternalPluginDirs(options = {}) {
  const env = options.env || {};
  const dirs = [];
  const envDirs = normalizeDir(env.AIH_QUOTA_PLUGIN_DIR);
  if (envDirs) {
    for (const entry of envDirs.split(nodePath.delimiter)) {
      const dir = normalizeDir(entry);
      if (dir) dirs.push(dir);
    }
  }
  const aiHomeDir = normalizeDir(options.aiHomeDir);
  if (aiHomeDir) dirs.push(nodePath.join(aiHomeDir, EXTERNAL_PLUGIN_DIR_NAME));
  return dirs;
}

function listPluginFiles(dir, fs) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => PLUGIN_FILE_PATTERN.test(name))
      .sort()
      .map((name) => nodePath.join(dir, name));
  } catch (_error) {
    return [];
  }
}

/** 插件模块既可以 `module.exports = definition`，也可以用 `export default definition`。 */
function resolvePluginDefinition(loadedModule) {
  if (loadedModule && typeof loadedModule === 'object' && typeof loadedModule.createProbe === 'function') {
    return loadedModule;
  }
  if (loadedModule && typeof loadedModule === 'object' && loadedModule.default) return loadedModule.default;
  return loadedModule;
}

/**
 * 加载全部额度插件并登记进注册表。
 * @returns {{loaded: Array<object>, errors: Array<object>}}
 */
function loadQuotaPlugins(options = {}) {
  const registry = options.registry;
  if (!registry || typeof registry.registerPlugin !== 'function') {
    throw new Error('quota_plugin_registry_required');
  }
  const fs = options.fs || nodeFs;
  const requireFn = typeof options.requireFn === 'function' ? options.requireFn : require;
  const dirs = [
    { dir: options.builtinDir || BUILTIN_PLUGIN_DIR, origin: 'builtin' },
    ...resolveExternalPluginDirs(options).map((dir) => ({ dir, origin: 'external' }))
  ];
  const loaded = [];
  const errors = [];
  for (const entry of dirs) {
    for (const file of listPluginFiles(entry.dir, fs)) {
      try {
        const definition = resolvePluginDefinition(requireFn(file));
        const source = registry.registerPlugin(definition, { origin: entry.origin });
        loaded.push(Object.freeze({
          id: source.id,
          origin: entry.origin,
          file,
          providers: source.providers,
          snapshotKind: source.snapshotKind
        }));
      } catch (error) {
        // 原样带上 detail 与 message，由 recordLoadError 决定展示哪一个
        // （两者相同或缺失时不重复展示）。
        const recorded = registry.recordLoadError({
          code: error && error.code || 'quota_plugin_load_failed',
          detail: error && error.detail,
          message: error && error.message,
          target: file
        });
        errors.push(recorded);
      }
    }
  }
  return { loaded, errors };
}

module.exports = {
  BUILTIN_PLUGIN_DIR,
  EXTERNAL_PLUGIN_DIR_NAME,
  resolveExternalPluginDirs,
  listPluginFiles,
  resolvePluginDefinition,
  loadQuotaPlugins
};
