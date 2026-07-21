'use strict';

const CONTROL_PLANE_DEVICE_STATUS_SERVICE = 'aih-control-plane';

function normalizeText(value, maxLength = 128) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeCount(value) {
  return Math.max(0, Math.floor(normalizeNumber(value, 0)));
}

function normalizeRate(value) {
  return Math.max(0, Math.min(1, normalizeNumber(value, 0)));
}

function normalizeStatusMap(value) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.keys(source).sort().reduce((acc, key) => {
    const name = normalizeText(key, 64);
    if (name) acc[name] = normalizeCount(source[key]);
    return acc;
  }, {});
}

function normalizeProviderStatus(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    total: normalizeCount(source.total),
    active: normalizeCount(source.active),
    statuses: normalizeStatusMap(source.statuses)
  };
}

function normalizeProviderMap(value) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.keys(source).sort().reduce((acc, provider) => {
    const name = normalizeText(provider, 64).toLowerCase();
    if (name) acc[name] = normalizeProviderStatus(source[provider]);
    return acc;
  }, {});
}

function normalizeQueueEntry(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    name: normalizeText(source.name, 64),
    running: normalizeCount(source.running),
    queued: normalizeCount(source.queued),
    maxConcurrency: normalizeCount(source.maxConcurrency),
    queueLimit: normalizeCount(source.queueLimit),
    totalScheduled: normalizeCount(source.totalScheduled),
    totalRejected: normalizeCount(source.totalRejected)
  };
}

function normalizeQueueMap(value) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.keys(source).sort().reduce((acc, provider) => {
    const name = normalizeText(provider, 64).toLowerCase();
    if (name) acc[name] = normalizeQueueEntry(source[provider]);
    return acc;
  }, {});
}

function buildQueueTotals(queue) {
  return Object.values(queue).reduce((acc, item) => ({
    running: acc.running + normalizeCount(item.running),
    queued: acc.queued + normalizeCount(item.queued),
    totalScheduled: acc.totalScheduled + normalizeCount(item.totalScheduled),
    totalRejected: acc.totalRejected + normalizeCount(item.totalRejected)
  }), {
    running: 0,
    queued: 0,
    totalScheduled: 0,
    totalRejected: 0
  });
}

function buildControlPlaneDeviceStatus(managementStatus, options = {}) {
  const source = managementStatus && typeof managementStatus === 'object' ? managementStatus : {};
  const queue = normalizeQueueMap(source.queue);
  return {
    ok: Boolean(source.ok),
    service: CONTROL_PLANE_DEVICE_STATUS_SERVICE,
    serverTime: new Date(normalizeNumber(options.nowMs, Date.now())).toISOString(),
    uptimeSec: normalizeCount(source.uptimeSec),
    backend: normalizeText(source.backend, 96),
    providerMode: normalizeText(source.providerMode, 64),
    strategy: normalizeText(source.strategy, 64),
    totalAccounts: normalizeCount(source.totalAccounts),
    activeAccounts: normalizeCount(source.activeAccounts),
    cooldownAccounts: normalizeCount(source.cooldownAccounts),
    statusTotals: normalizeStatusMap(source.statusTotals),
    providers: normalizeProviderMap(source.providers),
    queue,
    queueTotals: buildQueueTotals(queue),
    modelsCached: normalizeCount(source.modelsCached),
    modelsUpdatedAt: normalizeCount(source.modelsUpdatedAt),
    modelRegistryUpdatedAt: normalizeCount(source.modelRegistryUpdatedAt),
    successRate: normalizeRate(source.successRate),
    timeoutRate: normalizeRate(source.timeoutRate),
    totalRequests: normalizeCount(source.totalRequests)
  };
}

module.exports = {
  CONTROL_PLANE_DEVICE_STATUS_SERVICE,
  buildControlPlaneDeviceStatus
};
