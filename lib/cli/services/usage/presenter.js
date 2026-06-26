'use strict';

const {
  readAccountStatusFile,
  resolveEffectiveAccountStatus
} = require('../../../account/status-file');
const {
  formatUsageWindows,
  formatUsageWindowLines
} = require('./window-format');

function createUsagePresenterService(options = {}) {
  const {
    usageCacheMaxAgeMs,
    readUsageCache,
    ensureUsageSnapshot,
    ensureUsageSnapshotAsync,
    buildAgyUsagePreflight,
    getClaudeUsageAuthForSandbox,
    getLastUsageProbeError,
    checkStatus,
    getProfileDir,
    filterExistingAccountIds,
    getAccountStateIndex,
    getToolAccountIds,
    getDefaultParallelism,
    accountStateService,
    getAccountQuotaState,
    getMinRemainingPctFromCache,
    codexAuthInvalidReconciler
  } = options;
  const processObj = options.processObj || process;
  const env = processObj.env || {};

  function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(number)));
  }

  function readEnvInteger(name, fallback, min, max) {
    return clampInteger(env[name], min, max, fallback);
  }

  function createTimeoutResult(error) {
    return {
      cliName: '',
      id: '',
      status: 'probe_error',
      error
    };
  }

  async function waitForCodexAuthInvalidReconcile(cliName) {
    if (String(cliName || '').trim().toLowerCase() !== 'codex') return;
    if (!codexAuthInvalidReconciler || typeof codexAuthInvalidReconciler.waitForIdle !== 'function') return;
    await codexAuthInvalidReconciler.waitForIdle();
  }

  async function withDeadline(promise, timeoutMs, fallback) {
    const safeTimeoutMs = Math.max(1, Number(timeoutMs) || 1);
    let timer = null;
    try {
      return await Promise.race([
        promise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(fallback()), safeTimeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function resolveUsageScanPlan(cliName, totalAccounts, requestedJobs) {
    const total = Math.max(0, Number(totalAccounts) || 0);
    const isWindows = processObj.platform === 'win32';
    const bulkThreshold = readEnvInteger('AIH_USAGE_BULK_THRESHOLD', 200, 1, 100000);
    const bulkScan = total >= bulkThreshold;
    const requested = Number.isFinite(requestedJobs) && requestedJobs > 0
      ? Math.floor(requestedJobs)
      : 0;
    const defaultBase = Math.max(1, Number(getDefaultParallelism ? getDefaultParallelism() : 10) || 10);
    let automaticWorkers = defaultBase;

    if (cliName === 'codex') {
      automaticWorkers = bulkScan
        ? (isWindows ? 100 : readEnvInteger('AIH_CODEX_USAGE_BULK_JOBS', 100, 1, 5000))
        : (isWindows ? 50 : 500);
    } else if (bulkScan) {
      automaticWorkers = isWindows
        ? Math.max(defaultBase, 100)
        : Math.max(defaultBase, readEnvInteger('AIH_USAGE_BULK_JOBS', 1000, 1, 3000));
    }

    const hardCap = cliName === 'codex'
      ? (isWindows ? 100 : 5000)
      : (isWindows ? 200 : 3000);
    const maxWorkers = Math.max(1, Math.min(total || 1, requested || automaticWorkers, hardCap));
    const deadlineMs = readEnvInteger('AIH_USAGE_SCAN_DEADLINE_MS', 30_000, 5_000, 120_000);
    const probeTimeoutMs = bulkScan
      ? readEnvInteger('AIH_USAGE_BULK_PROBE_TIMEOUT_MS', 10000, 500, 30_000)
      : 0;

    return {
      bulkScan,
      deadlineMs,
      maxWorkers,
      probeTimeoutMs,
      skipCodexAppServerFallback: cliName === 'codex' && bulkScan && env.AIH_CODEX_USAGE_BULK_APP_SERVER_FALLBACK !== '1',
      allowCodexTokenRefresh: !(cliName === 'codex' && bulkScan) || env.AIH_CODEX_USAGE_BULK_TOKEN_REFRESH === '1'
    };
  }

  function getIndexedAccountState(cliName, accountId) {
    const index = typeof getAccountStateIndex === 'function' ? getAccountStateIndex() : null;
    if (!index) return null;
    if (typeof index.getAccountState === 'function') {
      return index.getAccountState(cliName, accountId) || null;
    }
    if (typeof index.listStates === 'function') {
      const rows = index.listStates(cliName) || [];
      return rows.find((row) => String(row && row.accountId || '') === String(accountId)) || null;
    }
    return null;
  }

  function resolvePersistedOperationalStatus(cliName, accountId) {
    const row = getIndexedAccountState(cliName, accountId);
    return resolveEffectiveAccountStatus(
      row && row.status,
      readAccountStatusFile(options.fs, getProfileDir(cliName, accountId))
    );
  }

  function syncIndexedBaseState(cliName, accountId, state) {
    if (!accountStateService || typeof accountStateService.syncAccountBaseState !== 'function') return false;
    return accountStateService.syncAccountBaseState(cliName, accountId, state);
  }

  function formatUsageLabel(cliName, id, accountName) {
    if (accountName && accountName.startsWith('API Key')) {
      return '\x1b[90m[Remaining: API Key mode]\x1b[0m';
    }
    const cache = readUsageCache(cliName, id);
    if (!cache || !cache.capturedAt || (Date.now() - cache.capturedAt > usageCacheMaxAgeMs)) {
      return '';
    }

    if ((cache.kind === 'gemini_oauth_stats' || cache.kind === 'agy_code_assist_quota') && Array.isArray(cache.models) && cache.models.length > 0) {
      const hottest = [...cache.models].sort((a, b) => a.remainingPct - b.remainingPct)[0];
      return `\x1b[36m[Remaining: ${hottest.model} ${hottest.remainingPct.toFixed(1)}% / ${hottest.resetIn}]\x1b[0m`;
    }

    // codex/claude share the windowed entry shape — show every window that has
    // a figure, shortest-first (5h, then 7days). codex without a 5h window just
    // shows 7days; no figures → no label.
    const windowsLabel = formatUsageWindows(cache);
    if (windowsLabel) {
      return `\x1b[36m[Remaining: ${windowsLabel}]\x1b[0m`;
    }

    return '';
  }

  function formatCodexProbeErrorHint(id) {
    if (typeof getLastUsageProbeError !== 'function') return '';
    const raw = String(getLastUsageProbeError('codex', id) || '').trim();
    if (!raw) return '';
    const lower = raw.toLowerCase();
    if (lower.includes('panic') || lower.includes('null object') || lower.includes('app_server_exit_')) {
      return 'Codex app-server crashed while probing usage. Upgrade codex and retry (`npm install -g @openai/codex@latest`).';
    }
    if (lower.includes('timeout')) {
      return 'Usage probe timed out. Retry this account; if it keeps failing, lower concurrency or increase timeout.';
    }
    if (lower.includes('spawn_failed') || lower.includes('spawn_error') || lower.includes('einval')) {
      const isWindows = (typeof processObj !== 'undefined' && processObj.platform === 'win32');
      if (isWindows) {
        return 'Failed to start codex app-server (Windows spawn limit). Try lower concurrency: `aih codex usage -j 20`';
      }
      return 'Failed to start codex app-server in this sandbox. Check codex install/path and retry.';
    }
    if (
      lower.includes('direct_http_status_401')
      || lower.includes('direct_http_status_403')
      || lower.includes('http_401')
      || lower.includes('http_403')
      || lower.includes('invalid_token')
      || lower.includes('token_invalidated')
      || lower.includes('unauthorized')
    ) {
      return 'Account token appears invalid/expired in this sandbox. Run `aih codex <id>` once (or `codex login`) to refresh auth.';
    }
    return `Usage probe failed: ${raw}`;
  }

  function hasCodexAuthProbeError(id) {
    if (typeof getLastUsageProbeError !== 'function') return false;
    const raw = String(getLastUsageProbeError('codex', id) || '').trim().toLowerCase();
    return raw.includes('direct_http_status_401')
      || raw.includes('direct_http_status_403')
      || raw.includes('http_401')
      || raw.includes('http_403')
      || raw.includes('invalid_token')
      || raw.includes('unauthorized')
      || raw.includes('token_invalidated');
  }

  function readProbeErrorForSummary(cliName, id) {
    if (typeof getLastUsageProbeError !== 'function') return '';
    return String(getLastUsageProbeError(cliName, id) || '').trim();
  }

  function normalizeProbeErrorForSummary(value) {
    const text = String(value || '').trim();
    if (!text) return 'no_probe_error';
    const compact = text.replace(/\s+/g, ' ');
    return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
  }

  function incrementCount(map, key) {
    map.set(key, (map.get(key) || 0) + 1);
  }

  function formatTopCounts(map, limit = 5) {
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .slice(0, limit)
      .map(([key, count]) => `${key}=${count}`)
      .join(', ');
  }

  function getUsageNoSnapshotHint(cliName, id = null) {
    if (cliName === 'gemini') {
      return 'Ensure this account is logged in (OAuth), then retry.';
    }
    if (cliName === 'codex') {
      const probeHint = formatCodexProbeErrorHint(id);
      if (probeHint) return probeHint;
      return 'No usage snapshot returned yet. Run `aih codex <id>` once in this sandbox, then retry.';
    }
    if (cliName === 'claude') {
      if (id !== null && id !== undefined) {
        const auth = getClaudeUsageAuthForSandbox(cliName, id);
        if (!auth) {
          return 'No usable Claude auth token was found in this sandbox. Run `aih claude <id>` and login first.';
        }
        if (auth.mode === 'settings_env_token' && auth.isLocalProxy) {
          return `Detected local provider token (${auth.baseUrl}). Start that provider first, then retry; or login with Claude OAuth.`;
        }
        if (auth.mode === 'settings_env_token') {
          return 'Detected token from settings env. If this provider does not expose /api/oauth/usage, switch to Claude OAuth for usage-remaining.';
        }
      }
      return 'Ensure this account is logged in with OAuth (not API key), then retry.';
    }
    if (cliName === 'agy') {
      return 'Ensure this AGY account has a valid Antigravity OAuth access token, then retry.';
    }
    return '';
  }

  function formatUsageSnapshotLines(cache) {
    if (!cache || typeof cache !== 'object') return [];
    if ((cache.kind === 'gemini_oauth_stats' || cache.kind === 'agy_code_assist_quota') && Array.isArray(cache.models)) {
      return cache.models.map((m) => `${m.model}: ${m.remainingPct.toFixed(1)}% (resets in ${m.resetIn})`);
    }
    if (cache.kind === 'codex_oauth_status' || cache.kind === 'claude_oauth_usage') {
      return formatUsageWindowLines(cache);
    }
    return [JSON.stringify(cache)];
  }

  function formatBoolean(value) {
    return value ? 'yes' : 'no';
  }

  function formatOptionalBoolean(value) {
    if (value === null || value === undefined) return 'unknown';
    return formatBoolean(Boolean(value));
  }

  function printAgyUsagePreflight(id) {
    if (typeof buildAgyUsagePreflight !== 'function') {
      console.log(`\x1b[90m[aih]\x1b[0m AGY usage preflight is unavailable in this runtime.`);
      return;
    }
    const report = buildAgyUsagePreflight('agy', id);
    if (!report) {
      console.log(`\x1b[90m[aih]\x1b[0m AGY usage preflight returned no data for Account ID ${id}.`);
      return;
    }

    console.log(`\x1b[36m[aih]\x1b[0m AGY usage preflight for Account ID ${id}`);
    console.log(`  - profileDir: ${report.profileDir}`);
    console.log(`  - configDir: ${report.configDir}`);
    console.log(`  - tokenFile: ${formatBoolean(report.tokenFileExists)}`);
    console.log(`  - accessToken: oauthFile=${formatBoolean(report.oauthAccessTokenPresent)}, env=${formatBoolean(report.envAccessTokenPresent)}, selected=${report.selectedTokenSource || 'none'}`);
    console.log(`  - refreshToken: ${formatBoolean(report.refreshTokenPresent)}`);
    console.log(`  - emailCache: ${formatBoolean(report.emailPresent)}`);
    console.log(`  - tokenExpiry: ${report.tokenExpiresAt || 'unknown'} (expired=${formatOptionalBoolean(report.tokenExpired)}, refreshDue=${formatBoolean(report.refreshDue)})`);
    console.log(`  - usageCache: ${formatBoolean(report.usageCachePresent)}${report.usageCacheKind ? ` (${report.usageCacheKind})` : ''}${report.usageCacheCapturedAt ? ` capturedAt=${report.usageCacheCapturedAt}` : ''}`);
    console.log(`  - codeAssistClientVersion: ${report.codeAssistClientVersion || 'unknown'}`);
    console.log(`  - codeAssistUserAgent: ${report.codeAssistUserAgent || 'unknown'}`);
    const endpoints = Array.isArray(report.quotaBaseUrls) ? report.quotaBaseUrls : [];
    console.log(`  - quotaEndpoints: ${endpoints.length > 0 ? endpoints.join(', ') : 'none'}`);
    console.log(`\x1b[90m[Hint]\x1b[0m Preflight is local-only. Run with --no-cache to perform the live quota probe after explicit approval.`);
  }

  function formatAgyPreflightRow(report) {
    const pieces = [
      `token=${formatBoolean(report.tokenFileExists && report.oauthAccessTokenPresent)}`,
      `refresh=${formatBoolean(report.refreshTokenPresent)}`,
      `expired=${formatOptionalBoolean(report.tokenExpired)}`,
      `refreshDue=${formatBoolean(report.refreshDue)}`,
      `cache=${formatBoolean(report.usageCachePresent)}`,
      `selected=${report.selectedTokenSource || 'none'}`
    ];
    if (report.tokenExpiresAt) pieces.push(`expires=${report.tokenExpiresAt}`);
    return pieces.join(', ');
  }

  function printAllAgyUsagePreflights() {
    if (typeof buildAgyUsagePreflight !== 'function') {
      console.log(`\x1b[90m[aih]\x1b[0m AGY usage preflight is unavailable in this runtime.`);
      return;
    }
    const rawIds = getToolAccountIds('agy');
    const ids = Array.from(new Set(
      (Array.isArray(rawIds) ? rawIds : [])
        .map((id) => String(id || '').trim())
        .filter((id) => /^\d+$/.test(id))
    )).sort((a, b) => Number(a) - Number(b));
    if (ids.length === 0) {
      console.log('\x1b[90m[aih]\x1b[0m No accounts found for agy.');
      return;
    }

    const reports = ids
      .map((id) => buildAgyUsagePreflight('agy', id))
      .filter(Boolean);
    const first = reports[0] || {};
    let directReady = 0;
    let refreshDue = 0;
    let missingToken = 0;
    let withCache = 0;
    let recommended = '';

    console.log('\x1b[36m[aih]\x1b[0m AGY usage preflight for all local accounts');
    if (first.codeAssistClientVersion || first.codeAssistUserAgent) {
      console.log(`  - codeAssistClientVersion: ${first.codeAssistClientVersion || 'unknown'}`);
      console.log(`  - codeAssistUserAgent: ${first.codeAssistUserAgent || 'unknown'}`);
    }
    const endpoints = Array.isArray(first.quotaBaseUrls) ? first.quotaBaseUrls : [];
    if (endpoints.length > 0) {
      console.log(`  - quotaEndpoints: ${endpoints.join(', ')}`);
    }

    reports.forEach((report) => {
      const hasToken = !!(report.tokenFileExists && report.oauthAccessTokenPresent);
      if (!hasToken) missingToken += 1;
      if (report.refreshDue) refreshDue += 1;
      if (report.usageCachePresent) withCache += 1;
      if (hasToken && report.refreshTokenPresent && !report.refreshDue) {
        directReady += 1;
        if (!recommended) recommended = report.id;
      }
      console.log(`  - Account ID ${report.id}: ${formatAgyPreflightRow(report)}`);
    });

    console.log(`\x1b[90m[aih]\x1b[0m Summary: accounts=${reports.length}, direct_ready=${directReady}, refresh_due=${refreshDue}, missing_token=${missingToken}, with_cache=${withCache}`);
    if (recommended) {
      console.log(`\x1b[90m[Hint]\x1b[0m Recommended first live probe target: agy Account ID ${recommended}.`);
    }
    console.log(`\x1b[90m[Hint]\x1b[0m Preflight is local-only. Run \`aih agy usage <id> --no-cache\` to perform the live quota probe after explicit approval.`);
  }

  function getCodexNoNumericUsageHint(cache, id = null) {
    if (!cache || cache.kind !== 'codex_oauth_status') return '';
    if (!Array.isArray(cache.entries) || cache.entries.length === 0) return '';
    const hasNumeric = cache.entries.some((entry) => typeof entry.remainingPct === 'number');
    if (hasNumeric) return '';
    const fallbackSource = String(cache.fallbackSource || '').trim();
    const planType = String(cache.account && cache.account.planType || '').trim().toLowerCase();
    if (fallbackSource !== 'account_read') return '';
    if (hasCodexAuthProbeError(id)) {
      return formatCodexProbeErrorHint(id);
    }
    if (planType === 'team') {
      return 'Codex account/read fallback returned no numeric rate limits for a team plan. This usually means the workspace entitlement is missing, invalid, or no longer active.';
    }
    if (planType === 'free') {
      return 'Codex account/read fallback returned no numeric rate limits for a free plan.';
    }
    return 'Codex account/read fallback returned no numeric rate limits.';
  }

  function printUsageSnapshot(cliName, id, queryOptions = {}) {
    if (queryOptions && queryOptions.preflight) {
      if (cliName === 'agy') {
        printAgyUsagePreflight(id);
        return;
      }
      console.log(`\x1b[90m[aih]\x1b[0m Usage preflight is currently only available for agy accounts.`);
      return;
    }

    const profileDir = getProfileDir(cliName, id);
    const { accountName } = checkStatus(cliName, profileDir);
    if (accountName && accountName.startsWith('API Key')) {
      console.log(`\x1b[90m[aih]\x1b[0m ${cliName} Account ID ${id} is in API Key mode.`);
      console.log(`\x1b[90m[Hint]\x1b[0m OAuth usage-remaining is unavailable for API Key accounts.`);
      return;
    }

    const noCache = !!(queryOptions && queryOptions.noCache);
    let cache = readUsageCache(cliName, id);
    cache = ensureUsageSnapshot(cliName, id, cache, { forceRefresh: noCache });
    if (!cache) {
      console.log(`\x1b[90m[aih]\x1b[0m No cached usage snapshot for ${cliName} Account ID ${id}.`);
      const hint = getUsageNoSnapshotHint(cliName, id);
      if (hint) {
        console.log(`\x1b[90m[Hint]\x1b[0m ${hint}`);
      }
      return;
    }

    const ageLabel = cache.capturedAt
      ? `${Math.max(0, Math.floor((Date.now() - cache.capturedAt) / 1000))}s`
      : 'unknown';
    console.log(`\x1b[36m[aih]\x1b[0m Usage snapshot for ${cliName} Account ID ${id} (age: ${ageLabel})`);
    const lines = formatUsageSnapshotLines(cache);
    lines.forEach((line) => {
      console.log(`  - ${line}`);
    });
    const noNumericHint = getCodexNoNumericUsageHint(cache, id);
    if (noNumericHint) {
      console.log(`\x1b[90m[Hint]\x1b[0m ${noNumericHint}`);
    }
  }

  async function printUsageSnapshotAsync(cliName, id, queryOptions = {}) {
    if (queryOptions && queryOptions.preflight) {
      if (cliName === 'agy') {
        printAgyUsagePreflight(id);
        return;
      }
      console.log(`\x1b[90m[aih]\x1b[0m Usage preflight is currently only available for agy accounts.`);
      return;
    }

    const profileDir = getProfileDir(cliName, id);
    const { accountName } = checkStatus(cliName, profileDir);
    if (accountName && accountName.startsWith('API Key')) {
      console.log(`\x1b[90m[aih]\x1b[0m ${cliName} Account ID ${id} is in API Key mode.`);
      console.log(`\x1b[90m[Hint]\x1b[0m OAuth usage-remaining is unavailable for API Key accounts.`);
      return;
    }

    const noCache = !!(queryOptions && queryOptions.noCache);
    let cache = readUsageCache(cliName, id);
    if (typeof ensureUsageSnapshotAsync === 'function') {
      cache = await ensureUsageSnapshotAsync(cliName, id, cache, { forceRefresh: noCache });
    } else {
      cache = ensureUsageSnapshot(cliName, id, cache, { forceRefresh: noCache });
    }
    await waitForCodexAuthInvalidReconcile(cliName);
    if (!cache) {
      console.log(`\x1b[90m[aih]\x1b[0m No cached usage snapshot for ${cliName} Account ID ${id}.`);
      const hint = getUsageNoSnapshotHint(cliName, id);
      if (hint) {
        console.log(`\x1b[90m[Hint]\x1b[0m ${hint}`);
      }
      return;
    }

    const ageLabel = cache.capturedAt
      ? `${Math.max(0, Math.floor((Date.now() - cache.capturedAt) / 1000))}s`
      : 'unknown';
    console.log(`\x1b[36m[aih]\x1b[0m Usage snapshot for ${cliName} Account ID ${id} (age: ${ageLabel})`);
    const lines = formatUsageSnapshotLines(cache);
    lines.forEach((line) => {
      console.log(`  - ${line}`);
    });
    const noNumericHint = getCodexNoNumericUsageHint(cache, id);
    if (noNumericHint) {
      console.log(`\x1b[90m[Hint]\x1b[0m ${noNumericHint}`);
    }
  }

  function buildUsageProbePayload(cliName, id) {
    const profileDir = getProfileDir(cliName, id);
    const { configured, accountName } = checkStatus(cliName, profileDir);
    if (!configured) {
      return { cliName, id, status: 'pending' };
    }
    if (accountName && accountName.startsWith('API Key')) {
      return { cliName, id, status: 'api_key', label: accountName };
    }

    let cache = readUsageCache(cliName, id);
    cache = ensureUsageSnapshot(cliName, id, cache);
    const label = accountName && accountName !== 'Unknown' ? accountName : 'OAuth';
    if (!cache) {
      return {
        cliName,
        id,
        status: 'no_snapshot',
        label,
        hint: getUsageNoSnapshotHint(cliName, id)
      };
    }

    const ageLabel = cache.capturedAt
      ? `${Math.max(0, Math.floor((Date.now() - cache.capturedAt) / 1000))}s`
      : 'unknown';
    const minRemainingPct = getMinRemainingPctFromCache(cache);
    return {
      cliName,
      id,
      status: 'ok',
      label,
      ageLabel,
      minRemainingPct,
      lines: formatUsageSnapshotLines(cache)
    };
  }

  async function buildUsageProbePayloadAsync(cliName, id, probeOptions = {}) {
    const profileDir = getProfileDir(cliName, id);
    const { configured, accountName } = checkStatus(cliName, profileDir);
    if (!configured) {
      return { cliName, id, status: 'pending' };
    }
    if (accountName && accountName.startsWith('API Key')) {
      return { cliName, id, status: 'api_key', label: accountName };
    }

    let cache = readUsageCache(cliName, id);
    if (typeof ensureUsageSnapshotAsync === 'function') {
      cache = await ensureUsageSnapshotAsync(cliName, id, cache, probeOptions);
    } else {
      cache = ensureUsageSnapshot(cliName, id, cache);
    }
    const label = accountName && accountName !== 'Unknown' ? accountName : 'OAuth';
    if (!cache) {
      return {
        cliName,
        id,
        status: 'no_snapshot',
        label,
        hint: getUsageNoSnapshotHint(cliName, id)
      };
    }

    const ageLabel = cache.capturedAt
      ? `${Math.max(0, Math.floor((Date.now() - cache.capturedAt) / 1000))}s`
      : 'unknown';
    const minRemainingPct = getMinRemainingPctFromCache(cache);
    return {
      cliName,
      id,
      status: 'ok',
      label,
      ageLabel,
      minRemainingPct,
      lines: formatUsageSnapshotLines(cache)
    };
  }

  async function printAllUsageSnapshots(cliName, scanOptions = {}) {
    if (scanOptions && scanOptions.preflight) {
      if (cliName === 'agy') {
        printAllAgyUsagePreflights();
        return;
      }
      console.log(`\x1b[90m[aih]\x1b[0m Usage preflight is currently only available for agy accounts.`);
      return;
    }

    const rawIds = getToolAccountIds(cliName);
    const ids = Array.from(new Set(
      (Array.isArray(rawIds) ? rawIds : [])
        .map((id) => String(id || '').trim())
        .filter((id) => /^\d+$/.test(id))
    )).sort((a, b) => Number(a) - Number(b));
    if (ids.length === 0) {
      console.log(`\x1b[90m[aih]\x1b[0m No accounts found for ${cliName}.`);
      return;
    }

    let oauthCount = 0;
    let withSnapshot = 0;
    let skippedApiKey = 0;
    let skippedPending = 0;
    let skippedDepleted = 0;
    let skippedUnknown = 0;
    let processed = 0;
    let inFlight = 0;
    let lastAction = 'ready';
    const forcedQuiet = String(env.AIH_USAGE_SCAN_QUIET || '0') === '1';
    const quiet = forcedQuiet || (ids.length > 200 && String(env.AIH_USAGE_SCAN_VERBOSE || '0') !== '1');
    const requestedJobs = Number(scanOptions && scanOptions.jobs);
    const scanPlan = resolveUsageScanPlan(cliName, ids.length, requestedJobs);
    const maxWorkers = scanPlan.maxWorkers;
    const inFlightById = new Set();
    const useProgressBar = !!(processObj.stdout && processObj.stdout.isTTY);
    let progressTimer = null;
    let progressTick = 0;
    let skippedTimedOut = 0;
    const probeErrorCounts = new Map();
    const deadlineAt = Date.now() + scanPlan.deadlineMs;
    const progressFrames = ['.', '..', '...'];
    const renderProgress = (forceNewline = false) => {
      if (!useProgressBar || !processObj.stdout || typeof processObj.stdout.write !== 'function') return;
      const frame = progressFrames[progressTick % progressFrames.length];
      progressTick += 1;
      const text = `\r\x1b[90m[aih]\x1b[0m scanning${frame} ${processed}/${ids.length} workers=${maxWorkers} in_flight=${inFlight} ok=${withSnapshot} unknown=${skippedUnknown} timed_out=${skippedTimedOut} depleted_skip=${skippedDepleted} api_key_skip=${skippedApiKey} pending_skip=${skippedPending} last=${lastAction}   `;
      processObj.stdout.write(text);
      if (forceNewline) processObj.stdout.write('\n');
    };
    console.log(`\x1b[36m[aih]\x1b[0m Usage snapshots for ${cliName} (all local accounts)`);
    console.log(`\x1b[90m[aih]\x1b[0m Scan plan: accounts=${ids.length}, workers=${maxWorkers}, deadline=${scanPlan.deadlineMs}ms${scanPlan.bulkScan ? ', bulk=on' : ''}${scanPlan.skipCodexAppServerFallback ? ', codex_app_server_fallback=off' : ''}`);
    if (useProgressBar) {
      renderProgress(false);
      progressTimer = setInterval(() => renderProgress(false), 250);
      if (typeof progressTimer.unref === 'function') progressTimer.unref();
    }
    let cursor = 0;
    const worker = async () => {
      while (true) {
        if (Date.now() >= deadlineAt) {
          const remaining = Math.max(0, ids.length - cursor);
          if (remaining > 0) {
            cursor = ids.length;
            processed += remaining;
            skippedTimedOut += remaining;
            lastAction = 'deadline';
          }
          return;
        }
        const idx = cursor;
        cursor += 1;
        if (idx >= ids.length) return;
        const id = ids[idx];
        if (inFlightById.has(id)) {
          processed += 1;
          continue;
        }
        inFlightById.add(id);
        inFlight += 1;
        try {
          lastAction = `query#${id}`;
          const remainingBudgetMs = Math.max(1, deadlineAt - Date.now());
          const probeOptions = {
            bulkScan: scanPlan.bulkScan,
            probeTimeoutMs: scanPlan.probeTimeoutMs || undefined,
            skipCodexAppServerFallback: scanPlan.skipCodexAppServerFallback,
            allowCodexTokenRefresh: scanPlan.allowCodexTokenRefresh,
            // --refresh 旁路 TTL 缓存,强制重新拉取用量快照
            forceRefresh: !!(scanOptions && scanOptions.refresh)
          };
          const payload = await withDeadline(
            buildUsageProbePayloadAsync(cliName, id, probeOptions),
            Math.min(remainingBudgetMs, scanPlan.probeTimeoutMs || remainingBudgetMs),
            () => ({
              ...createTimeoutResult('deadline_timeout'),
              cliName,
              id
            })
          );
          const operationalStatus = resolvePersistedOperationalStatus(cliName, id);
          if (payload.status === 'pending') {
            syncIndexedBaseState(cliName, id, {
              status: operationalStatus,
              configured: false,
              apiKeyMode: false,
              remainingPct: null
            });
            skippedPending += 1;
            lastAction = `skip#${id}:pending`;
            if (!quiet) console.log(`  - Account ID ${id}: Pending Login (skipped)`);
            continue;
          }
          if (payload.status === 'api_key') {
            syncIndexedBaseState(cliName, id, {
              status: operationalStatus,
              configured: true,
              apiKeyMode: true,
              remainingPct: null
            });
            skippedApiKey += 1;
            lastAction = `skip#${id}:api_key`;
            if (!quiet) console.log(`  - Account ID ${id}: ${payload.label} (API Key mode, skipped)`);
            continue;
          }
          if (payload.status === 'probe_error') {
            oauthCount += 1;
            if (payload.error === 'deadline_timeout') skippedTimedOut += 1;
            incrementCount(probeErrorCounts, normalizeProbeErrorForSummary(payload.error || readProbeErrorForSummary(cliName, id)));
            lastAction = `skip#${id}:probe_error`;
            if (!quiet) console.log(`  - Account ID ${id}: usage probe failed (${payload.error || 'unknown'})`);
            continue;
          }

          oauthCount += 1;
          if (payload.status !== 'ok') {
            const quotaState = typeof getAccountQuotaState === 'function'
              ? getAccountQuotaState(cliName, id, { refreshSnapshot: false })
              : null;
            syncIndexedBaseState(cliName, id, {
              status: operationalStatus,
              configured: true,
              apiKeyMode: false,
              remainingPct: null
            });
            skippedUnknown += 1;
            incrementCount(probeErrorCounts, normalizeProbeErrorForSummary(readProbeErrorForSummary(cliName, id)));
            lastAction = `skip#${id}:${quotaState && quotaState.quotaStatus ? quotaState.quotaStatus : 'no_snapshot'}`;
            if (!quiet) console.log(`  - Account ID ${id} (${payload.label || 'OAuth'}): no cached usage snapshot`);
            if (!quiet && payload.hint) {
              console.log(`    Hint: ${payload.hint}`);
            }
            continue;
          }

          const payloadRemaining = Number(payload.minRemainingPct);
          const minRemaining = Number.isFinite(payloadRemaining) ? payloadRemaining : null;
          if (Number.isFinite(minRemaining) && minRemaining <= 0) {
            syncIndexedBaseState(cliName, id, {
              status: operationalStatus,
              configured: true,
              apiKeyMode: false,
              remainingPct: minRemaining
            });
            skippedDepleted += 1;
            lastAction = `skip#${id}:depleted`;
            continue;
          }
          syncIndexedBaseState(cliName, id, {
            status: operationalStatus,
            configured: true,
            apiKeyMode: false,
            remainingPct: minRemaining
          });
          withSnapshot += 1;
          lastAction = `ok#${id}`;
          if (!quiet) {
            console.log(`  - Account ID ${id} (${payload.label}) [age: ${payload.ageLabel}]`);
            (Array.isArray(payload.lines) ? payload.lines : []).forEach((line) => {
              console.log(`    ${line}`);
            });
          }
        } finally {
          inFlightById.delete(id);
          inFlight -= 1;
          processed += 1;
        }
      }
    };

    const workerCount = Math.min(maxWorkers, ids.length);
    const workers = [];
    for (let i = 0; i < workerCount; i += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);
    await waitForCodexAuthInvalidReconcile(cliName);
    if (progressTimer) clearInterval(progressTimer);
    renderProgress(true);

    console.log(`\x1b[90m[aih]\x1b[0m Summary: oauth=${oauthCount}, with_snapshot=${withSnapshot}, unknown_remaining=${skippedUnknown}, timed_out=${skippedTimedOut}, depleted_skipped=${skippedDepleted}, api_key_skipped=${skippedApiKey}, pending_skipped=${skippedPending}`);
    const probeErrorSummary = formatTopCounts(probeErrorCounts);
    if (probeErrorSummary) {
      console.log(`\x1b[90m[aih]\x1b[0m Probe errors: ${probeErrorSummary}`);
    }
  }

  return {
    formatUsageLabel,
    getUsageNoSnapshotHint,
    formatUsageSnapshotLines,
    printUsageSnapshot,
    printUsageSnapshotAsync,
    printAgyUsagePreflight,
    buildUsageProbePayload,
    buildUsageProbePayloadAsync,
    printAllUsageSnapshots
  };
}

module.exports = {
  createUsagePresenterService
};
