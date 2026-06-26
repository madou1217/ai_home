'use strict';

const { parseCodexClientVersion } = require('./codex-client-version');
const {
  readResponseText,
  sanitizeResponseText
} = require('./response-body');

function toPlainText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function sanitizeAccessToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) return '';
  if (/[\r\n\0]/.test(token)) return '';
  return token;
}

function resolveCodexClientVersion(options) {
  return parseCodexClientVersion(options && options.codexClientVersion);
}

function resolveCodexUpstreamBaseUrl(options, account) {
  const accountBaseUrl = (
    account
    && (account.apiKeyMode || account.authType === 'api-key')
    && String(account.openaiBaseUrl || '').trim()
  ) || '';
  return String(accountBaseUrl || (options && options.codexBaseUrl) || '').trim().replace(/\/+$/, '');
}

function isLoopbackServerUrl(url, serverPort) {
  try {
    const parsed = new URL(url);
    const host = String(parsed.hostname || '').trim().toLowerCase();
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1';
    const targetPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return isLocal && targetPort === String(serverPort);
  } catch (_error) {
    return false;
  }
}

function parseCodexModelsResponse(payload) {
  const list = Array.isArray(payload && payload.models)
    ? payload.models
    : (Array.isArray(payload && payload.data) ? payload.data : []);
  const ids = [];
  list.forEach((model) => {
    if (!model || typeof model !== 'object') return;
    if (model.supported_in_api === false) return;
    const visibility = toPlainText(model.visibility || '').trim().toLowerCase();
    if (visibility && !['list', 'default', 'public'].includes(visibility)) return;
    const id = toPlainText(model.slug || model.id || model.model || '').trim();
    if (id) ids.push(id);
  });
  return ids;
}

async function fetchCodexModelsForAccount(ctx) {
  const { options, account, fetchWithTimeout, timeoutMs } = ctx;
  const token = sanitizeAccessToken(account && account.accessToken);
  if (!token) throw new Error('invalid_access_token');
  const base = resolveCodexUpstreamBaseUrl(options, account);
  if (!base) throw new Error('invalid_codex_base_url');
  if (isLoopbackServerUrl(base, options && options.port)) throw new Error('infinite_loop_detected');
  const clientVersion = resolveCodexClientVersion(options);
  const query = clientVersion ? `?client_version=${encodeURIComponent(clientVersion)}` : '';
  const url = `${base}/models${query}`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    originator: 'codex_cli_rs'
  };
  if (clientVersion) {
    headers.version = clientVersion;
    headers['user-agent'] = `codex_cli_rs/${clientVersion}`;
  }
  if (account && account.accountId) {
    headers['chatgpt-account-id'] = account.accountId;
  }
  const upstreamRes = await fetchWithTimeout(url, {
    method: 'GET',
    headers
  }, timeoutMs, {
    proxyUrl: options && options.proxyUrl,
    noProxy: options && options.noProxy
  });
  const rawText = await readResponseText(upstreamRes);
  if (!upstreamRes.ok) {
    throw new Error(`upstream_${upstreamRes.status}: ${sanitizeResponseText(rawText)}`);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    const suffix = sanitizeResponseText(rawText, 120);
    throw new Error(suffix
      ? `invalid_models_payload: ${suffix}`
      : `invalid_models_payload: ${String(error && error.message || error || '').trim()}`
    );
  }
  return parseCodexModelsResponse(parsed);
}

module.exports = {
  fetchCodexModelsForAccount,
  parseCodexModelsResponse,
  resolveCodexClientVersion,
  resolveCodexUpstreamBaseUrl,
  __private: {
    isLoopbackServerUrl,
    sanitizeAccessToken
  }
};
