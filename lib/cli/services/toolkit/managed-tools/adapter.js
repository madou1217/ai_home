'use strict';

const { defineInstallLifecycle } = require('../../../../runtime/install-lifecycle');

const TOOL_CATEGORIES = new Set(['session-runtimes', 'network-access']);

/**
 * 会话运行时和网络工具的稳定接口。
 *
 * 每个资源模块自行声明支持平台、探测、三段生命周期和配置目标；聚合层只调用
 * 这个接口，不包含资源 ID 或平台分支。
 */
function defineManagedToolAdapter(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new TypeError('managed tool adapter must be an object');
  }
  const id = String(definition.id || '').trim().toLowerCase();
  const category = String(definition.category || '').trim();
  if (!id || !TOOL_CATEGORIES.has(category)) {
    throw new TypeError(`invalid managed tool adapter metadata: ${id || '(empty)'}`);
  }
  if (typeof definition.supports !== 'function' || typeof definition.detect !== 'function') {
    throw new TypeError(`managed tool adapter ${id} must implement supports() and detect()`);
  }
  const lifecycle = defineInstallLifecycle({
    install: definition.install,
    update: definition.update,
    uninstall: definition.uninstall
  }, `managed tool adapter ${id}`);

  return Object.freeze({
    id,
    category,
    name: String(definition.name || id),
    role: String(definition.role || ''),
    binaryName: String(definition.binaryName || id),
    versionArgs: Object.freeze((definition.versionArgs || [['--version']])
      .map((args) => Object.freeze((args || []).map((arg) => String(arg))))),
    capabilities: Object.freeze([...(definition.capabilities || ['detect', 'version'])]),
    runtimeInspectable: Boolean(definition.runtimeInspectable),
    supports: definition.supports,
    detect: definition.detect,
    resolveConfig: typeof definition.resolveConfig === 'function' ? definition.resolveConfig : null,
    ...lifecycle
  });
}

module.exports = {
  defineManagedToolAdapter
};
