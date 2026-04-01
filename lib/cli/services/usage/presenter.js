'use strict';

function createUsagePresenterService(options = {}) {
  const {
    usageCacheMaxAgeMs,
    readUsageCache,
    ensureUsageSnapshot,
    ensureUsageSnapshotAsync,
    getClaudeUsageAuthForSandbox,
    getLastUsageProbeError,
    checkStatus,
    getProfileDir,
    filterExistingAccountIds,
    getAccountStateIndex,
    getToolAccountIds,
    getDefaultParallelism,
    stateIndexClient,
    isExhausted,
    getMinRemainingPctFromCache
  } = options;
  const processObj = options.processObj || process;

  function formatUsageLabel(cliName, id, accountName) {
    if (accountName && accountName.startsWith('API Key')) {
      return '\x1b[90m[Remaining: API Key mode]\x1b[0m';
    }
    const cache = readUsageCache(cliName, id);
    if (!cache || !cache.capturedAt || (Date.now() - cache.capturedAt > usageCacheMaxAgeMs)) {
      return '';
    }

    if (cache.kind === 'gemini_oauth_stats' && Array.isArray(cache.models) && cache.models.length > 0) {
      const hottest = [...cache.models].sort((a, b) => a.remainingPct - b.remainingPct)[0];
      return `\x1b[36m[Remaining: ${hottest.model} ${hottest.remainingPct.toFixed(1)}% / ${hottest.resetIn}]\x1b[0m`;
    }

    if (cache.kind === 'codex_oauth_status' && Array.isArray(cache.entries) && cache.entries.length > 0) {
      const withPct = cache.entries
        .filter((x) => typeof x.remainingPct === 'number')
        .sort((a, b) => (Number(b.windowMinutes) || 0) - (Number(a.windowMinutes) || 0))[0];
      if (withPct) {
        const resetSuffix = withPct.resetIn ? ` / ${withPct.resetIn}` : '';
        return `\x1b[36m[Remaining: ${withPct.window} ${withPct.remainingPct.toFixed(1)}%${resetSuffix}]\x1b[0m`;
      }
      return `\x1b[36m[Remaining: ${cache.entries[0].window}]\x1b[0m`;
    }

    if (cache.kind === 'claude_oauth_usage' && Array.isArray(cache.entries) && cache.entries.length > 0) {
      const withPct = cache.entries
        .filter((x) => typeof x.remainingPct === 'number')
        .sort((a, b) => (Number(b.windowMinutes) || 0) - (Number(a.windowMinutes) || 0))[0];
      if (withPct) {
        const resetSuffix = withPct.resetIn ? ` / ${withPct.resetIn}` : '';
        return `\x1b[36m[Remaining: ${withPct.window} ${withPct.remainingPct.toFixed(1)}%${resetSuffix}]\x1b[0m`;
      }
      return `\x1b[36m[Remaining: ${cache.entries[0].window}]\x1b[0m`;
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
    if (lower.includes('spawn_failed')) {
      return 'Failed to start codex app-server in this sandbox. Check codex install/path and retry.';
    }
    if (lower.includes('direct_http_status_401') || lower.includes('direct_http_status_403') || lower.includes('invalid_token') || lower.includes('unauthorized')) {
      return 'Account token appears invalid/expired in this sandbox. Run `aih codex <id>` once (or `codex login`) to refresh auth.';
    }
    return `Usage probe failed: ${raw}`;
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
    return '';
  }

  function formatUsageSnapshotLines(cache) {
    if (!cache || typeof cache !== 'object') return [];
    if (cache.kind === 'gemini_oauth_stats' && Array.isArray(cache.models)) {
      return cache.models.map((m) => `${m.model}: ${m.remainingPct.toFixed(1)}% (resets in ${m.resetIn})`);
    }
    if (cache.kind === 'codex_oauth_status' && Array.isArray(cache.entries)) {
      return cache.entries.map((x) => {
        if (typeof x.remainingPct === 'number') {
          const resetSuffix = x.resetIn ? ` (resets in ${x.resetIn})` : '';
          return `${x.window}: ${x.remainingPct.toFixed(1)}%${resetSuffix}`;
        }
        return `${x.window}`;
      });
    }
    if (cache.kind === 'claude_oauth_usage' && Array.isArray(cache.entries)) {
      return cache.entries.map((x) => {
        if (typeof x.remainingPct === 'number') {
          const resetSuffix = x.resetIn ? ` (resets in ${x.resetIn})` : '';
          return `${x.window}: ${x.remainingPct.toFixed(1)}%${resetSuffix}`;
        }
        return `${x.window}`;
      });
    }
    return [JSON.stringify(cache)];
  }

  function printUsageSnapshot(cliName, id, queryOptions = {}) {
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
  }

  async function printUsageSnapshotAsync(cliName, id, queryOptions = {}) {
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

  async function buildUsageProbePayloadAsync(cliName, id) {
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
      cache = await ensureUsageSnapshotAsync(cliName, id, cache);
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
    const forcedQuiet = String(processObj.env.AIH_USAGE_SCAN_QUIET || '0') === '1';
    const quiet = forcedQuiet || (ids.length > 200 && String(processObj.env.AIH_USAGE_SCAN_VERBOSE || '0') !== '1');
    const requestedJobs = Number(scanOptions && scanOptions.jobs);
    const defaultParallel = cliName === 'codex'
      ? 500
      : Math.max(1, Number(getDefaultParallelism ? getDefaultParallelism() : 10) || 10);
    const maxWorkers = Number.isFinite(requestedJobs) && requestedJobs > 0
      ? Math.max(1, Math.min(2000, Math.floor(requestedJobs)))
      : Math.max(1, Math.min(defaultParallel, ids.length));
    const inFlightById = new Set();
    const useProgressBar = !!(processObj.stdout && processObj.stdout.isTTY);
    let progressTimer = null;
    let progressTick = 0;
    const progressFrames = ['.', '..', '...'];
    const renderProgress = (forceNewline = false) => {
      if (!useProgressBar || !processObj.stdout || typeof processObj.stdout.write !== 'function') return;
      const frame = progressFrames[progressTick % progressFrames.length];
      progressTick += 1;
      const text = `\r\x1b[90m[aih]\x1b[0m scanning${frame} ${processed}/${ids.length} in_flight=${inFlight} ok=${withSnapshot} unknown=${skippedUnknown} depleted_skip=${skippedDepleted} api_key_skip=${skippedApiKey} pending_skip=${skippedPending} last=${lastAction}   `;
      processObj.stdout.write(text);
      if (forceNewline) processObj.stdout.write('\n');
    };
    console.log(`\x1b[36m[aih]\x1b[0m Usage snapshots for ${cliName} (all local accounts)`);
    if (useProgressBar) {
      renderProgress(false);
      progressTimer = setInterval(() => renderProgress(false), 250);
      if (typeof progressTimer.unref === 'function') progressTimer.unref();
    }
    let cursor = 0;
    const worker = async () => {
      while (true) {
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
          const payload = await buildUsageProbePayloadAsync(cliName, id);
          if (payload.status === 'pending') {
            stateIndexClient.upsert(cliName, id, {
              configured: false,
              apiKeyMode: false,
              exhausted: false
            });
            skippedPending += 1;
            lastAction = `skip#${id}:pending`;
            if (!quiet) console.log(`  - Account ID ${id}: Pending Login (skipped)`);
            continue;
          }
          if (payload.status === 'api_key') {
            stateIndexClient.upsert(cliName, id, {
              configured: true,
              apiKeyMode: true,
              exhausted: false
            });
            skippedApiKey += 1;
            lastAction = `skip#${id}:api_key`;
            if (!quiet) console.log(`  - Account ID ${id}: ${payload.label} (API Key mode, skipped)`);
            continue;
          }
          if (payload.status === 'probe_error') {
            oauthCount += 1;
            lastAction = `skip#${id}:probe_error`;
            if (!quiet) console.log(`  - Account ID ${id}: usage probe failed (${payload.error || 'unknown'})`);
            continue;
          }

          oauthCount += 1;
          if (payload.status !== 'ok') {
            stateIndexClient.upsert(cliName, id, {
              configured: true,
              apiKeyMode: false,
              exhausted: isExhausted(cliName, id),
              remainingPct: null
            });
            skippedUnknown += 1;
            lastAction = `skip#${id}:no_snapshot`;
            if (!quiet) console.log(`  - Account ID ${id} (${payload.label || 'OAuth'}): no cached usage snapshot`);
            if (!quiet && payload.hint) {
              console.log(`    Hint: ${payload.hint}`);
            }
            continue;
          }

          const payloadRemaining = Number(payload.minRemainingPct);
          const minRemaining = Number.isFinite(payloadRemaining) ? payloadRemaining : null;
          if (Number.isFinite(minRemaining) && minRemaining <= 0) {
            stateIndexClient.upsert(cliName, id, {
              configured: true,
              apiKeyMode: false,
              exhausted: true,
              remainingPct: minRemaining
            });
            skippedDepleted += 1;
            lastAction = `skip#${id}:depleted`;
            continue;
          }
          stateIndexClient.upsert(cliName, id, {
            configured: true,
            apiKeyMode: false,
            exhausted: isExhausted(cliName, id),
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
    if (progressTimer) clearInterval(progressTimer);
    renderProgress(true);

    console.log(`\x1b[90m[aih]\x1b[0m Summary: oauth=${oauthCount}, with_snapshot=${withSnapshot}, unknown_remaining=${skippedUnknown}, depleted_skipped=${skippedDepleted}, api_key_skipped=${skippedApiKey}, pending_skipped=${skippedPending}`);
  }

  return {
    formatUsageLabel,
    getUsageNoSnapshotHint,
    formatUsageSnapshotLines,
    printUsageSnapshot,
    printUsageSnapshotAsync,
    buildUsageProbePayload,
    buildUsageProbePayloadAsync,
    printAllUsageSnapshots
  };
}

module.exports = {
  createUsagePresenterService
};
