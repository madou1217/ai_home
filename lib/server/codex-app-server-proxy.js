'use strict';

// Codex app-server WebSocket/stdio 代理已迁至 Go Core，此处仅保留 CLI 复用的纯 JSON-RPC 入站改写工具函数。
function isCodexAppServerUpgradePath(pathname) {
  const normalized = String(pathname || '').trim() || '/';
  return normalized === '/' || normalized === '/v0/codex/app-server';
}

function normalizeModelProviderFiltersForSharedSessions(modelProviders) {
  if (!Array.isArray(modelProviders)) return [];
  return [];
}

function normalizeInjectedCwd(cwd) {
  return String(cwd || '').trim();
}

function rewriteCodexAppServerClientMessage(raw, options = {}) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    return text;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return text;
  }
  const method = String(parsed.method || '').trim();
  if (!method) {
    return text;
  }
  const next = { ...parsed };
  const params = (next.params && typeof next.params === 'object' && !Array.isArray(next.params))
    ? { ...next.params }
    : {};

  if (method === 'thread/list') {
    let changed = false;
    const injectedCwd = normalizeInjectedCwd(options.cwd);
    if (
      injectedCwd
      && options.injectCwd !== false
      && (
        !Object.prototype.hasOwnProperty.call(params, 'cwd')
        || params.cwd === null
        || params.cwd === ''
      )
    ) {
      params.cwd = injectedCwd;
      changed = true;
    }
    const normalizedModelProviders = normalizeModelProviderFiltersForSharedSessions(params.modelProviders);
    if (
      !Object.prototype.hasOwnProperty.call(params, 'modelProviders')
      || params.modelProviders === null
      || JSON.stringify(params.modelProviders) !== JSON.stringify(normalizedModelProviders)
    ) {
      params.modelProviders = normalizedModelProviders;
      changed = true;
    }
    if (params.useStateDbOnly !== true) {
      params.useStateDbOnly = true;
      changed = true;
    }
    if (!changed) return text;
    next.params = params;
    return JSON.stringify(next);
  }

  if (method === 'thread/start' || method === 'thread/resume' || method === 'thread/fork') {
    const config = (params.config && typeof params.config === 'object' && !Array.isArray(params.config))
      ? { ...params.config }
      : null;
    if (config && typeof config.profile === 'string' && config.profile.trim()) {
      delete config.profile;
      if (Object.keys(config).length > 0) {
        params.config = config;
      } else {
        delete params.config;
      }
      next.params = params;
      return JSON.stringify(next);
    }
  }

  return text;
}

module.exports = {
  isCodexAppServerUpgradePath,
  normalizeModelProviderFiltersForSharedSessions,
  rewriteCodexAppServerClientMessage
};
