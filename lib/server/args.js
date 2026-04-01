'use strict';

function createProxyArgError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  err.detail = detail || '';
  return err;
}

function proxyOptionCode(optionName) {
  return optionName.replace(/^-+/, '').replace(/-/g, '_');
}

function parseStrictIntOption(rawValue, optionName, min, max) {
  const val = String(rawValue || '').trim();
  if (!/^\d+$/.test(val)) {
    throw createProxyArgError(
      `proxy_serve_invalid_${proxyOptionCode(optionName)}`,
      `Invalid ${optionName} value`,
      'expected_integer'
    );
  }
  const num = Number(val);
  if (!Number.isFinite(num) || num < min || num > max) {
    throw createProxyArgError(
      `proxy_serve_invalid_${proxyOptionCode(optionName)}`,
      `Invalid ${optionName} value`,
      `out_of_range_${min}_${max}`
    );
  }
  return num;
}

function validateApiKeyValue(rawValue, optionName) {
  const val = String(rawValue || '').trim();
  if (!val) {
    throw createProxyArgError(
      `proxy_serve_invalid_${proxyOptionCode(optionName)}`,
      `Invalid ${optionName} value`,
      'empty'
    );
  }
  if (val.length > 256) {
    throw createProxyArgError(
      `proxy_serve_invalid_${proxyOptionCode(optionName)}`,
      `Invalid ${optionName} value`,
      'too_long'
    );
  }
  if (!/^[\x21-\x7E]+$/.test(val)) {
    throw createProxyArgError(
      `proxy_serve_invalid_${proxyOptionCode(optionName)}`,
      `Invalid ${optionName} value`,
      'invalid_chars'
    );
  }
  return val;
}

function resolveEnvClientKey() {
  const envCandidates = [
    ['AIH_SERVER_API_KEY', process.env.AIH_SERVER_API_KEY, '--api-key'],
    ['AIH_SERVER_CLIENT_KEY', process.env.AIH_SERVER_CLIENT_KEY, '--client-key']
  ];
  for (const [envName, rawValue, optionName] of envCandidates) {
    if (rawValue === undefined || rawValue === null) continue;
    const trimmed = String(rawValue).trim();
    if (!trimmed) continue;
    return {
      value: validateApiKeyValue(trimmed, optionName),
      source: `env:${envName}`
    };
  }
  return {
    value: '',
    source: 'unset'
  };
}

function parseServerSyncArgs(rawArgs) {
  const out = {
    managementUrl: 'http://127.0.0.1:8317/v0/management',
    key: String(process.env.AIH_SERVER_MANAGEMENT_KEY || '').trim(),
    parallel: 8,
    limit: 0,
    dryRun: false,
    namePrefix: 'aih-codex-'
  };
  const tokens = Array.isArray(rawArgs) ? rawArgs.slice() : [];
  for (let i = 0; i < tokens.length; i += 1) {
    const arg = String(tokens[i] || '').trim();
    if (!arg) continue;
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (arg === '--management-url') {
      const val = String(tokens[i + 1] || '').trim();
      if (!val) throw new Error('Invalid --management-url value');
      out.managementUrl = val;
      i += 1;
      continue;
    }
    if (arg === '--key') {
      const val = String(tokens[i + 1] || '').trim();
      if (!val) throw new Error('Invalid --key value');
      out.key = val;
      i += 1;
      continue;
    }
    if (arg === '--parallel' || arg === '-p') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --parallel value');
      out.parallel = Math.max(1, Math.min(32, Number(val)));
      i += 1;
      continue;
    }
    if (arg === '--limit') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --limit value');
      out.limit = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--name-prefix') {
      const val = String(tokens[i + 1] || '').trim();
      if (!val) throw new Error('Invalid --name-prefix value');
      out.namePrefix = val;
      i += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return out;
}

