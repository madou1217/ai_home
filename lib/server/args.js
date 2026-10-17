'use strict';

const {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  DEFAULT_SERVER_API_KEY,
  buildServerBaseUrl,
  buildManagementBaseUrl
} = require('./server-defaults');

function createProxyArgError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  err.detail = detail || '';
  return err;
}

function splitInlineOption(arg) {
  const text = String(arg || '').trim();
  const index = text.indexOf('=');
  if (index <= 0) return null;
  return {
    key: text.slice(0, index),
    value: text.slice(index + 1)
  };
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
    ['AIH_SERVER_API_KEY', process.env.AIH_SERVER_API_KEY, '--api-key']
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

function normalizeManagementBase(url) {
  const base = String(url || '').trim();
  if (!base) throw new Error('Empty management URL');
  return base.replace(/\/+$/, '');
}

function parseServerSyncArgs(rawArgs) {
  const out = {
    managementUrl: buildManagementBaseUrl(),
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
      out.managementUrl = normalizeManagementBase(val);
      i += 1;
      continue;
    }
    if (arg === '--key' || arg === '--management-key') {
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
    host: String(process.env.AIH_SERVER_HOST || DEFAULT_SERVER_HOST).trim(),
    port: DEFAULT_SERVER_PORT,
    portSource: 'default',
    codexBaseUrl: 'https://chatgpt.com/backend-api/codex'.trim(),
    geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai'.trim(),
    claudeBaseUrl: 'https://api.anthropic.com/v1'.trim(),
    agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal'.trim(),
    codexModels: ''.trim(),
    codexClientVersion: ''.trim(),
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
    strategy: 'random'.trim().toLowerCase(),
    clientKey: envKey.value,
    clientKeySource: envKey.source,
    managementKey: String(process.env.AIH_SERVER_MANAGEMENT_KEY || '').trim(),
    managementKeySource: String(process.env.AIH_SERVER_MANAGEMENT_KEY || '').trim()
      ? 'env:AIH_SERVER_MANAGEMENT_KEY'
      : '',
    cooldownMs: 60000,
    upstreamTimeoutMs: 120000,
    maxAttempts: 3,
    modelsCacheTtlMs: 300000,
    modelsProbeAccounts: 2,
    backend: 'codex-adapter'.trim().toLowerCase(),
    provider: 'auto'.trim().toLowerCase(),
    failureThreshold: 2,
    logRequests: true,
    codexMaxConcurrency: 2,
    geminiMaxConcurrency: 1,
    claudeMaxConcurrency: 1,
    agyMaxConcurrency: 1,
    opencodeMaxConcurrency: 1,
    queueLimit: 200,
    sessionAffinityTtlMs: 1800000,
    sessionAffinityMaxEntries: 10000,
    // Transcript scans are incremental (per-file cursors, plus a per-tick byte
    // budget for codex) and the first run is deferred past HTTP listen; OAuth
    // providers like kimi only get usage through this scan, so it stays on by
    // default. Opt out with --no-model-usage-scan.
    modelUsageScan: true,
    modelUsageScanStartDelayMs: 5000,
    modelUsageScanIntervalMs: 600000,
    // Provider CLI 自动升级。检查与应用都默认开：这是完整闭环（检查 → 静默闸门 → 升级 →
    // 验证 → 坏版本回滚 → 熔断）。它确实会动用户的全局环境（npm -g 会连带改掉用户自己终端里
    // 的 codex），所以关掉的路径必须一直留着：--no-provider-cli-auto-upgrade-apply
    // 退回只检查；--no-provider-cli-auto-upgrade 整条关掉。
    providerCliAutoUpgrade: true,
    providerCliAutoUpgradeApply: true,
    providerCliAutoUpgradeStartDelayMs: 300000,
    providerCliAutoUpgradeIntervalMs: 300000,
    // 窗口激活：对滚动限额窗口类账号（当前典型是 Codex Plus）在「窗口关闭后」补一个
    // 极小探测，让窗口持续滚动。每次探测都是一次真实上游请求，且是「为了不用而用」，
    // 所以全局默认关：只有显式打开（且逐账号开启）才生效。
    windowActivation: false,
    // 兜底间隔：只在「窗口状态观察不出来」时使用（能观察到窗口的账号按关窗时刻续窗，
    // 不看这个值）。窗口时长的下限就是它 → 兜底节奏取 1 小时（更密没有收益）。
    windowActivationDefaultIntervalMs: 3600000,
    windowActivationMinIntervalMs: 3600000,
    windowActivationTickIntervalMs: 600000,
    windowActivationStartDelayMs: 180000,
    windowActivationBatchSize: 4,
    windowActivationProbeTimeoutMs: 30000,
    codexCliHookSelfHealIntervalMs: 15000,
    codexDesktopHookSelfHealIntervalMs: 15000,
    codexDesktopTraceFile: ''.trim(),
    codexDesktopTraceResponses: ''.trim() === '1',
    codexDesktopTraceRemoteControl: true,
    codexDesktopRemoteControlProxy: true,
    codexDesktopRestartAppServerOnHookChange: false
  };
  const envPort = String(process.env.AIH_SERVER_PORT || '').trim();
  if (envPort) {
    out.port = parseStrictIntOption(envPort, '--port', 1, 65535);
    out.portSource = 'env:AIH_SERVER_PORT';
  }
  const tokens = Array.isArray(rawArgs) ? rawArgs.slice() : [];
  for (let i = 0; i < tokens.length; i += 1) {
    const rawArg = String(tokens[i] || '').trim();
    const inline = splitInlineOption(rawArg);
    const arg = inline ? inline.key : rawArg;
    if (!arg) continue;
    if (arg === '--host') {
      const val = String(inline ? inline.value : (tokens[i + 1] || '')).trim();
      if (!val) throw new Error('Invalid --host value');
      out.host = val;
      if (!inline) i += 1;
      continue;
    }
    if (arg === '--port') {
      out.port = parseStrictIntOption(inline ? inline.value : tokens[i + 1], '--port', 1, 65535);
      out.portSource = 'cli:--port';
      if (!inline) i += 1;
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
    if (arg === '--agy-base-url') {
      const val = String(tokens[i + 1] || '').trim();
      if (!val) throw new Error('Invalid --agy-base-url value');
      out.agyBaseUrl = val;
      i += 1;
      continue;
    }
    if (arg === '--codex-models') {
      out.codexModels = String(tokens[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--codex-client-version') {
      out.codexClientVersion = String(tokens[i + 1] || '').trim();
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
      out.clientKey = validateApiKeyValue(inline ? inline.value : tokens[i + 1], '--client-key');
      out.clientKeySource = 'cli:--client-key';
      if (!inline) i += 1;
      continue;
    }
    if (arg === '--api-key') {
      out.clientKey = validateApiKeyValue(inline ? inline.value : tokens[i + 1], '--api-key');
      out.clientKeySource = 'cli:--api-key';
      if (!inline) i += 1;
      continue;
    }
    if (arg === '--management-key') {
      const val = String(inline ? inline.value : (tokens[i + 1] || '')).trim();
      if (!val) throw new Error('Invalid --management-key value');
      out.managementKey = val;
      out.managementKeySource = 'cli:--management-key';
      if (!inline) i += 1;
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
      if (!['codex', 'gemini', 'claude', 'agy', 'opencode', 'auto'].includes(val)) throw new Error('Invalid --provider value');
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
    if (arg === '--agy-max-concurrency') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --agy-max-concurrency value');
      out.agyMaxConcurrency = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--opencode-max-concurrency') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --opencode-max-concurrency value');
      out.opencodeMaxConcurrency = Number(val);
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
    if (arg === '--no-model-usage-scan') {
      out.modelUsageScan = false;
      continue;
    }
    if (arg === '--model-usage-scan-start-delay-ms') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --model-usage-scan-start-delay-ms value');
      out.modelUsageScanStartDelayMs = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--model-usage-scan-interval-ms') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --model-usage-scan-interval-ms value');
      out.modelUsageScanIntervalMs = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--no-provider-cli-auto-upgrade') {
      out.providerCliAutoUpgrade = false;
      continue;
    }
    if (arg === '--provider-cli-auto-upgrade-apply') {
      out.providerCliAutoUpgradeApply = true;
      continue;
    }
    // 默认已开，这个 flag 才是实际有用的那一个：退回「只检查、不改动」。
    if (arg === '--no-provider-cli-auto-upgrade-apply') {
      out.providerCliAutoUpgradeApply = false;
      continue;
    }
    if (arg === '--provider-cli-auto-upgrade-start-delay-ms') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --provider-cli-auto-upgrade-start-delay-ms value');
      out.providerCliAutoUpgradeStartDelayMs = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--provider-cli-auto-upgrade-interval-ms') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --provider-cli-auto-upgrade-interval-ms value');
      out.providerCliAutoUpgradeIntervalMs = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--strict-port') {
      out.strictPort = true;
      continue;
    }
    if (arg === '--allow-multi') {
      out.allowMulti = true;
      continue;
    }
    if (arg === '--window-activation') {
      out.windowActivation = true;
      continue;
    }
    if (arg === '--no-window-activation') {
      out.windowActivation = false;
      continue;
    }
    if (arg === '--window-activation-default-interval-ms') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --window-activation-default-interval-ms value');
      out.windowActivationDefaultIntervalMs = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--window-activation-min-interval-ms') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --window-activation-min-interval-ms value');
      out.windowActivationMinIntervalMs = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--window-activation-tick-interval-ms') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --window-activation-tick-interval-ms value');
      out.windowActivationTickIntervalMs = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--window-activation-start-delay-ms') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --window-activation-start-delay-ms value');
      out.windowActivationStartDelayMs = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--window-activation-batch-size') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --window-activation-batch-size value');
      out.windowActivationBatchSize = Number(val);
      i += 1;
      continue;
    }
    if (arg === '--window-activation-probe-timeout-ms') {
      const val = String(tokens[i + 1] || '').trim();
      if (!/^\d+$/.test(val)) throw new Error('Invalid --window-activation-probe-timeout-ms value');
      out.windowActivationProbeTimeoutMs = Number(val);
      i += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  out.codexBaseUrl = out.codexBaseUrl.replace(/\/+$/, '');
  out.geminiBaseUrl = out.geminiBaseUrl.replace(/\/+$/, '');
  out.claudeBaseUrl = out.claudeBaseUrl.replace(/\/+$/, '');
  out.agyBaseUrl = out.agyBaseUrl.replace(/\/+$/, '');
  out.codexModels = String(out.codexModels || '').trim();
  out.codexClientVersion = String(out.codexClientVersion || '').trim();
  out.proxyUrl = String(out.proxyUrl || '').trim();
  out.noProxy = String(out.noProxy || '').trim();
  out.upstreamTimeoutMs = Math.max(1000, out.upstreamTimeoutMs || 15000);
  out.maxAttempts = Math.max(1, Math.min(32, out.maxAttempts || 3));
  out.modelsCacheTtlMs = Math.max(1000, out.modelsCacheTtlMs || 300000);
  out.modelsProbeAccounts = Math.max(1, Math.min(8, out.modelsProbeAccounts || 2));
  if (!['codex-adapter'].includes(out.backend)) out.backend = 'codex-adapter';
  if (!['codex', 'gemini', 'claude', 'agy', 'opencode', 'auto'].includes(out.provider)) out.provider = 'auto';
  out.failureThreshold = Math.max(1, Math.min(10, Number(out.failureThreshold) || 2));
  out.codexMaxConcurrency = Math.max(1, Math.min(32, Number(out.codexMaxConcurrency) || 2));
  out.geminiMaxConcurrency = Math.max(1, Math.min(16, Number(out.geminiMaxConcurrency) || 1));
  out.claudeMaxConcurrency = Math.max(1, Math.min(16, Number(out.claudeMaxConcurrency) || 1));
  out.agyMaxConcurrency = Math.max(1, Math.min(16, Number(out.agyMaxConcurrency) || 1));
  out.opencodeMaxConcurrency = Math.max(1, Math.min(16, Number(out.opencodeMaxConcurrency) || 1));
  out.queueLimit = Math.max(1, Math.min(5000, Number(out.queueLimit) || 200));
  out.sessionAffinityTtlMs = Math.max(30000, Number(out.sessionAffinityTtlMs) || 1800000);
  out.sessionAffinityMaxEntries = Math.max(100, Math.min(100000, Number(out.sessionAffinityMaxEntries) || 10000));
  out.modelUsageScan = out.modelUsageScan !== false;
  {
    const startDelayMs = Number(out.modelUsageScanStartDelayMs);
    out.modelUsageScanStartDelayMs = Number.isFinite(startDelayMs) && startDelayMs >= 0 ? startDelayMs : 5000;
    const intervalMs = Number(out.modelUsageScanIntervalMs);
    out.modelUsageScanIntervalMs = Number.isFinite(intervalMs) && intervalMs >= 60000 ? intervalMs : 600000;
  }
  out.providerCliAutoUpgrade = out.providerCliAutoUpgrade !== false;
  out.providerCliAutoUpgradeApply = out.providerCliAutoUpgradeApply !== false;
  {
    const startDelayMs = Number(out.providerCliAutoUpgradeStartDelayMs);
    out.providerCliAutoUpgradeStartDelayMs = Number.isFinite(startDelayMs) && startDelayMs >= 0 ? startDelayMs : 300000;
    // 默认与下限都是 5min：新版本发布后 10 分钟内开始升级；不给调成秒级。
    const intervalMs = Number(out.providerCliAutoUpgradeIntervalMs);
    out.providerCliAutoUpgradeIntervalMs = Number.isFinite(intervalMs) && intervalMs >= 300000 ? intervalMs : 300000;
  }
  out.windowActivation = out.windowActivation === true;
  {
    const minIntervalMs = Number(out.windowActivationMinIntervalMs);
    out.windowActivationMinIntervalMs = Number.isFinite(minIntervalMs) && minIntervalMs >= 60000 ? minIntervalMs : 3600000;
    // 默认间隔不得低于下限，否则「默认」会被 clamp 悄悄改写、配置看起来不生效。
    const defaultIntervalMs = Number(out.windowActivationDefaultIntervalMs);
    out.windowActivationDefaultIntervalMs = Number.isFinite(defaultIntervalMs) && defaultIntervalMs >= out.windowActivationMinIntervalMs
      ? defaultIntervalMs
      : Math.max(out.windowActivationMinIntervalMs, 3600000);
    const tickIntervalMs = Number(out.windowActivationTickIntervalMs);
    out.windowActivationTickIntervalMs = Number.isFinite(tickIntervalMs) && tickIntervalMs >= 60000 ? tickIntervalMs : 600000;
    const startDelayMs = Number(out.windowActivationStartDelayMs);
    out.windowActivationStartDelayMs = Number.isFinite(startDelayMs) && startDelayMs >= 0 ? startDelayMs : 180000;
    const batchSize = Number(out.windowActivationBatchSize);
    out.windowActivationBatchSize = Number.isFinite(batchSize) ? Math.max(1, Math.min(32, Math.floor(batchSize))) : 4;
    const probeTimeoutMs = Number(out.windowActivationProbeTimeoutMs);
    out.windowActivationProbeTimeoutMs = Number.isFinite(probeTimeoutMs)
      ? Math.max(5000, Math.min(120000, Math.floor(probeTimeoutMs)))
      : 30000;
  }
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
    baseUrl: buildServerBaseUrl(),
    apiKey: DEFAULT_SERVER_API_KEY
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
