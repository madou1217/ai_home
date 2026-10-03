'use strict';

// 候选代次的静态依赖诊断：在加载任何插件代码之前，根据清单的 requires / provides 找出
// 身份冲突、缺失服务、版本范围不满足和循环依赖，并给出确定的加载顺序。
//
// 为什么不交给 Cordis：Cordis 对缺失或循环的依赖只是让 fiber 永远停在 PENDING，没有任何诊断
// （M0 实测）。计划要求这些问题在候选准备时失败并列出原因，不能靠加载先后顺序碰运气。

const semver = require('semver');

const HOST_SERVICES = new Set(['aih']);

function diagnose(code, detail, extra = {}) {
  return { code, detail, ...extra };
}

// 返回 cycle 上的插件序列（首尾相同），没有环返回 null。
function findCycle(edges, nodes) {
  const WHITE = 0; const GRAY = 1; const BLACK = 2;
  const color = new Map(nodes.map((node) => [node, WHITE]));
  const stack = [];
  const visit = (node) => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of edges.get(node) || []) {
      if (color.get(next) === GRAY) return [...stack.slice(stack.indexOf(next)), next];
      if (color.get(next) === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  };
  for (const node of nodes) {
    if (color.get(node) === WHITE) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}

/**
 * @param {Array<{ instanceId: string, manifest: object }>} plugins 已通过 schema 校验的清单
 * @returns {{ ok: boolean, diagnostics: object[], order: string[] }} order 为 instanceId 的加载顺序
 */
function planGeneration(plugins) {
  const diagnostics = [];
  const byInstance = new Map();
  const pluginIds = new Map();
  const contributionOwners = new Map();
  const serviceOwners = new Map();

  for (const { instanceId, manifest } of plugins) {
    if (byInstance.has(instanceId)) {
      diagnostics.push(diagnose('plugin_instance_duplicate', `实例 ${instanceId} 重复`, { instanceId }));
      continue;
    }
    byInstance.set(instanceId, manifest);
    if (pluginIds.has(manifest.pluginId)) {
      diagnostics.push(diagnose('plugin_id_duplicate', `插件 ${manifest.pluginId} 在同一代次中出现多次`, { instanceId, pluginId: manifest.pluginId }));
    } else {
      pluginIds.set(manifest.pluginId, instanceId);
    }
    for (const contribution of manifest.contributes || []) {
      const owner = contributionOwners.get(contribution.id);
      if (owner) {
        diagnostics.push(diagnose('plugin_contribution_duplicate', `贡献项 ${contribution.id} 同时由 ${owner} 与 ${instanceId} 声明`, { instanceId, contributionId: contribution.id }));
      } else {
        contributionOwners.set(contribution.id, instanceId);
      }
    }
    for (const service of manifest.provides || []) {
      if (HOST_SERVICES.has(service.name)) {
        diagnostics.push(diagnose('plugin_service_reserved', `服务名 ${service.name} 由宿主保留`, { instanceId, service: service.name }));
        continue;
      }
      const owner = serviceOwners.get(service.name);
      if (owner) {
        diagnostics.push(diagnose('plugin_service_conflict', `服务 ${service.name} 同时由 ${owner.instanceId} 与 ${instanceId} 提供`, { instanceId, service: service.name }));
      } else {
        serviceOwners.set(service.name, { instanceId, version: service.version });
      }
    }
  }

  const edges = new Map();
  for (const [instanceId, manifest] of byInstance) {
    const dependsOn = new Set();
    for (const requirement of manifest.requires || []) {
      if (HOST_SERVICES.has(requirement.name)) continue;
      const provider = serviceOwners.get(requirement.name);
      if (!provider) {
        diagnostics.push(diagnose('plugin_service_missing', `${instanceId} 需要的服务 ${requirement.name} 没有任何启用的插件提供`, { instanceId, service: requirement.name }));
        continue;
      }
      if (!semver.satisfies(provider.version, requirement.versionRange)) {
        diagnostics.push(diagnose('plugin_service_version_mismatch',
          `${instanceId} 需要 ${requirement.name}@${requirement.versionRange}，${provider.instanceId} 提供的是 ${provider.version}`,
          { instanceId, service: requirement.name }));
        continue;
      }
      if (provider.instanceId !== instanceId) dependsOn.add(provider.instanceId);
    }
    edges.set(instanceId, [...dependsOn].sort());
  }

  const nodes = [...byInstance.keys()].sort();
  const cycle = findCycle(edges, nodes);
  if (cycle) {
    diagnostics.push(diagnose('plugin_dependency_cycle', `服务依赖成环：${cycle.join(' → ')}`, { cycle }));
  }

  // 依赖在前；同层按 instanceId 排序，保证顺序稳定、不受注册先后影响。
  const order = [];
  if (!cycle) {
    const done = new Set();
    const place = (node) => {
      if (done.has(node)) return;
      for (const dependency of edges.get(node) || []) place(dependency);
      done.add(node);
      order.push(node);
    };
    nodes.forEach(place);
  }
  return { ok: diagnostics.length === 0, diagnostics, order };
}

module.exports = { planGeneration, HOST_SERVICES };
