'use strict';

const { listEnvironmentTools } = require('./catalog');
const { resolveEnvironmentToolPlans } = require('./lifecycle');
const { ENVIRONMENT_RUNTIME_PLUGINS } = require('./plugins');
const {
  probeEnvironmentTool,
  probeEnvironmentToolAsync,
  resolveHostHome,
  resolvePlatform
} = require('./probe');

function lifecycleAvailability(tool, options = {}) {
  const availability = {};
  for (const action of ['install', 'update', 'uninstall']) {
    availability[action] = resolveEnvironmentToolPlans(tool.id, action, options).ok;
  }
  return availability;
}

function buildEnvironmentResource(tool, options = {}) {
  const observed = probeEnvironmentTool(tool, options);
  const availability = lifecycleAvailability(tool, options);
  return {
    id: tool.id,
    name: tool.name,
    runtime: tool.runtime,
    category: tool.category,
    description: tool.description,
    platform: options.platform,
    installed: observed.installed,
    version: observed.version || '',
    executablePath: observed.executablePath || '',
    managedVersions: observed.managedVersions || [],
    canInstall: !observed.installed && availability.install,
    canUpdate: observed.installed && availability.update,
    canUninstall: observed.installed && availability.uninstall,
    lifecycle: availability
  };
}

function legacyEnvironmentShape(runtime, summary, resources) {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  if (runtime === 'node') {
    return {
      name: summary.name,
      scope: summary.scope,
      source: summary.source,
      probeStatus: summary.probeStatus,
      currentVersion: summary.currentVersion,
      activePath: summary.activePath,
      packageManagers: {
        npm: summary.packageManagerVersion || null,
        pnpm: byId.get('pnpm')?.version || null,
        yarn: byId.get('yarn')?.version || null,
        bun: byId.get('bun')?.version || null
      },
      versionManagers: ['nvm', 'fnm', 'volta'].flatMap((id) => {
        const resource = byId.get(id);
        if (!resource || !resource.installed) return [];
        return [{
          name: resource.id,
          displayName: resource.name,
          installed: true,
          version: resource.version,
          path: resource.executablePath,
          versions: resource.managedVersions
        }];
      }),
      installedVersions: byId.get('nvm')?.managedVersions.length
        ? byId.get('nvm').managedVersions
        : [summary.currentVersion].filter(Boolean)
    };
  }
  return {
    name: summary.name,
    scope: summary.scope,
    source: summary.source,
    probeStatus: summary.probeStatus,
    currentVersion: summary.currentVersion,
    activePath: summary.activePath,
    pip: summary.packageManagerVersion || null,
    tools: {
      uv: byId.get('uv')?.version || null,
      poetry: byId.get('poetry')?.version || null
    },
    versionManagers: ['pyenv', 'conda'].flatMap((id) => {
      const resource = byId.get(id);
      if (!resource || !resource.installed) return [];
      return [{
        name: resource.id,
        displayName: resource.name,
        installed: true,
        version: resource.version,
        path: resource.executablePath,
        versions: resource.managedVersions
      }];
    }),
    installedVersions: byId.get('pyenv')?.managedVersions.length
      ? byId.get('pyenv').managedVersions
      : [summary.currentVersion].filter(Boolean)
  };
}

function getEnvironmentsSummary(options = {}) {
  const platform = resolvePlatform(options);
  const runtimeOptions = {
    ...options,
    platform,
    hostHomeDir: resolveHostHome(options)
  };
  const resources = listEnvironmentTools(platform)
    .map((tool) => buildEnvironmentResource(tool, runtimeOptions));
  const plugins = ENVIRONMENT_RUNTIME_PLUGINS
    .filter((plugin) => resources.some((resource) => resource.runtime === plugin.id));
  const runtimes = Object.fromEntries(plugins.map((plugin) => [plugin.id, plugin.detectRuntime(runtimeOptions)]));
  const node = runtimes.node;
  const python = runtimes.python;
  return {
    ok: true,
    platform,
    runtimePlugins: plugins.map((plugin) => ({ id: plugin.id, name: plugin.name, icon: plugin.icon })),
    runtimes,
    resources,
    installedCount: resources.filter((resource) => resource.installed).length,
    total: resources.length,
    environments: node && python && {
      node: legacyEnvironmentShape('node', node, resources.filter((resource) => resource.runtime === 'node')),
      python: legacyEnvironmentShape('python', python, resources.filter((resource) => resource.runtime === 'python'))
    }
  };
}

async function buildEnvironmentResourceAsync(tool, options = {}) {
  const observed = await probeEnvironmentToolAsync(tool, options);
  const availability = lifecycleAvailability(tool, options);
  return {
    id: tool.id,
    name: tool.name,
    runtime: tool.runtime,
    category: tool.category,
    description: tool.description,
    platform: options.platform,
    installed: observed.installed,
    version: observed.version || '',
    executablePath: observed.executablePath || '',
    managedVersions: observed.managedVersions || [],
    canInstall: !observed.installed && availability.install,
    canUpdate: observed.installed && availability.update,
    canUninstall: observed.installed && availability.uninstall,
    lifecycle: availability
  };
}

// 环境汇总的缓存：探测的是「本机装了什么」，而一次完整探测要跑 40+ 个子进程
// （pnpm --version 单次就 ~0.5s，冷启动合计 ~700ms）。
// 策略是「有旧值就立刻回旧值 + 后台刷新」，第二次及以后的请求恒定 ~0ms；
// 首次（无任何快照）才等一次真实探测。显式动作后由 clearEnvironmentsSummaryCache() 失效。
const ENVIRONMENTS_SUMMARY_TTL_MS = 15 * 1000;
let environmentsSummaryCache = null;
let environmentsSummaryInFlight = null;

