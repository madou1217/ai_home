'use strict';

// Model discovery never sits on the selection/translation critical path.
// A target-scoped cache also prevents a late remote response replacing the
// catalog after the user switches servers.
function createDesktopTranslationModelCatalog({ fetch: fetchImpl = globalThis.fetch, getManagementKey = () => '', onChange = () => {} } = {}) {
  let scope = '';
  let value = { models: [], defaultModel: '', defaultProvider: '' };
  let pending = null;
  let updatedAt = 0;
  let generation = 0;

  function reset(nextScope = '') {
    generation += 1;
    pending?.abort();
    pending = null;
    scope = nextScope;
    updatedAt = 0;
    value = { models: [], defaultModel: '', defaultProvider: '' };
  }

  function read(target, current = {}, executionTarget) {
    const nextScope = `${executionTarget}:${target.origin || ''}:${target.serverId || ''}`;
    if (scope !== nextScope) reset(nextScope);
    const routes = (current.routes || []).filter((route) => route.enabled !== false && route.operations?.includes('selection'));
    const models = executionTarget === 'direct-provider'
      ? routes.map((route) => ({ id: route.model, provider: route.modelProvider || route.provider, label: route.model }))
      : value.models;
    const first = routes[0];
    return {
      models,
      defaultModel: first?.model || current.model || value.defaultModel,
      defaultProvider: first?.modelProvider || (executionTarget === 'direct-provider' ? first?.provider : '') || current.provider || value.defaultProvider
    };
  }

  async function refresh(target, executionTarget) {
    if (executionTarget !== 'aih-server' || !/^https?:\/\//.test(target.origin || '') || typeof fetchImpl !== 'function') return;
    if (pending || (updatedAt && Date.now() - updatedAt < 60000)) return;
    const token = generation;
    const controller = new AbortController();
    pending = controller;
    try {
      const headers = {};
      const key = getManagementKey();
      if (key) headers.Authorization = `Bearer ${key}`;
      if (target.serverId) headers['x-aih-server-id'] = target.serverId;
      const response = await fetchImpl(`${target.origin.replace(/\/$/, '')}/v0/webui/translation/models`, {
        headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4000)])
      });
      if (!response.ok) return;
      const payload = await response.json();
      if (token !== generation || controller.signal.aborted) return;
      const seen = new Set();
      const models = (Array.isArray(payload.models) ? payload.models : []).filter((entry) => {
        if (!entry || typeof entry.id !== 'string' || !entry.id.trim()) return false;
        const identity = `${entry.provider || ''}:${entry.id}`;
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      }).slice(0, 256).map((entry) => ({ id: entry.id.slice(0, 200), provider: String(entry.provider || '').slice(0, 100), label: String(entry.label || entry.id).slice(0, 240) }));
      value = { models, defaultModel: String(payload.defaultModel || '').slice(0, 200), defaultProvider: String(payload.defaultProvider || '').slice(0, 100) };
      updatedAt = Date.now();
      onChange();
    } catch (_error) {
      // Keep manual selection and existing catalog available on network failure.
    } finally {
      if (pending === controller) pending = null;
    }
  }

  return { read, refresh, reset };
}

module.exports = { createDesktopTranslationModelCatalog };
