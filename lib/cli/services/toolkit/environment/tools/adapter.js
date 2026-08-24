'use strict';

const { defineInstallLifecycle } = require('../../../../../runtime/install-lifecycle');

const PLATFORM_IDS = Object.freeze(['macos', 'windows', 'linux']);

const PARAMETER_DEFINITIONS = Object.freeze({
  version: Object.freeze({ key: 'version', label: '版本号', placeholder: '例如 22 或 3.12.7' }),
  package: Object.freeze({ key: 'package', label: '包名', placeholder: '例如 typescript' }),
  script: Object.freeze({ key: 'script', label: '脚本路径', placeholder: '例如 scripts/check.py' }),
  environment: Object.freeze({ key: 'environment', label: '环境名称', placeholder: '例如 analytics' }),
  environmentPath: Object.freeze({ key: 'environmentPath', label: '环境目录', placeholder: '例如 .venv' })
});

function parameters(...keys) {
  return keys.map((key) => PARAMETER_DEFINITIONS[key]).filter(Boolean);
}

function freezeTasks(tasks = []) {
  return Object.freeze(tasks.map((task) => Object.freeze({
    ...task,
    parameters: Object.freeze([...(task.parameters || [])])
  })));
}

/**
 * 运行环境资源的稳定适配器边界。
 *
 * 每个资源模块自行持有元数据、探测和平台生命周期；目录与执行层只依赖该接口，
 * 不再按资源 ID 或平台拼装行为。
 */
function defineEnvironmentToolAdapter(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new TypeError('environment tool adapter must be an object');
  }
  const id = String(definition.id || '').trim().toLowerCase();
  const platforms = Object.freeze([...(definition.platforms || [])]);
  if (!id || !platforms.length || typeof definition.detect !== 'function'
    || typeof definition.buildPlans !== 'function') {
    throw new TypeError(`invalid environment tool adapter: ${id || '(empty)'}`);
  }
  const supports = typeof definition.supports === 'function'
    ? definition.supports
    : (platform) => platforms.includes(String(platform || '').trim().toLowerCase());
  const lifecycle = defineInstallLifecycle({
    install: (options = {}) => definition.buildPlans('install', options),
    update: (options = {}) => definition.buildPlans('update', options),
    uninstall: (options = {}) => definition.buildPlans('uninstall', options)
  }, `environment tool adapter ${id}`);

  return Object.freeze({
    id,
    name: String(definition.name || id),
    runtime: String(definition.runtime || ''),
    category: String(definition.category || ''),
    description: String(definition.description || ''),
    platforms,
    probe: Object.freeze({ ...(definition.probe || {}) }),
    tasks: freezeTasks(definition.tasks),
    supports,
    detect: definition.detect,
    buildPlans: definition.buildPlans,
    ...lifecycle
  });
}

module.exports = {
  PARAMETER_DEFINITIONS,
  PLATFORM_IDS,
  defineEnvironmentToolAdapter,
  parameters
};
