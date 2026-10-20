'use strict';

// 把 P4 的账号来源数据翻译成 auth-sources 解析器认识的描述符。
//
// 解析器只认识函数（available / identity / import），插件只传 JSON，
// 这层适配是唯一转换点：界面与导入链路不需要知道来源来自内置描述符还是插件。

const { describeAuthMethodsWithSources, resolveAuthSources } = require('../../account/auth-sources');

function identityValue(source) {
  if (source.identity === null || source.identity === undefined) return '';
  if (typeof source.identity === 'string') return source.identity.trim();
  try { return JSON.stringify(source.identity); } catch (_error) { return ''; }
}

function toAuthSourceDescriptor(source, service) {
  const identity = identityValue(source);
  return {
    id: source.id,
    kind: source.kind,
    clientDependent: source.clientDependent,
    requires: source.requiresApp ? { app: source.requiresApp } : undefined,
    authMode: source.authMode,
    directImport: source.directImport,
    // 插件来源的登录任务走 /plugin-login；界面据此渲染入口，而不是假设所有来源都是本机导入。
    pluginLogin: source.loginAvailable === true,
    description: source.description,
    // 可用性由插件自报（插件才知道宿主登录态/设备环境）；宿主不猜 provider。
    available: () => source.available !== false,
    identity: identity ? () => identity : undefined,
    import: source.directImport
      ? () => ({
          import: async (deps = {}) => service.importSource({
            provider: deps.provider || source.provider,
            sourceId: source.id,
            runtimeDir: deps.runtimeDir,
            hostHomeDir: deps.hostHomeDir,
            request: deps.request
          })
        })
      : undefined
  };
}

async function collectPluginAuthSources(provider, service, options = {}) {
  if (!service || typeof service.listSources !== 'function') return { sources: [], warnings: [], generation: 0 };
  const listed = await service.listSources(provider, options);
  return {
    sources: (listed.sources || []).map((source) => toAuthSourceDescriptor(source, service)),
    warnings: listed.warnings || [],
    generation: listed.generation || 0
  };
}

async function resolveAuthSourcesWithPlugins(provider, service, options = {}) {
  const plugin = await collectPluginAuthSources(provider, service, options);
  return {
    ...resolveAuthSources(provider, { ...options, extraSources: plugin.sources }),
    pluginWarnings: plugin.warnings,
    pluginGeneration: plugin.generation
  };
}

async function describeAuthMethodsWithPluginSources(provider, service, options = {}) {
  const plugin = await collectPluginAuthSources(provider, service, options);
  const resolved = describeAuthMethodsWithSources(provider, { ...options, extraSources: plugin.sources });
  return { ...resolved, pluginWarnings: plugin.warnings, pluginGeneration: plugin.generation };
}

module.exports = {
  collectPluginAuthSources,
  describeAuthMethodsWithPluginSources,
  resolveAuthSourcesWithPlugins,
  toAuthSourceDescriptor
};
