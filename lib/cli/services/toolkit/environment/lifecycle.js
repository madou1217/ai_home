'use strict';

const { renderPlanCommand } = require('./plan-builders');
const { resolveHostHome, resolvePlatform } = require('./probe');
const { getEnvironmentToolAdapter } = require('./tools');

const LIFECYCLE_ACTIONS = new Set(['install', 'update', 'uninstall']);

function normalizeAction(value) {
  const action = String(value || '').trim().toLowerCase();
  return LIFECYCLE_ACTIONS.has(action) ? action : '';
}

function normalizePlan(plan, tool, platform) {
  if (!plan || typeof plan !== 'object' || !String(plan.command || '').trim()) return null;
  return {
    id: String(plan.id || `${tool.id}_${plan.action}`).trim(),
    toolId: tool.id,
    action: String(plan.action || '').trim().toLowerCase(),
    label: String(plan.label || '').trim(),
    method: String(plan.method || '').trim(),
    command: String(plan.command || '').trim(),
    args: Array.isArray(plan.args) ? plan.args.map((arg) => String(arg)) : [],
    env: plan.env && typeof plan.env === 'object' ? { ...plan.env } : {},
    cwd: String(plan.cwd || '').trim() || null,
    effect: String(plan.effect || '').trim(),
    timeoutMs: Math.min(Math.max(Number(plan.timeoutMs) || 30 * 60 * 1000, 1000), 60 * 60 * 1000),
    requiresConfirmation: plan.requiresConfirmation !== false,
    preview: renderPlanCommand(plan, platform)
  };
}

function uniquePlans(plans) {
  const seen = new Set();
  return plans.filter((plan) => {
    if (!plan) return false;
    const key = `${plan.command}\0${JSON.stringify(plan.args)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveEnvironmentToolPlans(toolId, action, options = {}) {
  const platform = resolvePlatform(options);
  const tool = getEnvironmentToolAdapter(toolId);
  const normalizedAction = normalizeAction(action);
  if (!tool) return { ok: false, error: 'environment_tool_not_found', message: '运行环境工具不存在。' };
  if (!normalizedAction) return { ok: false, error: 'unsupported_environment_tool_action', message: '仅支持安装、更新和卸载。' };
  if (!tool.supports(platform)) {
    return { ok: false, error: 'unsupported_platform', message: `${tool.name} 不支持当前系统。` };
  }
  const lifecycleOptions = {
    ...options,
    platform,
    hostHomeDir: resolveHostHome(options),
    name: tool.name
  };
  const rawPlans = tool[normalizedAction](lifecycleOptions);
  const plans = uniquePlans((rawPlans || [])
    .map((plan) => normalizePlan(plan, tool, platform))
    .filter(Boolean));
  if (!plans.length) {
    return {
      ok: false,
      error: 'environment_lifecycle_contract_violation',
      message: '运行环境生命周期配置异常，请刷新资源清单后重试。'
    };
  }
  return {
    ok: true,
    platform,
    tool: {
      id: tool.id,
      name: tool.name,
      runtime: tool.runtime,
      category: tool.category
    },
    action: normalizedAction,
    label: plans[0].label,
    plans
  };
}

function planEnvironmentToolAction(input = {}, options = {}) {
  const result = resolveEnvironmentToolPlans(input.toolId, input.action, options);
  if (!result.ok) return result;
  const tool = getEnvironmentToolAdapter(input.toolId);
  const probe = tool.detect(options);
  if (result.action === 'install' && probe.installed) {
    return { ok: false, error: 'environment_tool_already_installed', message: `${tool.name} 已安装。` };
  }
  if (result.action !== 'install' && !probe.installed) {
    return { ok: false, error: 'environment_tool_not_installed', message: `${tool.name} 尚未安装。` };
  }
  return { ...result, current: probe };
}

module.exports = {
  LIFECYCLE_ACTIONS,
  normalizeAction,
  planEnvironmentToolAction,
  resolveEnvironmentToolPlans
};
