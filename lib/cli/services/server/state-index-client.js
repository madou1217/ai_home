'use strict';

const { buildManagementBaseUrl } = require('../../../server/server-defaults');

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

  function enqueuePost(route, payload) {
    if (!route || typeof fetchImpl !== 'function') return;
    const runPost = () => {
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
    // Serialize writes per process to avoid bursty concurrent updates.
    writeQueue = writeQueue.then(runPost, runPost);
  }

  function upsert(accountRef, provider, state) {
    enqueuePost('/state-index/upsert', {
      accountRef: String(accountRef || '').trim(),
      provider: String(provider || '').trim(),
      state: state && typeof state === 'object' ? state : {}
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
    pruneMissing
  };
}

module.exports = {
  createStateIndexClient
};