function parseServerServeArgs(rawArgs) {
  const envKey = resolveEnvClientKey();
  const out = {
    host: String(process.env.AIH_SERVER_HOST || '127.0.0.1').trim(),
    port: 8317,
    portSource: 'default',
    codexBaseUrl: String(process.env.AIH_SERVER_CODEX_BASE_URL || 'https://chatgpt.com/backend-api/codex').trim(),
    geminiBaseUrl: String(process.env.AIH_SERVER_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').trim(),
    claudeBaseUrl: String(process.env.AIH_SERVER_CLAUDE_BASE_URL || 'https://api.anthropic.com/v1').trim(),
    codexModels: String(process.env.AIH_SERVER_CODEX_MODELS || '').trim(),
    proxyUrl: String(
      process.env.AIH_SERVER_PROXY_URL
      || process.env.HTTPS_PROXY
      || process.env.https_proxy
      || process.env.HTTP_PROXY
      || process.env.http_proxy
      || ''
    ).trim(),
    noProxy: String(
      process.env.AIH_SERVER_NO_PROXY
      || process.env.NO_PROXY
      || process.env.no_proxy
      || ''
    ).trim(),
    strategy: String(process.env.AIH_SERVER_STRATEGY || 'random').trim().toLowerCase(),
    clientKey: envKey.value,
    clientKeySource: envKey.source,
    managementKey: String(process.env.AIH_SERVER_MANAGEMENT_KEY || '').trim(),
    cooldownMs: Number(process.env.AIH_SERVER_COOLDOWN_MS || 60000),
    upstreamTimeoutMs: Number(process.env.AIH_SERVER_UPSTREAM_TIMEOUT_MS || 45000),
    maxAttempts: Number(process.env.AIH_SERVER_MAX_ATTEMPTS || 3),
    modelsCacheTtlMs: Number(process.env.AIH_SERVER_MODELS_CACHE_TTL_MS || 300000),
    modelsProbeAccounts: Number(process.env.AIH_SERVER_MODELS_PROBE_ACCOUNTS || 2),
    backend: String(process.env.AIH_SERVER_BACKEND || 'codex-adapter').trim().toLowerCase(),
    provider: String(process.env.AIH_SERVER_PROVIDER || 'auto').trim().toLowerCase(),
    failureThreshold: Number(process.env.AIH_SERVER_FAILURE_THRESHOLD || 2),
    logRequests: String(process.env.AIH_SERVER_LOG_REQUESTS || '1').trim() !== '0',
    codexMaxConcurrency: Number(process.env.AIH_SERVER_CODEX_MAX_CONCURRENCY || 2),
    geminiMaxConcurrency: Number(process.env.AIH_SERVER_GEMINI_MAX_CONCURRENCY || 1),
    claudeMaxConcurrency: Number(process.env.AIH_SERVER_CLAUDE_MAX_CONCURRENCY || 1),
    queueLimit: Number(process.env.AIH_SERVER_QUEUE_LIMIT || 200),
    sessionAffinityTtlMs: Number(process.env.AIH_SERVER_SESSION_AFFINITY_TTL_MS || 1800000),
    sessionAffinityMaxEntries: Number(process.env.AIH_SERVER_SESSION_AFFINITY_MAX || 10000)
  };
  const envPort = String(process.env.AIH_SERVER_PORT || '').trim();
  if (envPort) {
    out.port = parseStrictIntOption(envPort, '--port', 1, 65535);
    out.portSource = 'env:AIH_SERVER_PORT';
  }
  const tokens = Array.isArray(rawArgs) ? rawArgs.slice() : [];
  for (let i = 0; i < tokens.length; i += 1) {
    const arg = String(tokens[i] || '').trim();
    if (!arg) continue;
    if (arg === '--host') {
      const val = String(tokens[i + 1] || '').trim();
      if (!val) throw new Error('Invalid --host value');
      out.host = val;
      i += 1;
      continue;
    }
    if (arg === '--port') {
      out.port = parseStrictIntOption(tokens[i + 1], '--port', 1, 65535);
      out.portSource = 'cli:--port';
      i += 1;
      continue;
    }
    if (arg === '--codex-base-url') {
      const val = String(tokens[i + 1] || '').trim();
      if (!val) throw new Error('Invalid --codex-base-url value');
      out.codexBaseUrl = val;
      i += 1;
      continue;
    }
    if (arg === '--gemini-base-url') {
      const val = String(tokens[i + 1] || '').trim();
      if (!val) throw new Error('Invalid --gemini-base-url value');
      out.geminiBaseUrl = val;
      i += 1;
      continue;
    }
    if (arg === '--claude-base-url') {
      const val = String(tokens[i + 1] || '').trim();
      if (!val) throw new Error('Invalid --claude-base-url value');
      out.claudeBaseUrl = val;
      i += 1;
      continue;
    }
    if (arg === '--codex-models') {
      out.codexModels = String(tokens[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--proxy-url') {
      const val = String(tokens[i + 1] || '').trim();
      if (!val) throw new Error('Invalid --proxy-url value');
      out.proxyUrl = val;
      i += 1;
      continue;
    }
    if (arg === '--no-proxy') {
      out.noProxy = String(tokens[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--strategy') {
      const val = String(tokens[i + 1] || '').trim().toLowerCase();
      if (!['round-robin', 'random'].includes(val)) throw new Error('Invalid --strategy value');
      out.strategy = val;
      i += 1;
      continue;
    }
    if (arg === '--client-key') {
      out.clientKey = validateApiKeyValue(tokens[i + 1], '--client-key');
      out.clientKeySource = 'cli:--client-key';
      i += 1;
      continue;
    }
    if (arg === '--api-key') {
      out.clientKey = validateApiKeyValue(tokens[i + 1], '--api-key');
      out.clientKeySource = 'cli:--api-key';
      i += 1;
      continue;
    }
    if (arg === '--management-key') {
      const val = String(tokens[i + 1] || '').trim();
      if (!val) throw new Error('Invalid --management-key value');
      out.managementKey = val;
      i += 1;
      continue;
    }
    if (arg === '--cooldown-ms') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --cooldown-ms value');
      out.cooldownMs = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--upstream-timeout-ms') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --upstream-timeout-ms value');
      out.upstreamTimeoutMs = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--max-attempts') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --max-attempts value');
      out.maxAttempts = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--models-cache-ttl-ms') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --models-cache-ttl-ms value');
      out.modelsCacheTtlMs = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--models-probe-accounts') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --models-probe-accounts value');
      out.modelsProbeAccounts = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--backend') {
      const val = String(tokens[i + 1] || '').trim().toLowerCase();
      if (!['codex-adapter'].includes(val)) throw new Error('Invalid --backend value');
      out.backend = val;
      i += 1;
      continue;
    }
    if (arg === '--provider') {
      const val = String(tokens[i + 1] || '').trim().toLowerCase();
      if (!['codex', 'gemini', 'claude', 'auto'].includes(val)) throw new Error('Invalid --provider value');
      out.provider = val;
      i += 1;
      continue;
    }
    if (arg === '--failure-threshold') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --failure-threshold value');
      out.failureThreshold = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--no-request-log') {
      out.logRequests = false;
      continue;
    }
    if (arg === '--codex-max-concurrency') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --codex-max-concurrency value');
      out.codexMaxConcurrency = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--gemini-max-concurrency') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --gemini-max-concurrency value');
      out.geminiMaxConcurrency = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--claude-max-concurrency') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --claude-max-concurrency value');
      out.claudeMaxConcurrency = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--queue-limit') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --queue-limit value');
      out.queueLimit = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--session-affinity-ttl-ms') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --session-affinity-ttl-ms value');
      out.sessionAffinityTtlMs = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--session-affinity-max') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --session-affinity-max value');
      out.sessionAffinityMaxEntries = Number(val);
      i += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  out.codexBaseUrl = out.codexBaseUrl.replace(/\/+$/, '');
  out.geminiBaseUrl = out.geminiBaseUrl.replace(/\/+$/, '');
  out.claudeBaseUrl = out.claudeBaseUrl.replace(/\/+$/, '');
  out.codexModels = String(out.codexModels || '').trim();
  out.proxyUrl = String(out.proxyUrl || '').trim();
  out.noProxy = String(out.noProxy || '').trim();
  out.upstreamTimeoutMs = Math.max(1000, out.upstreamTimeoutMs || 15000);
  out.maxAttempts = Math.max(1, Math.min(32, out.maxAttempts || 3));
  out.modelsCacheTtlMs = Math.max(1000, out.modelsCacheTtlMs || 300000);
  out.modelsProbeAccounts = Math.max(1, Math.min(8, out.modelsProbeAccounts || 2));
  if (!['codex-adapter'].includes(out.backend)) out.backend = 'codex-adapter';
  if (!['codex', 'gemini', 'claude', 'auto'].includes(out.provider)) out.provider = 'auto';
  out.failureThreshold = Math.max(1, Math.min(10, Number(out.failureThreshold) || 2));
  out.codexMaxConcurrency = Math.max(1, Math.min(32, Number(out.codexMaxConcurrency) || 2));
  out.geminiMaxConcurrency = Math.max(1, Math.min(16, Number(out.geminiMaxConcurrency) || 1));
  out.claudeMaxConcurrency = Math.max(1, Math.min(16, Number(out.claudeMaxConcurrency) || 1));
  out.queueLimit = Math.max(1, Math.min(5000, Number(out.queueLimit) || 200));
  out.sessionAffinityTtlMs = Math.max(30000, Number(out.sessionAffinityTtlMs) || 1800000);
  out.sessionAffinityMaxEntries = Math.max(100, Math.min(100000, Number(out.sessionAffinityMaxEntries) || 10000));
  out.apiKey = out.clientKey;
  out.apiKeyConfigured = Boolean(out.clientKey);
  out.effectiveConfig = {
    port: out.port,
    portSource: out.portSource,
    apiKeyConfigured: out.apiKeyConfigured,
    apiKeySource: out.clientKeySource,
    proxyConfigured: Boolean(out.proxyUrl),
    backend: out.backend
  };
  return out;
}

function parseServerEnvArgs(rawArgs) {
  const out = {
    baseUrl: 'http://127.0.0.1:8317/v1',
    apiKey: 'dummy'
  };
  const tokens = Array.isArray(rawArgs) ? rawArgs.slice() : [];
  for (let i = 0; i < tokens.length; i += 1) {
    const arg = String(tokens[i] || '').trim();
    if (!arg) continue;
    if (arg === '--base-url') {
      const val = String(tokens[i + 1] || '').trim();
      if (!val) throw new Error('Invalid --base-url value');
      out.baseUrl = val;
      i += 1;
      continue;
    }
    if (arg === '--api-key') {
      const val = String(tokens[i + 1] || '').trim();
      if (!val) throw new Error('Invalid --api-key value');
      out.apiKey = val;
      i += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return out;
}

module.exports = {
  parseServerSyncArgs,
  parseServerServeArgs,
  parseServerEnvArgs
};
