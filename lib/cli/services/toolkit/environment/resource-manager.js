'use strict';

const { listEnvironmentTools } = require('./catalog');
const { resolveEnvironmentToolPlans } = require('./lifecycle');
const {
  detectNodeEnvironment,
  detectPythonEnvironment,
  probeEnvironmentTool,
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
  const node = detectNodeEnvironment(runtimeOptions);
  const python = detectPythonEnvironment(runtimeOptions);
  return {
    ok: true,
    platform,
    runtimes: { node, python },
    resources,
    installedCount: resources.filter((resource) => resource.installed).length,
    total: resources.length,
    environments: {
      node: legacyEnvironmentShape('node', node, resources.filter((resource) => resource.runtime === 'node')),
      python: legacyEnvironmentShape('python', python, resources.filter((resource) => resource.runtime === 'python'))
    }
  };
}

module.exports = {
  buildEnvironmentResource,
  getEnvironmentsSummary,
  legacyEnvironmentShape,
  lifecycleAvailability
};
