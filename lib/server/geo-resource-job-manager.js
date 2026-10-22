'use strict';

// GeoIP 数据资源的**作业管理**（下载 / 更新 / 删除），复用工具箱的通用资源作业工厂
// （见 lib/server/toolkit-resource-job-manager.js），所以进度、SSE、取消、任务队列 UI 全部与
// 「托管工具」一致 —— 用户要求的「可视化下载/更新」不需要另做一套。
//
// 资源 = 一个 geo 数据文件（见 lib/runtime/geo/download.js 的 describeManagedGeoFiles）。
// 动作：
//   install/update —— 下载到 <aiHome>/geo/（原子替换，见 download.js）
//   uninstall      —— 删除托管文件（本机客户端自带的库不受影响，paths.js 只读它们）

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const {
  createToolkitResourceJobManager,
  desiredStateReached,
  serializeToolkitResourceJob
} = require('./toolkit-resource-job-manager');
const {
  DBIP_URL_TEMPLATE,
  describeManagedGeoFiles,
  downloadDbipCity
} = require('../runtime/geo/download');

// 可管理的资源（每个 = 一个可下载的数据文件）。新增数据源 = 加一条声明。
const GEO_RESOURCES = Object.freeze([
  {
    id: 'dbip-city',
    name: 'DB-IP City Lite',
    role: '城市级归属地（国家 / 省州 / 城市），免注册、每月更新',
    kind: 'city',
    sizeHint: '约 60 MB 压缩 / 120 MB 解压',
    url: DBIP_URL_TEMPLATE.replace('{month}', '<YYYY-MM>'),
    autoDownload: true,
    capabilities: { country: true, region: true, city: true, asn: false }
  }
]);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 列表：托管资源的现状（在不在、多大、什么时候下的）。 */
function listGeoResources(options = {}) {
  const files = describeManagedGeoFiles({ fs: options.fs || nodeFs, aiHomeDir: options.aiHomeDir });
  const byKind = new Map(files.map((file) => [file.kind, file]));
  return GEO_RESOURCES.map((resource) => {
    const file = byKind.get(resource.kind) || { present: false, bytes: 0, updatedAt: 0, path: '' };
    return {
      id: resource.id,
      name: resource.name,
      role: resource.role,
      kind: resource.kind,
      sizeHint: resource.sizeHint,
      url: resource.url,
      autoDownload: resource.autoDownload === true,
      capabilities: { ...resource.capabilities },
      installed: file.present === true,
      bytes: Number(file.bytes) || 0,
      updatedAt: Number(file.updatedAt) || 0,
      path: String(file.path || '')
    };
  });
}

function findGeoResource(resourceId) {
  const id = normalizeString(resourceId).toLowerCase();
  return GEO_RESOURCES.find((resource) => resource.id === id) || null;
}

/**
 * 计划一个资源动作。**签名与托管工具的 planAction 一致**（input 对象 + options），
 * 返回 { ok, tool, action, label, plans }，这样通用 job manager 能直接消费。
 * 下载是单一计划（没有「多包管理器候选」那种分支）。
 */
function planGeoResourceAction(input = {}, _options = {}) {
  const resourceId = normalizeString(input.resourceId || input.toolId);
  const action = normalizeString(input.action) || 'install';
  const resource = findGeoResource(resourceId);
  if (!resource) return { ok: false, error: 'geo_resource_not_found' };
  if (!['install', 'update', 'uninstall'].includes(action)) return { ok: false, error: 'geo_action_unsupported' };
  const label = action === 'uninstall'
    ? `删除 ${resource.name}`
    : `${action === 'update' ? '更新' : '下载'} ${resource.name}（${resource.sizeHint}）`;
  return {
    ok: true,
    tool: { id: resource.id, name: resource.name },
    action,
    label,
    plans: [{
      id: `${resource.id}:${action}`,
      label,
      // 计划只描述「做什么」；真正执行在 runPlan（下载要走网络、要报进度）。
      resourceId: resource.id,
      action
    }]
  };
}

/**
 * 执行一个计划。下载走 download.js（带进度回调 → job.progress）。
 * 返回 { ok, error?, ... }，与 lifecycle-plan-executor 的返回形状一致。
 */
async function runGeoResourcePlan(plan, runtimeOptions = {}) {
  const resource = findGeoResource(plan && plan.resourceId);
  if (!resource) return { ok: false, error: 'geo_resource_unknown' };
  const action = normalizeString(plan.action) || 'install';
  const fs = runtimeOptions.fs || nodeFs;
  const aiHomeDir = normalizeString(runtimeOptions.aiHomeDir);
  if (!aiHomeDir) return { ok: false, error: 'ai_home_dir_required' };
  const onProgress = typeof runtimeOptions.onProgress === 'function' ? runtimeOptions.onProgress : () => {};

  if (action === 'uninstall') {
    try {
      const target = nodePath.join(aiHomeDir, 'geo', 'dbip-city-lite.mmdb');
      fs.rmSync(target, { force: true });
      return { ok: true, installed: false };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || 'geo_remove_failed') };
    }
  }

  // DB-IP City Lite 是当前唯一可下载的资源（其它来源是「用户自备 / 本机客户端自带」）。
  if (resource.id !== 'dbip-city') return { ok: false, error: 'geo_resource_not_downloadable' };
  onProgress({ percent: 5, label: '正在连接下载源', phase: 'downloading' });
  const result = await downloadDbipCity({
    fs,
    aiHomeDir,
    fetchImpl: runtimeOptions.fetch,
    now: runtimeOptions.now,
    onProgress: (progress) => {
      // 下载进度映射到 5%..95%（留出校验与落盘的空间）。
      const percent = progress.phase === 'done' ? 95 : 5 + Math.round((Number(progress.percent) || 0) * 0.9);
      onProgress({
        percent,
        label: progress.totalBytes
          ? `下载中 ${(progress.receivedBytes / 1048576).toFixed(0)}/${(progress.totalBytes / 1048576).toFixed(0)} MB`
          : '下载中',
        phase: 'downloading'
      });
    }
  });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, installed: true, version: result.month, bytes: result.bytes };
}

/** 资源现状探针（job manager 用它判断「目标状态是否已达成」）。 */
function probeGeoResource(resourceId, options = {}) {
  const resource = listGeoResources(options).find((item) => item.id === normalizeString(resourceId).toLowerCase());
  return resource || null;
}

function createGeoResourceJobManager(options = {}) {
  return createToolkitResourceJobManager({
    ...options,
    source: 'geo-resource',
    kind: 'geo-resource',
    idPrefix: 'geo-resource',
    eventType: 'geo-resource-job',
    waitingLabel: '等待 GeoIP 数据操作开始',
    failureLabel: 'GeoIP 数据操作失败。',
    cancelledLabel: 'GeoIP 数据任务已取消。',
    planAction: (input, options) => planGeoResourceAction(input, options),
    runPlan: (plan, runtimeOptions) => runGeoResourcePlan(plan, runtimeOptions),
    probeResource: (resourceId, runtimeOptions) => probeGeoResource(resourceId, runtimeOptions),
    resolveResourceId: (planned, input) => (planned && planned.tool && planned.tool.id) || normalizeString(input && input.resourceId)
  });
}

module.exports = {
  GEO_RESOURCES,
  createGeoResourceJobManager,
  desiredStateReached,
  findGeoResource,
  listGeoResources,
  planGeoResourceAction,
  probeGeoResource,
  runGeoResourcePlan,
  serializeToolkitResourceJob
};
