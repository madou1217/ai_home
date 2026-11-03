'use strict';

const { listGuideTools, PLATFORM_IDS } = require('./catalog');
const { resolveEnvironmentToolPlans } = require('./lifecycle');
const { resolveHostHome, resolvePlatform } = require('./probe');

const PLATFORM_LABELS = Object.freeze({
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux'
});

const ACTION_LABELS = Object.freeze({
  install: '安装工具',
  update: '更新工具',
  uninstall: '卸载工具'
});

const GUIDE_HOME_PLACEHOLDERS = Object.freeze({
  macos: '/Users/<user>',
  windows: 'C:\\Users\\<user>',
  linux: '/home/<user>'
});

function guideHome(platform, currentPlatform, options = {}) {
  if (platform === currentPlatform) return resolveHostHome(options);
  return GUIDE_HOME_PLACEHOLDERS[platform];
}

function normalizeTask(tool, task, platform) {
  return {
    id: `${tool.id}:${task.id}`,
    toolId: tool.id,
    label: task.label,
    category: task.category,
    template: platform === 'windows' && task.windowsTemplate ? task.windowsTemplate : task.template,
    parameters: Array.isArray(task.parameters) ? task.parameters : [],
    source: 'task'
  };
}

function buildEnvironmentGuide(options = {}) {
  const currentPlatform = resolvePlatform(options);
  const requestedPlatform = String(options.guidePlatform || options.platform || currentPlatform).trim().toLowerCase();
  const platform = PLATFORM_IDS.includes(requestedPlatform) ? requestedPlatform : currentPlatform;
  const lifecycleOptions = {
    ...options,
    platform,
    hostHomeDir: guideHome(platform, currentPlatform, options)
  };
  const tools = listGuideTools(platform).map((tool) => {
    const lifecycleTasks = tool.probe ? ['install', 'update', 'uninstall'].flatMap((action) => {
      const resolved = resolveEnvironmentToolPlans(tool.id, action, lifecycleOptions);
      if (!resolved.ok || !resolved.plans.length) return [];
      const preferred = resolved.plans.find((plan) => plan.method !== 'AIH 清理器') || resolved.plans[0];
      return [{
        id: `${tool.id}:lifecycle:${action}`,
        toolId: tool.id,
        label: ACTION_LABELS[action],
        category: action,
        template: preferred.preview,
        parameters: [],
        method: preferred.method,
        source: 'lifecycle'
      }];
    }) : [];
    return {
      id: tool.id,
      name: tool.name,
      runtime: tool.runtime,
      category: tool.category,
      description: tool.description,
      tasks: [
        ...lifecycleTasks,
        ...(tool.tasks || []).map((task) => normalizeTask(tool, task, platform))
      ]
    };
  });
  return {
    ok: true,
    platform,
    currentPlatform,
    platforms: PLATFORM_IDS.map((id) => ({ id, label: PLATFORM_LABELS[id] })),
    tools
  };
}

module.exports = {
  ACTION_LABELS,
  PLATFORM_LABELS,
  buildEnvironmentGuide
};