function clearEnvironmentsSummaryCache() {
  environmentsSummaryCache = null;
  environmentsSummaryInFlight = null;
}

/**
 * 异步版环境汇总：14 个工具 + 各运行时探测全部并发，不再串行占住主线程。
 * 同步版在 macOS 上要依次等 40+ 个 spawnSync，实测 ~3s。
 */
const ENVIRONMENTS_SNAPSHOT_KEY = 'cache:environments-summary';

// 持久化快照：进程重启后第一次请求也能立刻回上一份，不必等 40+ 个子进程。
// 只有 aiHomeDir 可用时才读写；失败一律当没有（这是纯加速，不是数据）。
function readPersistedSummary(options = {}) {
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!aiHomeDir) return null;
  try {
    const { readJsonValue } = require('../../../../server/app-state-store');
    const raw = readJsonValue(options.fs || require('node:fs'), aiHomeDir, ENVIRONMENTS_SNAPSHOT_KEY, options);
    const value = raw && typeof raw === 'object' && raw.ok ? raw : null;
    return value ? { at: Number(value.probedAt || 0), value } : null;
  } catch (_error) {
    return null;
  }
}

function writePersistedSummary(options = {}, value) {
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!aiHomeDir) return;
  try {
    const { writeJsonValue } = require('../../../../server/app-state-store');
    writeJsonValue(options.fs || require('node:fs'), aiHomeDir, ENVIRONMENTS_SNAPSHOT_KEY, value, {
      ...options,
      bestEffort: true
    });
  } catch (_error) {
    // 加速用的快照写不进去不影响结果。
  }
}

function refreshEnvironmentsSummaryAsync(options = {}) {
  if (environmentsSummaryInFlight) return environmentsSummaryInFlight;
  const now = Number(options.now ? options.now() : Date.now());
  const request = buildEnvironmentsSummaryAsync(options)
    .then((value) => {
      environmentsSummaryCache = { at: now, value };
      writePersistedSummary(options, value);
      return value;
    })
    .finally(() => {
      if (environmentsSummaryInFlight === request) environmentsSummaryInFlight = null;
    });
  environmentsSummaryInFlight = request;
  return request;
}

/**
 * stale-while-revalidate：有快照就先回快照（附 stale 标记），同时在后台刷新。
 * 首次没有任何快照时才等真实探测。
 */
async function getEnvironmentsSummaryAsync(options = {}) {
  const now = Number(options.now ? options.now() : Date.now());
  if (!environmentsSummaryCache) environmentsSummaryCache = readPersistedSummary(options);
  const cached = environmentsSummaryCache;
  if (cached) {
    if (now - cached.at >= ENVIRONMENTS_SUMMARY_TTL_MS && !environmentsSummaryInFlight) {
      // 后台刷新：不 await，但必须吞掉 rejection，否则会变成未处理拒绝。
      refreshEnvironmentsSummaryAsync(options).catch(() => {});
    }
    return { ...cached.value, stale: now - cached.at >= ENVIRONMENTS_SUMMARY_TTL_MS, probedAt: cached.at };
  }
  return refreshEnvironmentsSummaryAsync(options);
}

async function buildEnvironmentsSummaryAsync(options = {}) {
  const platform = resolvePlatform(options);
  const runtimeOptions = {
    ...options,
    platform,
    hostHomeDir: resolveHostHome(options)
  };
  const tools = listEnvironmentTools(platform);
  const plugins = ENVIRONMENT_RUNTIME_PLUGINS
    .filter((plugin) => tools.some((tool) => tool.runtime === plugin.id));
  const [resources, runtimeValues] = await Promise.all([
    Promise.all(tools.map((tool) => buildEnvironmentResourceAsync(tool, runtimeOptions))),
    Promise.all(plugins.map((plugin) => (typeof plugin.detectRuntimeAsync === 'function'
      ? plugin.detectRuntimeAsync(runtimeOptions)
      : Promise.resolve(plugin.detectRuntime(runtimeOptions)))))
  ]);
  const usedPlugins = plugins.filter((plugin) => resources.some((resource) => resource.runtime === plugin.id));
  const runtimes = Object.fromEntries(
    usedPlugins.map((plugin) => [plugin.id, runtimeValues[plugins.indexOf(plugin)]])
  );
  const node = runtimes.node;
  const python = runtimes.python;
  return {
    ok: true,
    platform,
    runtimePlugins: usedPlugins.map((plugin) => ({ id: plugin.id, name: plugin.name, icon: plugin.icon })),
    runtimes,
    resources,
    installedCount: resources.filter((resource) => resource.installed).length,
    total: resources.length,
    environments: node && python && {
      node: legacyEnvironmentShape('node', node, resources.filter((resource) => resource.runtime === 'node')),
      python: legacyEnvironmentShape('python', python, resources.filter((resource) => resource.runtime === 'python'))
    }
  };
}

module.exports = {
  buildEnvironmentsSummaryAsync,
  buildEnvironmentResource,
  buildEnvironmentResourceAsync,
  clearEnvironmentsSummaryCache,
  refreshEnvironmentsSummaryAsync,
  getEnvironmentsSummary,
  getEnvironmentsSummaryAsync,
  getEnvironmentsSummary,
  legacyEnvironmentShape,
  lifecycleAvailability
};
