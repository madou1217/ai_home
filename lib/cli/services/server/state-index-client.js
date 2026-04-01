'use strict';

function createStateIndexClient(deps = {}) {
  const {
    fetchImpl,
    managementBase,
    managementKey,
    abortSignalFactory
  } = deps;

  const base = String(managementBase || 'http://127.0.0.1:8317/v0/management')
    .trim()
    .replace(/\/+$/, '');
  const key = String(managementKey || '').trim();
  let writeQueue = Promise.resolve();

  function enqueuePost(route, payload) {
    if (!route || typeof fetchImpl !== 'function') return;
    const url = `${base}${route}`;
    const headers = { 'content-type': 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;
    const runPost = () => {
      const options = {
        method: 'POST',
        headers,
        body: JSON.stringify(payload || {})
      };
      if (typeof abortSignalFactory === 'function') {
        options.signal = abortSignalFactory(1200);
      }
      return fetchImpl(url, options).catch(() => {});
    };
    // Serialize writes per process to avoid bursty concurrent updates.
    writeQueue = writeQueue.then(runPost, runPost);
  }

  function upsert(provider, accountId, state) {
    enqueuePost('/state-index/upsert', {
      provider: String(provider || '').trim(),
      accountId: String(accountId || '').trim(),
      state: state && typeof state === 'object' ? state : {}
    });
  }

  function setExhausted(provider, accountId, exhausted) {
    enqueuePost('/state-index/set-exhausted', {
      provider: String(provider || '').trim(),
      accountId: String(accountId || '').trim(),
      exhausted: !!exhausted
    });
  }

  function pruneMissing(provider, existingIds) {
    enqueuePost('/state-index/prune-missing', {
      provider: String(provider || '').trim(),
      existingIds: Array.isArray(existingIds) ? existingIds : []
    });
  }

  return {
    upsert,
    setExhausted,
    pruneMissing
  };
}

module.exports = {
  createStateIndexClient
};
