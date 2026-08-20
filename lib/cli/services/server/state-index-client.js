'use strict';

const { buildManagementBaseUrl } = require('../../../server/server-defaults');
const { sanitizeBaseState } = require('../../../account/state-sync-policy');

function createStateIndexClient(deps = {}) {
  const {
    fetchImpl,
    managementBase,
    managementKey,
    abortSignalFactory,
    resolveManagementSettings
  } = deps;

  const defaultBase = String(managementBase || buildManagementBaseUrl())
    .trim()
    .replace(/\/+$/, '');
  const defaultKey = String(managementKey || '').trim();
  let writeQueue = Promise.resolve();
  let operationalWriteQueue = Promise.resolve();
  let rejectedAuthSignature = '';

  function readManagementSettings() {
    let current = null;
    if (typeof resolveManagementSettings === 'function') {
      try {
        current = resolveManagementSettings();
      } catch (_error) {}
    }
    const base = String(current && current.managementBase || defaultBase)
      .trim()
      .replace(/\/+$/, '');
    const key = String(
      current && Object.prototype.hasOwnProperty.call(current, 'managementKey')
        ? current.managementKey
        : defaultKey
    ).trim();
    return {
      base: base || defaultBase,
      key
    };
  }

  function createPostTask(route, payload) {
    return () => {
      const { base, key } = readManagementSettings();
      const authSignature = `${base}\u0000${key}`;
      if (rejectedAuthSignature === authSignature) return undefined;
      const url = `${base}${route}`;
      const headers = { 'content-type': 'application/json' };
      if (key) headers.authorization = `Bearer ${key}`;
      const options = {
        method: 'POST',
        headers,
        body: JSON.stringify(payload || {})
      };
      if (typeof abortSignalFactory === 'function') {
        options.signal = abortSignalFactory(1200);
      }
      return Promise.resolve()
        .then(() => fetchImpl(url, options))
        .then((response) => {
          const status = Number(response && response.status) || 0;
          if (status === 401 || status === 403) rejectedAuthSignature = authSignature;
          else if (response && response.ok) rejectedAuthSignature = '';
        })
        .catch(() => {});
    };
  }

  function enqueuePost(route, payload) {
    if (!route || typeof fetchImpl !== 'function') return;
    const runPost = createPostTask(route, payload);
    // Serialize writes per process to avoid bursty concurrent updates.
    writeQueue = writeQueue.then(runPost, runPost);
  }

  function enqueueOperationalPost(route, payload) {
    if (!route || typeof fetchImpl !== 'function') return;
    const runPost = createPostTask(route, payload);
    // User commands stay ordered with each other but never wait behind background state sync.
    operationalWriteQueue = operationalWriteQueue.then(runPost, runPost);
  }

  function upsert(accountRef, provider, state) {
    enqueuePost('/state-index/upsert', {
      accountRef: String(accountRef || '').trim(),
      provider: String(provider || '').trim(),
      state: sanitizeBaseState(state)
    });
  }

  function setOperationalStatus(accountRef, provider, status, baseState = {}) {
    enqueueOperationalPost('/state-index/operational-status', {
      accountRef: String(accountRef || '').trim(),
      provider: String(provider || '').trim(),
      status: String(status || '').trim().toLowerCase(),
      baseState: sanitizeBaseState(baseState)
    });
  }

  function pruneMissing(provider, existingRefs) {
    enqueuePost('/state-index/prune-missing', {
      provider: String(provider || '').trim(),
      existingRefs: Array.isArray(existingRefs) ? existingRefs : []
    });
  }

  return {
    upsert,
    setOperationalStatus,
    pruneMissing
  };
}

module.exports = {
  createStateIndexClient
};
