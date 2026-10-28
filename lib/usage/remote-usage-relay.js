'use strict';

const { listControlPlaneProfiles } = require('../server/control-plane-profile-store');

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_TIMEOUT_MS = 5000;

function normalizeEndpoint(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.toString().replace(/\/+$/, '');
  } catch (_error) {
    return '';
  }
}

function createRemoteUsageRelay(options = {}) {
  const fs = options.fs || require('node:fs');
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const readProfiles = typeof options.readProfiles === 'function'
    ? options.readProfiles
    : () => listControlPlaneProfiles({ fs, aiHomeDir });
  const sourceId = String(options.sourceId || '').trim();
  const batchSize = Math.max(1, Math.min(500, Number(options.batchSize) || DEFAULT_BATCH_SIZE));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  let cursor = 0;
  let inFlight = null;
  let lastResult = null;

  function resolveTarget() {
    if ((!fs || !aiHomeDir) && typeof options.readProfiles !== 'function') return null;
    const store = readProfiles();
    const profiles = Array.isArray(store) ? store : store && Array.isArray(store.profiles) ? store.profiles : [];
    const activeId = String(store && store.activeProfileId || '').trim();
    const profile = profiles.find((item) => item && item.id === activeId)
      || (profiles.length === 1 ? profiles[0] : null);
    const endpoint = normalizeEndpoint(profile && profile.endpoint);
    const managementKey = String(profile && profile.managementKey || '').trim();
    if (!endpoint || !managementKey) return null;
    return { endpoint, managementKey, profileId: String(profile.id || '') };
  }

  async function postBatch(target, records) {
    if (typeof fetchImpl !== 'function') return null;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetchImpl(`${target.endpoint}/v0/management/usage/import`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${target.managementKey}`,
          'content-type': 'application/json',
          ...(sourceId ? { 'x-aih-usage-source': sourceId } : {})
        },
        body: JSON.stringify({ records }),
        ...(controller ? { signal: controller.signal } : {})
      });
      if (!response || !response.ok) return { ok: false, status: Number(response && response.status) || 0 };
      const payload = await response.json().catch(() => ({}));
      return { ok: true, inserted: Number(payload && payload.inserted) || 0 };
    } catch (_error) {
      return { ok: false, status: 0 };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function sync(modelUsageService) {
    if (!modelUsageService || typeof modelUsageService.listUsageRecords !== 'function') {
      return { ok: false, skipped: true, reason: 'service_unavailable' };
    }
    const target = resolveTarget();
    if (!target) return { ok: false, skipped: true, reason: 'target_unconfigured' };
    let sent = 0;
    let inserted = 0;
    for (let page = 0; page < 5; page += 1) {
      const records = modelUsageService.listUsageRecords({ afterId: cursor, limit: batchSize });
      if (!Array.isArray(records) || records.length === 0) break;
      const result = await postBatch(target, records);
      if (!result || result.ok !== true) {
        lastResult = { ok: false, sent, inserted, target: target.profileId };
        return lastResult;
      }
      sent += records.length;
      inserted += Number(result.inserted) || 0;
      cursor = Math.max(cursor, ...records.map((record) => Number(record && record.id) || 0));
      if (records.length < batchSize) break;
    }
    lastResult = { ok: true, sent, inserted, cursor, target: target.profileId };
    return lastResult;
  }

  function syncOnce(modelUsageService) {
    if (!inFlight) inFlight = sync(modelUsageService).catch(() => ({ ok: false })).finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    sync,
    syncOnce,
    getState: () => ({ cursor, lastResult, inFlight: Boolean(inFlight) })
  };
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  DEFAULT_TIMEOUT_MS,
  createRemoteUsageRelay
};
